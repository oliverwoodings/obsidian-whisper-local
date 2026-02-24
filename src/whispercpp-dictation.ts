import { convertFloat32ToPcm16, postWhisperCppInference } from './whispercpp-http';

export interface WhisperCppDictationConfig {
	baseUrl: string;
	language?: string;
	requestTimeoutMs: number;
}

interface WhisperCppDictationHandlers {
	onTranscript: (transcript: string) => void;
	onError: (message: string) => void;
	onDebug?: (message: string, data?: unknown) => void;
	onStop?: () => void;
}

const WORKLET_PROCESSOR = 'whisper-local-pcm-capture';
const TARGET_SAMPLE_RATE = 16_000;
const WORKLET_SOURCE = `
class WhisperLocalPcmCaptureProcessor extends AudioWorkletProcessor {
	process(inputs) {
		const firstInput = inputs[0];
		const firstChannel = firstInput && firstInput[0];
		if (firstChannel && firstChannel.length > 0) {
			this.port.postMessage(firstChannel);
		}

		return true;
	}
}

registerProcessor('${WORKLET_PROCESSOR}', WhisperLocalPcmCaptureProcessor);
`;

const VAD_ENERGY_THRESHOLD = 0.008;
const VAD_SILENCE_MS = 320;
const VAD_MIN_UTTERANCE_MS = 220;
const VAD_MAX_UTTERANCE_MS = 2_500;
const VAD_PREROLL_MS = 180;

export class WhisperCppDictationSession {
	private readonly config: WhisperCppDictationConfig;
	private readonly handlers: WhisperCppDictationHandlers;
	private mediaStream: MediaStream | null = null;
	private audioContext: AudioContext | null = null;
	private sourceNode: MediaStreamAudioSourceNode | null = null;
	private workletNode: AudioWorkletNode | null = null;
	private silentGainNode: GainNode | null = null;
	private starting = false;
	private active = false;
	private sampleRate = 16_000;
	private startedAtMs: number | null = null;
	private audioFrameCount = 0;
	private audioSampleCount = 0;
	private utteranceCount = 0;
	private transcriptCount = 0;
	private transcriptionRequestCount = 0;
	private pendingQueueCount = 0;
	private processingQueue = false;
	private speaking = false;
	private speakingSilenceMs = 0;
	private utterancePcmChunks: Int16Array[] = [];
	private utteranceSampleCount = 0;
	private preRollChunks: Int16Array[] = [];
	private preRollSampleCount = 0;
	private transcriptionQueue: Int16Array[] = [];
	private lastError: string | null = null;
	private lastTranscriptPreview: string | null = null;

	constructor(config: WhisperCppDictationConfig, handlers: WhisperCppDictationHandlers) {
		this.config = {
			baseUrl: config.baseUrl.trim(),
			language: config.language?.trim(),
			requestTimeoutMs: config.requestTimeoutMs,
		};
		this.handlers = handlers;
	}

	get isActive(): boolean {
		return this.active || this.starting;
	}

	async start(): Promise<void> {
		if (this.isActive) {
			this.debug('Start ignored because dictation is already active.');
			return;
		}

		this.starting = true;
		this.resetStats();
		this.startedAtMs = Date.now();
		this.debug('Whisper.cpp dictation session start requested.', {
			baseUrl: this.config.baseUrl,
			language: this.config.language || null,
			requestTimeoutMs: this.config.requestTimeoutMs,
		});

		try {
			this.debug('Requesting microphone access.');
			this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
			this.audioContext = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
			this.sampleRate = this.audioContext.sampleRate;
			await this.audioContext.resume();
			await this.setupAudioPipeline();
			this.active = true;
			this.debug('Audio pipeline ready.', {
				sampleRate: this.sampleRate,
				vad: {
					energyThreshold: VAD_ENERGY_THRESHOLD,
					silenceMs: VAD_SILENCE_MS,
					maxUtteranceMs: VAD_MAX_UTTERANCE_MS,
				},
			});
		} catch (error) {
			await this.stop();
			this.handlers.onError(getErrorMessage(error, 'Failed to start live dictation.'));
			throw error;
		} finally {
			this.starting = false;
		}
	}

	async stop(): Promise<void> {
		this.debug('Stop requested.');
		const wasActive = this.active || this.starting;
		this.active = false;
		this.starting = false;
		this.speaking = false;
		this.speakingSilenceMs = 0;
		this.utterancePcmChunks = [];
		this.utteranceSampleCount = 0;
		this.preRollChunks = [];
		this.preRollSampleCount = 0;
		this.transcriptionQueue = [];
		this.pendingQueueCount = 0;

		await this.cleanupAudio();
		this.debug('Session stopped and resources released.');
		if (wasActive) {
			this.handlers.onStop?.();
		}
	}

	getDebugSnapshot(): Record<string, unknown> {
		return {
			isActive: this.isActive,
			starting: this.starting,
			startedAt: this.startedAtMs ? new Date(this.startedAtMs).toISOString() : null,
			sampleRate: this.sampleRate,
			audioFrameCount: this.audioFrameCount,
			audioSampleCount: this.audioSampleCount,
			utteranceCount: this.utteranceCount,
			transcriptCount: this.transcriptCount,
			transcriptionRequestCount: this.transcriptionRequestCount,
			pendingQueueCount: this.pendingQueueCount,
			processingQueue: this.processingQueue,
			speaking: this.speaking,
			lastError: this.lastError,
			lastTranscriptPreview: this.lastTranscriptPreview,
		};
	}

	private async setupAudioPipeline(): Promise<void> {
		if (!this.audioContext || !this.mediaStream) {
			throw new Error('Audio pipeline was not initialized.');
		}

		if (typeof AudioWorkletNode === 'undefined') {
			throw new Error('AudioWorklet is not available in this environment.');
		}

		this.debug('Initializing audio worklet pipeline.');
		const workletModuleUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], {
			type: 'application/javascript',
		}));

		try {
			await this.audioContext.audioWorklet.addModule(workletModuleUrl);
		} finally {
			URL.revokeObjectURL(workletModuleUrl);
		}

		this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);
		this.workletNode = new AudioWorkletNode(this.audioContext, WORKLET_PROCESSOR, {
			channelCount: 1,
			channelCountMode: 'explicit',
			channelInterpretation: 'speakers',
			numberOfInputs: 1,
			numberOfOutputs: 1,
		});
		this.workletNode.port.addEventListener('message', this.handleWorkletMessage);
		this.workletNode.port.start();

		this.silentGainNode = this.audioContext.createGain();
		this.silentGainNode.gain.value = 0;

		this.sourceNode.connect(this.workletNode);
		this.workletNode.connect(this.silentGainNode);
		this.silentGainNode.connect(this.audioContext.destination);
	}

	private readonly handleWorkletMessage = (event: MessageEvent<Float32Array>): void => {
		if (!this.active) {
			return;
		}

		const frame = event.data;
		if (!(frame instanceof Float32Array) || frame.length === 0) {
			return;
		}

		this.audioFrameCount += 1;
		this.audioSampleCount += frame.length;
		if (this.audioFrameCount % 120 === 0) {
			this.debug('Audio frames captured.', {
				frameCount: this.audioFrameCount,
				sampleCount: this.audioSampleCount,
			});
		}

		const frameRms = calculateRms(frame);
		const frameDurationMs = (frame.length / this.sampleRate) * 1_000;
		const pcmFrame = convertFloat32ToPcm16(frame);
		this.capturePreRollFrame(pcmFrame);

		if (!this.speaking && frameRms >= VAD_ENERGY_THRESHOLD) {
			this.speaking = true;
			this.speakingSilenceMs = 0;
			this.absorbPreRollIntoUtterance();
			this.debug('Speech started.', {
				frameRms,
			});
		}

		if (!this.speaking) {
			return;
		}

		this.appendUtteranceFrame(pcmFrame);

		if (frameRms >= VAD_ENERGY_THRESHOLD) {
			this.speakingSilenceMs = 0;
		} else {
			this.speakingSilenceMs += frameDurationMs;
		}

		const utteranceDurationMs = this.getUtteranceDurationMs();
		if (this.speakingSilenceMs >= VAD_SILENCE_MS) {
			this.finalizeUtterance('silence');
			return;
		}

		if (utteranceDurationMs >= VAD_MAX_UTTERANCE_MS) {
			this.finalizeUtterance('max_duration');
		}
	};

	private capturePreRollFrame(frame: Int16Array): void {
		this.preRollChunks.push(frame);
		this.preRollSampleCount += frame.length;
		const maxPreRollSamples = Math.floor((this.sampleRate * VAD_PREROLL_MS) / 1_000);
		while (this.preRollSampleCount > maxPreRollSamples && this.preRollChunks.length > 0) {
			const dropped = this.preRollChunks.shift();
			this.preRollSampleCount -= dropped?.length ?? 0;
		}
	}

	private absorbPreRollIntoUtterance(): void {
		if (this.preRollSampleCount === 0) {
			return;
		}

		for (const frame of this.preRollChunks) {
			this.appendUtteranceFrame(frame);
		}
		this.preRollChunks = [];
		this.preRollSampleCount = 0;
	}

	private appendUtteranceFrame(frame: Int16Array): void {
		this.utterancePcmChunks.push(frame);
		this.utteranceSampleCount += frame.length;
	}

	private finalizeUtterance(reason: 'silence' | 'max_duration'): void {
		const utteranceDurationMs = this.getUtteranceDurationMs();
		const utterancePcm = concatInt16Chunks(this.utterancePcmChunks, this.utteranceSampleCount);
		this.utterancePcmChunks = [];
		this.utteranceSampleCount = 0;
		this.speaking = false;
		this.speakingSilenceMs = 0;

		if (utteranceDurationMs < VAD_MIN_UTTERANCE_MS || utterancePcm.length === 0) {
			this.debug('Discarded short utterance.', {
				reason,
				utteranceDurationMs,
			});
			return;
		}

		this.utteranceCount += 1;
		this.transcriptionQueue.push(utterancePcm);
		this.pendingQueueCount = this.transcriptionQueue.length;
		this.debug('Queued utterance for transcription.', {
			reason,
			utteranceDurationMs,
			queueLength: this.transcriptionQueue.length,
		});
		void this.processTranscriptionQueue();
	}

	private async processTranscriptionQueue(): Promise<void> {
		if (this.processingQueue) {
			return;
		}

		this.processingQueue = true;
		try {
			while (this.transcriptionQueue.length > 0) {
				const next = this.transcriptionQueue.shift();
				this.pendingQueueCount = this.transcriptionQueue.length;
				if (!next) {
					continue;
				}

				this.transcriptionRequestCount += 1;
				this.debug('Sending utterance to whisper.cpp /inference.', {
					requestCount: this.transcriptionRequestCount,
					samples: next.length,
					sampleRate: this.sampleRate,
					queueLength: this.transcriptionQueue.length,
				});

				try {
					const result = await postWhisperCppInference({
						baseUrl: this.config.baseUrl,
						pcm16: next,
						sampleRate: this.sampleRate,
						language: this.config.language,
						timeoutMs: this.config.requestTimeoutMs,
					});
					const transcript = result.text.trim();
					if (transcript.length === 0) {
						this.debug('Whisper.cpp returned an empty transcript.');
						continue;
					}

					if (!this.active) {
						this.debug('Transcript ignored because session is no longer active.');
						continue;
					}

					this.transcriptCount += 1;
					this.lastTranscriptPreview = transcript.slice(0, 120);
					this.debug('Transcript received from whisper.cpp.', {
						transcriptCount: this.transcriptCount,
						transcriptLength: transcript.length,
					});
					this.handlers.onTranscript(transcript);
				} catch (error) {
					this.lastError = getErrorMessage(error, 'whisper.cpp transcription failed.');
					this.debug('Whisper.cpp transcription request failed.', {
						error: this.lastError,
					});
					this.handlers.onError(this.lastError);
				}
			}
		} finally {
			this.processingQueue = false;
		}
	}

	private getUtteranceDurationMs(): number {
		if (this.utteranceSampleCount === 0) {
			return 0;
		}

		return (this.utteranceSampleCount / this.sampleRate) * 1_000;
	}

	private async cleanupAudio(): Promise<void> {
		if (this.sourceNode) {
			this.sourceNode.disconnect();
			this.sourceNode = null;
		}

		if (this.workletNode) {
			this.workletNode.port.removeEventListener('message', this.handleWorkletMessage);
			this.workletNode.port.close();
			this.workletNode.disconnect();
			this.workletNode = null;
		}

		if (this.silentGainNode) {
			this.silentGainNode.disconnect();
			this.silentGainNode = null;
		}

		if (this.mediaStream) {
			for (const track of this.mediaStream.getTracks()) {
				track.stop();
			}
			this.mediaStream = null;
		}

		if (this.audioContext) {
			const audioContext = this.audioContext;
			this.audioContext = null;
			if (audioContext.state !== 'closed') {
				await audioContext.close();
			}
		}
	}

	private resetStats(): void {
		this.audioFrameCount = 0;
		this.audioSampleCount = 0;
		this.utteranceCount = 0;
		this.transcriptCount = 0;
		this.transcriptionRequestCount = 0;
		this.pendingQueueCount = 0;
		this.processingQueue = false;
		this.speaking = false;
		this.speakingSilenceMs = 0;
		this.utterancePcmChunks = [];
		this.utteranceSampleCount = 0;
		this.preRollChunks = [];
		this.preRollSampleCount = 0;
		this.transcriptionQueue = [];
		this.lastError = null;
		this.lastTranscriptPreview = null;
	}

	private debug(message: string, data?: unknown): void {
		this.handlers.onDebug?.(message, data);
	}
}

function calculateRms(input: Float32Array): number {
	let sum = 0;
	for (let index = 0; index < input.length; index += 1) {
		const sample = input[index] ?? 0;
		sum += sample * sample;
	}

	if (input.length === 0) {
		return 0;
	}

	return Math.sqrt(sum / input.length);
}

function concatInt16Chunks(chunks: Int16Array[], totalLength: number): Int16Array {
	if (chunks.length === 0 || totalLength <= 0) {
		return new Int16Array(0);
	}

	if (chunks.length === 1) {
		return chunks[0] ?? new Int16Array(0);
	}

	const merged = new Int16Array(totalLength);
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.length;
	}

	return merged;
}

function getErrorMessage(error: unknown, fallback: string): string {
	if (error instanceof Error && error.message.trim().length > 0) {
		return error.message;
	}

	return fallback;
}

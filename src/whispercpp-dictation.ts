import { convertFloat32ToPcm16, postWhisperCppInference } from './whispercpp-http';
import { normalizeTranscriptChunk, type TranscriptNormalizationReason } from './transcript-normalization';

export interface WhisperCppDictationConfig {
	baseUrl: string;
	language?: string;
	requestTimeoutMs: number;
}

type UtteranceReason = 'silence' | 'max_duration';
export type TranscriptPhase = 'partial' | 'provisional' | 'final';

export interface WhisperCppTranscriptUpdate {
	text: string;
	phase: TranscriptPhase;
	speechSequenceId: number;
	utteranceDurationMs: number;
}

interface WhisperCppDictationHandlers {
	onTranscript: (update: WhisperCppTranscriptUpdate) => void;
	onError: (message: string) => void;
	onDebug?: (message: string, data?: unknown) => void;
	onStop?: () => void;
}

interface TranscriptionJob {
	pcm16: Int16Array;
	reason: UtteranceReason;
	speechSequenceId: number;
	utteranceDurationMs: number;
	voicedMs: number;
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
const VAD_MAX_UTTERANCE_MS = 3_500;
const VAD_PREROLL_MS = 180;
const VAD_MIN_VOICED_MS = 180;

const PARTIAL_REQUEST_INTERVAL_MS = 450;
const PARTIAL_MIN_VOICED_MS = 320;

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
	private sampleRate = TARGET_SAMPLE_RATE;
	private startedAtMs: number | null = null;

	private audioFrameCount = 0;
	private audioSampleCount = 0;
	private utteranceCount = 0;
	private transcriptCount = 0;
	private transcriptionRequestCount = 0;
	private partialRequestCount = 0;
	private pendingQueueCount = 0;

	private processingQueue = false;
	private speaking = false;
	private speakingSilenceMs = 0;
	private utterancePcmChunks: Int16Array[] = [];
	private utteranceSampleCount = 0;
	private utteranceVoicedMs = 0;
	private preRollChunks: Int16Array[] = [];
	private preRollSampleCount = 0;
	private transcriptionQueue: TranscriptionJob[] = [];

	private currentSpeechSequenceId = 0;
	private continueSpeechSequence = false;
	private finalizedSpeechSequenceId = 0;
	private partialRequestInFlight = false;
	private partialRequestQueued = false;
	private lastPartialRequestAtMs = 0;

	private lastError: string | null = null;
	private lastTranscriptPreview: string | null = null;
	private lastCommittedTranscript = '';

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
				partial: {
					intervalMs: PARTIAL_REQUEST_INTERVAL_MS,
					minVoicedMs: PARTIAL_MIN_VOICED_MS,
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
		this.utteranceVoicedMs = 0;
		this.preRollChunks = [];
		this.preRollSampleCount = 0;
		this.transcriptionQueue = [];
		this.pendingQueueCount = 0;

		this.partialRequestInFlight = false;
		this.partialRequestQueued = false;

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
			partialRequestCount: this.partialRequestCount,
			pendingQueueCount: this.pendingQueueCount,
			processingQueue: this.processingQueue,
			speaking: this.speaking,
			currentSpeechSequenceId: this.currentSpeechSequenceId,
			finalizedSpeechSequenceId: this.finalizedSpeechSequenceId,
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
			if (!this.continueSpeechSequence) {
				this.currentSpeechSequenceId += 1;
			}
			this.continueSpeechSequence = false;
			this.absorbPreRollIntoUtterance();
			this.debug('Speech started.', {
				frameRms,
				speechSequenceId: this.currentSpeechSequenceId,
			});
		}

		if (!this.speaking) {
			return;
		}

		this.appendUtteranceFrame(pcmFrame);

		if (frameRms >= VAD_ENERGY_THRESHOLD) {
			this.speakingSilenceMs = 0;
			this.utteranceVoicedMs += frameDurationMs;
		} else {
			this.speakingSilenceMs += frameDurationMs;
		}

		void this.maybeRequestPartialTranscription();

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

	private async maybeRequestPartialTranscription(): Promise<void> {
		if (!this.active || !this.speaking) {
			return;
		}

		if (this.utteranceVoicedMs < PARTIAL_MIN_VOICED_MS) {
			return;
		}

		const now = Date.now();
		if (now - this.lastPartialRequestAtMs < PARTIAL_REQUEST_INTERVAL_MS) {
			return;
		}

		if (this.partialRequestInFlight) {
			this.partialRequestQueued = true;
			return;
		}

		const snapshotPcm = concatInt16Chunks(this.utterancePcmChunks, this.utteranceSampleCount);
		if (snapshotPcm.length === 0) {
			return;
		}

		const speechSequenceId = this.currentSpeechSequenceId;
		const utteranceDurationMs = this.getUtteranceDurationMs();
		this.partialRequestInFlight = true;
		this.lastPartialRequestAtMs = now;
		this.partialRequestCount += 1;
		this.debug('Sending partial hypothesis request.', {
			speechSequenceId,
			utteranceDurationMs,
			requestCount: this.partialRequestCount,
		});

		try {
			const result = await postWhisperCppInference({
				baseUrl: this.config.baseUrl,
				pcm16: snapshotPcm,
				sampleRate: this.sampleRate,
				language: this.config.language,
				timeoutMs: this.config.requestTimeoutMs,
			});
			if (!this.active || speechSequenceId <= this.finalizedSpeechSequenceId) {
				return;
			}

			const transcript = this.normalizeTranscript(result.text, 'partial');
			if (transcript.length === 0) {
				return;
			}

			this.publishTranscriptUpdate({
				text: transcript,
				phase: 'partial',
				speechSequenceId,
				utteranceDurationMs,
			});
		} catch (error) {
			this.debug('Partial hypothesis request failed.', {
				error: getErrorMessage(error, 'Unknown partial transcription error.'),
			});
		} finally {
			this.partialRequestInFlight = false;
			if (this.partialRequestQueued) {
				this.partialRequestQueued = false;
				void this.maybeRequestPartialTranscription();
			}
		}
	}

	private finalizeUtterance(reason: UtteranceReason): void {
		const utteranceDurationMs = this.getUtteranceDurationMs();
		const utterancePcm = concatInt16Chunks(this.utterancePcmChunks, this.utteranceSampleCount);
		const voicedMs = this.utteranceVoicedMs;
		const speechSequenceId = this.currentSpeechSequenceId;

		this.utterancePcmChunks = [];
		this.utteranceSampleCount = 0;
		this.utteranceVoicedMs = 0;
		this.speaking = false;
		this.speakingSilenceMs = 0;
		this.continueSpeechSequence = reason === 'max_duration';

		if (utteranceDurationMs < VAD_MIN_UTTERANCE_MS || voicedMs < VAD_MIN_VOICED_MS || utterancePcm.length === 0) {
			this.debug('Discarded short utterance.', {
				reason,
				utteranceDurationMs,
				voicedMs,
				speechSequenceId,
			});
			return;
		}

		this.utteranceCount += 1;
		this.transcriptionQueue.push({
			pcm16: utterancePcm,
			reason,
			speechSequenceId,
			utteranceDurationMs,
			voicedMs,
		});
		this.pendingQueueCount = this.transcriptionQueue.length;
		this.debug('Queued utterance for transcription.', {
			reason,
			utteranceDurationMs,
			voicedMs,
			speechSequenceId,
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
					samples: next.pcm16.length,
					sampleRate: this.sampleRate,
					reason: next.reason,
					speechSequenceId: next.speechSequenceId,
					utteranceDurationMs: next.utteranceDurationMs,
					queueLength: this.transcriptionQueue.length,
				});

				try {
					const result = await postWhisperCppInference({
						baseUrl: this.config.baseUrl,
						pcm16: next.pcm16,
						sampleRate: this.sampleRate,
						language: this.config.language,
						timeoutMs: this.config.requestTimeoutMs,
					});
					const transcript = this.normalizeTranscript(result.text, next.reason);
					if (transcript.length === 0) {
						this.debug('Transcript dropped after normalization.', {
							rawLength: result.text.trim().length,
							reason: next.reason,
							speechSequenceId: next.speechSequenceId,
						});
						continue;
					}

					if (!this.active) {
						this.debug('Transcript ignored because session is no longer active.');
						continue;
					}

					const phase: TranscriptPhase = next.reason === 'silence' ? 'final' : 'provisional';
					if (phase === 'final') {
						this.finalizedSpeechSequenceId = Math.max(this.finalizedSpeechSequenceId, next.speechSequenceId);
						this.lastCommittedTranscript = transcript;
					}

					this.publishTranscriptUpdate({
						text: transcript,
						phase,
						speechSequenceId: next.speechSequenceId,
						utteranceDurationMs: next.utteranceDurationMs,
					});
				} catch (error) {
					this.lastError = getErrorMessage(error, 'whisper.cpp transcription failed.');
					this.debug('Whisper.cpp transcription request failed.', {
						error: this.lastError,
						reason: next.reason,
						speechSequenceId: next.speechSequenceId,
					});
					this.handlers.onError(this.lastError);
				}
			}
		} finally {
			this.processingQueue = false;
		}
	}

	private normalizeTranscript(text: string, reason: TranscriptNormalizationReason): string {
		return normalizeTranscriptChunk(text, reason, this.lastCommittedTranscript);
	}

	private publishTranscriptUpdate(update: WhisperCppTranscriptUpdate): void {
		this.transcriptCount += 1;
		this.lastTranscriptPreview = update.text.slice(0, 120);
		this.debug('Transcript update emitted.', {
			phase: update.phase,
			speechSequenceId: update.speechSequenceId,
			transcriptLength: update.text.length,
		});
		this.handlers.onTranscript(update);
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
		this.partialRequestCount = 0;
		this.pendingQueueCount = 0;
		this.processingQueue = false;

		this.speaking = false;
		this.speakingSilenceMs = 0;
		this.utterancePcmChunks = [];
		this.utteranceSampleCount = 0;
		this.utteranceVoicedMs = 0;
		this.preRollChunks = [];
		this.preRollSampleCount = 0;
		this.transcriptionQueue = [];

		this.currentSpeechSequenceId = 0;
		this.continueSpeechSequence = false;
		this.finalizedSpeechSequenceId = 0;
		this.partialRequestInFlight = false;
		this.partialRequestQueued = false;
		this.lastPartialRequestAtMs = 0;

		this.lastError = null;
		this.lastTranscriptPreview = null;
		this.lastCommittedTranscript = '';
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

import { requestUrl } from 'obsidian';

export interface WhisperCppInferenceRequest {
	baseUrl: string;
	pcm16: Int16Array;
	sampleRate: number;
	language?: string;
	timeoutMs?: number;
}

export interface WhisperCppInferenceResponse {
	status: number;
	text: string;
	rawResponse: string;
}

const DEFAULT_TIMEOUT_MS = 45_000;
const MULTIPART_BOUNDARY_PREFIX = '----obsidian-whisper-local-';

export function normalizeBaseUrl(baseUrl: string): URL {
	const trimmed = baseUrl.trim();
	const withProtocol = /^[a-zA-Z][a-zA-Z0-9+\-.]*:\/\//.test(trimmed)
		? trimmed
		: `http://${trimmed}`;
	return new URL(withProtocol);
}

export function buildWhisperCppEndpoint(baseUrl: string, path: string): string {
	return new URL(path, normalizeBaseUrl(baseUrl)).toString();
}

export function buildWhisperCppHealthUrl(baseUrl: string): string {
	return buildWhisperCppEndpoint(baseUrl, '/health');
}

export function buildWhisperCppPropsUrl(baseUrl: string): string {
	return buildWhisperCppEndpoint(baseUrl, '/props');
}

export function buildWhisperCppInferenceUrl(baseUrl: string): string {
	return buildWhisperCppEndpoint(baseUrl, '/inference');
}

export function convertFloat32ToPcm16(input: Float32Array): Int16Array {
	const pcm = new Int16Array(input.length);
	for (let index = 0; index < input.length; index += 1) {
		const sample = Math.max(-1, Math.min(1, input[index] ?? 0));
		pcm[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
	}

	return pcm;
}

export function pcm16ToWavBytes(input: Int16Array, sampleRate: number): Uint8Array {
	const numChannels = 1;
	const bitsPerSample = 16;
	const blockAlign = numChannels * (bitsPerSample / 8);
	const byteRate = sampleRate * blockAlign;
	const dataSize = input.length * 2;
	const wavSize = 44 + dataSize;
	const wav = new Uint8Array(wavSize);
	const view = new DataView(wav.buffer);

	writeAscii(wav, 0, 'RIFF');
	view.setUint32(4, 36 + dataSize, true);
	writeAscii(wav, 8, 'WAVE');
	writeAscii(wav, 12, 'fmt ');
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, numChannels, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, byteRate, true);
	view.setUint16(32, blockAlign, true);
	view.setUint16(34, bitsPerSample, true);
	writeAscii(wav, 36, 'data');
	view.setUint32(40, dataSize, true);

	for (let index = 0; index < input.length; index += 1) {
		view.setInt16(44 + index * 2, input[index] ?? 0, true);
	}

	return wav;
}

export async function postWhisperCppInference(request: WhisperCppInferenceRequest): Promise<WhisperCppInferenceResponse> {
	if (request.pcm16.length === 0) {
		return {
			status: 200,
			text: '',
			rawResponse: '',
		};
	}

	const wavBytes = pcm16ToWavBytes(request.pcm16, request.sampleRate);
	const fields: Record<string, string> = {
		response_format: 'json',
		temperature: '0.0',
		no_timestamps: 'true',
	};
	const language = request.language?.trim();
	if (language) {
		fields.language = language;
	}

	const multipart = buildMultipartBody(fields, {
		fieldName: 'file',
		filename: 'audio.wav',
		contentType: 'audio/wav',
		data: wavBytes,
	});

	const timeoutMs = coerceTimeoutMs(request.timeoutMs);
	const response = await requestWithTimeout({
		url: buildWhisperCppInferenceUrl(request.baseUrl),
		method: 'POST',
		headers: {
			'Content-Type': multipart.contentType,
		},
		body: multipart.body.buffer,
	}, timeoutMs);

	if (!response.ok) {
		const snippet = response.text.slice(0, 300);
		throw new Error(`whisper.cpp /inference returned ${response.status}: ${snippet}`);
	}

	return {
		status: response.status,
		rawResponse: response.text,
		text: extractTranscriptText(response.text),
	};
}

function coerceTimeoutMs(timeoutMs: number | undefined): number {
	if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		return DEFAULT_TIMEOUT_MS;
	}

	return Math.round(timeoutMs);
}

function extractTranscriptText(rawResponse: string): string {
	const trimmed = rawResponse.trim();
	if (trimmed.length === 0) {
		return '';
	}

	const parsed = parseJson<unknown>(trimmed);
	if (typeof parsed === 'string') {
		return parsed.trim();
	}

	if (parsed && typeof parsed === 'object') {
		const record = parsed as Record<string, unknown>;
		for (const key of ['text', 'transcript', 'result']) {
			const value = record[key];
			if (typeof value === 'string') {
				return value.trim();
			}
		}
	}

	return trimmed;
}

function buildMultipartBody(
	fields: Record<string, string>,
	file: {
		fieldName: string;
		filename: string;
		contentType: string;
		data: Uint8Array;
	},
): {
	contentType: string;
	body: Uint8Array;
} {
	const boundary = `${MULTIPART_BOUNDARY_PREFIX}${Math.random().toString(16).slice(2)}`;
	const encoder = new TextEncoder();
	const chunks: Uint8Array[] = [];

	for (const [key, value] of Object.entries(fields)) {
		chunks.push(encoder.encode(
			`--${boundary}\r\nContent-Disposition: form-data; name="${escapeQuoted(key)}"\r\n\r\n${value}\r\n`,
		));
	}

	chunks.push(encoder.encode(
		`--${boundary}\r\nContent-Disposition: form-data; name="${escapeQuoted(file.fieldName)}"; filename="${escapeQuoted(file.filename)}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
	));
	chunks.push(file.data);
	chunks.push(encoder.encode('\r\n'));
	chunks.push(encoder.encode(`--${boundary}--\r\n`));

	const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
	const body = new Uint8Array(totalLength);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.length;
	}

	return {
		contentType: `multipart/form-data; boundary=${boundary}`,
		body,
	};
}

function writeAscii(output: Uint8Array, offset: number, text: string): void {
	for (let index = 0; index < text.length; index += 1) {
		output[offset + index] = text.charCodeAt(index);
	}
}

function escapeQuoted(value: string): string {
	return value.split('"').join('\\"');
}

async function requestWithTimeout(
	request: {
		url: string;
		method: string;
		headers?: Record<string, string>;
		body?: string | ArrayBuffer;
	},
	timeoutMs: number,
): Promise<{ status: number; ok: boolean; text: string }> {
	let timeoutId: number | null = null;
	try {
		const timeoutPromise = new Promise<never>((_, reject) => {
			timeoutId = window.setTimeout(() => {
				reject(new Error(`Request timed out after ${timeoutMs}ms.`));
			}, timeoutMs);
		});

		const response = await Promise.race([
			requestUrl(request),
			timeoutPromise,
		]);

		return {
			status: response.status,
			ok: response.status >= 200 && response.status < 300,
			text: response.text,
		};
	} finally {
		if (timeoutId !== null) {
			window.clearTimeout(timeoutId);
		}
	}
}

function parseJson<T>(value: string): T | null {
	try {
		return JSON.parse(value) as T;
	} catch {
		return null;
	}
}

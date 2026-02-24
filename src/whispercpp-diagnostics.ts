import { requestUrl } from 'obsidian';
import {
	buildWhisperCppHealthUrl,
	buildWhisperCppPropsUrl,
	postWhisperCppInference,
} from './whispercpp-http';

export type WhisperCppDiagnosticStatus = 'pass' | 'warn' | 'fail';

export interface WhisperCppDiagnosticsInput {
	baseUrl: string;
	language?: string;
	timeoutMs?: number;
}

export interface WhisperCppDiagnosticCheck {
	id: string;
	label: string;
	status: WhisperCppDiagnosticStatus;
	message: string;
	durationMs: number;
	details?: unknown;
}

export interface WhisperCppDiagnosticsReport {
	timestamp: string;
	baseUrl: string;
	checks: WhisperCppDiagnosticCheck[];
	summary: {
		passed: number;
		warned: number;
		failed: number;
	};
}

interface WhisperCppCheckOutcome {
	status: WhisperCppDiagnosticStatus;
	message: string;
	details?: unknown;
}

const DEFAULT_TIMEOUT_MS = 7_500;

export function isValidLanguageHint(value: string): boolean {
	if (value.length === 0) {
		return true;
	}

	return /^[a-z]{2,3}(-[A-Z]{2})?$/.test(value);
}

export async function runWhisperCppDiagnostics(input: WhisperCppDiagnosticsInput): Promise<WhisperCppDiagnosticsReport> {
	const timeoutMs = typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs)
		? Math.max(500, Math.round(input.timeoutMs))
		: DEFAULT_TIMEOUT_MS;
	const normalizedLanguage = input.language?.trim() ?? '';
	const checks: WhisperCppDiagnosticCheck[] = [];

	checks.push(await runCheck('language-hint', 'Language hint format', async () => {
		if (isValidLanguageHint(normalizedLanguage)) {
			return {
				status: 'pass',
				message: normalizedLanguage
					? `Language hint looks valid (${normalizedLanguage}).`
					: 'No language hint set. whisper.cpp will auto-detect language.',
			};
		}

		return {
			status: 'warn',
			message: 'Language hint format is unusual. Use values like `en` or `en-US`.',
			details: {
				language: normalizedLanguage,
			},
		};
	}));

	checks.push(await runCheck('health', 'Health endpoint', async () => {
		const response = await requestWithTimeout({
			url: buildWhisperCppHealthUrl(input.baseUrl),
			method: 'GET',
		}, timeoutMs);

		if (!response.ok) {
			return {
				status: 'fail',
				message: `Health endpoint returned ${response.status}.`,
				details: response.text,
			};
		}

		return {
			status: 'pass',
			message: 'Health endpoint is reachable.',
			details: response.text.trim() || null,
		};
	}));

	checks.push(await runCheck('props', 'Server props endpoint', async () => {
		const response = await requestWithTimeout({
			url: buildWhisperCppPropsUrl(input.baseUrl),
			method: 'GET',
		}, timeoutMs);

		if (!response.ok) {
			return {
				status: 'warn',
				message: `Props endpoint returned ${response.status}.`,
				details: response.text,
			};
		}

		return {
			status: 'pass',
			message: 'Props endpoint is reachable.',
			details: parseJson<unknown>(response.text) ?? response.text,
		};
	}));

	checks.push(await runCheck('inference', 'Inference dry run', async () => {
		const silence = new Int16Array(16_000 / 3);
		const result = await postWhisperCppInference({
			baseUrl: input.baseUrl,
			pcm16: silence,
			sampleRate: 16_000,
			language: normalizedLanguage || undefined,
			timeoutMs,
		});

		const preview = result.text.trim();
		if (preview.length === 0) {
			return {
				status: 'pass',
				message: 'Inference endpoint responded successfully.',
				details: {
					transcript: null,
				},
			};
		}

		return {
			status: 'pass',
			message: 'Inference endpoint responded successfully.',
			details: {
				transcriptPreview: preview.slice(0, 120),
			},
		};
	}));

	checks.push(await runCheck('client-capabilities', 'Client capabilities', async () => {
		const missing: string[] = [];
		if (typeof navigator.mediaDevices?.getUserMedia !== 'function') {
			missing.push('navigator.mediaDevices.getUserMedia');
		}
		if (typeof AudioWorkletNode === 'undefined') {
			missing.push('AudioWorkletNode');
		}

		if (missing.length > 0) {
			return {
				status: 'fail',
				message: `Browser runtime is missing required APIs: ${missing.join(', ')}.`,
			};
		}

		let microphonePermission: string | null = null;
		try {
			if (typeof navigator.permissions?.query === 'function') {
				const result = await navigator.permissions.query({ name: 'microphone' as PermissionName });
				microphonePermission = result.state;
			}
		} catch {
			microphonePermission = null;
		}

		return {
			status: 'pass',
			message: 'Runtime APIs required for live dictation are available.',
			details: {
				microphonePermission,
			},
		};
	}));

	return {
		timestamp: new Date().toISOString(),
		baseUrl: input.baseUrl.trim(),
		checks,
		summary: summarizeChecks(checks),
	};
}

async function runCheck(
	id: string,
	label: string,
	callback: () => Promise<WhisperCppCheckOutcome>,
): Promise<WhisperCppDiagnosticCheck> {
	const start = Date.now();
	try {
		const outcome = await callback();
		return {
			id,
			label,
			status: outcome.status,
			message: outcome.message,
			durationMs: Date.now() - start,
			details: outcome.details,
		};
	} catch (error) {
		return {
			id,
			label,
			status: 'fail',
			message: getErrorMessage(error, 'Unexpected diagnostics error.'),
			durationMs: Date.now() - start,
		};
	}
}

function summarizeChecks(checks: WhisperCppDiagnosticCheck[]): WhisperCppDiagnosticsReport['summary'] {
	let passed = 0;
	let warned = 0;
	let failed = 0;

	for (const check of checks) {
		if (check.status === 'pass') {
			passed += 1;
		} else if (check.status === 'warn') {
			warned += 1;
		} else {
			failed += 1;
		}
	}

	return { passed, warned, failed };
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

		let response: Awaited<ReturnType<typeof requestUrl>>;
		try {
			response = await Promise.race([
				requestUrl(request),
				timeoutPromise,
			]);
		} catch (error) {
			const normalized = normalizeRequestUrlError(error);
			if (!normalized) {
				throw error;
			}

			return normalized;
		}

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

function normalizeRequestUrlError(error: unknown): { status: number; ok: boolean; text: string } | null {
	if (!error || typeof error !== 'object') {
		return null;
	}

	const candidate = error as {
		status?: unknown;
		message?: unknown;
		response?: {
			text?: unknown;
		};
	};

	if (typeof candidate.status !== 'number' || !Number.isFinite(candidate.status)) {
		return null;
	}

	const responseText = candidate.response && typeof candidate.response.text === 'string'
		? candidate.response.text
		: (typeof candidate.message === 'string' ? candidate.message : '');

	return {
		status: candidate.status,
		ok: candidate.status >= 200 && candidate.status < 300,
		text: responseText,
	};
}

function parseJson<T>(value: string): T | null {
	try {
		return JSON.parse(value) as T;
	} catch {
		return null;
	}
}

function getErrorMessage(error: unknown, fallback: string): string {
	if (error instanceof Error && error.message.trim().length > 0) {
		return error.message;
	}

	return fallback;
}

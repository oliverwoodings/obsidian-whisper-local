export interface WhisperLocalPluginSettings {
	baseUrl: string;
	language: string;
	requestTimeoutMs: number;
	partialRequestIntervalMs: number;
	partialMinVoicedMs: number;
	stabilizationAgreementWindow: number;
	mutableTailOpacity: number;
	enableDebugLogging: boolean;
}

const MIN_REQUEST_TIMEOUT_MS = 5_000;
const MAX_REQUEST_TIMEOUT_MS = 120_000;
const MIN_PARTIAL_REQUEST_INTERVAL_MS = 200;
const MAX_PARTIAL_REQUEST_INTERVAL_MS = 2_000;
const MIN_PARTIAL_MIN_VOICED_MS = 120;
const MAX_PARTIAL_MIN_VOICED_MS = 1_500;
const MIN_STABILIZATION_AGREEMENT_WINDOW = 2;
const MAX_STABILIZATION_AGREEMENT_WINDOW = 4;
const MIN_MUTABLE_TAIL_OPACITY = 0.15;
const MAX_MUTABLE_TAIL_OPACITY = 1;

export const DEFAULT_SETTINGS: WhisperLocalPluginSettings = {
	baseUrl: 'http://127.0.0.1:8080',
	language: 'en',
	requestTimeoutMs: 45_000,
	partialRequestIntervalMs: 450,
	partialMinVoicedMs: 320,
	stabilizationAgreementWindow: 2,
	mutableTailOpacity: 0.8,
	enableDebugLogging: false,
};

export function normalizeSettings(loaded: unknown): WhisperLocalPluginSettings {
	if (!loaded || typeof loaded !== 'object') {
		return { ...DEFAULT_SETTINGS };
	}

	const candidate = loaded as Partial<WhisperLocalPluginSettings>;
	return {
		baseUrl: typeof candidate.baseUrl === 'string' && candidate.baseUrl.trim().length > 0
			? candidate.baseUrl.trim()
			: DEFAULT_SETTINGS.baseUrl,
		language: typeof candidate.language === 'string'
			? candidate.language.trim()
			: DEFAULT_SETTINGS.language,
		requestTimeoutMs: coerceRequestTimeout(candidate.requestTimeoutMs),
		partialRequestIntervalMs: coerceRoundedNumber(
			candidate.partialRequestIntervalMs,
			DEFAULT_SETTINGS.partialRequestIntervalMs,
			MIN_PARTIAL_REQUEST_INTERVAL_MS,
			MAX_PARTIAL_REQUEST_INTERVAL_MS,
		),
		partialMinVoicedMs: coerceRoundedNumber(
			candidate.partialMinVoicedMs,
			DEFAULT_SETTINGS.partialMinVoicedMs,
			MIN_PARTIAL_MIN_VOICED_MS,
			MAX_PARTIAL_MIN_VOICED_MS,
		),
		stabilizationAgreementWindow: coerceRoundedNumber(
			candidate.stabilizationAgreementWindow,
			DEFAULT_SETTINGS.stabilizationAgreementWindow,
			MIN_STABILIZATION_AGREEMENT_WINDOW,
			MAX_STABILIZATION_AGREEMENT_WINDOW,
		),
		mutableTailOpacity: coerceNumber(
			candidate.mutableTailOpacity,
			DEFAULT_SETTINGS.mutableTailOpacity,
			MIN_MUTABLE_TAIL_OPACITY,
			MAX_MUTABLE_TAIL_OPACITY,
		),
		enableDebugLogging: candidate.enableDebugLogging !== false,
	};
}

function coerceRequestTimeout(value: unknown): number {
	return coerceRoundedNumber(value, DEFAULT_SETTINGS.requestTimeoutMs, MIN_REQUEST_TIMEOUT_MS, MAX_REQUEST_TIMEOUT_MS);
}

function coerceRoundedNumber(
	value: unknown,
	fallback: number,
	minimum: number,
	maximum: number,
): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return fallback;
	}

	const rounded = Math.round(value);
	if (rounded < minimum) {
		return minimum;
	}
	if (rounded > maximum) {
		return maximum;
	}

	return rounded;
}

function coerceNumber(
	value: unknown,
	fallback: number,
	minimum: number,
	maximum: number,
): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return fallback;
	}

	if (value < minimum) {
		return minimum;
	}
	if (value > maximum) {
		return maximum;
	}

	return value;
}

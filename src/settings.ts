export interface WhisperLocalPluginSettings {
	baseUrl: string;
	language: string;
	requestTimeoutMs: number;
	enableDebugLogging: boolean;
}

const MIN_REQUEST_TIMEOUT_MS = 5_000;
const MAX_REQUEST_TIMEOUT_MS = 120_000;

export const DEFAULT_SETTINGS: WhisperLocalPluginSettings = {
	baseUrl: 'http://127.0.0.1:8080',
	language: 'en',
	requestTimeoutMs: 45_000,
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
		enableDebugLogging: candidate.enableDebugLogging !== false,
	};
}

function coerceRequestTimeout(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return DEFAULT_SETTINGS.requestTimeoutMs;
	}

	const rounded = Math.round(value);
	if (rounded < MIN_REQUEST_TIMEOUT_MS) {
		return MIN_REQUEST_TIMEOUT_MS;
	}
	if (rounded > MAX_REQUEST_TIMEOUT_MS) {
		return MAX_REQUEST_TIMEOUT_MS;
	}

	return rounded;
}

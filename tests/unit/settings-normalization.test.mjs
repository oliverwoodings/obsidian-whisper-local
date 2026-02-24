import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from '../helpers/load-ts.mjs';

const { DEFAULT_SETTINGS, normalizeSettings } = loadTs('../../src/settings.ts');

test('normalizeSettings returns defaults for empty input', () => {
	assert.deepEqual(normalizeSettings(null), DEFAULT_SETTINGS);
	assert.deepEqual(normalizeSettings(undefined), DEFAULT_SETTINGS);
});

test('normalizeSettings trims valid string values and keeps numeric timeout', () => {
	const result = normalizeSettings({
		baseUrl: '  http://localhost:8080  ',
		language: '  en  ',
		requestTimeoutMs: 30000,
		partialRequestIntervalMs: 600,
		partialMinVoicedMs: 400,
		stabilizationAgreementWindow: 3,
		mutableTailOpacity: 0.45,
		enableDebugLogging: 1,
	});

	assert.equal(result.baseUrl, 'http://localhost:8080');
	assert.equal(result.language, 'en');
	assert.equal(result.requestTimeoutMs, 30000);
	assert.equal(result.partialRequestIntervalMs, 600);
	assert.equal(result.partialMinVoicedMs, 400);
	assert.equal(result.stabilizationAgreementWindow, 3);
	assert.equal(result.mutableTailOpacity, 0.45);
	assert.equal(result.enableDebugLogging, true);
});

test('normalizeSettings falls back for invalid values', () => {
	const result = normalizeSettings({
		baseUrl: '   ',
		language: 42,
		requestTimeoutMs: -10,
		partialRequestIntervalMs: 50,
		partialMinVoicedMs: 5000,
		stabilizationAgreementWindow: 99,
		mutableTailOpacity: -1,
		enableDebugLogging: false,
	});

	assert.equal(result.baseUrl, DEFAULT_SETTINGS.baseUrl);
	assert.equal(result.language, DEFAULT_SETTINGS.language);
	assert.equal(result.requestTimeoutMs, 5000);
	assert.equal(result.partialRequestIntervalMs, 200);
	assert.equal(result.partialMinVoicedMs, 1500);
	assert.equal(result.stabilizationAgreementWindow, 4);
	assert.equal(result.mutableTailOpacity, 0.15);
	assert.equal(result.enableDebugLogging, false);
});

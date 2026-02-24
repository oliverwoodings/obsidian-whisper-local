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
		enableDebugLogging: 1,
	});

	assert.equal(result.baseUrl, 'http://localhost:8080');
	assert.equal(result.language, 'en');
	assert.equal(result.requestTimeoutMs, 30000);
	assert.equal(result.enableDebugLogging, true);
});

test('normalizeSettings falls back for invalid values', () => {
	const result = normalizeSettings({
		baseUrl: '   ',
		language: 42,
		requestTimeoutMs: -10,
		enableDebugLogging: false,
	});

	assert.equal(result.baseUrl, DEFAULT_SETTINGS.baseUrl);
	assert.equal(result.language, DEFAULT_SETTINGS.language);
	assert.equal(result.requestTimeoutMs, 5000);
	assert.equal(result.enableDebugLogging, false);
});

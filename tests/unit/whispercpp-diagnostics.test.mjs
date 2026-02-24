import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from '../helpers/load-ts.mjs';

const { isValidLanguageHint } = loadTs('../../src/whispercpp-diagnostics.ts');

test('isValidLanguageHint accepts empty, language, and language-region patterns', () => {
	assert.equal(isValidLanguageHint(''), true);
	assert.equal(isValidLanguageHint('en'), true);
	assert.equal(isValidLanguageHint('eng'), true);
	assert.equal(isValidLanguageHint('en-US'), true);
});

test('isValidLanguageHint rejects malformed values', () => {
	assert.equal(isValidLanguageHint('EN'), false);
	assert.equal(isValidLanguageHint('english'), false);
	assert.equal(isValidLanguageHint('en-us'), false);
	assert.equal(isValidLanguageHint('e'), false);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from '../helpers/load-ts.mjs';

const {
	normalizeTranscriptChunk,
	splitStableMutableTranscript,
	takeWordsRange,
} = loadTs('../../src/transcript-normalization.ts');

test('normalizeTranscriptChunk removes non-speech markers and special tokens', () => {
	assert.equal(
		normalizeTranscriptChunk('[BLANK_AUDIO] <|nospeech|> [MUSIC]', 'silence', ''),
		'',
	);
	assert.equal(
		normalizeTranscriptChunk('hello [MUSIC] there', 'silence', ''),
		'hello there',
	);
});

test('normalizeTranscriptChunk keeps repeated words spoken intentionally', () => {
	assert.equal(
		normalizeTranscriptChunk('this this is is a test test', 'silence', ''),
		'this this is is a test test',
	);
});

test('normalizeTranscriptChunk trims leading overlap with previous committed transcript', () => {
	assert.equal(
		normalizeTranscriptChunk('we continue from here', 'silence', 'and then we continue'),
		'from here',
	);
	assert.equal(
		normalizeTranscriptChunk('continue from here', 'silence', 'we continue'),
		'continue from here',
	);
});

test('normalizeTranscriptChunk softens sentence punctuation for max-duration chunks only', () => {
	assert.equal(
		normalizeTranscriptChunk('this likely continues.', 'max_duration', ''),
		'this likely continues,',
	);
	assert.equal(
		normalizeTranscriptChunk('this is complete.', 'silence', ''),
		'this is complete.',
	);
	assert.equal(
		normalizeTranscriptChunk('thinking out loud.', 'partial', ''),
		'thinking out loud.',
	);
});

test('splitStableMutableTranscript grows stable prefix from local agreement', () => {
	const first = splitStableMutableTranscript(['hello there'], 0, 2);
	assert.equal(first.stableWordCount, 0);
	assert.equal(first.stableText, '');
	assert.equal(first.mutableText, 'hello there');

	const second = splitStableMutableTranscript(['hello there', 'hello there friend'], 0, 2);
	assert.equal(second.stableWordCount, 2);
	assert.equal(second.stableText, 'hello there');
	assert.equal(second.mutableText, 'friend');
});

test('takeWordsRange returns requested word spans', () => {
	assert.equal(takeWordsRange('alpha beta gamma', 0, 1), 'alpha');
	assert.equal(takeWordsRange('alpha beta gamma', 1, 3), 'beta gamma');
	assert.equal(takeWordsRange('alpha beta gamma', 2), 'gamma');
	assert.equal(takeWordsRange('alpha beta gamma', 3), '');
});

export type TranscriptNormalizationReason = 'silence' | 'max_duration' | 'partial';

const NON_SPEECH_TOKEN_PATTERN = /\[(?:BLANK[_\s-]*AUDIO|MUSIC|NOISE|SILENCE|LAUGHTER|APPLAUSE)\]/gi;
const SPECIAL_TOKEN_PATTERN = /<\|[^|>]+\|>/g;
const WORD_PATTERN = /[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g;
const MAX_STITCH_OVERLAP_WORDS = 6;

export interface StableTranscriptSplit {
	stableText: string;
	mutableText: string;
	stableWordCount: number;
}

export function normalizeTranscriptChunk(
	rawTranscript: string,
	reason: TranscriptNormalizationReason,
	previousTranscript: string,
): string {
	let text = rawTranscript
		.replace(SPECIAL_TOKEN_PATTERN, ' ')
		.replace(NON_SPEECH_TOKEN_PATTERN, ' ')
		.replace(/\s+/g, ' ')
		.trim();

	if (text.length === 0) {
		return '';
	}

	text = trimLeadingWordOverlap(previousTranscript, text);
	text = text.replace(/\s+/g, ' ').trim();
	if (text.length === 0) {
		return '';
	}

	if (reason === 'max_duration') {
		text = softenTerminalPunctuation(text);
	}

	return text;
}

export function splitStableMutableTranscript(
	hypotheses: string[],
	previousStableWordCount: number,
	agreementWindow = 2,
): StableTranscriptSplit {
	if (hypotheses.length === 0) {
		return {
			stableText: '',
			mutableText: '',
			stableWordCount: 0,
		};
	}

	const latest = hypotheses[hypotheses.length - 1]?.trim() ?? '';
	if (latest.length === 0) {
		return {
			stableText: '',
			mutableText: '',
			stableWordCount: 0,
		};
	}

	const latestWords = getWordsWithOffsets(latest);
	const latestWordCount = latestWords.length;
	if (latestWordCount === 0) {
		return {
			stableText: latest,
			mutableText: '',
			stableWordCount: 0,
		};
	}

	const windowSize = Math.max(1, Math.min(agreementWindow, hypotheses.length));
	const windowStart = hypotheses.length - windowSize;
	const candidates = hypotheses
		.slice(windowStart)
		.map((text) => getWords(text));

	let agreedPrefixCount = 0;
	if (candidates.length >= 2) {
		agreedPrefixCount = candidates[0]?.length ?? 0;
		for (let index = 1; index < candidates.length; index += 1) {
			agreedPrefixCount = sharedPrefixWordCount(candidates[index - 1] ?? [], candidates[index] ?? []);
			if (agreedPrefixCount === 0) {
				break;
			}
		}
	}

	const clampedPreviousStable = Math.max(0, Math.min(previousStableWordCount, latestWordCount));
	const stableWordCount = Math.max(clampedPreviousStable, Math.min(agreedPrefixCount, latestWordCount));
	const stableText = textUntilWord(latest, latestWords, stableWordCount).trim();
	const mutableText = textFromWord(latest, latestWords, stableWordCount).trim();

	return {
		stableText,
		mutableText,
		stableWordCount,
	};
}

export function takeWordsRange(text: string, fromWord: number, toWord?: number): string {
	const trimmed = text.trim();
	if (trimmed.length === 0) {
		return '';
	}

	const words = getWordsWithOffsets(trimmed);
	if (words.length === 0) {
		return fromWord <= 0 ? trimmed : '';
	}

	const start = Math.max(0, Math.min(fromWord, words.length));
	const end = typeof toWord === 'number'
		? Math.max(start, Math.min(toWord, words.length))
		: words.length;
	if (start >= end) {
		return '';
	}

	const startOffset = words[start]?.start ?? 0;
	const endOffset = words[end - 1]?.end ?? trimmed.length;
	return trimmed.slice(startOffset, endOffset).trim();
}

function softenTerminalPunctuation(text: string): string {
	if (!/[.!?]+$/.test(text)) {
		return text;
	}

	return text.replace(/[.!?]+$/, ',');
}

function trimLeadingWordOverlap(previousText: string, currentText: string): string {
	const previousWords = getWords(previousText);
	const currentWords = getWordsWithOffsets(currentText);
	if (previousWords.length === 0 || currentWords.length === 0) {
		return currentText;
	}

	const maxOverlap = Math.min(MAX_STITCH_OVERLAP_WORDS, previousWords.length, currentWords.length);
	for (let candidate = maxOverlap; candidate >= 2; candidate -= 1) {
		if (!tailEqualsHead(previousWords, currentWords, candidate)) {
			continue;
		}

		const nextWordOffset = currentWords[candidate]?.start ?? 0;
		return currentText.slice(nextWordOffset).trimStart();
	}

	return currentText;
}

function tailEqualsHead(
	previousWords: string[],
	currentWords: Array<{ normalized: string; start: number; end: number }>,
	count: number,
): boolean {
	const previousStart = previousWords.length - count;
	for (let index = 0; index < count; index += 1) {
		const previousWord = previousWords[previousStart + index];
		const currentWord = currentWords[index]?.normalized;
		if (!previousWord || !currentWord || previousWord !== currentWord) {
			return false;
		}
	}

	return true;
}

function getWords(text: string): string[] {
	const matches = text.match(WORD_PATTERN);
	if (!matches) {
		return [];
	}

	return matches.map((word) => normalizeToken(word)).filter((word) => word.length > 0);
}

function getWordsWithOffsets(text: string): Array<{ normalized: string; start: number; end: number }> {
	const matches = Array.from(text.matchAll(WORD_PATTERN));
	const words: Array<{ normalized: string; start: number; end: number }> = [];
	for (const match of matches) {
		const value = match[0];
		const start = match.index;
		if (!value || typeof start !== 'number') {
			continue;
		}

		const normalized = normalizeToken(value);
		if (normalized.length === 0) {
			continue;
		}

		words.push({
			normalized,
			start,
			end: start + value.length,
		});
	}

	return words;
}

function textUntilWord(
	text: string,
	words: Array<{ normalized: string; start: number; end: number }>,
	wordCount: number,
): string {
	if (wordCount <= 0) {
		return '';
	}

	if (wordCount >= words.length) {
		return text;
	}

	const endOffset = words[wordCount - 1]?.end ?? text.length;
	return text.slice(0, endOffset);
}

function textFromWord(
	text: string,
	words: Array<{ normalized: string; start: number; end: number }>,
	wordIndex: number,
): string {
	if (wordIndex <= 0) {
		return text;
	}

	if (wordIndex >= words.length) {
		return '';
	}

	const startOffset = words[wordIndex]?.start ?? text.length;
	return text.slice(startOffset);
}

function sharedPrefixWordCount(left: string[], right: string[]): number {
	const maxCount = Math.min(left.length, right.length);
	let count = 0;
	for (let index = 0; index < maxCount; index += 1) {
		if (left[index] !== right[index]) {
			break;
		}
		count += 1;
	}

	return count;
}

function normalizeToken(token: string): string {
	return token.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
}

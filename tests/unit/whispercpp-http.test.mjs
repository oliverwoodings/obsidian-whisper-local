import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from '../helpers/load-ts.mjs';

const {
	buildWhisperCppInferenceUrl,
	buildWhisperCppHealthUrl,
	buildWhisperCppPropsUrl,
	convertFloat32ToPcm16,
	pcm16ToWavBytes,
} = loadTs('../../src/whispercpp-http.ts');

test('whisper.cpp endpoint builders normalize base URL and paths', () => {
	assert.equal(buildWhisperCppInferenceUrl('127.0.0.1:8080'), 'http://127.0.0.1:8080/inference');
	assert.equal(buildWhisperCppHealthUrl('http://localhost:8080/'), 'http://localhost:8080/health');
	assert.equal(buildWhisperCppPropsUrl('https://example.local'), 'https://example.local/props');
});

test('convertFloat32ToPcm16 clamps and converts samples', () => {
	const converted = convertFloat32ToPcm16(new Float32Array([-2, -1, 0, 0.5, 1, 2]));
	assert.deepEqual([...converted], [-32768, -32768, 0, 16383, 32767, 32767]);
});

test('pcm16ToWavBytes writes a valid mono 16-bit WAV header', () => {
	const pcm = new Int16Array([0, 1200, -1200]);
	const wav = pcm16ToWavBytes(pcm, 16_000);
	const view = new DataView(wav.buffer);
	const riff = String.fromCharCode(...wav.slice(0, 4));
	const wave = String.fromCharCode(...wav.slice(8, 12));
	const fmt = String.fromCharCode(...wav.slice(12, 16));
	const data = String.fromCharCode(...wav.slice(36, 40));

	assert.equal(riff, 'RIFF');
	assert.equal(wave, 'WAVE');
	assert.equal(fmt, 'fmt ');
	assert.equal(data, 'data');
	assert.equal(view.getUint16(22, true), 1);
	assert.equal(view.getUint32(24, true), 16_000);
	assert.equal(view.getUint16(34, true), 16);
	assert.equal(view.getUint32(40, true), pcm.length * 2);
});

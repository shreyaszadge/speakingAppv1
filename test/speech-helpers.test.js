'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// public/speech-helpers.js is a browser ES module; load it here by stripping the "export" keywords.
const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'speech-helpers.js'), 'utf8').replace(/^export\s+/gm, '');
const { splitSentences, estimateWordTimings, pickVoice } = new Function(src + '\nreturn { splitSentences, estimateWordTimings, pickVoice };')();

test('splitSentences: sentence chunks, short ones merged, capped at 5', () => {
  assert.deepEqual(splitSentences("Hi there! It's lovely to meet you. How is your day going?"),
    ["Hi there! It's lovely to meet you.", 'How is your day going?']);
  assert.deepEqual(splitSentences('Ok.'), ['Ok.']);
  assert.deepEqual(splitSentences('no punctuation at all here'), ['no punctuation at all here']);
  const many = Array.from({ length: 9 }, (_, i) => `This is sentence number ${i}.`).join(' ');
  const chunks = splitSentences(many);
  assert.equal(chunks.length, 5);
  assert.ok(chunks[4].includes('number 8'), 'nothing may be dropped');
});

test('estimateWordTimings: in order, inside the total, longer words get longer, punctuation adds a pause', () => {
  const t = estimateWordTimings('I love extraordinary weather, really.', 3000);
  assert.deepEqual(t.words, ['I', 'love', 'extraordinary', 'weather,', 'really.']);
  assert.equal(t.wtimes[0], 0);
  assert.ok(t.wtimes.every((x, i) => i === 0 || x > t.wtimes[i - 1]));
  assert.ok(t.wdurations[2] > t.wdurations[0] * 3, 'long word is longer than a one-letter word');
  const gap = t.wtimes[4] - (t.wtimes[3] + t.wdurations[3]);
  assert.ok(gap > 100, 'comma leaves a silent pause');
  const last = t.wtimes[4] + t.wdurations[4];
  assert.ok(last <= 3000 + 5, 'last word ends within the estimated total');
});

test('estimateWordTimings: handles odd input', () => {
  assert.deepEqual(estimateWordTimings('', 1000).words, []);
  const t = estimateWordTimings('... !!!', 1000);
  assert.equal(t.words.length, 2);
  assert.ok(t.wdurations.every(d => d >= 40));
});

test('pickVoice: preferred name, language match, Natural/Google first, default fallback', () => {
  const voices = [
    { name: 'Plain', lang: 'en-US' }, { name: 'Microsoft Aria Online (Natural)', lang: 'en-US' },
    { name: 'Google US English', lang: 'en_US' }, { name: 'Hindi', lang: 'hi-IN' }, { name: 'British', lang: 'en-GB' }
  ];
  assert.equal(pickVoice(voices, 'en-US', '').name, 'Microsoft Aria Online (Natural)');
  assert.equal(pickVoice(voices, 'en-US', 'google').name, 'Google US English');
  assert.equal(pickVoice(voices, 'en-US', 'does-not-exist').name, 'Microsoft Aria Online (Natural)');
  assert.equal(pickVoice(voices, 'hi-IN', '').name, 'Hindi');
  assert.equal(pickVoice(voices, 'en-IN', '').name, 'Microsoft Aria Online (Natural)', 'falls back to same language family');
  assert.equal(pickVoice(voices, 'fr-FR', ''), null, 'no match -> browser default');
  assert.equal(pickVoice([], 'en-US', ''), null);
});

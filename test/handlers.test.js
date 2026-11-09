'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHandlers, buildContents, buildSsml, mockSpeech } = require('../lib/handlers');

const baseConfig = { mock: false, geminiApiKey: 'k', geminiModel: 'gemini-flash-latest', ttsApiKey: 't', ttsLanguageCode: 'en-US', ttsVoice: 'en-US-Neural2-F' };

test('chat: rejects empty / bad input', async () => {
  const h = createHandlers({ config: { ...baseConfig, mock: true } });
  assert.equal((await h.chat({})).status, 400);
  assert.equal((await h.chat({ message: '   ' })).status, 400);
  assert.equal((await h.chat({ message: 'x'.repeat(2001) })).status, 400);
  assert.equal((await h.chat({ message: 'hi', history: 'nope' })).status, 400);
});

test('chat: mock mode answers without any keys', async () => {
  const h = createHandlers({ config: { mock: true } });
  const out = await h.chat({ message: 'hello' });
  assert.equal(out.status, 200);
  assert.match(out.body.reply, /lovely to meet you/);
});

test('chat: missing key gives a clear 500', async () => {
  const h = createHandlers({ config: { ...baseConfig, geminiApiKey: '' } });
  const out = await h.chat({ message: 'hi' });
  assert.equal(out.status, 500);
  assert.match(out.body.error, /GEMINI_API_KEY/);
});

test('chat: sends model, system prompt and normalised history to Gemini', async () => {
  let seen;
  const fake = { models: { generateContent: async args => { seen = args; return { text: ' Hi friend! ' }; } } };
  const h = createHandlers({ config: baseConfig, geminiClient: fake });
  const out = await h.chat({ message: 'what next?', history: [
    { role: 'assistant', text: 'orphan model turn' },   // must be dropped (can't start with model)
    { role: 'user', text: 'hello' },
    { role: 'assistant', text: 'hi!' },
    { role: 'hacker', text: 'ignored' }
  ] });
  assert.equal(out.status, 200);
  assert.equal(out.body.reply, 'Hi friend!');
  assert.equal(seen.model, 'gemini-flash-latest');
  assert.ok(seen.config.systemInstruction.length > 20);
  assert.deepEqual(seen.contents.map(c => c.role), ['user', 'model', 'user']);
});

test('chat: maps Gemini quota (429) and other errors', async () => {
  const quota = { models: { generateContent: async () => { const e = new Error('RESOURCE_EXHAUSTED: quota'); e.status = 429; throw e; } } };
  assert.equal((await createHandlers({ config: baseConfig, geminiClient: quota }).chat({ message: 'hi' })).status, 429);
  const boom = { models: { generateContent: async () => { throw new Error('kaboom'); } } };
  const out = await createHandlers({ config: baseConfig, geminiClient: boom }).chat({ message: 'hi' });
  assert.equal(out.status, 502);
  assert.ok(!JSON.stringify(out.body).includes('kaboom'), 'internal error text must not leak');
  const notFound = { models: { generateContent: async () => { const e = new Error('nf'); e.status = 404; throw e; } } };
  assert.match((await createHandlers({ config: baseConfig, geminiClient: notFound }).chat({ message: 'hi' })).body.error, /GEMINI_MODEL/);
});

test('chat: empty Gemini answer is reported', async () => {
  const empty = { models: { generateContent: async () => ({ text: '' }) } };
  assert.equal((await createHandlers({ config: baseConfig, geminiClient: empty }).chat({ message: 'hi' })).status, 502);
});

test('buildSsml: marks before each word, XML escaped', () => {
  const { words, ssml } = buildSsml('Tom & "Jerry" <win>');
  assert.deepEqual(words, ['Tom', '&', '"Jerry"', '<win>']);
  assert.equal(ssml, '<speak><mark name="0"/>Tom <mark name="1"/>&amp; <mark name="2"/>&quot;Jerry&quot; <mark name="3"/>&lt;win&gt;</speak>');
});

test('tts: builds correct Google request and converts timepoints to ms', async () => {
  let call;
  const fetchImpl = async (url, opts) => { call = { url, body: JSON.parse(opts.body) }; return { ok: true, status: 200, json: async () => ({
    audioContent: 'QUJD', timepoints: [{ markName: '1', timeSeconds: 0.5 }, { markName: '0', timeSeconds: 0 }] }) }; };
  const h = createHandlers({ config: baseConfig, fetchImpl });
  const out = await h.tts({ text: 'Hello world' });
  assert.equal(out.status, 200);
  assert.deepEqual(out.body.words, ['Hello', 'world']);
  assert.deepEqual(out.body.wtimes, [0, 500]);
  assert.equal(out.body.mimeType, 'audio/mpeg');
  assert.match(call.url, /^https:\/\/texttospeech\.googleapis\.com\/v1beta1\/text:synthesize\?key=t$/);
  assert.deepEqual(call.body.enableTimePointing, ['SSML_MARK']);
  assert.equal(call.body.audioConfig.audioEncoding, 'MP3');
  assert.equal(call.body.voice.name, 'en-US-Neural2-F');
});

test('tts: errors (quota, bad key, missing timings, network, no key)', async () => {
  const mk = f => createHandlers({ config: baseConfig, fetchImpl: f });
  assert.equal((await mk(async () => ({ ok: false, status: 429, json: async () => ({}) })).tts({ text: 'hi' })).status, 429);
  const bad = await mk(async () => ({ ok: false, status: 403, json: async () => ({ error: { message: 'secret detail' } }) })).tts({ text: 'hi' });
  assert.equal(bad.status, 502); assert.ok(!JSON.stringify(bad.body).includes('secret detail'));
  assert.match((await mk(async () => ({ ok: true, status: 200, json: async () => ({ audioContent: 'x', timepoints: [] }) })).tts({ text: 'hi' })).body.error, /word timings/);
  assert.equal((await mk(async () => { throw new Error('offline'); }).tts({ text: 'hi' })).status, 502);
  assert.equal((await createHandlers({ config: { ...baseConfig, ttsApiKey: '' } }).tts({ text: 'hi' })).status, 500);
  assert.equal((await mk(async () => {}).tts({ text: ' ' })).status, 400);
});

test('mockSpeech: valid WAV with increasing word times', () => {
  const s = mockSpeech('Hello there my friend.');
  const buf = Buffer.from(s.audioContent, 'base64');
  assert.equal(buf.toString('ascii', 0, 4), 'RIFF');
  assert.equal(buf.toString('ascii', 8, 12), 'WAVE');
  assert.equal(buf.readUInt32LE(40), buf.length - 44);
  assert.equal(s.words.length, 4);
  assert.ok(s.wtimes.every((t, i) => i === 0 || t > s.wtimes[i - 1]));
});

test('clientConfig never contains secrets', () => {
  const c = createHandlers({ config: { ...baseConfig, avatarUrls: () => ['/a.glb'], avatarBody: 'F' } }).clientConfig();
  const json = JSON.stringify(c);
  assert.ok(!json.includes('"k"') && !json.includes('"t"'));
  assert.deepEqual(c.avatarUrls, ['/a.glb']);
  assert.deepEqual(Object.keys(c).sort(), ['avatarBaseline', 'avatarBody', 'avatarUrls', 'avatarView', 'browserVoice', 'lipsyncOffsetMs', 'mock', 'speechLang', 'ttsProvider']);
});

test('tts: browser provider has no server voice (clear 400), but mock mode still works', async () => {
  const off = await createHandlers({ config: { mock: false, ttsProvider: 'browser' } }).tts({ text: 'hi' });
  assert.equal(off.status, 400);
  assert.match(off.body.error, /browser voice/);
  assert.equal((await createHandlers({ config: { mock: true, ttsProvider: 'browser' } }).tts({ text: 'hi' })).status, 200);
});

test('clientConfig tells the browser which voice to use', () => {
  const c = createHandlers({ config: { ttsProvider: 'browser', browserVoice: 'Natural', lipsyncOffsetMs: -120, ttsLanguageCode: 'en-IN' } }).clientConfig();
  assert.equal(c.ttsProvider, 'browser'); assert.equal(c.browserVoice, 'Natural');
  assert.equal(c.lipsyncOffsetMs, -120); assert.equal(c.speechLang, 'en-IN');
});

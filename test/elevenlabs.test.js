'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHandlers, wordsFromAlignment } = require('../lib/handlers');

const cfg = { mock: false, ttsProvider: 'elevenlabs', elevenApiKey: 'xi-key', elevenVoiceId: 'VOICE123', elevenModel: 'eleven_flash_v2_5' };

// Build an ElevenLabs-style alignment: every character gets 0.1 s
function align(text, perChar = 0.1) {
  const characters = [...text];
  return {
    characters,
    character_start_times_seconds: characters.map((_, i) => +(i * perChar).toFixed(3)),
    character_end_times_seconds: characters.map((_, i) => +((i + 1) * perChar).toFixed(3))
  };
}

test('wordsFromAlignment groups characters into words with start times in ms', () => {
  const { words, wtimes } = wordsFromAlignment(align("Hi there! It's me"));
  assert.deepEqual(words, ['Hi', 'there!', "It's", 'me']);
  assert.deepEqual(wtimes, [0, 300, 1000, 1500]);
});

test('wordsFromAlignment copes with empty / missing / extra whitespace', () => {
  assert.deepEqual(wordsFromAlignment(null), { words: [], wtimes: [] });
  assert.deepEqual(wordsFromAlignment({ characters: [], character_start_times_seconds: [] }), { words: [], wtimes: [] });
  assert.deepEqual(wordsFromAlignment(align('  a   b  ')).words, ['a', 'b']);
});

test('elevenlabs tts: correct request and response mapping', async () => {
  let call;
  const fetchImpl = async (url, opts) => {
    call = { url, opts, body: JSON.parse(opts.body) };
    return { ok: true, status: 200, json: async () => ({ audio_base64: 'QUJD', alignment: align('Hello world') }) };
  };
  const out = await createHandlers({ config: cfg, fetchImpl }).tts({ text: 'Hello world' });
  assert.equal(out.status, 200);
  assert.deepEqual(out.body.words, ['Hello', 'world']);
  assert.deepEqual(out.body.wtimes, [0, 600]);
  assert.equal(out.body.audioContent, 'QUJD');
  assert.equal(out.body.mimeType, 'audio/mpeg');
  assert.equal(call.url, 'https://api.elevenlabs.io/v1/text-to-speech/VOICE123/with-timestamps?output_format=mp3_44100_128');
  assert.equal(call.opts.method, 'POST');
  assert.equal(call.opts.headers['xi-api-key'], 'xi-key');
  assert.deepEqual(call.body, { text: 'Hello world', model_id: 'eleven_flash_v2_5' });
});

test('elevenlabs tts: falls back to normalized_alignment', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ audio_base64: 'QUJD', alignment: null, normalized_alignment: align('ok then') }) });
  const out = await createHandlers({ config: cfg, fetchImpl }).tts({ text: 'ok then' });
  assert.deepEqual(out.body.words, ['ok', 'then']);
});

test('elevenlabs tts: error mapping, no secret/detail leaks', async () => {
  const mk = (status, detail) => createHandlers({ config: cfg, fetchImpl: async () => ({ ok: false, status, json: async () => ({ detail }) }) }).tts({ text: 'hi' });
  assert.match((await mk(400, { status: 'api_key_id_used_as_api_key', message: 'API key ID used as API key' })).body.error, /key ID.*sk_/);
  assert.match((await mk(401, { status: 'invalid_api_key', message: 'secret-xyz' })).body.error, /ELEVENLABS_API_KEY/);
  assert.equal((await mk(429, { status: 'quota_exceeded' })).status, 429);
  assert.match((await mk(402, { status: 'payment_required' })).body.error, /plan/);
  assert.match((await mk(404, {})).body.error, /ELEVENLABS_VOICE_ID/);
  assert.match((await mk(422, [{ msg: 'bad' }])).body.error, /voice or model/);
  const generic = await mk(500, { message: 'secret-xyz' });
  assert.equal(generic.status, 502);
  assert.ok(!JSON.stringify(generic.body).includes('secret-xyz'));
});

test('elevenlabs tts: missing key, no audio, no timings, network failure', async () => {
  const run = (config, fetchImpl) => createHandlers({ config, fetchImpl }).tts({ text: 'hi' });
  assert.match((await run({ ...cfg, elevenApiKey: '' })).body.error, /ELEVENLABS_API_KEY is missing/);
  assert.match((await run(cfg, async () => ({ ok: true, status: 200, json: async () => ({ alignment: align('hi') }) }))).body.error, /no audio/);
  assert.match((await run(cfg, async () => ({ ok: true, status: 200, json: async () => ({ audio_base64: 'x' }) }))).body.error, /no word timings/);
  assert.equal((await run(cfg, async () => { throw new Error('offline'); })).status, 502);
});

test('provider switch: google path is untouched and mock mode ignores provider', async () => {
  let url;
  const g = createHandlers({ config: { mock: false, ttsProvider: 'google', ttsApiKey: 't', ttsLanguageCode: 'en-US', ttsVoice: 'v' },
    fetchImpl: async u => { url = u; return { ok: true, status: 200, json: async () => ({ audioContent: 'x', timepoints: [{ markName: '0', timeSeconds: 0 }] }) }; } });
  assert.equal((await g.tts({ text: 'hi' })).status, 200);
  assert.match(url, /texttospeech\.googleapis\.com/);
  const m = await createHandlers({ config: { mock: true, ttsProvider: 'elevenlabs' } }).tts({ text: 'hi there' });
  assert.equal(m.body.mimeType, 'audio/wav');
});

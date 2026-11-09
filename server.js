'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const { createHandlers } = require('./lib/handlers');

// Where the browser looks for the avatar model, in order.
// 1) AVATAR_URL from .env (only that one), else
// 2) public/avatars/avatar.glb if you put one there, then
// 3) sample avatars hosted in the TalkingHead project (needs internet, non-commercial licence).
const LOCAL_AVATAR = path.join(__dirname, 'public', 'avatars', 'avatar.glb');
const SAMPLE_AVATARS = [
  'https://raw.githubusercontent.com/met4citizen/TalkingHead/main/avatars/brunette.glb',
  'https://cdn.jsdelivr.net/gh/met4citizen/TalkingHead@1.7/avatars/brunette.glb'
];
function avatarUrls() {
  if (process.env.AVATAR_URL) return [process.env.AVATAR_URL];
  return [...(fs.existsSync(LOCAL_AVATAR) ? ['/avatars/avatar.glb'] : []), ...SAMPLE_AVATARS];
}

function parseJson(text) {
  if (!text) return null;
  try { const v = JSON.parse(text); return v && typeof v === 'object' ? v : null; }
  catch { console.warn('Warning: AVATAR_BASELINE is not valid JSON, ignoring it.'); return null; }
}

const config = {
  port: Number(process.env.PORT) || 3000,
  mock: String(process.env.MOCK_MODE).toLowerCase() === 'true',
  geminiApiKey: process.env.GEMINI_API_KEY,
  geminiModel: process.env.GEMINI_MODEL || 'gemini-flash-lite-latest',
  geminiThinking: process.env.GEMINI_THINKING,
  // browser (default, built-in browser voice, no key) | google | elevenlabs
  ttsProvider: ['browser', 'google', 'elevenlabs'].includes((process.env.TTS_PROVIDER || '').trim().toLowerCase())
    ? process.env.TTS_PROVIDER.trim().toLowerCase() : 'browser',
  browserVoice: process.env.BROWSER_VOICE || '',
  lipsyncOffsetMs: Number(process.env.LIPSYNC_OFFSET_MS) || 0,
  elevenApiKey: process.env.ELEVENLABS_API_KEY,
  elevenVoiceId: process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM',
  elevenModel: process.env.ELEVENLABS_MODEL || 'eleven_flash_v2_5',
  ttsApiKey: process.env.GOOGLE_TTS_API_KEY,
  ttsLanguageCode: process.env.TTS_LANGUAGE_CODE || 'en-US',
  ttsVoice: process.env.TTS_VOICE || 'en-US-Neural2-F',
  avatarUrls,
  avatarBody: process.env.AVATAR_BODY || 'F',
  avatarView: ['full', 'mid', 'upper', 'head'].includes(process.env.AVATAR_VIEW) ? process.env.AVATAR_VIEW : 'upper',
  avatarBaseline: parseJson(process.env.AVATAR_BASELINE)
};

const handlers = createHandlers({ config });
const app = express();

app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const wrap = fn => async (req, res) => {
  const started = Date.now();
  const out = await fn(req.body || {});
  console.log(`${req.method} ${req.path} -> ${out.status} in ${Date.now() - started} ms`); // shows which step is slow
  res.status(out.status).json(out.body);
};

app.post('/api/chat', wrap(handlers.chat));
app.post('/api/tts', wrap(handlers.tts));
app.get('/api/config', (req, res) => res.json(handlers.clientConfig()));

// invalid JSON etc.
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body.' });
  console.error(err);
  res.status(500).json({ error: 'Unexpected server error.' });
});

app.listen(config.port, () => {
  console.log(`Talking Avatar running at http://localhost:${config.port}`);
  console.log('Voice provider: ' + config.ttsProvider + (config.ttsProvider === 'browser' ? ' (built-in browser voice, no key needed)' : ''));
  if (config.mock) console.log('MOCK_MODE is ON: using dummy replies (no API keys needed).');
  else {
    if (!config.geminiApiKey) console.warn('Warning: GEMINI_API_KEY is not set.');
    if (config.ttsProvider === 'elevenlabs' && !config.elevenApiKey) console.warn('Warning: ELEVENLABS_API_KEY is not set.');
    if (config.ttsProvider === 'elevenlabs' && config.elevenApiKey && !config.elevenApiKey.startsWith('sk_')) {
      console.warn('Warning: ELEVENLABS_API_KEY does not start with "sk_". You may have pasted the key ID instead of the key.');
    }
    if (config.ttsProvider === 'google' && !config.ttsApiKey) console.warn('Warning: GOOGLE_TTS_API_KEY is not set.');
  }
});

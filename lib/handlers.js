'use strict';
/**
 * Framework-free request handlers. Each returns { status, body }.
 * server.js plugs them into Express. Dependencies (Gemini client, fetch)
 * are injectable so they can be tested without real API keys.
 */

const MAX_TEXT = 2000;
const MAX_TTS_CHARS = 700;
const MAX_HISTORY = 12;

const SYSTEM_PROMPT = [
  'You are a friendly, warm human-like conversational assistant shown as a talking avatar.',
  'Your replies are spoken aloud, so keep them natural and short: usually one to three sentences.',
  'Use plain spoken English. No markdown, no bullet points, no emojis, no stage directions.',
  'Ask at most one short follow-up question when it feels natural.'
].join(' ');

/* ---------- helpers ---------- */

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** Validate + normalise history into Gemini "contents" (roles: user/model, starts with user). */
function buildContents(history, message) {
  const turns = [];
  if (Array.isArray(history)) {
    for (const h of history.slice(-MAX_HISTORY)) {
      const text = clean(h && h.text).slice(0, MAX_TEXT);
      if (!text) continue;
      const role = h.role === 'user' ? 'user' : (h.role === 'assistant' || h.role === 'model') ? 'model' : null;
      if (role) turns.push({ role, text });
    }
  }
  turns.push({ role: 'user', text: message });
  while (turns.length && turns[0].role !== 'user') turns.shift();
  // merge consecutive same-role turns
  const merged = [];
  for (const t of turns) {
    const last = merged[merged.length - 1];
    if (last && last.role === t.role) last.text += '\n' + t.text;
    else merged.push({ ...t });
  }
  return merged.map(t => ({ role: t.role, parts: [{ text: t.text }] }));
}

function mapGeminiError(err) {
  const status = Number(err && (err.status || err.code)) || 0;
  const msg = String((err && err.message) || err || '');
  if (status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(msg)) {
    return { status: 429, body: { error: 'Gemini quota or rate limit reached. Wait a minute and try again.' } };
  }
  if (status === 400 && /API key/i.test(msg)) {
    return { status: 502, body: { error: 'Gemini rejected the API key. Check GEMINI_API_KEY in .env.' } };
  }
  if (status === 401 || status === 403) {
    return { status: 502, body: { error: 'Gemini refused the request (key invalid or not allowed).' } };
  }
  if (status === 404) {
    return { status: 502, body: { error: 'Gemini model not found. Check GEMINI_MODEL in .env.' } };
  }
  return { status: 502, body: { error: 'Gemini request failed. Please try again.' } };
}

/**
 * Gemini "thinking" makes replies slower. Newer models use thinkingLevel, Gemini 2.5 uses thinkingBudget,
 * and which one works depends on the model behind GEMINI_MODEL. So in "auto" mode we try
 * low level -> budget 0 -> nothing, and remember the first one the API accepts.
 * GEMINI_THINKING can force: off | minimal | low | medium | high | <number budget>.
 */
function thinkingVariants(setting) {
  const v = String(setting || 'auto').trim().toLowerCase();
  if (v === 'off' || v === 'none') return [null];
  if (['minimal', 'low', 'medium', 'high'].includes(v)) return [{ thinkingLevel: v }];
  if (/^\d+$/.test(v)) return [{ thinkingBudget: Number(v) }];
  return [{ thinkingLevel: 'low' }, { thinkingBudget: 0 }, null];
}

/* ---------- mock replies (MOCK_MODE) ---------- */

function mockReply(message) {
  const m = message.toLowerCase();
  if (/\b(hi|hello|hey|namaste)\b/.test(m)) return "Hi there! It's lovely to meet you. How is your day going?";
  if (/your name|who are you/.test(m)) return "I'm your talking avatar. Right now I'm running in demo mode, so my answers are pre-written.";
  if (/how are you/.test(m)) return "I'm doing great, thanks for asking! What would you like to talk about?";
  if (/weather/.test(m)) return "I can't check the weather in demo mode, but I hope it's sunny where you are.";
  if (/thank/.test(m)) return "You're very welcome! Happy to help anytime.";
  if (/bye|goodbye/.test(m)) return "Goodbye! It was nice talking with you.";
  return "That's interesting! In demo mode I can only give simple replies, but add your Gemini key and I'll answer properly.";
}

/* ---------- TTS helpers ---------- */

const escapeXml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/** Split text into words and build SSML with a <mark> before every word. */
function buildSsml(text) {
  const words = text.split(/\s+/).filter(Boolean);
  const body = words.map((w, i) => `<mark name="${i}"/>${escapeXml(w)}`).join(' ');
  return { words, ssml: `<speak>${body}</speak>` };
}

/**
 * ElevenLabs returns timings per character. TalkingHead wants per word, so group
 * consecutive non-space characters into words and use the first character's start time (ms).
 */
function wordsFromAlignment(alignment) {
  const chars = (alignment && alignment.characters) || [];
  const starts = (alignment && alignment.character_start_times_seconds) || [];
  const words = [], wtimes = [];
  let cur = '', start = 0;
  chars.forEach((ch, i) => {
    if (/\s/.test(ch)) {
      if (cur) { words.push(cur); wtimes.push(Math.round(start * 1000)); cur = ''; }
    } else {
      if (!cur) start = Number(starts[i]) || 0;
      cur += ch;
    }
  });
  if (cur) { words.push(cur); wtimes.push(Math.round(start * 1000)); }
  return { words, wtimes };
}

/** Make a WAV (base64) of soft "beeps", one per word, plus word timings. For MOCK_MODE only. */
function mockSpeech(text) {
  const words = text.split(/\s+/).filter(Boolean);
  const rate = 22050;
  const wtimes = [];
  const chunks = [];
  let t = 0;
  words.forEach((w, i) => {
    const dur = Math.min(0.55, 0.07 * w.length + 0.12);
    const gap = /[.!?]$/.test(w) ? 0.28 : 0.06;
    wtimes.push(Math.round(t * 1000));
    const n = Math.floor(dur * rate);
    const f = 170 + (i % 5) * 25;
    const buf = new Int16Array(n);
    for (let k = 0; k < n; k++) {
      const env = Math.sin(Math.PI * k / n);
      buf[k] = Math.round(Math.sin(2 * Math.PI * f * k / rate) * env * 0.18 * 32767);
    }
    chunks.push(buf, new Int16Array(Math.floor(gap * rate)));
    t += dur + gap;
  });
  const samples = Buffer.concat(chunks.map(c => Buffer.from(c.buffer)));
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + samples.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(samples.length, 40);
  return {
    audioContent: Buffer.concat([header, samples]).toString('base64'),
    mimeType: 'audio/wav',
    words, wtimes, durationMs: Math.round(t * 1000)
  };
}

/* ---------- factory ---------- */

function createHandlers({ config, geminiClient, fetchImpl }) {
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  let genai = geminiClient || null;
  const variants = thinkingVariants(config.geminiThinking);
  let variantIdx = 0;

  function getGemini() {
    if (!genai) {
      const { GoogleGenAI } = require('@google/genai'); // loaded lazily so mock mode needs no SDK
      genai = new GoogleGenAI({ apiKey: config.geminiApiKey });
    }
    return genai;
  }

  async function generate(contents) {
    for (;;) {
      const thinking = variants[variantIdx];
      try {
        return await getGemini().models.generateContent({
          model: config.geminiModel,
          contents,
          config: { systemInstruction: SYSTEM_PROMPT, maxOutputTokens: 1024, ...(thinking ? { thinkingConfig: thinking } : {}) }
        });
      } catch (err) {
        const status = Number(err && (err.status || err.code)) || 0;
        const msg = String((err && err.message) || '');
        // Only step down when the API is complaining about the thinking setting itself.
        if (variantIdx < variants.length - 1 && (status === 400 || !status) && /think/i.test(msg)) { variantIdx++; continue; }
        throw err;
      }
    }
  }

  async function chat(body) {
    const message = clean(body && body.message);
    if (!message) return { status: 400, body: { error: 'Please send a non-empty "message".' } };
    if (message.length > MAX_TEXT) return { status: 400, body: { error: `Message is too long (max ${MAX_TEXT} characters).` } };
    if (body.history !== undefined && !Array.isArray(body.history)) {
      return { status: 400, body: { error: '"history" must be an array.' } };
    }

    if (config.mock) {
      await new Promise(r => setTimeout(r, 400)); // feel like "thinking"
      return { status: 200, body: { reply: mockReply(message), mock: true } };
    }
    if (!config.geminiApiKey && !geminiClient) {
      return { status: 500, body: { error: 'GEMINI_API_KEY is missing. Add it to .env or set MOCK_MODE=true.' } };
    }
    try {
      const response = await generate(buildContents(body.history, message));
      const reply = clean(response && response.text);
      if (!reply) return { status: 502, body: { error: 'Gemini returned an empty answer (it may have been blocked). Try rephrasing.' } };
      return { status: 200, body: { reply } };
    } catch (err) {
      console.error('[chat] Gemini error:', err && err.message);
      return mapGeminiError(err);
    }
  }

  async function tts(body) {
    let text = clean(body && body.text);
    if (!text) return { status: 400, body: { error: 'Please send non-empty "text".' } };
    text = text.slice(0, MAX_TTS_CHARS);

    if (config.mock) return { status: 200, body: mockSpeech(text) };
    if (config.ttsProvider === 'browser') {
      return { status: 400, body: { error: 'Server voice is off: TTS_PROVIDER=browser uses the browser voice.' } };
    }
    if (config.ttsProvider === 'elevenlabs') return elevenTts(text);
    if (!config.ttsApiKey) {
      return { status: 500, body: { error: 'GOOGLE_TTS_API_KEY is missing. Add it to .env or set MOCK_MODE=true.' } };
    }
    const { words, ssml } = buildSsml(text);
    try {
      const res = await doFetch(
        'https://texttospeech.googleapis.com/v1beta1/text:synthesize?key=' + encodeURIComponent(config.ttsApiKey),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            input: { ssml },
            voice: { languageCode: config.ttsLanguageCode, name: config.ttsVoice },
            audioConfig: { audioEncoding: 'MP3' },
            enableTimePointing: ['SSML_MARK']
          })
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        console.error('[tts] Google TTS error:', res.status, data && data.error && data.error.message);
        const quota = res.status === 429;
        return { status: quota ? 429 : 502, body: { error: quota ? 'Text-to-Speech quota reached. Try again later.' : 'Text-to-Speech request failed. Check GOOGLE_TTS_API_KEY and that the Cloud Text-to-Speech API is enabled.' } };
      }
      if (!data.audioContent) return { status: 502, body: { error: 'Text-to-Speech returned no audio.' } };
      const points = new Array(words.length).fill(null);
      for (const p of data.timepoints || []) points[Number(p.markName)] = Math.round(p.timeSeconds * 1000);
      if (points.some(p => p === null)) {
        return { status: 502, body: { error: 'This TTS voice did not return word timings. Choose a Standard or Neural2 voice in TTS_VOICE.' } };
      }
      return { status: 200, body: { audioContent: data.audioContent, mimeType: 'audio/mpeg', words, wtimes: points } };
    } catch (err) {
      console.error('[tts] network error:', err && err.message);
      return { status: 502, body: { error: 'Could not reach Google Text-to-Speech.' } };
    }
  }

  async function elevenTts(text) {
    if (!config.elevenApiKey) {
      return { status: 500, body: { error: 'ELEVENLABS_API_KEY is missing. Add it to .env or set MOCK_MODE=true.' } };
    }
    const voiceId = config.elevenVoiceId || '21m00Tcm4TlvDq8ikWAM';
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/with-timestamps?output_format=mp3_44100_128`;
    try {
      const res = await doFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'xi-api-key': config.elevenApiKey },
        body: JSON.stringify({ text, model_id: config.elevenModel || 'eleven_flash_v2_5' })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const detail = data && data.detail;
        const code = String((detail && (detail.status || detail.code)) || '');
        console.error('[tts] ElevenLabs error:', res.status, code, detail && detail.message);
        if (code === 'api_key_id_used_as_api_key') {
          return { status: 502, body: { error: 'That value is the API key ID, not the key. Create a new key in ElevenLabs, copy the long key that starts with sk_ right away, and put it in ELEVENLABS_API_KEY.' } };
        }
        if (res.status === 401) return { status: 502, body: { error: 'ElevenLabs rejected the API key. Check ELEVENLABS_API_KEY in .env.' } };
        if (res.status === 402 || code === 'paid_plan_required' || code === 'payment_required') {
          return { status: 502, body: { error: 'Your ElevenLabs plan cannot use this voice through the API. Pick one of your own voices (ELEVENLABS_VOICE_ID) or upgrade.' } };
        }
        if (res.status === 429 || code === 'quota_exceeded') return { status: 429, body: { error: 'ElevenLabs quota or rate limit reached. Try again later.' } };
        if (res.status === 404 || res.status === 422) return { status: 502, body: { error: 'ElevenLabs could not use that voice or model. Check ELEVENLABS_VOICE_ID and ELEVENLABS_MODEL in .env.' } };
        return { status: 502, body: { error: 'ElevenLabs request failed. Please try again.' } };
      }
      if (!data.audio_base64) return { status: 502, body: { error: 'ElevenLabs returned no audio.' } };
      const { words, wtimes } = wordsFromAlignment(data.alignment || data.normalized_alignment);
      if (!words.length) return { status: 502, body: { error: 'ElevenLabs returned no word timings.' } };
      return { status: 200, body: { audioContent: data.audio_base64, mimeType: 'audio/mpeg', words, wtimes } };
    } catch (err) {
      console.error('[tts] ElevenLabs network error:', err && err.message);
      return { status: 502, body: { error: 'Could not reach ElevenLabs.' } };
    }
  }

  function clientConfig() {
    return {
      mock: !!config.mock,
      avatarUrls: (typeof config.avatarUrls === 'function' ? config.avatarUrls() : config.avatarUrls) || [],
      avatarBody: config.avatarBody,
      avatarView: config.avatarView || 'upper',
      avatarBaseline: config.avatarBaseline || null,
      speechLang: config.ttsLanguageCode || 'en-US',
      ttsProvider: config.ttsProvider || 'google',
      browserVoice: config.browserVoice || '',
      lipsyncOffsetMs: Number(config.lipsyncOffsetMs) || 0
    };
  }

  return { chat, tts, clientConfig };
}

module.exports = { createHandlers, thinkingVariants, buildContents, buildSsml, wordsFromAlignment, mockSpeech, mockReply, mapGeminiError, SYSTEM_PROMPT };

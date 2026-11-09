// Talking Avatar frontend (vanilla JS, no framework).
// Flow: mic/text -> /api/chat (Gemini) -> /api/tts (Google TTS) -> TalkingHead speakAudio().

import { splitSentences, estimateWordTimings, pickVoice } from './speech-helpers.js';

const $ = id => document.getElementById(id);
const els = {
  avatar: $('avatar'), status: $('status'), statusText: $('statusText'), modeBadge: $('modeBadge'),
  overlay: $('avatarOverlay'), overlayMsg: $('avatarMsg'),
  micBtn: $('micBtn'), micHint: $('micHint'), stopBtn: $('stopBtn'),
  messages: $('messages'), typing: $('typing'), form: $('chatForm'), input: $('textInput'), sendBtn: $('sendBtn')
};

const STATUS_LABEL = { loading: 'Loading avatar', ready: 'Ready', listening: 'Listening', thinking: 'Thinking', speaking: 'Speaking', error: 'Error' };
const MAX_HISTORY = 12;

let config = { mock: false, avatarUrls: ['/avatars/avatar.glb'], avatarBody: 'F', avatarView: 'upper', avatarBaseline: null, speechLang: 'en-US', ttsProvider: 'browser', browserVoice: '', lipsyncOffsetMs: 0 };
let head = null;            // TalkingHead instance (null if the avatar failed to load)
let history = [];           // [{role:'user'|'assistant', text}]
let busy = false;           // true while waiting for Gemini / TTS
let recognition = null;
let listening = false;
let speakToken = 0;         // lets us ignore stale "speech finished" timers

/* ---------- small UI helpers ---------- */

function setStatus(state, text) {
  els.status.dataset.state = state;
  els.statusText.textContent = text || STATUS_LABEL[state];
}

function addMessage(kind, text) {
  const li = document.createElement('li');
  li.className = 'msg ' + kind;
  li.textContent = text; // textContent: never inject model output as HTML
  els.messages.appendChild(li);
  els.messages.scrollTop = els.messages.scrollHeight;
}

function setBusy(value) {
  busy = value;
  els.typing.hidden = !value;
  els.sendBtn.disabled = value;
  els.input.disabled = value;
  if (value) els.messages.scrollTop = els.messages.scrollHeight;
}

function showError(message) {
  setStatus('error');
  addMessage('system error', message);
}

async function postJson(url, body) {
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    throw new Error('Cannot reach the server. Is it running?');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

/* ---------- avatar ---------- */

// Make sure a URL really serves a .glb model (not a 404 page or a Git LFS pointer) before handing it to TalkingHead.
async function checkModelUrl(url) {
  let res;
  try { res = await fetch(url); } catch { throw new Error('could not download'); }
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const reader = res.body.getReader();
  const { value } = await reader.read();
  reader.cancel().catch(() => {});
  const magic = value ? String.fromCharCode(...value.slice(0, 4)) : '';
  if (magic !== 'glTF') throw new Error('not a .glb model file');
}

async function loadAvatar() {
  setStatus('loading');
  try {
    // Dynamic import so a CDN failure doesn't break the chat itself.
    const { TalkingHead } = await import('talkinghead');
    head = new TalkingHead(els.avatar, {
      lipsyncModules: ['en'],
      cameraView: config.avatarView,
      modelFPS: 24,        // lighter on weak CPUs
      modelPixelRatio: 1   // don't render at retina resolution
    });

    const urls = (config.avatarUrls && config.avatarUrls.length) ? config.avatarUrls : ['/avatars/avatar.glb'];
    const problems = [];
    let loaded = false;
    for (const url of urls) {
      try {
        els.overlayMsg.textContent = 'Loading avatar…';
        await checkModelUrl(url);
        await head.showAvatar(
          { url, body: config.avatarBody, avatarMood: 'neutral', lipsyncLang: 'en',
            ...(config.avatarBaseline ? { baseline: config.avatarBaseline } : {}) },
          ev => {
            if (ev && ev.lengthComputable) {
              els.overlayMsg.textContent = `Loading avatar… ${Math.round((ev.loaded / ev.total) * 100)}%`;
            }
          }
        );
        loaded = true;
        break;
      } catch (err) {
        console.warn('Avatar source failed:', url, err);
        problems.push(`${url.length > 60 ? url.slice(0, 57) + '…' : url} (${err.message})`);
      }
    }
    if (!loaded) throw new Error(problems.join('; '));
    els.overlay.classList.add('hidden');
    setStatus('ready');
  } catch (err) {
    console.error('Avatar failed to load:', err);
    head = null;
    els.overlay.classList.add('failed');
    els.overlayMsg.textContent = 'The avatar could not be loaded. You can still chat in text; replies just will not be spoken.';
    setStatus('error', 'Avatar unavailable');
    addMessage('system error', 'Avatar failed to load: ' + err.message + '. See the README, section 2.');
  }
}

function base64ToArrayBuffer(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

function finishSpeaking(token) {
  if (token !== speakToken) return;
  els.stopBtn.disabled = true;
  if (!busy && !listening) setStatus('ready');
}

async function fetchSpeech(text) {
  const tts = await postJson('/api/tts', { text });
  const audio = await head.audioCtx.decodeAudioData(base64ToArrayBuffer(tts.audioContent));
  return { tts, audio };
}

// Sleep that ends early if the user pressed Stop (speakToken changed).
async function sleepWhileCurrent(ms, token) {
  const end = performance.now() + ms;
  while (performance.now() < end && token === speakToken) {
    await new Promise(r => setTimeout(r, Math.min(100, end - performance.now())));
  }
}

async function speak(text) {
  if (config.ttsProvider === 'browser') return speakWithBrowserVoice(text);
  if (!head) return; // text-only mode
  const token = ++speakToken;
  setStatus('thinking', 'Preparing voice');
  // Browsers only allow audio after a user gesture; resume just in case.
  if (head.audioCtx && head.audioCtx.state === 'suspended') await head.audioCtx.resume();

  const chunks = splitSentences(text);
  const jobs = [];
  // Look ahead by one chunk only (at most 2 voice requests at once, friendly to free-plan limits).
  const job = i => {
    if (i < chunks.length && !jobs[i]) { jobs[i] = fetchSpeech(chunks[i]); jobs[i].catch(() => {}); }
    return jobs[i];
  };
  const t0 = performance.now();
  job(0); job(1);

  for (let i = 0; i < chunks.length; i++) {
    const { tts, audio } = await job(i);
    if (token !== speakToken) return; // stopped or replaced
    if (i === 0) {
      setLastTiming({ voice: performance.now() - t0 });
      setStatus('speaking');
      els.stopBtn.disabled = false;
    }
    job(i + 2);
    // TalkingHead wants word timings in milliseconds: words, wtimes (start), wdurations.
    const totalMs = audio.duration * 1000;
    const wdurations = tts.wtimes.map((start, k) =>
      Math.max(40, Math.round((k + 1 < tts.wtimes.length ? tts.wtimes[k + 1] : totalMs) - start)));
    head.speakAudio({ audio, words: tts.words, wtimes: tts.wtimes, wdurations }, { lipsyncLang: 'en' });
    await sleepWhileCurrent(totalMs + 120, token);
    if (token !== speakToken) return;
  }
  finishSpeaking(token);
}

/* ---------- browser voice (no keys, no server TTS) ---------- */

const synth = 'speechSynthesis' in window ? window.speechSynthesis : null;
let currentUtterance = null; // keep a reference, otherwise Chrome can drop the utterance before it ends

function loadVoices() {
  return new Promise(resolve => {
    const now = synth.getVoices();
    if (now.length) return resolve(now);
    const timer = setTimeout(() => resolve(synth.getVoices()), 1500);
    synth.addEventListener('voiceschanged', () => { clearTimeout(timer); resolve(synth.getVoices()); }, { once: true });
  });
}

// How many ms per character this voice really takes. Learned after each sentence and remembered.
const calKey = voice => 'avatar.msPerChar:' + (voice ? voice.name : 'default');
function getMsPerChar(voice) {
  try { const v = Number(localStorage.getItem(calKey(voice))); if (v > 20 && v < 250) return v; } catch { /* storage blocked */ }
  return 65;
}
function saveMsPerChar(voice, value) {
  try { localStorage.setItem(calKey(voice), String(Math.round(value * 10) / 10)); } catch { /* storage blocked */ }
}

/** Speaks one sentence with the browser voice and starts the avatar's mouth at the moment the voice starts. */
function speakChunkWithBrowser(chunk, voice, msPerChar, token, onStarted) {
  return new Promise((resolve, reject) => {
    const utt = new SpeechSynthesisUtterance(chunk);
    utt.lang = config.speechLang || 'en-US';
    if (voice) utt.voice = voice;
    let startedAt = 0;
    const startGuard = setTimeout(() => {
      synth.cancel();
      reject(new Error('The browser voice did not start. Check your computer sound and that a voice is installed.'));
    }, 6000);

    utt.onstart = () => {
      clearTimeout(startGuard);
      startedAt = performance.now();
      onStarted();
      if (head && token === speakToken) {
        const est = estimateWordTimings(chunk, chunk.length * msPerChar);
        const offset = Number(config.lipsyncOffsetMs) || 0; // >0: mouth later, <0: mouth earlier
        const wtimes = offset < 0 ? est.wtimes.map(t => Math.max(0, t + offset)) : est.wtimes;
        const sr = head.audioCtx.sampleRate;
        // Silent audio of about the right length: TalkingHead needs an audio object to drive the mouth.
        const silent = head.audioCtx.createBuffer(1, Math.max(1, Math.round(sr * est.totalMs * 1.15 / 1000)), sr);
        const play = () => { if (token === speakToken) head.speakAudio({ audio: silent, words: est.words, wtimes, wdurations: est.wdurations }, { lipsyncLang: 'en' }); };
        if (offset > 0) setTimeout(play, offset); else play();
      }
    };
    utt.onend = () => { clearTimeout(startGuard); resolve({ started: startedAt > 0, actualMs: performance.now() - startedAt }); };
    utt.onerror = e => {
      clearTimeout(startGuard);
      if (e.error === 'canceled' || e.error === 'interrupted') resolve({ cancelled: true });
      else reject(new Error('Browser voice error: ' + (e.error || 'unknown')));
    };
    currentUtterance = utt;
    synth.speak(utt);
  });
}

async function speakWithBrowserVoice(text) {
  if (!synth) {
    addMessage('system error', 'This browser has no built-in voice. Try Chrome or Edge.');
    return;
  }
  const token = ++speakToken;
  setStatus('thinking', 'Preparing voice');
  const t0 = performance.now();
  const voices = await loadVoices();
  if (token !== speakToken) return;
  const voice = pickVoice(voices, config.speechLang, config.browserVoice);
  const chunks = splitSentences(text);

  for (let i = 0; i < chunks.length; i++) {
    const msPerChar = getMsPerChar(voice);
    const result = await speakChunkWithBrowser(chunks[i], voice, msPerChar, token, () => {
      if (i === 0) {
        setLastTiming({ voice: performance.now() - t0 });
        setStatus('speaking');
        els.stopBtn.disabled = false;
      }
    });
    if (head) head.stopSpeaking(); // close the mouth when the voice ends, so the next sentence re-syncs
    if (result.cancelled || token !== speakToken) return;
    // Learn this voice's real speed so the next sentence is timed better.
    if (result.started && chunks[i].length >= 15 && result.actualMs > 200) {
      saveMsPerChar(voice, 0.5 * msPerChar + 0.5 * (result.actualMs / chunks[i].length));
    }
  }
  finishSpeaking(token);
}

// Shows how long the last reply and voice took, to see which step is slow.
const timing = { reply: null, voice: null };
function setLastTiming(part) {
  Object.assign(timing, part);
  const fmt = v => (v == null ? '…' : (v / 1000).toFixed(1) + 's');
  $('timing').textContent = `Last turn: reply ${fmt(timing.reply)} · voice ready ${fmt(timing.voice)}`;
  console.info('[timing]', timing);
}

function stopSpeaking() {
  speakToken++;
  if (synth) synth.cancel();
  if (head) head.stopSpeaking();
  els.stopBtn.disabled = true;
  if (!busy && !listening) setStatus('ready');
}

/* ---------- conversation ---------- */

async function sendMessage(text) {
  text = (text || '').trim();
  if (!text || busy) return;
  stopSpeaking();
  if (head && head.audioCtx && head.audioCtx.state === 'suspended') head.audioCtx.resume();

  addMessage('user', text);
  els.input.value = '';
  setBusy(true);
  setStatus('thinking');

  try {
    const tChat = performance.now();
    const { reply } = await postJson('/api/chat', { message: text, history: history.slice(-MAX_HISTORY) });
    timing.voice = null; setLastTiming({ reply: performance.now() - tChat });
    history.push({ role: 'user', text }, { role: 'assistant', text: reply });
    history = history.slice(-MAX_HISTORY);
    addMessage('bot', reply);
    setBusy(false);
    if (head || config.ttsProvider === 'browser') {
      try { await speak(reply); }
      catch (err) { showError('Voice failed: ' + err.message); }
    } else {
      setStatus('ready');
    }
  } catch (err) {
    setBusy(false);
    showError(err.message);
  } finally {
    if (busy) setBusy(false);
    els.input.focus({ preventScroll: true });
  }
}

/* ---------- microphone ---------- */

function setupMic() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    els.micBtn.disabled = true;
    els.micHint.textContent = 'Mic not supported in this browser. Try Chrome or Edge.';
    return;
  }
  recognition = new SR();
  recognition.lang = config.speechLang || 'en-US';
  recognition.interimResults = true;
  recognition.continuous = false;

  let finalText = '';
  recognition.onstart = () => {
    listening = true; finalText = '';
    els.micBtn.setAttribute('aria-pressed', 'true');
    els.micBtn.setAttribute('aria-label', 'Stop microphone');
    els.micHint.textContent = 'Listening… tap to stop';
    setStatus('listening');
  };
  recognition.onresult = e => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) finalText += t; else interim += t;
    }
    els.input.value = (finalText + interim).trim(); // show what is being heard
  };
  recognition.onerror = e => {
    const msgs = {
      'not-allowed': 'Microphone permission was blocked. Allow it in the browser address bar and try again.',
      'service-not-allowed': 'Microphone permission was blocked. Allow it in the browser address bar and try again.',
      'no-speech': 'I did not hear anything. Tap the microphone and try again.',
      'audio-capture': 'No microphone was found.',
      'network': 'Speech recognition needs an internet connection.'
    };
    if (e.error !== 'aborted') showError(msgs[e.error] || 'Speech recognition error: ' + e.error);
  };
  recognition.onend = () => {
    listening = false;
    els.micBtn.setAttribute('aria-pressed', 'false');
    els.micBtn.setAttribute('aria-label', 'Start microphone');
    els.micHint.textContent = 'Tap to talk';
    const text = (finalText || '').trim();
    finalText = '';
    if (text) sendMessage(text);
    else if (!busy && els.status.dataset.state === 'listening') setStatus('ready');
  };
}

function toggleMic() {
  if (!recognition) return;
  if (listening) { recognition.stop(); return; }
  stopSpeaking(); // so the avatar's own voice isn't picked up by the mic
  if (head && head.audioCtx && head.audioCtx.state === 'suspended') head.audioCtx.resume();
  try { recognition.start(); } catch { /* already started */ }
}

/* ---------- start ---------- */

els.form.addEventListener('submit', e => { e.preventDefault(); sendMessage(els.input.value); });
els.micBtn.addEventListener('click', toggleMic);
els.stopBtn.addEventListener('click', stopSpeaking);

(async function init() {
  try { config = { ...config, ...(await (await fetch('/api/config')).json()) }; } catch { /* use defaults */ }
  els.modeBadge.hidden = !config.mock;
  setupMic();
  addMessage('system', config.mock
    ? 'Demo mode: replies are pre-written' + (config.ttsProvider === 'browser' ? '.' : ' and the voice is a test tone.') + ' Add your Gemini key to talk to the real AI.'
    : 'Say hello to your avatar.');
  await loadAvatar();
})();

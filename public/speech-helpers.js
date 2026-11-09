// Small pure helpers used by app.js (kept separate so they can be unit-tested).

/** Split a reply into short chunks (about one sentence each). */
export function splitSentences(text) {
  const parts = text.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) || [text];
  const chunks = [];
  let buf = '';
  for (const part of parts) {
    buf += part;
    if (buf.trim().length >= 20) { chunks.push(buf.trim()); buf = ''; }
  }
  if (buf.trim()) {
    if (chunks.length) chunks[chunks.length - 1] += ' ' + buf.trim();
    else chunks.push(buf.trim());
  }
  while (chunks.length > 5) { const last = chunks.pop(); chunks[chunks.length - 1] += ' ' + last; }
  return chunks;
}

/**
 * The browser voice cannot tell us when each word is spoken, so we estimate it:
 * every word gets time in proportion to its length, and punctuation adds a short silent pause.
 * Returns word start times and durations in milliseconds (what TalkingHead's speakAudio expects).
 */
export function estimateWordTimings(chunk, totalMs) {
  const words = chunk.split(/\s+/).filter(Boolean);
  const units = words.map(w => {
    const letters = w.replace(/[^\p{L}\p{N}]/gu, '').length;
    const pause = /[.!?]["')\]]*$/.test(w) ? 5 : /[,;:]$/.test(w) ? 3 : 0;
    return { speak: letters + 1.5, pause };
  });
  const total = units.reduce((sum, u) => sum + u.speak + u.pause, 0) || 1;
  const unitMs = totalMs / total;
  const wtimes = [], wdurations = [];
  let t = 0;
  units.forEach(u => {
    wtimes.push(Math.round(t));
    wdurations.push(Math.max(40, Math.round(u.speak * unitMs)));
    t += (u.speak + u.pause) * unitMs;
  });
  return { words, wtimes, wdurations, totalMs };
}

/** Pick a browser voice: the one named in BROWSER_VOICE, else the best match for the language. */
export function pickVoice(voices, lang, preferredName) {
  if (!voices || !voices.length) return null;
  const want = String(preferredName || '').trim().toLowerCase();
  if (want) {
    const hit = voices.find(v => v.name.toLowerCase().includes(want));
    if (hit) return hit;
  }
  const norm = s => String(s || '').toLowerCase().replace('_', '-');
  const base = norm(lang || 'en-US');
  const prefix = base.split('-')[0];
  const exact = voices.filter(v => norm(v.lang) === base);
  const loose = voices.filter(v => norm(v.lang).startsWith(prefix));
  const pool = exact.length ? exact : loose;
  if (!pool.length) return null; // let the browser use its default
  const score = v => (/natural/i.test(v.name) ? 3 : 0) + (/google/i.test(v.name) ? 2 : 0) + (/online/i.test(v.name) ? 1 : 0);
  return [...pool].sort((a, b) => score(b) - score(a))[0];
}

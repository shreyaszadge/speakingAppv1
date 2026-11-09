# Talking Avatar (MVP)

A 3D avatar you can talk to. Speak or type, Gemini answers, your browser's built-in voice (or ElevenLabs / Google
Text-to-Speech) speaks, and [TalkingHead](https://github.com/met4citizen/TalkingHead) animates the mouth.

```
mic / text -> Express /api/chat (Gemini) -> voice (browser, or /api/tts) -> TalkingHead.speakAudio() for the mouth
```

API keys stay on the server (`.env`). The browser never sees them. The voice can be your browser's own (no key).

## 1. Run it with NO keys first (demo mode)

```bash
npm install
cp .env.example .env        # Windows: copy .env.example .env
# open .env and set MOCK_MODE=true
npm start
```

Open http://localhost:3000. In demo mode the replies are pre-written, but the voice is your browser's real voice
and the whole pipeline (chat, speech, lip-sync) runs for real.

## 2. The 3D face

**It works automatically.** On start the browser looks for a model in this order:

1. `AVATAR_URL` from `.env` (if you set it, only that is used)
2. `public/avatars/avatar.glb` (if the file exists)
3. A sample avatar from the TalkingHead project, loaded from the internet (needs internet; non-commercial license)

Each source is checked to be a real `.glb` model before use. If none works, the page shows exactly why
(for example "HTTP 404") and still works as a text chat.

To use a different or more realistic face, put your own `.glb` in `public/avatars/avatar.glb`.
It must have ARKit + Oculus viseme blend shapes (that is what moves the mouth). Options:

**A. One command (sample models from the TalkingHead project, needs internet):**

```bash
npm run get-avatar              # photo-based "Avaturn" sample (most realistic)
npm run get-avatar -- mpfb      # Blender/MPFB human, CC0 license
npm run get-avatar -- brunette  # Ready Player Me style, non-commercial
```

The script checks that the download is a real model before saving it. If it fails, open
https://github.com/met4citizen/TalkingHead/tree/main/avatars, download a `.glb` and save it as `public/avatars/avatar.glb`.

**B. A face that looks like a real person (your own photo):** create an avatar at https://avaturn.me
from a selfie, export it as a `.glb` (use the **T2** avatar type, which TalkingHead supports) and save it as
`public/avatars/avatar.glb`. Then add this to `.env` for a better head angle and eyelids:

```
AVATAR_BASELINE={"headRotateX":-0.05,"eyeBlinkLeft":0.15,"eyeBlinkRight":0.15}
```

**Camera:** `AVATAR_VIEW=head` shows a close-up of the face, `upper` (default) shows head and shoulders.
`AVATAR_BODY=M` or `F` must match the body of your model.

**Licenses matter.** The sample models are for non-commercial use, except MPFB (CC0). Avaturn is free for
non-commercial use. A model you put in `public/` is downloadable by every visitor, so check the terms
before you publish the site.

## 3. Voice and AI

**Voice (default: your browser's own voice, free, no key).** `TTS_PROVIDER=browser` is the default, so you only need a
**Gemini key** (https://aistudio.google.com/apikey -> `GEMINI_API_KEY`) for real AI answers. Set `MOCK_MODE=false`.

- Works best in **Chrome or Edge**. Voices come from your computer; Edge has very natural ones ("Natural" in the name).
- `BROWSER_VOICE=Natural` picks a voice whose name contains that text. Your language is `TTS_LANGUAGE_CODE` (for example `en-IN`).
- **Lip-sync is approximate with browser voices.** The browser cannot say when each word is spoken, so the avatar's mouth
  follows an *estimated* timing. It re-syncs on every sentence and learns your voice's speed as you chat.
  If the mouth is **late**, set `LIPSYNC_OFFSET_MS=-150` (try -100, -200). If it is **early**, use `150`.
- English lip-sync rules are used for the mouth shapes. Other languages will move the mouth, but less accurately.

**Want exact lip-sync?** Use a voice service that reports word timings (costs money or has a free tier):

- **ElevenLabs:** `TTS_PROVIDER=elevenlabs`, `ELEVENLABS_API_KEY` (the long key starting with `sk_`, not the key ID),
  `ELEVENLABS_VOICE_ID` (copy from your Voices page), `ELEVENLABS_MODEL=eleven_flash_v2_5` (fast, cheaper).
- **Google Cloud Text-to-Speech:** `TTS_PROVIDER=google`, `GOOGLE_TTS_API_KEY` (enable the Cloud Text-to-Speech API,
  billing on). Use a Standard, Wavenet, Neural2, News or Casual voice in `TTS_VOICE`.

Restart `npm start` after editing `.env`. The terminal prints the active voice provider.

## How lip-sync works

- **Browser voice:** the voice starts, and at that moment the avatar's mouth is started with estimated word timings
  (longer words take longer, commas and full stops leave a pause) and silent audio of the right length.
  Each sentence is timed separately, and the app remembers how fast your voice really is.
- **ElevenLabs / Google:** the service returns audio plus word timings; `/api/tts` turns them into
  `{ audioContent (MP3, base64), words, wtimes (ms) }`, and the browser calls
  `head.speakAudio({ audio, words, wtimes, wdurations })`. TalkingHead turns the words into mouth shapes.

## If replies feel slow

Every reply goes: your speech -> Gemini -> voice service -> avatar. Under the chat title the app shows
`Last turn: reply X s · voice ready Y s`, and the terminal prints how long each call took
(for example `POST /api/chat -> 200 in 2400 ms`). Use those numbers to find the slow step.

- **Reply is slow:** run `npm run model-test` to time several Gemini models with your own key. It prints the fastest
  one to put in `GEMINI_MODEL`. Smaller flash-lite models are the quickest.
  Also: Gemini "thinking" is on by default in newer models. `GEMINI_THINKING=auto` (default) already asks for
  the lowest setting and falls back automatically. You can force `off`, `minimal`, `low`, or a number (Gemini 2.5).
  A smaller model such as a "flash-lite" one is faster still (`GEMINI_MODEL`).
- **Voice is slow:** the browser voice starts almost at once. With ElevenLabs or Google the voice starts after the FIRST
  sentence is ready (use `ELEVENLABS_MODEL=eleven_flash_v2_5`, the fastest).
- **Avatar is choppy:** this is your PC drawing the 3D face. Use `AVATAR_VIEW=head`, close other browser tabs,
  and use Chrome or Edge.
- **Microphone feels slow:** speech recognition runs in Google's cloud and needs a good internet connection.
- The very first request after starting can be slower than the following ones.

## Notes

- Microphone input uses the browser's SpeechRecognition: **Chrome or Edge**, needs internet, and a microphone permission.
  It works on `localhost`. Firefox does not support it (typing still works).
- TalkingHead and Three.js load from jsDelivr (see the `importmap` in `public/index.html`), so the browser needs internet.
  Versions are pinned there; change them in one place if needed.
- Light on weak PCs: 24 fps, no retina rendering, and no local AI models.
- Tests: `npm test` (backend logic with fake Gemini/Google clients; no keys needed).

## Files

```
server.js         Express app + routes
lib/handlers.js   chat / tts logic (validation, Gemini, Google TTS, mock mode)
public/           index.html, style.css, app.js, speech-helpers.js
scripts/          get-avatar.js (downloads a sample avatar)
test/             node:test unit tests
```

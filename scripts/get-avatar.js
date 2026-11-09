#!/usr/bin/env node
'use strict';
/**
 * Downloads a sample TalkingHead-compatible avatar into public/avatars/avatar.glb
 *   npm run get-avatar            (default: avaturn)
 *   npm run get-avatar -- mpfb
 *   npm run get-avatar -- brunette
 * Sample files come from the TalkingHead repository (met4citizen/TalkingHead, avatars/ folder).
 */
const fs = require('fs');
const path = require('path');

const BASE = process.env.AVATAR_SOURCE_BASE || 'https://raw.githubusercontent.com/met4citizen/TalkingHead/main/avatars/';
const CHOICES = {
  avaturn: { file: 'avatar.glb', note: 'Made with Avaturn (from a photo). Free for NON-commercial use.', env: 'AVATAR_BASELINE={"headRotateX":-0.05,"eyeBlinkLeft":0.15,"eyeBlinkRight":0.15}' },
  mpfb: { file: 'mpfb.glb', note: 'Made with Blender + MPFB. CC0 (free for any use).' },
  brunette: { file: 'brunette.glb', note: 'Made with Ready Player Me. CC BY-NC 4.0 (NON-commercial).' }
};

/** Returns null if the buffer looks like a real GLB, otherwise a human-readable problem. */
function checkGlb(buf) {
  if (!buf || buf.length < 1000) return 'The download is too small to be an avatar.';
  if (buf.toString('utf8', 0, 20).startsWith('version https://git')) return 'Got a Git LFS pointer file instead of the model.';
  if (buf.toString('ascii', 0, 4) !== 'glTF') return 'The downloaded file is not a .glb model.';
  if (buf.length < 50000) return 'The model file is suspiciously small.';
  return null;
}

async function downloadAvatar({ choice = 'avaturn', baseUrl = BASE, outDir = path.join(__dirname, '..', 'public', 'avatars') } = {}) {
  const c = CHOICES[choice];
  if (!c) throw new Error(`Unknown avatar "${choice}". Choose: ${Object.keys(CHOICES).join(', ')}`);
  let res;
  try { res = await fetch(baseUrl + c.file); } catch (e) { throw new Error('Could not reach the download server. Check your internet connection.'); }
  if (!res.ok) throw new Error(`Download failed (HTTP ${res.status}).`);
  const buf = Buffer.from(await res.arrayBuffer());
  const problem = checkGlb(buf);
  if (problem) throw new Error(problem);
  fs.mkdirSync(outDir, { recursive: true });
  const target = path.join(outDir, 'avatar.glb');
  fs.writeFileSync(target, buf);
  return { target, bytes: buf.length, ...c };
}

module.exports = { downloadAvatar, checkGlb, CHOICES };

if (require.main === module) {
  const choice = process.argv[2] || 'avaturn';
  downloadAvatar({ choice }).then(r => {
    console.log(`Saved ${r.target} (${(r.bytes / 1048576).toFixed(1)} MB)`);
    console.log(r.note);
    if (r.env) console.log('For the best look, add this line to .env:\n  ' + r.env);
    console.log('Restart the server (npm start) and refresh the page.');
  }).catch(err => {
    console.error('\nCould not get the avatar: ' + err.message);
    console.error('Manual option: open https://github.com/met4citizen/TalkingHead/tree/main/avatars');
    console.error('download a .glb and save it as public/avatars/avatar.glb');
    process.exit(1);
  });
}

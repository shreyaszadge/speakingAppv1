#!/usr/bin/env node
'use strict';
/**
 * Times your Gemini models with YOUR key, through the same code path the app uses.
 *   npm run model-test
 *   npm run model-test -- gemini-3.5-flash-lite gemini-2.5-flash
 */
const { createHandlers } = require('../lib/handlers');

const DEFAULT_MODELS = ['gemini-flash-lite-latest', 'gemini-3.5-flash-lite', 'gemini-2.5-flash-lite', 'gemini-3.6-flash', 'gemini-2.5-flash', 'gemini-flash-latest'];
const PROMPT = 'Say hello and ask how my day is going, in one short friendly sentence.';

async function timeModels({ models, config, geminiClient, runs = 2, now = () => Date.now() }) {
  const results = [];
  for (const model of models) {
    const h = createHandlers({ config: { ...config, geminiModel: model }, geminiClient });
    const times = [];
    let error = null, reply = '';
    for (let i = 0; i < runs; i++) {
      const started = now();
      const out = await h.chat({ message: PROMPT });
      if (out.status !== 200) { error = out.body.error; break; }
      times.push(now() - started); reply = out.body.reply;
    }
    results.push({ model, times, error, reply });
  }
  // working models first, fastest first
  return results.sort((a, b) => (a.error ? 1 : 0) - (b.error ? 1 : 0) || Math.min(...a.times) - Math.min(...b.times));
}

module.exports = { timeModels, DEFAULT_MODELS };

if (require.main === module) {
  require('dotenv').config();
  const key = process.env.GEMINI_API_KEY;
  if (!key) { console.error('GEMINI_API_KEY is not set in .env'); process.exit(1); }
  const models = process.argv.length > 2 ? process.argv.slice(2) : DEFAULT_MODELS;
  console.log(`Timing ${models.length} models (2 calls each, this takes a minute)...\n`);
  timeModels({ models, config: { mock: false, geminiApiKey: key, geminiThinking: process.env.GEMINI_THINKING } }).then(results => {
    for (const r of results) {
      if (r.error) console.log(`  FAILED  ${r.model}\n          ${r.error}`);
      else console.log(`  ${(Math.min(...r.times) / 1000).toFixed(1)}s  ${r.model}   (calls: ${r.times.map(t => (t / 1000).toFixed(1) + 's').join(', ')})`);
    }
    const best = results.find(r => !r.error);
    if (best) console.log(`\nFastest working model: ${best.model}\nPut this in .env:  GEMINI_MODEL=${best.model}`);
  });
}

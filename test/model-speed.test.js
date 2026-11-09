'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { timeModels } = require('../scripts/model-speed');

test('timeModels: runs each model twice, ranks working ones fastest-first, failures last', async () => {
  let clock = 0;
  const cost = { slow: 3000, fast: 400, mid: 1200 };
  const fake = { models: { generateContent: async ({ model }) => {
    if (model === 'gone') { const e = new Error('not found'); e.status = 404; throw e; }
    clock += cost[model]; return { text: 'Hello! How is your day?' };
  } } };
  const res = await timeModels({ models: ['slow', 'gone', 'fast', 'mid'], config: { mock: false, geminiApiKey: 'k' }, geminiClient: fake, now: () => clock });
  assert.deepEqual(res.map(r => r.model), ['fast', 'mid', 'slow', 'gone']);
  assert.deepEqual(res[0].times, [400, 400]);
  assert.match(res[3].error, /GEMINI_MODEL/);
});

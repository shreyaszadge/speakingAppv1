'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHandlers, thinkingVariants } = require('../lib/handlers');

const cfg = (extra = {}) => ({ mock: false, geminiApiKey: 'k', geminiModel: 'm', ...extra });
const badRequest = msg => { const e = new Error(msg); e.status = 400; return e; };

test('thinkingVariants parses settings', () => {
  assert.deepEqual(thinkingVariants(undefined), [{ thinkingLevel: 'low' }, { thinkingBudget: 0 }, null]);
  assert.deepEqual(thinkingVariants('off'), [null]);
  assert.deepEqual(thinkingVariants('MINIMAL'), [{ thinkingLevel: 'minimal' }]);
  assert.deepEqual(thinkingVariants('512'), [{ thinkingBudget: 512 }]);
  assert.equal(thinkingVariants('banana').length, 3);
});

test('auto: steps down level -> budget 0 and remembers what worked', async () => {
  const seen = [];
  const fake = { models: { generateContent: async a => {
    const t = a.config.thinkingConfig; seen.push(t);
    if (t && t.thinkingLevel) throw badRequest('thinking_level is not supported by this model');
    return { text: 'ok' };
  } } };
  const h = createHandlers({ config: cfg(), geminiClient: fake });
  assert.equal((await h.chat({ message: 'hi' })).body.reply, 'ok');
  assert.deepEqual(seen, [{ thinkingLevel: 'low' }, { thinkingBudget: 0 }]);
  seen.length = 0;
  await h.chat({ message: 'again' });
  assert.deepEqual(seen, [{ thinkingBudget: 0 }], 'second request must not retry the failed variant');
});

test('auto: falls back to no thinkingConfig when both are rejected', async () => {
  const seen = [];
  const fake = { models: { generateContent: async a => {
    seen.push(a.config.thinkingConfig);
    if (a.config.thinkingConfig) throw badRequest('thinking config invalid');
    return { text: 'fine' };
  } } };
  assert.equal((await createHandlers({ config: cfg(), geminiClient: fake }).chat({ message: 'hi' })).body.reply, 'fine');
  assert.deepEqual(seen, [{ thinkingLevel: 'low' }, { thinkingBudget: 0 }, undefined]);
});

test('unrelated 400 (bad API key) is NOT treated as a thinking problem', async () => {
  let calls = 0;
  const fake = { models: { generateContent: async () => { calls++; throw badRequest('API key not valid. Please pass a valid API key.'); } } };
  const out = await createHandlers({ config: cfg(), geminiClient: fake }).chat({ message: 'hi' });
  assert.equal(calls, 1);
  assert.match(out.body.error, /API key/);
});

test('GEMINI_THINKING=off sends no thinkingConfig; token limit leaves room for thinking', async () => {
  let seen;
  const fake = { models: { generateContent: async a => { seen = a.config; return { text: 'x' }; } } };
  await createHandlers({ config: cfg({ geminiThinking: 'off' }), geminiClient: fake }).chat({ message: 'hi' });
  assert.ok(!('thinkingConfig' in seen));
  assert.ok(seen.maxOutputTokens >= 1024);
  assert.ok(!('temperature' in seen), 'newer Gemini models reject the temperature setting');
});

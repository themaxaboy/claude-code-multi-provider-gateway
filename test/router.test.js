import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from '../src/router.js';

const cfg = {
  providers: {
    openrouter: { base_url: 'https://openrouter.ai/api', api_key: 'sk-or' },
    z_ai: { base_url: 'https://api.z.ai/api/anthropic', api_key: 'sk-z' },
  },
  models: {
    minimax: { model: 'minimax-m3:free', provider: 'openrouter' },
    glm: { model: 'glm-4.6', provider: 'z_ai' },
  },
};

test('known alias picks the provider and rewrites body.model', () => {
  const r = resolve({ model: 'glm', max_tokens: 100 }, cfg);
  assert.equal(r.providerName, 'z_ai');
  assert.equal(r.provider.base_url, 'https://api.z.ai/api/anthropic');
  assert.equal(r.body.model, 'glm-4.6');
  assert.equal(r.model, 'glm', 'the log should show the alias');
  assert.equal(r.rewritten, true);
  assert.equal(r.body.max_tokens, 100, 'other fields survive');
});

test('does not mutate the caller body', () => {
  const body = { model: 'glm' };
  resolve(body, cfg);
  assert.equal(body.model, 'glm');
});

test('unknown model goes to Anthropic with the body untouched', () => {
  const body = { model: 'claude-sonnet-4-5-20250929' };
  const r = resolve(body, cfg);
  assert.equal(r.providerName, null);
  assert.equal(r.provider, null);
  assert.equal(r.rewritten, false);
  assert.equal(r.body.model, 'claude-sonnet-4-5-20250929');
});

test('[1m] is stripped for lookup but kept on the Anthropic path', () => {
  const anthropic = resolve({ model: 'claude-sonnet-4-5-20250929[1m]' }, cfg);
  assert.equal(anthropic.providerName, null);
  assert.equal(
    anthropic.body.model,
    'claude-sonnet-4-5-20250929[1m]',
    'stripping it here would break the 1M context window',
  );

  const mapped = resolve({ model: 'minimax[1m]' }, cfg);
  assert.equal(mapped.providerName, 'openrouter');
  assert.equal(mapped.body.model, 'minimax-m3:free', 'other providers do not know [1m]');
});

test('[1M] uppercase is stripped too', () => {
  const r = resolve({ model: 'minimax[1M]' }, cfg);
  assert.equal(r.providerName, 'openrouter');
});

test('missing or non-string model falls back to Anthropic', () => {
  for (const body of [null, undefined, {}, { model: 42 }]) {
    const r = resolve(body, cfg);
    assert.equal(r.providerName, null);
    assert.equal(r.rewritten, false);
  }
});

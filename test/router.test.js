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
    // Both spellings of the same word, so the precedence below is testable.
    edge: { model: 'edge-1', provider: 'z_ai' },
    'anthropic/edge': { model: 'edge-literal', provider: 'openrouter' },
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

// ------------------------------------------------- the model discovery prefix
//
// Aliases Claude Code would filter out of its picker are advertised as
// `anthropic/<alias>` (see src/models.js), so that spelling comes back here.

test('an anthropic/ prefixed alias resolves to the alias', () => {
  const r = resolve({ model: 'anthropic/minimax', max_tokens: 5 }, cfg);
  assert.equal(r.providerName, 'openrouter');
  assert.equal(r.body.model, 'minimax-m3:free');
  assert.equal(r.model, 'minimax', 'the log should show the bare alias');
  assert.equal(r.rewritten, true);
  assert.equal(r.body.max_tokens, 5);
});

test('an anthropic/ prefixed alias with [1m] resolves too', () => {
  // Order matters: suffix first, then prefix. The other way round leaves the
  // suffix glued on and misses.
  const r = resolve({ model: 'anthropic/minimax[1m]' }, cfg);
  assert.equal(r.providerName, 'openrouter');
  assert.equal(r.body.model, 'minimax-m3:free');
  assert.equal(r.model, 'minimax');
});

test('an alias literally named anthropic/x beats the prefixed spelling of x', () => {
  const r = resolve({ model: 'anthropic/edge' }, cfg);
  assert.equal(r.providerName, 'openrouter');
  assert.equal(r.body.model, 'edge-literal');
  assert.equal(r.model, 'anthropic/edge');
});

test('an unknown prefixed name still goes to Anthropic untouched', () => {
  for (const model of ['anthropic/nope', 'anthropic/', 'anthropic']) {
    const r = resolve({ model }, cfg);
    assert.equal(r.providerName, null, model);
    assert.equal(r.rewritten, false, model);
    assert.equal(r.body.model, model, model);
  }
});

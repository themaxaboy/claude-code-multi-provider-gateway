// The model list Claude Code discovers. Pure — no server, no filesystem.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildModelList,
  discoveryIdFor,
  displayNameFor,
  localModelEntries,
  passesDiscoveryFilter,
  stripDiscoveryPrefix,
} from '../src/models.js';

const cfg = {
  providers: { openrouter: {}, z_ai: {} },
  models: {
    minimax: { model: 'minimax-m3:free', provider: 'openrouter' },
    glm: { model: 'glm-4.6', provider: 'z_ai' },
  },
};

const ids = (list) => list.data.map((entry) => entry.id);

// ------------------------------------------------------------- the filter

test('an alias Claude Code would drop is advertised prefixed', () => {
  assert.equal(discoveryIdFor('minimax'), 'anthropic/minimax');
  assert.equal(discoveryIdFor('qwen3-coder'), 'anthropic/qwen3-coder');
});

test('an alias that already survives the filter is advertised verbatim', () => {
  for (const alias of ['claude-fast', 'my-anthropic-router', 'Claude-X', 'vertex/claude-x']) {
    assert.equal(discoveryIdFor(alias), alias, alias);
  }
});

test('every advertised id survives Claude Code filter', () => {
  // The whole feature rests on this: an id that fails the filter never reaches
  // the picker, so the model it names is undiscoverable.
  const adversarial = {
    providers: { p: {} },
    models: Object.fromEntries(
      ['minimax', 'glm', 'kimi', 'qwen3-coder', 'deepseek', 'claude-fast', 'sonnet', 'gpt-5'].map(
        (alias) => [alias, { model: 'x', provider: 'p' }],
      ),
    ),
  };

  for (const id of ids(buildModelList(adversarial, null))) {
    assert.ok(passesDiscoveryFilter(id), `${id} would be dropped by Claude Code`);
  }
});

test('stripDiscoveryPrefix is the exact inverse, and refuses everything else', () => {
  assert.equal(stripDiscoveryPrefix('anthropic/minimax'), 'minimax');
  assert.equal(stripDiscoveryPrefix('anthropic/'), null, 'must not become a lookup of ""');
  assert.equal(stripDiscoveryPrefix('anthropic'), null);
  assert.equal(stripDiscoveryPrefix('Anthropic/x'), null, 'matching is exact-case');
  assert.equal(stripDiscoveryPrefix('claude/x'), null);
  for (const value of [null, undefined, 42, {}]) assert.equal(stripDiscoveryPrefix(value), null);
});

// -------------------------------------------------------------- the entries

test('a local entry names the alias and its provider', () => {
  const [minimax] = localModelEntries(cfg);
  assert.deepEqual(minimax, {
    type: 'model',
    id: 'anthropic/minimax',
    display_name: 'minimax (openrouter)',
  });
  assert.ok(!('created_at' in minimax), 'there is no honest date for an alias');
});

test('display_name degrades gracefully without a provider', () => {
  assert.equal(displayNameFor('minimax', undefined), 'minimax');
});

test('the envelope is Anthropic shaped', () => {
  const list = buildModelList(cfg, null);
  assert.equal(list.has_more, false);
  assert.equal(list.first_id, 'anthropic/minimax');
  assert.equal(list.last_id, 'anthropic/glm');
});

test('an empty config yields an empty list, not a throw', () => {
  for (const empty of [{}, { models: {} }, null, undefined]) {
    const list = buildModelList(empty, null);
    assert.deepEqual(list.data, []);
    assert.equal(list.first_id, null);
    assert.equal(list.last_id, null);
  }
});

// --------------------------------------------------------------- the merge

test('upstream entries are appended after the local ones, verbatim', () => {
  const upstream = [
    { id: 'claude-opus-4-5', display_name: 'Claude Opus 4.5', created_at: '2025-11-01T00:00:00Z' },
  ];
  const list = buildModelList(cfg, upstream);

  assert.deepEqual(ids(list), ['anthropic/minimax', 'anthropic/glm', 'claude-opus-4-5']);
  assert.deepEqual(list.data[2], upstream[0], 'upstream keeps its own fields');
  assert.equal(list.last_id, 'claude-opus-4-5');
});

test('a local alias wins an id collision', () => {
  const shadowing = {
    providers: { p: {} },
    models: { 'claude-opus-4-5': { model: 'something-else', provider: 'p' } },
  };
  const list = buildModelList(shadowing, [{ id: 'claude-opus-4-5', display_name: 'Claude Opus 4.5' }]);

  assert.deepEqual(ids(list), ['claude-opus-4-5'], 'exactly one entry');
  assert.equal(list.data[0].display_name, 'claude-opus-4-5 (p)', 'the routable one wins');
});

test('junk from upstream degrades to the local list', () => {
  for (const junk of [undefined, null, [], 'nope', 42, { data: [] }]) {
    assert.deepEqual(ids(buildModelList(cfg, junk)), ['anthropic/minimax', 'anthropic/glm'], String(junk));
  }
});

test('junk entries inside a good upstream array are skipped', () => {
  const list = buildModelList(cfg, [{}, { id: 42 }, null, { id: 'claude-ok' }]);
  assert.deepEqual(ids(list), ['anthropic/minimax', 'anthropic/glm', 'claude-ok']);
});

test('a duplicate upstream id appears once', () => {
  const list = buildModelList(cfg, [{ id: 'claude-ok' }, { id: 'claude-ok' }]);
  assert.deepEqual(ids(list), ['anthropic/minimax', 'anthropic/glm', 'claude-ok']);
});

// ------------------------------------------------------------- precedence

test('an alias literally named anthropic/x beats the prefixed spelling of x', () => {
  // Must match the precedence in router.js, or we advertise an id that routes
  // somewhere other than where the picker row says.
  const clashing = {
    providers: { a: {}, b: {} },
    models: {
      edge: { model: 'edge-1', provider: 'a' },
      'anthropic/edge': { model: 'edge-literal', provider: 'b' },
    },
  };
  const list = buildModelList(clashing, null);

  assert.deepEqual(ids(list), ['anthropic/edge'], 'one id, one owner');
  assert.equal(list.data[0].display_name, 'anthropic/edge (b)', 'the literal alias owns it');
});

test('nothing passed in is mutated', () => {
  const config = structuredClone(cfg);
  const upstream = [{ id: 'claude-ok' }];
  const upstreamCopy = structuredClone(upstream);

  buildModelList(config, upstream);

  assert.deepEqual(config, cfg);
  assert.deepEqual(upstream, upstreamCopy);
});

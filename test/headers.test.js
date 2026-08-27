import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRequestHeaders, buildResponseHeaders } from '../src/headers.js';

const incoming = {
  host: '127.0.0.1:8787',
  'content-length': '1234',
  'transfer-encoding': 'chunked',
  connection: 'keep-alive',
  'accept-encoding': 'gzip, br',
  'x-api-key': 'sk-ant-oauth-token',
  authorization: 'Bearer sk-ant-oauth-token',
  'anthropic-version': '2023-06-01',
  'anthropic-beta': 'oauth-2025-04-20, fine-grained-tool-streaming-2025-05-14',
  'user-agent': 'claude-cli/2.0.0',
};

const provider = { base_url: 'https://openrouter.ai/api', api_key: 'sk-or-v1-abc' };

test('hop-by-hop headers are dropped on both paths', () => {
  for (const target of [null, provider]) {
    const h = buildRequestHeaders(incoming, target);
    for (const key of ['host', 'content-length', 'transfer-encoding', 'connection']) {
      assert.equal(h[key], undefined, `${key} must not be forwarded`);
    }
  }
});

test('accept-encoding is forced to identity', () => {
  assert.equal(buildRequestHeaders(incoming, null)['accept-encoding'], 'identity');
  assert.equal(buildRequestHeaders(incoming, provider)['accept-encoding'], 'identity');
});

test('the Anthropic path forwards every credential header untouched', () => {
  const h = buildRequestHeaders(incoming, null);
  assert.equal(h['x-api-key'], 'sk-ant-oauth-token');
  assert.equal(h.authorization, 'Bearer sk-ant-oauth-token');
  assert.equal(h['anthropic-beta'], 'oauth-2025-04-20, fine-grained-tool-streaming-2025-05-14');
  assert.equal(h['anthropic-version'], '2023-06-01');
});

test('the provider path overwrites auth and removes x-api-key', () => {
  const h = buildRequestHeaders(incoming, provider);
  assert.equal(h.authorization, 'Bearer sk-or-v1-abc');
  assert.equal(h['x-api-key'], undefined, 'otherwise the provider sees two credentials');
});

test('only the oauth beta is stripped; other betas stay', () => {
  const h = buildRequestHeaders(incoming, provider);
  assert.equal(h['anthropic-beta'], 'fine-grained-tool-streaming-2025-05-14');
});

test('anthropic-beta is removed entirely when oauth was its only value', () => {
  const h = buildRequestHeaders({ 'anthropic-beta': 'oauth-2025-04-20' }, provider);
  assert.equal('anthropic-beta' in h, false);
});

test('a provider without api_key still gets no inbound credential', () => {
  // The leak this guards: with nothing to replace it with, the user's Anthropic
  // key must be dropped rather than forwarded to whatever base_url points at.
  const h = buildRequestHeaders(incoming, { base_url: 'http://127.0.0.1:8888' });
  assert.equal(h.authorization, undefined);
  assert.equal(h['x-api-key'], undefined);
  // ...and the request is still built, so keyless local endpoints keep working.
  assert.equal(h['anthropic-version'], '2023-06-01');
});

test('an api_key that resolved to an empty string is not a credential', () => {
  const h = buildRequestHeaders(incoming, { base_url: 'https://openrouter.ai/api', api_key: '' });
  assert.equal(h.authorization, undefined);
  assert.equal(h['x-api-key'], undefined);
});

test('cookie and proxy-authorization never reach a provider', () => {
  const withExtras = { ...incoming, cookie: 'session=secret', 'proxy-authorization': 'Basic abc' };
  const h = buildRequestHeaders(withExtras, provider);
  assert.equal(h.cookie, undefined);
  assert.equal(h['proxy-authorization'], undefined);
  assert.equal(h.authorization, 'Bearer sk-or-v1-abc');
});


test('array header values are joined', () => {
  const h = buildRequestHeaders({ 'x-multi': ['a', 'b'] }, null);
  assert.equal(h['x-multi'], 'a, b');
});

test('response headers drop hop-by-hop and content-encoding', () => {
  const h = buildResponseHeaders(
    new Headers({
      'content-type': 'text/event-stream',
      'content-encoding': 'gzip',
      'transfer-encoding': 'chunked',
      'request-id': 'req_123',
    }),
  );
  assert.equal(h['content-type'], 'text/event-stream');
  assert.equal(h['request-id'], 'req_123');
  assert.equal(h['content-encoding'], undefined);
  assert.equal(h['transfer-encoding'], undefined);
});

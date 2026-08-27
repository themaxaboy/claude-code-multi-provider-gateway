import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer } from '../src/server.js';
import { normalize } from '../src/config.js';

/** A stub upstream that records what it received and streams a canned SSE body. */
function stubUpstream(sseBody) {
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.push({
        method: req.method,
        url: req.url,
        headers: { ...req.headers },
        body: Buffer.concat(chunks).toString(),
      });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      // deliberately split so the proxy has to reassemble
      const half = Math.floor(sseBody.length / 2);
      res.write(sseBody.slice(0, half));
      setTimeout(() => res.end(sseBody.slice(half)), 5);
    });
  });
  return { server, received };
}

function listen(server) {
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res(server.address().port)));
}

function close(server) {
  return new Promise((res) => server.close(res));
}

const SSE =
  'event: message_start\n' +
  'data: {"type":"message_start","message":{"usage":{"input_tokens":11,"cache_read_input_tokens":9}}}\n\n' +
  'event: message_delta\n' +
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":22}}\n\n';

async function post(port, body, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages?beta=true`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text(), headers: res.headers };
}

/** Boots a provider stub, an Anthropic stub and the gateway in front of both. */
async function harness(t) {
  const provider = stubUpstream(SSE);
  const anthropic = stubUpstream(SSE);
  const providerPort = await listen(provider.server);
  const anthropicPort = await listen(anthropic.server);

  const cfg = normalize(
    {
      providers: { openrouter: { base_url: `http://127.0.0.1:${providerPort}`, api_key: 'sk-or-v1-secret' } },
      models: { minimax: { model: 'minimax-m3:free', provider: 'openrouter' } },
    },
    { env: {} },
  );

  const gateway = createServer(cfg, { anthropicBaseUrl: `http://127.0.0.1:${anthropicPort}` });
  const gatewayPort = await listen(gateway);

  t.after(async () => {
    await close(gateway);
    await close(provider.server);
    await close(anthropic.server);
  });

  return { provider, anthropic, gatewayPort };
}

test('a mapped alias reaches the provider with the model rewritten', async (t) => {
  const { provider, anthropic, gatewayPort } = await harness(t);

  const res = await post(gatewayPort, { model: 'minimax', max_tokens: 5 }, {
    'x-api-key': 'sk-ant-user',
    'anthropic-beta': 'oauth-2025-04-20, other-beta',
  });

  assert.equal(res.status, 200);
  assert.equal(anthropic.received.length, 0, 'must not touch Anthropic');
  assert.equal(provider.received.length, 1);

  const hit = provider.received[0];
  assert.equal(hit.url, '/v1/messages?beta=true', 'path and query are preserved');
  assert.equal(JSON.parse(hit.body).model, 'minimax-m3:free');
  assert.equal(JSON.parse(hit.body).max_tokens, 5);
  assert.equal(hit.headers.authorization, 'Bearer sk-or-v1-secret');
  assert.equal(hit.headers['x-api-key'], undefined, 'the user credential must not leak to the provider');
  assert.equal(hit.headers['anthropic-beta'], 'other-beta');
  assert.equal(hit.headers['accept-encoding'], 'identity');
});

test('an unmapped model falls through to Anthropic with credentials intact', async (t) => {
  const { provider, anthropic, gatewayPort } = await harness(t);

  await post(gatewayPort, { model: 'claude-sonnet-4-5-20250929[1m]' }, {
    'x-api-key': 'sk-ant-user',
    'anthropic-beta': 'oauth-2025-04-20',
  });

  assert.equal(provider.received.length, 0);
  assert.equal(anthropic.received.length, 1);

  const hit = anthropic.received[0];
  assert.equal(JSON.parse(hit.body).model, 'claude-sonnet-4-5-20250929[1m]', '[1m] must survive');
  assert.equal(hit.headers['x-api-key'], 'sk-ant-user');
  assert.equal(hit.headers['anthropic-beta'], 'oauth-2025-04-20', 'oauth beta is kept for Anthropic');
});

test('the streamed body arrives byte-for-byte', async (t) => {
  const { gatewayPort } = await harness(t);
  const res = await post(gatewayPort, { model: 'minimax' });
  assert.equal(res.text, SSE);
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
});

test('a GET with no body goes to Anthropic', async (t) => {
  const { provider, anthropic, gatewayPort } = await harness(t);
  await fetch(`http://127.0.0.1:${gatewayPort}/v1/models`);
  assert.equal(provider.received.length, 0);
  assert.equal(anthropic.received.length, 1);
  assert.equal(anthropic.received[0].method, 'GET');
});

test('an unreachable upstream returns 502 in Anthropic error shape', async (t) => {
  const cfg = normalize(
    {
      providers: { dead: { base_url: 'http://127.0.0.1:1', api_key: 'k' } },
      models: { ghost: { model: 'ghost-1', provider: 'dead' } },
    },
    { env: {} },
  );
  const gateway = createServer(cfg);
  const port = await listen(gateway);
  t.after(() => close(gateway));

  const res = await post(port, { model: 'ghost' });
  assert.equal(res.status, 502);
  const payload = JSON.parse(res.text);
  assert.equal(payload.type, 'error');
  assert.equal(payload.error.type, 'upstream_unreachable');
});

test('a non-JSON body is forwarded untouched to Anthropic', async (t) => {
  const { anthropic, gatewayPort } = await harness(t);
  await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: 'not json at all',
  });
  assert.equal(anthropic.received[0].body, 'not json at all');
});

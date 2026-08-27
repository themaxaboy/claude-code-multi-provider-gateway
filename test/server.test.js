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
  // /v1/models itself is answered locally now, so this uses retrieve-by-id -
  // which doubles as the guard that only the list endpoint was intercepted.
  const { provider, anthropic, gatewayPort } = await harness(t);
  await fetch(`http://127.0.0.1:${gatewayPort}/v1/models/claude-opus-4-5-20251101`);
  assert.equal(provider.received.length, 0);
  assert.equal(anthropic.received.length, 1);
  assert.equal(anthropic.received[0].method, 'GET');
  assert.equal(anthropic.received[0].url, '/v1/models/claude-opus-4-5-20251101');
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

/** Resolves once `check` returns true, or rejects after `ms`. */
async function waitFor(check, ms = 4000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timed out waiting for condition');
}

test('a client that hangs up mid-stream aborts the upstream request', async (t) => {
  // Without this the provider keeps streaming — and keeps charging — into a
  // socket nobody is reading. Esc mid-turn does exactly this.
  let upstreamAborted = false;
  let streaming = false;

  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: ping\ndata: {"type":"ping"}\n\n');
      streaming = true;
      // Deliberately never ended: only the client going away can close this.
    });
    res.on('close', () => {
      if (!res.writableEnded) upstreamAborted = true;
    });
  });

  const upstreamPort = await listen(upstream);
  const cfg = normalize({ providers: {}, models: {} }, { env: {} });
  const gateway = createServer(cfg, { anthropicBaseUrl: `http://127.0.0.1:${upstreamPort}` });
  const gatewayPort = await listen(gateway);

  t.after(async () => {
    await close(gateway);
    await close(upstream);
  });

  const request = http.request({
    host: '127.0.0.1',
    port: gatewayPort,
    path: '/v1/messages',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });
  request.on('error', () => {}); // destroying it below is the point
  request.end(JSON.stringify({ model: 'claude-sonnet-4', stream: true }));

  await waitFor(() => streaming);
  assert.equal(upstreamAborted, false, 'still connected while the client is listening');

  request.destroy();

  await waitFor(() => upstreamAborted);
  assert.equal(upstreamAborted, true);
});

// ------------------------------------------------------------ model discovery
//
// GET /v1/models is the one path the gateway answers itself. Every case here
// MUST pass an anthropicBaseUrl pointing at a stub: without one the best-effort
// merge fires at the real api.anthropic.com from whatever machine runs the suite.

/** A stub that answers /v1/models however the test says, and records the call. */
function stubModels(respond) {
  const received = [];
  const server = http.createServer((req, res) => {
    received.push({ method: req.method, url: req.url, headers: { ...req.headers } });
    respond(req, res);
  });
  return { server, received };
}

/** The gateway, a provider stub, and an Anthropic stub with a scripted /v1/models. */
async function discoveryHarness(t, respond, { modelsMergeTimeoutMs } = {}) {
  const provider = stubUpstream(SSE);
  const anthropic = stubModels(respond);
  const providerPort = await listen(provider.server);
  const anthropicPort = await listen(anthropic.server);

  const cfg = normalize(
    {
      providers: { openrouter: { base_url: `http://127.0.0.1:${providerPort}`, api_key: 'sk-or-v1-secret' } },
      models: { minimax: { model: 'minimax-m3:free', provider: 'openrouter' } },
    },
    { env: {} },
  );

  const gateway = createServer(cfg, {
    anthropicBaseUrl: `http://127.0.0.1:${anthropicPort}`,
    modelsMergeTimeoutMs,
  });
  const gatewayPort = await listen(gateway);

  t.after(async () => {
    await close(gateway);
    await close(provider.server);
    await close(anthropic.server);
  });

  return { provider, anthropic, gatewayPort };
}

const jsonModels = (body) => (req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const UPSTREAM_LIST = {
  data: [{ id: 'claude-opus-4-5', display_name: 'Claude Opus 4.5', created_at: '2025-11-01T00:00:00Z' }],
  has_more: false,
};

async function getModels(port, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/models?limit=1000`, { headers });
  return { status: res.status, headers: res.headers, body: JSON.parse(await res.text()) };
}

test('GET /v1/models merges the configured aliases with Anthropic', async (t) => {
  const { provider, anthropic, gatewayPort } = await discoveryHarness(t, jsonModels(UPSTREAM_LIST));

  const res = await getModels(gatewayPort);

  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/json');
  assert.deepEqual(
    res.body.data.map((m) => m.id),
    ['anthropic/minimax', 'claude-opus-4-5'],
  );
  assert.equal(res.body.data[0].display_name, 'minimax (openrouter)');
  assert.equal(res.body.has_more, false);

  assert.equal(provider.received.length, 0, 'discovery must never touch a provider');
  assert.equal(anthropic.received[0].url, '/v1/models?limit=1000', 'the query is forwarded');
});

test('the caller credential reaches the merge', async (t) => {
  const { anthropic, gatewayPort } = await discoveryHarness(t, jsonModels(UPSTREAM_LIST));

  await getModels(gatewayPort, {
    'x-api-key': 'sk-ant-user',
    'anthropic-beta': 'oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14',
  });

  const seen = anthropic.received[0].headers;
  assert.equal(seen['x-api-key'], 'sk-ant-user');
  // Without this beta value an OAuth Bearer is refused, so it has to survive.
  assert.match(seen['anthropic-beta'], /oauth-2025-04-20/);
});

test('an upstream that fails still serves the local aliases', async (t) => {
  const cases = [
    ['500', (req, res) => { res.writeHead(500); res.end('boom'); }],
    ['HTML', (req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<h1>hi</h1>'); }],
    ['a redirect', (req, res) => { res.writeHead(302, { location: 'https://elsewhere/v1/models' }); res.end(); }],
    ['no data array', jsonModels({ ok: true })],
  ];

  for (const [label, respond] of cases) {
    const { gatewayPort } = await discoveryHarness(t, respond);
    const res = await getModels(gatewayPort);
    assert.equal(res.status, 200, label);
    assert.deepEqual(res.body.data.map((m) => m.id), ['anthropic/minimax'], label);
  }
});

test('an upstream that hangs is abandoned well inside Claude Code budget', async (t) => {
  // Claude Code gives discovery 3s total and treats an overrun as no list at all.
  const { gatewayPort } = await discoveryHarness(t, () => {}, { modelsMergeTimeoutMs: 100 });

  const started = Date.now();
  const res = await getModels(gatewayPort);

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.map((m) => m.id), ['anthropic/minimax']);
  assert.ok(Date.now() - started < 3000, 'must not eat the whole discovery budget');
});

test('HEAD /v1/models is a bodyless 200 with an honest content-length', async (t) => {
  const { gatewayPort } = await discoveryHarness(t, jsonModels(UPSTREAM_LIST));

  const get = await fetch(`http://127.0.0.1:${gatewayPort}/v1/models`);
  const length = (await get.text()).length;

  const head = await fetch(`http://127.0.0.1:${gatewayPort}/v1/models`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal((await head.text()).length, 0);
  assert.equal(head.headers.get('content-length'), String(length));
});

test('a discovered id routes back to its provider', async (t) => {
  // The only test that proves what we advertise and what we route agree.
  const { provider, gatewayPort } = await discoveryHarness(t, jsonModels(UPSTREAM_LIST));

  const res = await getModels(gatewayPort);
  const advertised = res.body.data[0].id;
  assert.equal(advertised, 'anthropic/minimax');

  await post(gatewayPort, { model: advertised, max_tokens: 10 });

  assert.equal(provider.received.length, 1);
  assert.equal(JSON.parse(provider.received[0].body).model, 'minimax-m3:free');
});

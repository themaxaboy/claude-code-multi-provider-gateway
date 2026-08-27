// Anything Claude Code does straight against api.anthropic.com must behave
// identically through the gateway.
//
// Every case issues the SAME request twice - once direct to a stub standing in
// for api.anthropic.com, once through ccmpg - and compares what the stub saw
// and what the caller got back.
//
// GET and HEAD on /v1/models are the one documented exception: the gateway
// answers those itself (model discovery - see test/models.test.js and the
// discovery section of test/server.test.js). Do NOT add a parity case for that
// path. bothWays reads seen.at(-1), so on an intercepted path the gateway leg
// silently reuses the DIRECT observation and assertParity passes while testing
// nothing at all. /v1/models/{id} is still a passthrough and is covered below.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { createServer } from '../src/server.js';
import { normalize } from '../src/config.js';

/** Headers that legitimately differ between the two runs. */
const VOLATILE = new Set(['host', 'accept-encoding', 'connection', 'content-length']);

function stripVolatile(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!VOLATILE.has(k.toLowerCase())) out[k.toLowerCase()] = v;
  }
  return out;
}

function listen(server) {
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
}
/**
 * Track every TCP connection a server accepts.
 *
 * An upgraded socket is detached from the HTTP server, so closeAllConnections()
 * no longer knows about it and server.close() would wait on it forever.
 */
function trackSockets(server, sockets) {
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
}

function shutdown(servers, sockets) {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  return Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
}

async function harness(t, respond) {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      seen.push({ method: req.method, url: req.url, headers: { ...req.headers }, body });
      respond(req, res, body);
    });
  });
  upstream.on('upgrade', (req, socket) => {
    seen.push({ method: req.method, url: req.url, headers: { ...req.headers }, upgrade: true });
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.write('FRAME-1');
    socket.on('data', (d) => socket.write(`ECHO:${d}`));
  });

  const upPort = await listen(upstream);

  // no providers: every request takes the Anthropic passthrough path
  const cfg = normalize({ providers: {}, models: {} }, { env: {} });
  const gateway = createServer(cfg, { anthropicBaseUrl: `http://127.0.0.1:${upPort}` });
  const gwPort = await listen(gateway);

  const sockets = new Set();
  trackSockets(upstream, sockets);
  trackSockets(gateway, sockets);

  t.after(() => shutdown([gateway, upstream], sockets));

  return { seen, upPort, gwPort };
}

/** Issue the same request both ways and return both observations. */
async function bothWays({ upPort, gwPort, seen }, path, init = {}) {
  const direct = await fetch(`http://127.0.0.1:${upPort}${path}`, init);
  const directBody = Buffer.from(await direct.arrayBuffer());
  const directSeen = seen.at(-1);

  const viaGw = await fetch(`http://127.0.0.1:${gwPort}${path}`, init);
  const gwBody = Buffer.from(await viaGw.arrayBuffer());
  const gwSeen = seen.at(-1);

  return {
    direct: { res: direct, body: directBody, seen: directSeen },
    gateway: { res: viaGw, body: gwBody, seen: gwSeen },
  };
}

function assertParity(pair, label) {
  const { direct, gateway } = pair;

  assert.equal(gateway.res.status, direct.res.status, `${label}: status`);
  assert.equal(gateway.seen.method, direct.seen.method, `${label}: method`);
  assert.equal(gateway.seen.url, direct.seen.url, `${label}: path and query`);
  assert.deepEqual(
    gateway.seen.body?.toString('base64'),
    direct.seen.body?.toString('base64'),
    `${label}: request body bytes`,
  );
  assert.deepEqual(
    stripVolatile(gateway.seen.headers),
    stripVolatile(direct.seen.headers),
    `${label}: headers reaching upstream`,
  );
  assert.equal(
    gateway.body.toString('base64'),
    direct.body.toString('base64'),
    `${label}: response body bytes`,
  );
}

const JSON_BODY = (o) => ({
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-api-key': 'sk-ant-user',
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'oauth-2025-04-20, fine-grained-tool-streaming-2025-05-14',
    'user-agent': 'claude-cli/2.1.220',
  },
  body: JSON.stringify(o),
});

// ---------------------------------------------------------------- endpoints

test('POST /v1/messages - non-streaming JSON', async (t) => {
  const h = await harness(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'request-id': 'req_abc123' });
    res.end(JSON.stringify({ id: 'msg_1', content: [{ type: 'text', text: 'hi' }] }));
  });
  const pair = await bothWays(h, '/v1/messages', JSON_BODY({ model: 'claude-opus-5', max_tokens: 10 }));
  assertParity(pair, 'messages');
  assert.equal(pair.gateway.res.headers.get('request-id'), 'req_abc123');
});

test('POST /v1/messages - streaming SSE', async (t) => {
  const sse =
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\n' +
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}\n\n';
  const h = await harness(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write(sse.slice(0, 40));
    setTimeout(() => res.end(sse.slice(40)), 5);
  });
  const pair = await bothWays(h, '/v1/messages', JSON_BODY({ model: 'claude-opus-5', stream: true }));
  assertParity(pair, 'sse');
  assert.equal(pair.gateway.body.toString(), sse);
});

test('GET query strings survive', async (t) => {
  const h = await harness(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ limit: 20, has_more: false }));
  });
  assertParity(await bothWays(h, '/v1/organizations/spend_limits'), 'spend_limits');
  assertParity(
    await bothWays(h, '/v1/organizations/spend_limits?limit=20&after_id=abc&beta=true'),
    'spend_limits with query',
  );
});

test('GET /v1/models/{id} is still a passthrough', async (t) => {
  // Only the list endpoint is served locally; retrieve-by-id is not ours.
  const h = await harness(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'claude-opus-5', type: 'model' }));
  });
  assertParity(await bothWays(h, '/v1/models/claude-opus-5'), 'models retrieve');
});

test('the other endpoints Claude Code calls', async (t) => {
  const h = await harness(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });

  for (const path of [
    '/v1/messages/count_tokens',
    '/v1/organizations/spend_limits',
    '/v1/oauth/token',
    '/v1/oauth/hello',
    '/v1/skills',
    '/v1/code/sessions',
    '/v1/user_profiles',
    '/api/claude_cli/bootstrap',
    '/api/oauth/claude_cli/roles',
    '/v1/security/advisories/bulk',
  ]) {
    assertParity(await bothWays(h, path, JSON_BODY({ any: 'payload' })), path);
  }
});

test('every HTTP method passes through', async (t) => {
  const h = await harness(t, (req, res) => {
    res.writeHead(204);
    res.end();
  });

  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
    const init = method === 'GET' ? { method } : { method, body: 'x' };
    assertParity(await bothWays(h, '/v1/code/sessions/abc', init), method);
  }
});

test('HEAD gets no body', async (t) => {
  const h = await harness(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end();
  });
  const pair = await bothWays(h, '/v1/messages', { method: 'HEAD' });
  assert.equal(pair.gateway.res.status, 200);
  assert.equal(pair.gateway.body.length, 0);
});

// ---------------------------------------------------------------- errors

test('error statuses and their headers are relayed untouched', async (t) => {
  const cases = [
    [400, {}],
    [401, {}],
    [403, {}],
    [404, {}],
    [429, {
      'retry-after': '30',
      'anthropic-ratelimit-unified-status': 'rejected',
      'anthropic-ratelimit-unified-reset': '2026-08-27T12:00:00Z',
    }],
    [500, {}],
    [529, {}],
  ];

  for (const [status, extra] of cases) {
    const h = await harness(t, (req, res) => {
      res.writeHead(status, { 'content-type': 'application/json', ...extra });
      res.end(JSON.stringify({ type: 'error', error: { type: 'x', message: 'y' } }));
    });
    const pair = await bothWays(h, '/v1/messages', JSON_BODY({ model: 'claude-opus-5' }));
    assertParity(pair, `status ${status}`);

    for (const [key, value] of Object.entries(extra)) {
      assert.equal(
        pair.gateway.res.headers.get(key),
        value,
        `${status}: ${key} must survive - the client needs it to back off`,
      );
    }
  }
});

// ---------------------------------------------------------------- payloads

test('a large body survives byte for byte', async (t) => {
  const big = JSON.stringify({ model: 'claude-opus-5', text: 'x'.repeat(2 * 1024 * 1024) });
  const h = await harness(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(Buffer.alloc(1024 * 1024, 'y'));
  });
  const pair = await bothWays(h, '/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: big,
  });
  assertParity(pair, 'large body');
  assert.equal(pair.gateway.seen.body.length, Buffer.byteLength(big));
});

test('non-ASCII text and binary responses are unchanged', async (t) => {
  const payload = JSON.stringify({ model: 'claude-opus-5', text: 'สวัสดีครับ' });
  const h = await harness(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(Buffer.from([0, 1, 2, 253, 254, 255]));
  });
  const pair = await bothWays(h, '/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: payload,
  });
  assertParity(pair, 'binary');
});

test('an empty body is still an empty body', async (t) => {
  const h = await harness(t, (req, res) => {
    res.writeHead(200);
    res.end();
  });
  assertParity(await bothWays(h, '/v1/oauth/hello', { method: 'POST', body: '' }), 'empty');
});

// ---------------------------------------------------------------- upgrade

test('a WebSocket upgrade completes and carries frames both ways', async (t) => {
  const h = await harness(t, (req, res) => res.end('plain'));

  const talk = (port) =>
    new Promise((resolve) => {
      let data = '';
      const sock = net.connect(port, '127.0.0.1', () => {
        sock.write(
          'GET /v1/code/agent-proxy HTTP/1.1\r\n' +
            `Host: 127.0.0.1:${port}\r\n` +
            'Upgrade: websocket\r\n' +
            'Connection: Upgrade\r\n' +
            'Sec-WebSocket-Version: 13\r\n' +
            'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
        );
      });
      sock.on('data', (c) => {
        data += c;
        if (data.includes('FRAME-1') && !data.includes('ECHO:')) sock.write('PING');
      });
      sock.on('error', () => resolve('ERROR'));
      setTimeout(() => {
        sock.destroy();
        resolve(data);
      }, 600);
    });

  const direct = await talk(h.upPort);
  const viaGw = await talk(h.gwPort);

  assert.match(direct, /^HTTP\/1\.1 101 /, 'sanity: the stub really upgrades');
  assert.match(viaGw, /^HTTP\/1\.1 101 /, 'the gateway must relay the 101, not answer 200');
  assert.match(viaGw, /FRAME-1/, 'server-to-client frames must arrive');
  assert.match(viaGw, /ECHO:PING/, 'client-to-server frames must arrive');
  assert.equal(viaGw, direct, 'the tunnel must be byte-identical to a direct connection');
});

test('the upgrade request reaches upstream with its handshake headers intact', async (t) => {
  const h = await harness(t, (req, res) => res.end('plain'));

  await new Promise((resolve) => {
    const sock = net.connect(h.gwPort, '127.0.0.1', () => {
      sock.write(
        'GET /v1/code/agent-proxy?x=1 HTTP/1.1\r\n' +
          `Host: 127.0.0.1:${h.gwPort}\r\n` +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          'Sec-WebSocket-Version: 13\r\n' +
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
          'Authorization: Bearer sk-ant-oauth\r\n\r\n',
      );
    });
    setTimeout(() => {
      sock.destroy();
      resolve();
    }, 400);
  });

  const hit = h.seen.find((s) => s.upgrade);
  assert.ok(hit, 'upstream must see an upgrade request');
  assert.equal(hit.url, '/v1/code/agent-proxy?x=1', 'path and query preserved');
  assert.equal(hit.headers.upgrade, 'websocket');
  assert.equal(hit.headers.connection, 'Upgrade');
  assert.equal(hit.headers['sec-websocket-key'], 'dGhlIHNhbXBsZSBub25jZQ==');
  assert.equal(hit.headers.authorization, 'Bearer sk-ant-oauth', 'credentials pass through');
});

test('an unreachable upstream fails the tunnel instead of hanging', async (t) => {
  const cfg = normalize({ providers: {}, models: {} }, { env: {} });
  const gateway = createServer(cfg, { anthropicBaseUrl: 'http://127.0.0.1:1' });
  const port = await listen(gateway);

  const sockets = new Set();
  trackSockets(gateway, sockets);
  t.after(() => shutdown([gateway], sockets));

  const result = await new Promise((resolve) => {
    let data = '';
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write('GET /x HTTP/1.1\r\nHost: h\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    });
    sock.on('data', (c) => {
      data += c;
    });
    sock.on('close', () => resolve(data));
    setTimeout(() => {
      sock.destroy();
      resolve(data);
    }, 1500);
  });

  assert.match(result, /^HTTP\/1\.1 502 /, 'the client must be told, not left waiting');
});

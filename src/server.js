// The proxy itself: one catch-all route that forwards to the resolved upstream.

import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { Readable, pipeline } from 'node:stream';
import { ANTHROPIC_BASE_URL } from './config.js';
import { buildRequestHeaders, buildResponseHeaders } from './headers.js';
import { resolve } from './router.js';
import { createUsageTap, formatUsage } from './usage.js';
import { createDumper, logError, logRequest, logResponse, redactHeaders } from './log.js';

/** How long upstream may take to send response headers. */
const HEADERS_TIMEOUT_MS = 120_000;
/**
 * Longest gap allowed *between* body chunks. Deliberately not a wall-clock
 * budget over the whole exchange: a long turn can legitimately stream for far
 * more than it took to start, and a single deadline truncates it mid-answer.
 */
const IDLE_TIMEOUT_MS = 300_000;
const TUNNEL_CONNECT_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 128 * 1024 * 1024;

/**
 * @param {object} cfg  normalized config
 * @param {{dump?: string, verbose?: boolean, anthropicBaseUrl?: string}} options
 *        anthropicBaseUrl is injectable so tests can point the fallback at a stub
 */
export function createServer(cfg, { dump, verbose = false, anthropicBaseUrl = ANTHROPIC_BASE_URL } = {}) {
  const dumper = createDumper(dump);

  const server = http.createServer((req, res) => {
    handle(req, res, cfg, { dumper, verbose, anthropicBaseUrl }).catch((error) => {
      // A client that hung up is not worth reporting, and there is no longer
      // anywhere to report it to.
      if (res.destroyed || res.writableEnded) return;
      logError(error?.message ?? String(error));
      sendError(res, 502, 'proxy_error', error?.message ?? 'Unknown proxy error');
    });
  });

  // fetch() cannot carry a protocol upgrade, so WebSockets get their own path:
  // a raw byte tunnel. Without this the handshake is silently downgraded to a
  // plain request and the client sees 200 where it expected 101.
  server.on('upgrade', (req, socket, head) => {
    tunnel(req, socket, head, { anthropicBaseUrl, verbose });
  });

  return server;
}

/**
 * Splice the client socket to the upstream one and stay out of the way.
 *
 * Upgrade requests carry no JSON body, so there is no model to route on: they
 * always go to the Anthropic fallback.
 */
function tunnel(req, clientSocket, head, { anthropicBaseUrl, verbose }) {
  let target;
  try {
    target = new URL(anthropicBaseUrl + req.url);
  } catch {
    return abortTunnel(clientSocket, 400, 'Bad upgrade target');
  }

  const secure = target.protocol === 'https:';
  const port = Number(target.port) || (secure ? 443 : 80);

  logRequest({ providerName: null, model: 'upgrade', path: pathOf(req.url) });

  // True once the tunnel is carrying bytes. Past that point an HTTP error
  // response is no longer something the client can parse.
  let established = false;

  const onReady = () => {
    // Rebuild the request line by hand: Upgrade and Connection must survive,
    // which is exactly what the normal header filter strips.
    const lines = [`${req.method} ${target.pathname}${target.search} HTTP/1.1`];
    const raw = req.rawHeaders;
    for (let i = 0; i < raw.length; i += 2) {
      const key = raw[i];
      const value = key.toLowerCase() === 'host' ? target.host : raw[i + 1];
      lines.push(`${key}: ${value}`);
    }

    upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head?.length) upstream.write(head);

    clientSocket.setNoDelay(true);
    upstream.setNoDelay(true);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);

    // Silence is normal once a tunnel is open, so the connect deadline goes away.
    upstream.setTimeout(0);
    established = true;

    if (verbose) console.error(`    -> ${target.href} (tunnel)`);
  };

  const upstream = secure
    ? tls.connect(
        // Force HTTP/1.1: an h2 negotiation would make the raw bytes above meaningless.
        { host: target.hostname, port, servername: target.hostname, ALPNProtocols: ['http/1.1'] },
        onReady,
      )
    : net.connect({ host: target.hostname, port }, onReady);

  // Covers the connect phase only, and is cleared in onReady. Without it a
  // black-holed upstream leaves the client hanging with no reply, forever.
  upstream.setTimeout(TUNNEL_CONNECT_TIMEOUT_MS, () => {
    if (!established) upstream.destroy(new Error(`connect to ${target.origin} timed out`));
  });

  upstream.on('error', (error) => {
    logError(`tunnel failed: ${error.message}`);
    if (established) {
      // Writing an HTTP response now would splice status-line bytes into the
      // middle of a WebSocket frame stream. Just close both ends.
      clientSocket.destroy();
      upstream.destroy();
      return;
    }
    abortTunnel(clientSocket, 502, `Cannot reach ${target.origin}`);
  });

  const close = () => {
    upstream.destroy();
    clientSocket.destroy();
  };
  clientSocket.on('error', close);
  clientSocket.on('close', () => upstream.destroy());
  upstream.on('close', () => clientSocket.destroy());
}

function abortTunnel(socket, status, message) {
  if (!socket.destroyed && socket.writable) {
    const reason = status === 502 ? 'Bad Gateway' : 'Bad Request';
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n${message}`);
  }
  socket.destroy();
}

async function handle(req, res, cfg, { dumper, verbose, anthropicBaseUrl }) {
  const body = await readBody(req);

  let parsed = null;
  if (req.method === 'POST' && body.length) {
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      parsed = null; // not JSON — forward as-is to Anthropic
    }
  }

  const route = resolve(parsed, cfg);
  const base = route.provider ? route.provider.base_url : anthropicBaseUrl;
  const target = base + req.url;

  const outboundBody = route.rewritten ? Buffer.from(JSON.stringify(route.body)) : body;
  const headers = buildRequestHeaders(req.headers, route.provider);

  logRequest({ providerName: route.providerName, model: route.model, path: pathOf(req.url) });
  if (verbose) {
    console.error(`    -> ${target}`);
    // Masked: this goes to stderr, which for a background gateway is the log
    // file that `ccmpg logs` prints straight to stdout.
    console.error(`    ${JSON.stringify(redactHeaders(headers))}`);
  }

  const controller = new AbortController();
  let timedOut = false;
  let clientGone = false;

  const abort = () => {
    if (!controller.signal.aborted) controller.abort();
  };

  // The client hanging up — Esc mid-turn, a routine event — must stop the
  // upstream too. Otherwise the provider keeps streaming, and keeps charging,
  // into a socket nobody is reading.
  res.on('close', () => {
    if (!res.writableEnded) {
      clientGone = true;
      abort();
    }
  });
  res.on('error', () => {
    clientGone = true;
    abort();
  });

  const headersTimer = setTimeout(() => {
    timedOut = true;
    abort();
  }, HEADERS_TIMEOUT_MS);

  let upstream;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : outboundBody,
      signal: controller.signal,
      redirect: 'manual',
    });
  } catch (error) {
    clearTimeout(headersTimer);
    if (clientGone) return; // nobody left to tell
    const reason = timedOut
      ? `Upstream sent no response headers within ${HEADERS_TIMEOUT_MS / 1000}s`
      : `Cannot reach ${base}: ${error?.message ?? error}`;
    logResponse({ providerName: route.providerName, model: route.model, status: 502, usage: reason });
    sendError(res, 502, 'upstream_unreachable', reason);
    return;
  }
  clearTimeout(headersTimer);

  dumper?.request({
    method: req.method,
    url: req.url,
    target,
    headers,
    body: outboundBody,
    status: upstream.status,
  });

  if (clientGone) return;

  res.writeHead(upstream.status, buildResponseHeaders(upstream.headers));

  if (!upstream.body) {
    res.end();
    logResponse({ providerName: route.providerName, model: route.model, status: upstream.status });
    return;
  }

  const tap = createUsageTap();
  const dumpChunks = dumper ? [] : null;

  const source = Readable.fromWeb(upstream.body.pipeThrough(tap.stream));

  let idleTimer;
  const bumpIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      timedOut = true;
      abort();
    }, IDLE_TIMEOUT_MS);
  };

  source.on('data', (chunk) => {
    bumpIdle();
    if (dumpChunks) dumpChunks.push(Buffer.from(chunk));
  });
  bumpIdle();

  const finish = () => {
    clearTimeout(idleTimer);
    if (dumpChunks) dumper.response({ status: upstream.status, chunks: dumpChunks });
    logResponse({
      providerName: route.providerName,
      model: route.model,
      status: upstream.status,
      usage: formatUsage(tap.stats),
    });
  };

  // pipeline, not pipe: a failure at either end must tear down the other, and
  // an http.ServerResponse with no error listener can otherwise throw.
  pipeline(source, res, (error) => {
    if (error && !clientGone) {
      logError(
        timedOut ? `stream idle for ${IDLE_TIMEOUT_MS / 1000}s` : `stream interrupted: ${error.message}`,
      );
    }
    abort();
    finish();
  });
}

function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        settle(reject, new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => settle(resolvePromise, Buffer.concat(chunks)));
    req.on('error', (error) => settle(reject, error));
    // An aborted request emits neither 'end' nor 'error', so without this the
    // promise never settles and everything it holds stays reachable.
    req.on('close', () => settle(reject, new Error('client closed the request')));
  });
}

function pathOf(url) {
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

/** Reply in Anthropic's error shape so Claude Code renders it properly. */
function sendError(res, status, type, message) {
  if (res.headersSent) {
    res.end();
    return;
  }
  const payload = JSON.stringify({ type: 'error', error: { type, message } });
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
}

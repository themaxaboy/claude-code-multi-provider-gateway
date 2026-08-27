// The proxy itself: one catch-all route that forwards to the resolved upstream.

import http from 'node:http';
import { Readable } from 'node:stream';
import { ANTHROPIC_BASE_URL } from './config.js';
import { buildRequestHeaders, buildResponseHeaders } from './headers.js';
import { resolve } from './router.js';
import { createUsageTap, formatUsage } from './usage.js';
import { createDumper, logError, logRequest, logResponse } from './log.js';

const REQUEST_TIMEOUT_MS = 300_000;

/**
 * @param {object} cfg  normalized config
 * @param {{dump?: string, verbose?: boolean, anthropicBaseUrl?: string}} options
 *        anthropicBaseUrl is injectable so tests can point the fallback at a stub
 */
export function createServer(cfg, { dump, verbose = false, anthropicBaseUrl = ANTHROPIC_BASE_URL } = {}) {
  const dumper = createDumper(dump);

  return http.createServer((req, res) => {
    handle(req, res, cfg, { dumper, verbose, anthropicBaseUrl }).catch((error) => {
      logError(error?.message ?? String(error));
      sendError(res, 502, 'proxy_error', error?.message ?? 'Unknown proxy error');
    });
  });
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
    console.error(`    ${JSON.stringify(headers)}`);
  }

  let upstream;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : outboundBody,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: 'manual',
    });
  } catch (error) {
    const reason = error?.name === 'TimeoutError' ? `Upstream timed out after ${REQUEST_TIMEOUT_MS / 1000}s` : `Cannot reach ${base}: ${error?.message ?? error}`;
    logResponse({ providerName: route.providerName, model: route.model, status: 502, usage: reason });
    sendError(res, 502, 'upstream_unreachable', reason);
    return;
  }

  dumper?.request({
    method: req.method,
    url: req.url,
    target,
    headers,
    body: outboundBody,
    status: upstream.status,
  });

  res.writeHead(upstream.status, buildResponseHeaders(upstream.headers));

  if (!upstream.body) {
    res.end();
    logResponse({ providerName: route.providerName, model: route.model, status: upstream.status });
    return;
  }

  const tap = createUsageTap();
  const dumpChunks = dumper ? [] : null;

  const source = Readable.fromWeb(upstream.body.pipeThrough(tap.stream));

  if (dumpChunks) source.on('data', (chunk) => dumpChunks.push(Buffer.from(chunk)));

  const finish = () => {
    if (dumpChunks) dumper.response({ status: upstream.status, chunks: dumpChunks });
    logResponse({
      providerName: route.providerName,
      model: route.model,
      status: upstream.status,
      usage: formatUsage(tap.stats),
    });
  };

  source.on('end', finish);
  source.on('error', (error) => {
    // Client hung up mid-stream, or upstream cut the connection. Not fatal.
    logError(`stream interrupted: ${error.message}`);
    finish();
    res.end();
  });

  source.pipe(res);
}

function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolvePromise(Buffer.concat(chunks)));
    req.on('error', reject);
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

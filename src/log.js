// Request logging and the --dump transcript.

import fs from 'node:fs';

const RESET = '\u001b[0m';
const DIM = '\u001b[2m';
const CYAN = '\u001b[36m';
const YELLOW = '\u001b[33m';
const RED = '\u001b[31m';
const GREEN = '\u001b[32m';

const useColor = () => process.stdout.isTTY && !process.env.NO_COLOR;

const paint = (code, text) => (useColor() ? `${code}${text}${RESET}` : text);

export const dim = (t) => paint(DIM, t);
export const cyan = (t) => paint(CYAN, t);
export const yellow = (t) => paint(YELLOW, t);
export const red = (t) => paint(RED, t);
export const green = (t) => paint(GREEN, t);

// ---------------------------------------------------------------- redaction

/** sk-or-v1-c1f9…5320 — enough to recognise, not enough to use. */
export function maskKey(value) {
  if (!value) return '';
  const text = String(value);
  if (text.startsWith('${')) return text; // an env reference is not a secret
  // A short key gives too much away from a prefix, and its length is itself a
  // hint, so it gets a fixed-width mask rather than a proportional one.
  if (text.length <= 12) return '*'.repeat(8);
  return `${text.slice(0, 8)}\u2026${text.slice(-4)}`;
}

const SECRET_HEADERS = new Set(['authorization', 'x-api-key', 'proxy-authorization', 'cookie']);

/**
 * The same headers with every credential masked. Both --verbose and --dump go
 * through this: their output lands in the daemon log, which `ccmpg logs` prints
 * to stdout, so a raw key here ends up in bug reports.
 */
export function redactHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (!SECRET_HEADERS.has(key.toLowerCase())) {
      out[key] = value;
      continue;
    }
    // Keep the scheme readable so "Bearer <wrong thing>" stays diagnosable.
    const text = String(value);
    const space = text.indexOf(' ');
    out[key] = space > 0 ? `${text.slice(0, space)} ${maskKey(text.slice(space + 1))}` : maskKey(text);
  }
  return out;
}

// ---------------------------------------------------------------- log lines

function clock() {
  return new Date().toTimeString().slice(0, 8);
}

/** Pad to a fixed width so the two lines of a request line up in the terminal. */
const pad = (text, width) => String(text).padEnd(width);

export function logRequest({ providerName, model, path }) {
  const target = providerName ?? 'anthropic';
  console.log(`${dim(clock())} ${cyan('>>>')} ${pad(target, 12)} | ${pad(model, 24)} | ${path}`);
}

export function logResponse({ providerName, model, status, usage }) {
  const target = providerName ?? 'anthropic';
  const arrow = status >= 400 ? red('<<<') : green('<<<');
  const detail = usage || (status >= 400 ? `HTTP ${status}` : 'no usage data');
  console.log(`${dim(clock())} ${arrow} ${pad(target, 12)} | ${pad(model, 24)} | ${detail}`);
}

export function logError(message) {
  console.error(`${dim(clock())} ${red('!!!')} ${message}`);
}

/**
 * Append full request/response transcripts to a file.
 * Credentials are masked, but the file still holds every request and response
 * body — treat it as sensitive. Created 0600 for that reason.
 */
export function createDumper(file) {
  if (!file) return null;

  const write = (text) => {
    try {
      fs.appendFileSync(file, text, { mode: 0o600 });
    } catch {
      /* never let logging break the proxy */
    }
  };

  return {
    file,
    request({ method, url, target, headers, body, status }) {
      const lines = [
        `\n${'='.repeat(60)}\n`,
        `[${new Date().toISOString()}] ${method} ${url} -> ${target} (${status})\n`,
      ];
      for (const [k, v] of Object.entries(redactHeaders(headers))) lines.push(`  ${k}: ${v}\n`);
      if (body?.length) {
        lines.push('\n');
        lines.push(prettyJson(body));
        lines.push('\n');
      }
      write(lines.join(''));
    },
    response({ status, chunks }) {
      write(`  --- response ${status} ---\n${Buffer.concat(chunks).toString('utf8')}\n`);
    },
  };
}

function prettyJson(buffer) {
  const text = buffer.toString('utf8');
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

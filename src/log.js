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
 * The file holds raw headers and bodies — treat it as sensitive.
 */
export function createDumper(file) {
  if (!file) return null;

  const write = (text) => {
    try {
      fs.appendFileSync(file, text);
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
      for (const [k, v] of Object.entries(headers)) lines.push(`  ${k}: ${v}\n`);
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

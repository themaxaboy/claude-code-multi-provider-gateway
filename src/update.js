// "Update available" notice, the way npm does it.
//
// The notice is printed from a cache so no command ever waits on the network.
// The cache is refreshed in the background, at most once a day, on a socket
// that is unref'd so it can never delay process exit.

import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { STATE_DIR } from './daemon.js';
import { dim, yellow } from './log.js';

export const CACHE_FILE = path.join(STATE_DIR, 'update-check.json');

const REGISTRY_URL = 'https://registry.npmjs.org/ccmpg/latest';
const TTL_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 2500;

const disabled = () => Boolean(process.env.CCMPG_NO_UPDATE_CHECK);

/** Numeric compare of major.minor.patch; a prerelease never counts as newer. */
export function isNewer(latest, current) {
  const parts = (v) =>
    String(v ?? '')
      .trim()
      .replace(/^v/, '')
      .split('-')[0]
      .split('.')
      .map((n) => Number.parseInt(n, 10));

  const a = parts(latest);
  const b = parts(current);
  if (a.some(Number.isNaN) || b.some(Number.isNaN)) return false;

  for (let i = 0; i < 3; i += 1) {
    const l = a[i] ?? 0;
    const c = b[i] ?? 0;
    if (l > c) return true;
    if (l < c) return false;
  }
  return false;
}

export function readCache(file = CACHE_FILE) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof data?.latest !== 'string') return null;
    return { latest: data.latest, checkedAt: Number(data.checkedAt) || 0 };
  } catch {
    return null;
  }
}

export function writeCache(latest, { file = CACHE_FILE, now = Date.now() } = {}) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ latest, checkedAt: now }));
  } catch {
    // A missing update notice is never worth failing a command over.
  }
}

/** @returns {[string, string]|null} the two lines to show, or null */
export function updateNotice(current, { file = CACHE_FILE } = {}) {
  if (disabled()) return null;

  const cached = readCache(file);
  if (!cached || !isNewer(cached.latest, current)) return null;

  return [
    `Update available ${current} -> ${cached.latest}`,
    'Run npm i -g ccmpg to update',
  ];
}

/** Prints to stderr so piping stdout stays clean. */
export function printUpdateNotice(current, options) {
  const lines = updateNotice(current, options);
  if (!lines) return false;

  console.error('');
  console.error(yellow(lines[0]));
  console.error(dim(lines[1]));
  return true;
}

/**
 * Refresh the cache in the background when it is stale. Never awaited.
 */
export function scheduleUpdateCheck(current, { file = CACHE_FILE, now = Date.now() } = {}) {
  if (disabled()) return;

  const cached = readCache(file);
  if (cached && now - cached.checkedAt < TTL_MS) return;

  fetchLatest((latest) => {
    if (latest) writeCache(latest, { file, now: Date.now() });
  });
}

function fetchLatest(done) {
  let request;
  try {
    request = https.get(
      REGISTRY_URL,
      { headers: { accept: 'application/json', 'user-agent': 'ccmpg' }, timeout: TIMEOUT_MS },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          done(null);
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
          if (body.length > 100_000) request.destroy();
        });
        res.on('end', () => {
          try {
            done(JSON.parse(body).version ?? null);
          } catch {
            done(null);
          }
        });
      },
    );
  } catch {
    done(null);
    return;
  }

  // Let the process exit without waiting for this.
  request.on('socket', (socket) => socket.unref());
  request.on('timeout', () => request.destroy());
  request.on('error', () => done(null));
}

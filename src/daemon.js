// Track background gateways: pid file, registry, spawn and kill.
//
// Everything here is runtime state, not configuration. The whole directory can
// be deleted safely when nothing is running.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const STATE_DIR = path.join(os.homedir(), '.local', 'state', 'ccmpg');
const REGISTRY = path.join(STATE_DIR, 'daemons.json');

const BIN = fileURLToPath(new URL('../bin/ccmpg.js', import.meta.url));

/** Identifies one running gateway: the global one, or one per project directory. */
export function scopeKey({ global = false, cwd = process.cwd() } = {}) {
  return global ? 'global' : `project:${path.resolve(cwd)}`;
}

export function scopeLabel(key) {
  return key === 'global' ? 'global' : 'project';
}

export function logFileFor(key) {
  const name =
    key === 'global'
      ? 'global'
      : `project-${crypto.createHash('sha1').update(key).digest('hex').slice(0, 8)}`;
  return path.join(STATE_DIR, `${name}.log`);
}

function ensureStateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

function readRegistry() {
  try {
    return JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
  } catch {
    return {};
  }
}

function writeRegistry(data) {
  try {
    ensureStateDir();
    const tmp = `${REGISTRY}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, REGISTRY);
  } catch {
    // Bookkeeping is not worth failing a command over.
  }
}

export function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return error.code === 'EPERM';
  }
}

/**
 * Is the process holding `pid` plausibly one of ours?
 *
 * `isAlive` only proves that *something* owns the pid, and pids get recycled —
 * after a reboot the recorded pid can belong to an unrelated program, which
 * `stop` would then terminate. This deliberately fails open: only a positive
 * identification of something that is not node blocks the kill.
 *
 * @returns {boolean|null} null when the platform gave us nothing to go on
 */
export function looksLikeOurs(pid) {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf8',
      });
      if (!out.trim() || out.includes('No tasks')) return null;
      return /^"node\.exe"/i.test(out.trim());
    }
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'comm='], {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    });
    if (!out.trim()) return null;
    return /node/i.test(out);
  } catch {
    return null; // no ps/tasklist, or the process vanished — do not block on it
  }
}

/** Every registered gateway, with dead entries pruned from the registry. */
export function list() {
  const registry = readRegistry();
  const live = {};
  let changed = false;

  for (const [key, entry] of Object.entries(registry)) {
    if (isAlive(entry.pid)) live[key] = entry;
    else changed = true;
  }

  if (changed) writeRegistry(live);

  return Object.entries(live).map(([key, entry]) => ({ key, ...entry }));
}

export function get(key) {
  const entry = readRegistry()[key];
  if (!entry || !isAlive(entry.pid)) return null;
  return { key, ...entry };
}

/**
 * Record the gateway running in *this* process.
 *
 * `start()` below covers `ccmpg start -d`, but a boot entry — launchd, a
 * systemd user unit, the Windows Startup folder — launches `__serve` directly
 * with no parent to do the bookkeeping. Without this, `status`, `stop` and
 * `logs` all went blind after a reboot.
 */
export function register({ key, cwd, config, host, port }) {
  const registry = readRegistry();
  const previous = registry[key];
  const mine = previous?.pid === process.pid;

  registry[key] = {
    pid: process.pid,
    host,
    port,
    cwd,
    config,
    logFile: previous?.logFile ?? logFileFor(key),
    scope: scopeLabel(key),
    startedAt: mine ? previous.startedAt : Date.now(),
  };

  writeRegistry(registry);
  return registry[key];
}

/** Drop an entry without touching the process it names. */
export function forget(key) {
  const registry = readRegistry();
  if (!(key in registry)) return false;
  delete registry[key];
  writeRegistry(registry);
  return true;
}

/**
 * Start a detached gateway and record it.
 * @returns {{pid: number, logFile: string}}
 */
export function start({ key, cwd, args, config, host, port }) {
  ensureStateDir();

  const logFile = logFileFor(key);
  const fd = fs.openSync(logFile, 'a', 0o600);

  const child = spawn(process.execPath, [BIN, '__serve', ...args], {
    cwd,
    detached: true,
    stdio: ['ignore', fd, fd],
    windowsHide: true,
  });

  // spawn reports failure asynchronously, so this only catches it later — but
  // an unhandled 'error' on a ChildProcess would otherwise throw.
  child.on('error', () => {});

  child.unref();
  fs.closeSync(fd);

  if (!child.pid) {
    const error = new Error('Could not spawn the gateway process');
    error.logFile = logFile;
    throw error;
  }

  const registry = readRegistry();
  registry[key] = {
    pid: child.pid,
    host,
    port,
    cwd,
    config,
    logFile,
    scope: scopeLabel(key),
    startedAt: Date.now(),
  };
  writeRegistry(registry);

  return { pid: child.pid, logFile };
}

/**
 * @returns {'stopped'|'not-running'|'stale'} `stale` means the recorded pid is
 *          now held by something that is not ours, so nothing was killed.
 */
export function stop(key) {
  const registry = readRegistry();
  const entry = registry[key];

  if (!entry) return 'not-running';

  let result = 'not-running';

  if (isAlive(entry.pid)) {
    if (looksLikeOurs(entry.pid) === false) {
      // The pid was recycled. Forget the entry rather than terminating whatever
      // now happens to hold it.
      delete registry[key];
      writeRegistry(registry);
      return 'stale';
    }
    try {
      process.kill(entry.pid, 'SIGTERM');
      result = 'stopped';
    } catch {
      /* already gone */
    }
  }

  delete registry[key];
  writeRegistry(registry);
  return result;
}

export function logPath(key) {
  return readRegistry()[key]?.logFile ?? logFileFor(key);
}

/** The last `bytes` bytes of a file, for reporting a failed start. */
export function tailFile(file, bytes = 4096) {
  try {
    const { size } = fs.statSync(file);
    const start = Math.max(0, size - bytes);
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      return buffer.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

/** "2h 14m" / "45s" */
export function uptime(startedAt) {
  const seconds = Math.floor((Date.now() - startedAt) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

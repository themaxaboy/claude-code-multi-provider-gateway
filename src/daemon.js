// Track background gateways: pid file, registry, spawn and kill.
//
// Everything here is runtime state, not configuration. The whole directory can
// be deleted safely when nothing is running.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
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

function logFileFor(key) {
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
  ensureStateDir();
  const tmp = `${REGISTRY}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, REGISTRY);
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
 * Start a detached gateway and record it.
 * @returns {{pid: number, logFile: string}}
 */
export function start({ key, cwd, args, config, host, port }) {
  ensureStateDir();

  const logFile = logFileFor(key);
  const fd = fs.openSync(logFile, 'a');

  const child = spawn(process.execPath, [BIN, '__serve', ...args], {
    cwd,
    detached: true,
    stdio: ['ignore', fd, fd],
    windowsHide: true,
  });
  child.unref();
  fs.closeSync(fd);

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

/** @returns {boolean} whether something was actually running */
export function stop(key) {
  const registry = readRegistry();
  const entry = registry[key];

  if (!entry) return false;

  const wasAlive = isAlive(entry.pid);
  if (wasAlive) {
    try {
      process.kill(entry.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }

  delete registry[key];
  writeRegistry(registry);
  return wasAlive;
}

export function logPath(key) {
  return readRegistry()[key]?.logFile ?? logFileFor(key);
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

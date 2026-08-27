// Point Claude Code at the gateway by writing env vars into its settings.
//
// These files belong to Claude Code, not to us: they routinely hold permissions,
// hooks and model choices. Every write merges into what is already there.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * project -> ./.claude/settings.local.json   (personal, usually gitignored)
 * global  -> ~/.claude/settings.json         (applies to every project)
 */
export function settingsPath({ global = false, cwd = process.cwd() } = {}) {
  return global
    ? path.join(os.homedir(), '.claude', 'settings.json')
    : path.join(cwd, '.claude', 'settings.local.json');
}

/** Wildcard binds, and loopback in either family, are all reached as localhost. */
const LOCALHOST_BINDS = new Set(['127.0.0.1', '0.0.0.0', '::', '::1']);

export function baseUrlFor({ host = '127.0.0.1', port = 8787 } = {}) {
  // 127.0.0.1 is what the gateway binds, but localhost reads better and Node
  // clients try both families.
  if (LOCALHOST_BINDS.has(host)) return `http://localhost:${port}`;
  // A bare IPv6 literal needs brackets, or the result is not a parseable URL.
  const shown = host.includes(':') ? `[${host}]` : host;
  return `http://${shown}:${port}`;
}

/**
 * Merge a set of env vars into the settings file, leaving every other key alone.
 *
 * @param {{global?: boolean, cwd?: string, env: Record<string, string>}} options
 * @returns {{file: string, action: 'created'|'updated'|'unchanged'|'unreadable',
 *            previous: Record<string, string|undefined>, changed: string[], error?: string}}
 *          `previous` holds the old value of each key that changed
 */
export function applyEnv({ global = false, cwd = process.cwd(), env }) {
  const file = settingsPath({ global, cwd });

  let settings = {};
  let existed = false;

  if (fs.existsSync(file)) {
    existed = true;
    const raw = fs.readFileSync(file, 'utf8');

    if (raw.trim()) {
      try {
        settings = JSON.parse(raw);
      } catch (error) {
        // Never overwrite a file we cannot understand.
        return { file, action: 'unreadable', error: error.message, previous: {}, changed: [] };
      }
      if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
        return {
          file,
          action: 'unreadable',
          error: 'the top level is not an object',
          previous: {},
          changed: [],
        };
      }
    }
  }

  const changed = Object.keys(env).filter((key) => settings.env?.[key] !== env[key]);
  const previous = Object.fromEntries(changed.map((key) => [key, settings.env?.[key]]));
  if (!changed.length) return { file, action: 'unchanged', previous, changed };

  // Spreading into .env keeps each key in its original position when it exists.
  settings.env = { ...settings.env, ...env };

  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
  fs.renameSync(tmp, file);

  return { file, action: existed ? 'updated' : 'created', previous, changed };
}

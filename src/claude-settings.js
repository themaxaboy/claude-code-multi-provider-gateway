// Point Claude Code at the gateway by writing ANTHROPIC_BASE_URL into its settings.
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

export function baseUrlFor({ host = '127.0.0.1', port = 8787 } = {}) {
  // 127.0.0.1 is what the gateway binds, but localhost reads better and Node
  // clients try both families.
  const shown = host === '127.0.0.1' || host === '0.0.0.0' ? 'localhost' : host;
  return `http://${shown}:${port}`;
}

/**
 * Merge ANTHROPIC_BASE_URL into the settings file, leaving every other key alone.
 *
 * @returns {{file: string, action: 'created'|'updated'|'unchanged'|'unreadable',
 *            previous?: string, error?: string}}
 */
export function applyBaseUrl({ global = false, cwd = process.cwd(), url }) {
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
        return { file, action: 'unreadable', error: error.message };
      }
      if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
        return { file, action: 'unreadable', error: 'the top level is not an object' };
      }
    }
  }

  const previous = settings.env?.ANTHROPIC_BASE_URL;
  if (previous === url) return { file, action: 'unchanged', previous };

  // Assigning to .env keeps the key in its original position when it exists.
  settings.env = { ...settings.env, ANTHROPIC_BASE_URL: url };

  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
  fs.renameSync(tmp, file);

  return { file, action: existed ? 'updated' : 'created', previous };
}

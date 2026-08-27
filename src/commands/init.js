import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIG_NAME, DEFAULT_SERVER, configPath } from '../config.js';
import { applyEnv, baseUrlFor, settingsPath } from '../claude-settings.js';
import { ensureIgnored } from '../gitignore.js';
import { confirm } from '../prompt.js';
import { cyan, dim, green, red, yellow } from '../log.js';

/** Claude Code's per-user settings file; personal, never shared. */
const SETTINGS_ENTRY = '.claude/settings.local.json';

/**
 * The env vars that point Claude Code at the gateway. Values must be strings.
 *
 * Deliberately just the base URL. The gateway also serves GET /v1/models, which
 * Claude Code reads only when CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1 —
 * but that is left for the user to set, not written here. See the README.
 */
const settingsEnv = (url) => ({ ANTHROPIC_BASE_URL: url });

const template = (port) => `version: 1

server:
  host: 127.0.0.1
  port: ${port}

# Where requests get forwarded. Name these whatever you like.
providers:
  openrouter:
    base_url: https://openrouter.ai/api
    api_key: sk-or-v1-xxxxxxxxxxxxxxxx   # paste your key right here

# The name on the left is what you type in /model
models:
  minimax:
    model: minimax-m3:free               # the provider's real model id
    provider: openrouter                 # must match a name under providers:
`;

/** Shorten a home-relative path so prompts stay readable. */
function short(file) {
  const home = os.homedir();
  return file.startsWith(home) ? path.join('~', path.relative(home, file)) : file;
}

export async function init(flags = {}) {
  const { global = false, force = false, yes = false } = flags;
  const port = flags.port ?? DEFAULT_SERVER.port;
  const file = configPath({ global });

  // 1. the gateway config
  let wroteConfig = false;
  if (fs.existsSync(file) && !force) {
    console.log(`${yellow('kept')}    ${file} ${dim('(already exists — pass --force to replace it)')}`);
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, template(port), { mode: 0o600 });
    console.log(`${green('created')} ${file}`);
    wroteConfig = true;
  }

  // 2. optionally point Claude Code at the gateway
  const url = baseUrlFor({ port });
  const target = settingsPath({ global });
  const scope = global ? 'every project' : 'this project';

  let wantSettings = false;
  if (!flags['no-settings']) {
    wantSettings = await confirm(
      `Point Claude Code at the gateway for ${scope}?  ${short(target)}`,
      { yes, defaultValue: true },
    );
  }

  let wroteSettings = false;

  if (wantSettings) {
    const result = applyEnv({ global, env: settingsEnv(url) });
    const detail = dim(`(ANTHROPIC_BASE_URL=${url})`);

    switch (result.action) {
      case 'created':
        console.log(`${green('created')} ${result.file} ${detail}`);
        wroteSettings = true;
        break;
      case 'updated':
        console.log(`${green('updated')} ${result.file} ${detail}`);
        if (result.previous.ANTHROPIC_BASE_URL) {
          console.log(dim(`        was ${result.previous.ANTHROPIC_BASE_URL}`));
        }
        wroteSettings = true;
        break;
      case 'unchanged':
        console.log(`${dim('ok')}      ${result.file} ${dim(`already points at ${url}`)}`);
        wroteSettings = true;
        break;
      case 'unreadable':
        console.log(`${red('skipped')} ${result.file} ${dim(`— ${result.error}`)}`);
        break;
    }
  }

  // 3. keep the local files out of git
  if (!global && !flags['no-gitignore']) {
    const entries = [
      [CONFIG_NAME, 'ccmpg config - may hold a real API key'],
      ['dump.log', 'ccmpg --dump transcript - holds every request and response body'],
    ];
    if (wroteSettings) entries.push([SETTINGS_ENTRY, null]);

    for (const [entry, comment] of entries) {
      const result = ensureIgnored(entry, { comment: comment ?? undefined });
      if (result.action === 'created') {
        console.log(`${green('created')} ${result.file} ${dim(`(ignoring ${entry})`)}`);
      } else if (result.action === 'updated') {
        console.log(`${green('updated')} ${result.file} ${dim(`(+ ${entry})`)}`);
      }
    }
  }

  // 4. what to do next
  console.log('');
  let step = 1;
  if (wroteConfig) {
    console.log(`  ${step++}. Open ${cyan(CONFIG_NAME)} and set ${cyan('base_url')}, ${cyan('api_key')} and your ${cyan('models:')}`);
  }
  console.log(`  ${step++}. Start the gateway with  ${cyan('ccmpg')}`);

  if (wroteSettings) {
    console.log(`  ${step}. Run ${cyan('claude')}${global ? '' : ' from this directory'} — it picks up the base URL automatically`);
  } else {
    console.log(`  ${step}. Point Claude Code at it yourself:`);
    console.log(`     ${cyan(`export ANTHROPIC_BASE_URL=${url}`)}`);
    console.log(dim(`     or add  "env": { "ANTHROPIC_BASE_URL": "${url}" }  to ${short(target)}`));
  }

  console.log('');
  console.log(dim('  Anthropic models need no entry — anything not in models: goes straight through.'));

  return 0;
}

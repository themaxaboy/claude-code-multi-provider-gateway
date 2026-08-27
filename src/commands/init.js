import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIG_NAME, DEFAULT_SERVER, configPath } from '../config.js';
import { applyBaseUrl, baseUrlFor, settingsPath } from '../claude-settings.js';
import { confirm } from '../prompt.js';
import { cyan, dim, green, red, yellow } from '../log.js';

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
    fs.writeFileSync(file, template(port));
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
    const result = applyBaseUrl({ global, url });

    switch (result.action) {
      case 'created':
        console.log(`${green('created')} ${result.file} ${dim(`(ANTHROPIC_BASE_URL=${url})`)}`);
        wroteSettings = true;
        break;
      case 'updated':
        console.log(`${green('updated')} ${result.file} ${dim(`(ANTHROPIC_BASE_URL=${url})`)}`);
        if (result.previous) console.log(dim(`        was ${result.previous}`));
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

  // 3. what to do next
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

  if (!global) {
    console.log(dim(`  Add ${CONFIG_NAME} to .gitignore if you keep a real key in it.`));
  }

  return 0;
}

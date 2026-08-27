#!/usr/bin/env node
// Parse argv and dispatch. Every command accepts -g to act on the global config.

import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { ConfigError } from '../src/config.js';
import { NotATTYError } from '../src/prompt.js';
import { printUpdateNotice, scheduleUpdateCheck } from '../src/update.js';
import { red, dim } from '../src/log.js';

const pkg = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);

const HELP = `ccmpg ${pkg.version} — Claude Code Multi-Provider Gateway

Usage
  ccmpg [command] [options]

Gateway
  start                   run in the foreground (default when no command given)
  start -d                run in the background
  stop                    stop the running gateway
  restart                 stop, then start again with the current config
  status                  show pid, port and which config is loaded
  logs -f                 follow the background gateway's log
  startup                 run automatically at boot (undo with unstartup)
  unstartup               remove the boot entry

Config
  init                    write a starter .ccmpg.yaml (+ point Claude Code at it)
  config                  print the merged config
  provider add|rm|ls      manage providers
  model add|rm|ls         manage model aliases

Options
  -g, --global            act on ~/.config/ccmpg/.ccmpg.yaml
  -d, --detach            run the gateway in the background
  -p, --port <number>     override server.port
      --host <addr>       override server.host
      --dump [file]       record every request and response (default: dump.log)
  -f, --follow            keep following the log
  -a, --all               show every running gateway
  -v, --verbose           print forwarded headers and target URLs
  -y, --yes               answer confirmation prompts with yes
      --force             overwrite an existing file
      --no-settings       init: skip writing Claude Code's settings file
      --no-gitignore      init: skip updating .gitignore
      --cascade           remove dependent model aliases too
      --version           print the version
  -h, --help              show this help
`;

const OPTIONS = {
  global: { type: 'boolean', short: 'g', default: false },
  detach: { type: 'boolean', short: 'd', default: false },
  port: { type: 'string', short: 'p' },
  host: { type: 'string' },
  dump: { type: 'string' },
  follow: { type: 'boolean', short: 'f', default: false },
  all: { type: 'boolean', short: 'a', default: false },
  verbose: { type: 'boolean', short: 'v', default: false },
  yes: { type: 'boolean', short: 'y', default: false },
  force: { type: 'boolean', default: false },
  cascade: { type: 'boolean', default: false },
  'no-settings': { type: 'boolean', default: false },
  'no-gitignore': { type: 'boolean', default: false },
  version: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
  // provider/model flags, so partial input can skip the matching question
  'base-url': { type: 'string' },
  'api-key': { type: 'string' },
  model: { type: 'string' },
  provider: { type: 'string' },
};

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    console.error(red(error.message));
    console.error(dim('Run  ccmpg --help  for usage.'));
    return 2;
  }

  const { values, positionals } = parsed;

  if (values.version) {
    console.log(pkg.version);
    return 0;
  }

  const [command = 'start', ...rest] = positionals;

  if (values.help || command === 'help') {
    console.log(HELP);
    return 0;
  }

  const flags = {
    ...values,
    port: values.port === undefined ? undefined : Number(values.port),
    // `--dump` with no value should still mean "dump to the default file"
    dump: values.dump === '' ? 'dump.log' : values.dump,
  };

  if (values.port !== undefined && !Number.isInteger(flags.port)) {
    console.error(red(`--port must be a number, got "${values.port}"`));
    return 2;
  }

  const ctx = { version: pkg.version };

  switch (command) {
    case 'start':
      return (await import('../src/commands/start.js')).start(flags, ctx);

    // Internal: what `start -d` spawns. Always foreground inside the child.
    case '__serve':
      return (await import('../src/commands/start.js')).serve({ ...flags, detach: true }, ctx);

    case 'stop':
      return (await import('../src/commands/lifecycle.js')).stop(flags);
    case 'restart':
      return (await import('../src/commands/lifecycle.js')).restart(flags, ctx);
    case 'status':
      return (await import('../src/commands/lifecycle.js')).status(flags);
    case 'logs':
      return (await import('../src/commands/lifecycle.js')).logs(flags);

    case 'init':
      return (await import('../src/commands/init.js')).init(flags);
    case 'config':
      return (await import('../src/commands/show.js')).show(flags);

    case 'provider':
      return (await import('../src/commands/provider.js')).provider(rest, flags);
    case 'model':
      return (await import('../src/commands/model.js')).model(rest, flags);

    case 'startup':
      return (await import('../src/commands/startup.js')).startup(flags, ctx);
    case 'unstartup':
      return (await import('../src/commands/startup.js')).unstartup(flags);

    default:
      console.error(red(`Unknown command: ${command}`));
      console.error(dim('Run  ccmpg --help  for the list.'));
      return 2;
  }
}

try {
  process.exitCode = (await main(process.argv.slice(2))) ?? 0;

  // Long-running commands print their own notice inside the banner.
  if (!['start', '__serve'].includes(process.argv[2] ?? 'start')) {
    printUpdateNotice(pkg.version);
    scheduleUpdateCheck(pkg.version);
  }
} catch (error) {
  if (error instanceof NotATTYError) {
    console.error(red(error.message));
    console.error(dim('Pass every value as a flag when running without a terminal.'));
    console.error(dim('Example:  ccmpg provider add z_ai --base-url https://api.z.ai/api/anthropic --api-key sk-...'));
    process.exitCode = 2;
  } else if (error instanceof ConfigError) {
    console.error(red(error.message));
    if (error.hint) console.error(dim(error.hint));
    process.exitCode = 1;
  } else if (error?.code === 'EADDRINUSE') {
    console.error(red(`Port already in use: ${error.port}`));
    console.error(dim('Another gateway may be running. Try  ccmpg status'));
    process.exitCode = 1;
  } else if (error?.name === 'ExitPromptError') {
    // Ctrl+C inside an inquirer prompt
    process.exitCode = 130;
  } else {
    console.error(red(error?.stack ?? String(error)));
    process.exitCode = 1;
  }
}

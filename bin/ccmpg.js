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
  restart                 stop, then start again in the background
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

Values for provider/model, so they work without a terminal
      --base-url <url>    provider add: the provider's API base URL
      --api-key <key>     provider add: the credential (or \${ENV_VAR})
      --model <id>        model add: the provider's real model id
      --provider <name>   model add: which provider the alias uses

Both --dump and --verbose mask credentials, but --dump still records every
request and response body. Treat its output as sensitive.
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

const COMMANDS = new Set([
  'start', '__serve', 'stop', 'restart', 'status', 'logs',
  'init', 'config', 'provider', 'model', 'startup', 'unstartup', 'help',
]);

const DEFAULT_DUMP_FILE = 'dump.log';

/**
 * `parseArgs` in strict mode has no notion of an optional value, so a bare
 * `--dump` either fails outright or — worse, with the flag before the command —
 * silently swallows the command name as its filename. Supply the documented
 * default before parseArgs ever sees it.
 */
function withDumpDefault(args) {
  return args.map((arg, i) => {
    if (arg !== '--dump') return arg;
    const next = args[i + 1];
    const bare = next === undefined || next.startsWith('-') || COMMANDS.has(next);
    return bare ? `--dump=${DEFAULT_DUMP_FILE}` : arg;
  });
}

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: withDumpDefault(argv),
      options: OPTIONS,
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    console.error(red(error.message));
    console.error(dim('Run  ccmpg --help  for usage.'));
    return { code: 2, command: null };
  }

  const { values, positionals } = parsed;
  const [command = 'start', ...rest] = positionals;

  if (values.version) {
    console.log(pkg.version);
    return { code: 0, command };
  }

  if (values.help || command === 'help') {
    console.log(HELP);
    return { code: 0, command };
  }

  const flags = {
    ...values,
    port: values.port === undefined ? undefined : Number(values.port),
    // `--dump` with no value still means "dump to the default file"
    dump: values.dump === '' ? DEFAULT_DUMP_FILE : values.dump,
  };

  // Same range normalize() enforces — checked here too so a flag override
  // cannot smuggle past it and bind an ephemeral port the banner misreports.
  if (values.port !== undefined && (!Number.isInteger(flags.port) || flags.port < 1 || flags.port > 65535)) {
    console.error(red(`--port must be a whole number between 1 and 65535, got "${values.port}"`));
    return { code: 2, command };
  }

  const ctx = { version: pkg.version };

  switch (command) {
    case 'start':
      return { code: await (await import('../src/commands/start.js')).start(flags, ctx), command };

    // Internal: what `start -d` and the boot entries spawn. Always foreground
    // inside the child.
    case '__serve':
      return { code: await (await import('../src/commands/start.js')).serve({ ...flags, detach: true }, ctx), command };

    case 'stop':
      return { code: (await import('../src/commands/lifecycle.js')).stop(flags), command };
    case 'restart':
      return { code: await (await import('../src/commands/lifecycle.js')).restart(flags, ctx), command };
    case 'status':
      return { code: (await import('../src/commands/lifecycle.js')).status(flags), command };
    case 'logs':
      return { code: await (await import('../src/commands/lifecycle.js')).logs(flags), command };

    case 'init':
      return { code: await (await import('../src/commands/init.js')).init(flags), command };
    case 'config':
      return { code: (await import('../src/commands/show.js')).show(flags), command };

    case 'provider':
      return { code: await (await import('../src/commands/provider.js')).provider(rest, flags), command };
    case 'model':
      return { code: await (await import('../src/commands/model.js')).model(rest, flags), command };

    case 'startup':
      return { code: (await import('../src/commands/startup.js')).startup(flags, ctx), command };
    case 'unstartup':
      return { code: (await import('../src/commands/startup.js')).unstartup(flags), command };

    default:
      console.error(red(`Unknown command: ${command}`));
      console.error(dim('Run  ccmpg --help  for the list.'));
      return { code: 2, command: null };
  }
}

try {
  const { code, command } = await main(process.argv.slice(2));
  process.exitCode = code ?? 0;

  // Long-running commands print their own notice inside the banner. This reads
  // the parsed command, not argv[2], which is a flag as often as not.
  if (!['start', '__serve'].includes(command)) {
    printUpdateNotice(pkg.version);
    scheduleUpdateCheck(pkg.version);
  }
} catch (error) {
  if (error instanceof NotATTYError) {
    console.error(red(error.message));
    if (error.need === 'yes') {
      console.error(dim('Pass  -y  to accept, or the matching --no-... flag to skip the step.'));
    } else {
      console.error(dim('Pass every value as a flag when running without a terminal.'));
      console.error(dim('Example:  ccmpg provider add z_ai --base-url https://api.z.ai/api/anthropic --api-key sk-...'));
    }
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

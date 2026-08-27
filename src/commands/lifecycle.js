// stop · restart · status · logs

import fs from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import * as daemon from '../daemon.js';
import { configPath } from '../config.js';
import { dim, green, red, yellow } from '../log.js';
import { start } from './start.js';

export function stop(flags) {
  const key = daemon.scopeKey({ global: flags.global });
  const stopped = daemon.stop(key);

  if (!stopped) {
    console.error(`Nothing running for the ${daemon.scopeLabel(key)} scope.`);
    return 1;
  }

  console.log(`${green('stopped')} ${daemon.scopeLabel(key)} gateway`);
  return 0;
}

export async function restart(flags, ctx) {
  const key = daemon.scopeKey({ global: flags.global });
  const running = daemon.get(key);

  if (running) {
    daemon.stop(key);
    console.log(dim(`stopped pid ${running.pid}`));
    // Give the OS a moment to release the listening socket.
    await sleep(300);
  }

  return start({ ...flags, detach: true }, ctx);
}

export function status(flags) {
  const running = daemon.list();
  const rows = [];

  const scopes = flags.all
    ? running.map((entry) => entry.key)
    : [daemon.scopeKey({ global: true }), daemon.scopeKey({ global: false })];

  for (const key of new Set(scopes)) {
    const entry = running.find((r) => r.key === key);
    const isGlobal = key === 'global';

    if (entry) {
      rows.push([
        daemon.scopeLabel(key),
        green('running'),
        String(entry.pid),
        String(entry.port),
        daemon.uptime(entry.startedAt),
        entry.config,
      ]);
    } else {
      const file = isGlobal ? configPath({ global: true }) : configPath({ global: false });
      const exists = fs.existsSync(file);
      rows.push([
        daemon.scopeLabel(key),
        exists ? yellow('stopped') : dim('no config'),
        dim('-'),
        dim('-'),
        dim('-'),
        exists ? file : dim(file),
      ]);
    }
  }

  printTable(['SCOPE', 'STATUS', 'PID', 'PORT', 'UPTIME', 'CONFIG'], rows);

  if (!flags.all && running.length > rows.filter((r) => !r[1].includes('stopped')).length) {
    console.log('');
    console.log(dim('Other gateways are running elsewhere. Use  ccmpg status -a  to see them.'));
  }

  return 0;
}

export async function logs(flags) {
  const key = daemon.scopeKey({ global: flags.global });
  const file = daemon.logPath(key);

  if (!fs.existsSync(file)) {
    console.error(`No log file yet at ${file}`);
    console.error(dim('Logs appear once the gateway has run with  ccmpg start -d'));
    return 1;
  }

  const tailBytes = 16 * 1024;
  const { size } = fs.statSync(file);
  const from = Math.max(0, size - tailBytes);

  process.stdout.write(fs.readFileSync(file, 'utf8').slice(from ? 1 : 0));

  if (!flags.follow) return 0;

  // Poll rather than fs.watch: watch is unreliable across platforms for appends.
  let offset = size;
  for (;;) {
    await sleep(400);
    let current;
    try {
      current = fs.statSync(file).size;
    } catch {
      continue;
    }
    if (current < offset) offset = 0; // truncated
    if (current > offset) {
      const stream = fs.createReadStream(file, { start: offset, end: current - 1 });
      for await (const chunk of stream) process.stdout.write(chunk);
      offset = current;
    }
  }
}

function printTable(headers, rows) {
  const strip = (s) => String(s).replace(/\u001b\[[0-9;]*m/g, '');
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => strip(r[i]).length)),
  );

  const line = (cells) =>
    cells
      .map((cell, i) => cell + ' '.repeat(widths[i] - strip(cell).length))
      .join('  ')
      .trimEnd();

  console.log(dim(line(headers)));
  for (const row of rows) console.log(line(row));
}

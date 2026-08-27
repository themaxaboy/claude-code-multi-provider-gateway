import { setTimeout as sleep } from 'node:timers/promises';
import { ANTHROPIC_BASE_URL, loadConfig } from '../config.js';
import { createServer } from '../server.js';
import * as daemon from '../daemon.js';
import { cyan, dim, green, logError, red } from '../log.js';
import { printUpdateNotice, scheduleUpdateCheck } from '../update.js';

/** How long to wait before believing a detached gateway actually started. */
const READY_CHECK_MS = 400;

/** Shared by the foreground and detached paths. */
function resolveConfig(flags) {
  const cfg = loadConfig({ globalOnly: flags.global });
  const host = flags.host ?? cfg.server.host;
  const port = flags.port ?? cfg.server.port;
  return { cfg, host, port };
}

function banner({ cfg, host, port, version }) {
  const names = (obj) => (Object.keys(obj).length ? Object.keys(obj).join(', ') : dim('none'));
  const files = cfg.files.map((f) => f.path).join(dim(' + '));

  console.log(`${cyan(`ccmpg ${version}`)}  ${dim('·')}  listening on ${green(`http://${host}:${port}`)}`);
  console.log(`  ${dim('config   ')} ${files}`);
  console.log(`  ${dim('providers')} ${names(cfg.providers)}`);
  console.log(`  ${dim('models   ')} ${names(cfg.models)}`);
  console.log(`  ${dim('default  ')} ${ANTHROPIC_BASE_URL.replace('https://', '')}`);
  console.log('');
}

/** Runs the server in this process and blocks until it is stopped. */
export async function serve(flags, { version }) {
  const { cfg, host, port } = resolveConfig(flags);
  const server = createServer(cfg, { dump: flags.dump, verbose: flags.verbose });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      // Past listen, errors are no longer this promise's business. Leaving the
      // rejector attached would swallow them into an already-settled promise.
      server.off('error', reject);
      server.on('error', (error) => logError(`server error: ${error.message}`));
      resolve();
    });
  });

  banner({ cfg, host, port, version });

  if (!flags.detach) {
    console.log(`  ${dim('Ctrl+C to stop')}  ${dim('·')}  ${dim('ccmpg start -d to run in the background')}`);
    console.log('');
  }
  if (flags.dump) console.log(dim(`  dumping every request to ${flags.dump}`));

  const key = daemon.scopeKey({ global: flags.global });

  // A boot entry (launchd, systemd, the Windows Startup folder) runs __serve
  // directly, with no parent to do the bookkeeping — so the process records
  // itself. Without this, status/stop/logs all went blind after a reboot.
  if (flags.detach) {
    daemon.register({
      key,
      cwd: process.cwd(),
      config: cfg.files.map((f) => f.path).join(' + '),
      host,
      port,
    });
  }

  // Several Claude Code sessions can share one gateway; a single stray error
  // must not take all of them down without explanation.
  process.on('uncaughtException', (error) => logError(`uncaught: ${error?.stack ?? error}`));
  process.on('unhandledRejection', (reason) => logError(`unhandled rejection: ${reason?.stack ?? reason}`));

  printUpdateNotice(version);
  // The server is about to run for a long time, so a background refresh here
  // costs nothing and keeps the cache warm for short commands.
  scheduleUpdateCheck(version);

  return new Promise((resolveServe) => {
    const shutdown = () => {
      if (flags.detach) daemon.forget(key);
      server.close(() => resolveServe(0));
      // Streaming connections can hold the socket open; do not wait forever.
      setTimeout(() => {
        server.closeAllConnections?.();
        resolveServe(0);
      }, 2000).unref();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
}

export async function start(flags, ctx) {
  if (!flags.detach) return serve(flags, ctx);

  const key = daemon.scopeKey({ global: flags.global });
  const running = daemon.get(key);
  if (running) {
    console.error(`Already running (pid ${running.pid}) on http://${running.host}:${running.port}`);
    console.error(`Use  ccmpg restart${flags.global ? ' -g' : ''}  to reload it.`);
    return 1;
  }

  // Fail fast in this process so the user sees config errors instead of a
  // daemon that dies silently one second later.
  const { cfg, host, port } = resolveConfig(flags);

  const args = [];
  if (flags.global) args.push('-g');
  if (flags.host !== undefined) args.push('--host', flags.host);
  if (flags.port !== undefined) args.push('--port', String(flags.port));
  if (flags.dump) args.push('--dump', flags.dump);
  if (flags.verbose) args.push('--verbose');

  const { pid, logFile } = daemon.start({
    key,
    cwd: process.cwd(),
    args,
    config: cfg.files.map((f) => f.path).join(' + '),
    host,
    port,
  });

  // Config errors were caught above, but binding errors happen in the child —
  // a busy port, an unusable --host. Claiming success without checking is how
  // "started in background" came to be printed for a gateway that was gone.
  await sleep(READY_CHECK_MS);
  if (!daemon.isAlive(pid)) {
    daemon.forget(key);
    console.error(red(`The gateway exited immediately — nothing is listening on ${host}:${port}.`));
    const tail = daemon.tailFile(logFile, 2048).trim();
    if (tail) {
      console.error(dim(`last lines of ${logFile}:`));
      console.error(tail);
    } else {
      console.error(dim(`see ${logFile}`));
    }
    return 1;
  }

  console.log(`${cyan(`ccmpg ${ctx.version}`)}  ${dim('·')}  ${green('started in background')}  ${dim('·')}  pid ${pid}`);
  console.log(`  ${dim('listening')} http://${host}:${port}`);
  console.log(`  ${dim('logs     ')} ${logFile}`);
  console.log('');
  console.log(dim(`  ccmpg status  ·  ccmpg logs -f  ·  ccmpg stop`));
  printUpdateNotice(ctx.version);
  return 0;
}

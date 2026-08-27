// Register the gateway to launch at boot, using whatever the OS provides.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ConfigError, loadConfig } from '../config.js';
import { cyan, dim, green, red } from '../log.js';
import * as daemon from '../daemon.js';

const BIN = fileURLToPath(new URL('../../bin/ccmpg.js', import.meta.url));

/**
 * A boot entry is named after its scope.
 *
 * The basename alone is not enough: it can contain characters systemd and
 * launchd reject, and two checkouts sharing one (~/work/api and ~/oss/api)
 * would overwrite each other's entry. The hash of the absolute path keeps them
 * apart, the same way the daemon registry does.
 */
function unitName(flags) {
  if (flags.global) return 'ccmpg';
  const cwd = path.resolve(process.cwd());
  const base = path.basename(cwd).replace(/[^A-Za-z0-9_-]/g, '-') || 'project';
  const hash = crypto.createHash('sha1').update(cwd).digest('hex').slice(0, 8);
  return `ccmpg-${base}-${hash}`;
}

/** Arguments the boot entry should launch with. */
function serveArgs(flags) {
  const args = ['__serve'];
  if (flags.global) args.push('-g');
  if (flags.port !== undefined) args.push('--port', String(flags.port));
  if (flags.host !== undefined) args.push('--host', flags.host);
  return args;
}

export function startup(flags) {
  // Fail early on a broken config: a boot entry that cannot start is worse than
  // no boot entry at all.
  const cfg = loadConfig({ globalOnly: flags.global });
  const port = flags.port ?? cfg.server.port;
  const host = flags.host ?? cfg.server.host;

  const target = {
    name: unitName(flags),
    cwd: process.cwd(),
    args: serveArgs(flags),
    host,
    port,
    // The same file `ccmpg logs` reads, so boot-launched and `start -d`
    // gateways are inspected the same way.
    log: daemon.logFileFor(daemon.scopeKey({ global: flags.global })),
  };

  switch (process.platform) {
    case 'darwin':
      return installLaunchd(target);
    case 'linux':
      return installSystemd(target);
    case 'win32':
      return installWindows(target);
    default:
      console.error(red(`ccmpg startup does not support ${process.platform} yet.`));
      console.error(dim('Start it yourself with:  ccmpg start -d'));
      return 1;
  }
}

export function unstartup(flags) {
  const target = { name: unitName(flags) };

  switch (process.platform) {
    case 'darwin':
      return removeLaunchd(target);
    case 'linux':
      return removeSystemd(target);
    case 'win32':
      return removeWindows(target);
    default:
      console.error(red(`ccmpg unstartup does not support ${process.platform}.`));
      return 1;
  }
}

// ------------------------------------------------------------------ macOS

function launchdPlistPath(name) {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `com.${name}.plist`);
}

function installLaunchd({ name, cwd, args, host, port, log }) {
  const file = launchdPlistPath(name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(daemon.STATE_DIR, { recursive: true });

  const argv = [process.execPath, BIN, ...args]
    .map((a) => `    <string>${escapeXml(a)}</string>`)
    .join('\n');

  fs.writeFileSync(
    file,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.${name}</string>
  <key>ProgramArguments</key>
  <array>
${argv}
  </array>
  <key>WorkingDirectory</key><string>${escapeXml(cwd)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${escapeXml(log)}</string>
  <key>StandardErrorPath</key><string>${escapeXml(log)}</string>
</dict>
</plist>
`,
  );

  activate(file, () => {
    run('launchctl', ['unload', file], { ignoreFailure: true });
    run('launchctl', ['load', '-w', file]);
  });

  return report(file, { host, port, undo: `launchctl unload -w ${file}` });
}

function removeLaunchd({ name }) {
  const file = launchdPlistPath(name);
  if (!fs.existsSync(file)) return notInstalled();
  run('launchctl', ['unload', '-w', file], { ignoreFailure: true });
  fs.rmSync(file);
  return removed(file);
}

// ------------------------------------------------------------------ Linux

function systemdUnitPath(name) {
  return path.join(os.homedir(), '.config', 'systemd', 'user', `${name}.service`);
}

function installSystemd({ name, cwd, args, host, port, log }) {
  const file = systemdUnitPath(name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(daemon.STATE_DIR, { recursive: true });

  const exec = [process.execPath, BIN, ...args].map(quoteUnit).join(' ');

  fs.writeFileSync(
    file,
    `[Unit]
Description=ccmpg - Claude Code Multi-Provider Gateway
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${cwd}
ExecStart=${exec}
StandardOutput=append:${log}
StandardError=append:${log}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`,
  );

  activate(file, () => {
    run('systemctl', ['--user', 'daemon-reload']);
    run('systemctl', ['--user', 'enable', '--now', `${name}.service`]);
  });

  console.log(dim('  tip: loginctl enable-linger keeps it up without an active login'));
  return report(file, { host, port, undo: `systemctl --user disable --now ${name}.service` });
}

function removeSystemd({ name }) {
  const file = systemdUnitPath(name);
  if (!fs.existsSync(file)) return notInstalled();
  run('systemctl', ['--user', 'disable', '--now', `${name}.service`], { ignoreFailure: true });
  fs.rmSync(file);
  run('systemctl', ['--user', 'daemon-reload'], { ignoreFailure: true });
  return removed(file);
}

// ------------------------------------------------------------------ Windows
//
// Task Scheduler ONLOGON entries require elevation, so use the per-user Startup
// folder instead: no admin rights, and the entry is a plain file the user can
// inspect or delete. A .vbs wrapper launches the gateway with no console flash.

function startupFolder() {
  const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

function windowsEntryPath(name) {
  return path.join(startupFolder(), `${name}.vbs`);
}

function installWindows({ name, cwd, args, host, port }) {
  const file = windowsEntryPath(name);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  // Inside a VBScript string literal a double quote is written twice — which is
  // both how an argument gets quoted and how a quote inside one is escaped.
  const command = [process.execPath, BIN, ...args]
    .map((a) => (/\s/.test(a) ? `""${quoteVbs(a)}""` : quoteVbs(a)))
    .join(' ');

  fs.writeFileSync(
    file,
    `' ccmpg - starts the Claude Code gateway at logon
' Remove it with:  ccmpg unstartup${args.includes('-g') ? ' -g' : ''}
' Or just delete this file.
Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = "${quoteVbs(cwd)}"
shell.Run "${command}", 0, False
`,
  );

  // Unlike launchctl and systemctl, dropping a file in the Startup folder does
  // not run it — so do not claim anything is listening yet.
  return report(file, { host, port, undo: `del "${file}"`, active: false });
}

function removeWindows({ name }) {
  const file = windowsEntryPath(name);
  if (!fs.existsSync(file)) return notInstalled();
  fs.rmSync(file);
  return removed(file);
}

// ------------------------------------------------------------------ helpers

function run(command, args, { ignoreFailure = false } = {}) {
  try {
    execFileSync(command, args, { stdio: 'pipe' });
  } catch (error) {
    if (ignoreFailure) return;
    const detail = error.stderr?.toString().trim() || error.message;
    // A ConfigError prints as a message, not a stack: every way this fails —
    // no D-Bus session, launchctl refusing the label — is the user's to fix.
    throw new ConfigError(`${command} ${args.join(' ')} failed: ${detail}`, {
      hint: 'No boot entry was installed. You can still run:  ccmpg start -d',
    });
  }
}

/** Roll the unit file back if the tool meant to activate it refuses. */
function activate(file, steps) {
  try {
    steps();
  } catch (error) {
    fs.rmSync(file, { force: true });
    throw error;
  }
}

function report(where, { host, port, undo, active = true }) {
  const url = `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
  console.log(`${green('registered')} ${where}`);
  if (active) {
    console.log(`  ${dim('listening on')} ${url} ${dim('now, and after every boot')}`);
  } else {
    console.log(`  ${dim('starts on')} ${url} ${dim('at your next sign-in')}`);
    console.log(`  ${dim('start it now with')} ${cyan('ccmpg start -d')}`);
  }
  console.log('');
  console.log(`  ${dim('undo with')} ${cyan('ccmpg unstartup')} ${dim(`(or: ${undo})`)}`);
  return 0;
}

function removed(where) {
  console.log(`${green('removed')} ${where}`);
  return 0;
}

function notInstalled() {
  console.error('No boot entry is installed for this scope.');
  return 1;
}

const escapeXml = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const quoteUnit = (s) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);
const quoteVbs = (s) => s.replace(/"/g, '""');

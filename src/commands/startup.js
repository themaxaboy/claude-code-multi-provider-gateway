// Register the gateway to launch at boot, using whatever the OS provides.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.js';
import { cyan, dim, green, red } from '../log.js';
import * as daemon from '../daemon.js';

const BIN = fileURLToPath(new URL('../../bin/ccmpg.js', import.meta.url));

function unitName(flags) {
  return flags.global ? 'ccmpg' : `ccmpg-${path.basename(process.cwd())}`;
}

/** Arguments the boot entry should launch with. */
function serveArgs(flags) {
  const args = ['__serve'];
  if (flags.global) args.push('-g');
  if (flags.port) args.push('--port', String(flags.port));
  if (flags.host) args.push('--host', flags.host);
  return args;
}

export function startup(flags) {
  // Fail early on a broken config: a boot entry that cannot start is worse than
  // no boot entry at all.
  const cfg = loadConfig({ globalOnly: flags.global });
  const port = flags.port ?? cfg.server.port;

  const target = { name: unitName(flags), cwd: process.cwd(), args: serveArgs(flags), port };

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

function installLaunchd({ name, cwd, args, port }) {
  const file = launchdPlistPath(name);
  const log = path.join(daemon.STATE_DIR, `${name}.boot.log`);
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

  run('launchctl', ['unload', file], { ignoreFailure: true });
  run('launchctl', ['load', '-w', file]);

  return report(file, port, `launchctl unload -w ${file}`);
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

function installSystemd({ name, cwd, args, port }) {
  const file = systemdUnitPath(name);
  fs.mkdirSync(path.dirname(file), { recursive: true });

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
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`,
  );

  run('systemctl', ['--user', 'daemon-reload']);
  run('systemctl', ['--user', 'enable', '--now', `${name}.service`]);

  console.log(dim('  tip: loginctl enable-linger keeps it up without an active login'));
  return report(file, port, `systemctl --user disable --now ${name}.service`);
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

function installWindows({ name, cwd, args, port }) {
  const file = windowsEntryPath(name);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  // Inside a VBScript string literal a double quote is written twice.
  const command = [process.execPath, BIN, ...args]
    .map((a) => (/\s/.test(a) ? `""${a}""` : a))
    .join(' ');

  fs.writeFileSync(
    file,
    `' ccmpg - starts the Claude Code gateway at logon
' Remove it with:  ccmpg unstartup${args.includes('-g') ? ' -g' : ''}
' Or just delete this file.
Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = "${cwd}"
shell.Run "${command}", 0, False
`,
  );

  return report(file, port, `del "${file}"`);
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
    throw new Error(`${command} ${args.join(' ')} failed: ${detail}`);
  }
}

function report(where, port, undoCommand) {
  console.log(`${green('registered')} ${where}`);
  console.log(`  ${dim('listens on')} http://127.0.0.1:${port} ${dim('after every boot')}`);
  console.log('');
  console.log(`  ${dim('undo with')} ${cyan('ccmpg unstartup')} ${dim(`(or: ${undoCommand})`)}`);
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
const quoteWin = (s) => (/\s/.test(s) ? `\\"${s}\\"` : s);

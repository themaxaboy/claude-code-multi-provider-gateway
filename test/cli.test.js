// Argv handling in bin/ccmpg.js. Spawned rather than imported: the entrypoint
// runs its dispatch on load, so there is nothing importable to call.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/ccmpg.js', import.meta.url));

/** @returns {{code: number, stdout: string, stderr: string}} */
function run(...args) {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CCMPG_NO_UPDATE_CHECK: '1', NO_COLOR: '1' },
    });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    return {
      code: error.status ?? 1,
      stdout: error.stdout?.toString() ?? '',
      stderr: error.stderr?.toString() ?? '',
    };
  }
}

test('--dump with no value is accepted, as --help advertises', () => {
  // parseArgs in strict mode has no optional values: this used to fail with
  // "Option '--dump' argument is ambiguous".
  const result = run('--dump', '--version');
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^\d+\.\d+\.\d+/);
});

test('--dump=<file> still works', () => {
  const result = run('--dump=custom.log', '--version');
  assert.equal(result.code, 0, result.stderr);
});

test('--dump before a command does not swallow the command', () => {
  // `ccmpg --dump help` used to parse as dump="help" with no positionals, so it
  // silently ran `start` and dumped to a file named "help".
  const result = run('--dump', 'help');
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Usage/);
  assert.match(result.stdout, /provider add\|rm\|ls/);
});

test('--port is range checked, not just parsed as a number', () => {
  // The `=` form so a leading dash reaches our check rather than parseArgs'.
  for (const bad of ['0', '99999', '-1', 'abc', '80.5']) {
    const result = run(`--port=${bad}`, 'nosuchcommand');
    assert.equal(result.code, 2, `--port ${bad} should be rejected`);
    assert.match(result.stderr, /between 1 and 65535/, `--port ${bad}`);
  }
});

test('a valid --port gets past validation to the dispatch', () => {
  const result = run('--port', '8080', 'nosuchcommand');
  assert.equal(result.code, 2);
  assert.match(result.stderr, /Unknown command/);
});

test('an unknown flag exits 2 and points at --help', () => {
  const result = run('--nope');
  assert.equal(result.code, 2);
  assert.match(result.stderr, /ccmpg --help/);
});

test('--help lists the value flags the non-TTY error tells users to pass', () => {
  const { stdout } = run('--help');
  for (const flag of ['--base-url', '--api-key', '--model', '--provider']) {
    assert.ok(stdout.includes(flag), `${flag} is missing from --help`);
  }
});

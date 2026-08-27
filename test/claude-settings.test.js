import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyEnv, baseUrlFor, settingsPath } from '../src/claude-settings.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ccmpg-settings-'));
}

function seed(cwd, contents) {
  const file = path.join(cwd, '.claude', 'settings.local.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return file;
}

const URL = 'http://localhost:8787';

test('project scope writes .claude/settings.local.json', () => {
  const cwd = tmpdir();
  const result = applyEnv({ cwd, env: { ANTHROPIC_BASE_URL: URL } });

  assert.equal(result.action, 'created');
  assert.equal(result.file, path.join(cwd, '.claude', 'settings.local.json'));
  assert.deepEqual(JSON.parse(fs.readFileSync(result.file, 'utf8')), {
    env: { ANTHROPIC_BASE_URL: URL },
  });
});

test('global scope targets ~/.claude/settings.json', () => {
  assert.equal(
    settingsPath({ global: true }),
    path.join(os.homedir(), '.claude', 'settings.json'),
  );
});

test('existing keys survive — permissions, hooks, model', () => {
  const cwd = tmpdir();
  seed(
    cwd,
    JSON.stringify(
      {
        model: 'opus',
        permissions: { allow: ['Bash(npm test)'] },
        hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'echo done' }] }] },
      },
      null,
      2,
    ),
  );

  const result = applyEnv({ cwd, env: { ANTHROPIC_BASE_URL: URL } });
  const after = JSON.parse(fs.readFileSync(result.file, 'utf8'));

  assert.equal(result.action, 'updated');
  assert.equal(after.model, 'opus');
  assert.deepEqual(after.permissions.allow, ['Bash(npm test)']);
  assert.equal(after.hooks.Stop[0].hooks[0].command, 'echo done');
  assert.equal(after.env.ANTHROPIC_BASE_URL, URL);
});

test('other env vars are kept alongside the new one', () => {
  const cwd = tmpdir();
  seed(cwd, JSON.stringify({ env: { FOO: 'bar', DISABLE_TELEMETRY: '1' } }));

  const result = applyEnv({ cwd, env: { ANTHROPIC_BASE_URL: URL } });
  const after = JSON.parse(fs.readFileSync(result.file, 'utf8'));

  assert.equal(after.env.FOO, 'bar');
  assert.equal(after.env.DISABLE_TELEMETRY, '1');
  assert.equal(after.env.ANTHROPIC_BASE_URL, URL);
});

test('a different existing base URL is replaced and reported', () => {
  const cwd = tmpdir();
  seed(cwd, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://localhost:9999' } }));

  const result = applyEnv({ cwd, env: { ANTHROPIC_BASE_URL: URL } });

  assert.equal(result.action, 'updated');
  assert.equal(
    result.previous.ANTHROPIC_BASE_URL,
    'http://localhost:9999',
    'the user should be told what changed',
  );
  assert.equal(
    JSON.parse(fs.readFileSync(result.file, 'utf8')).env.ANTHROPIC_BASE_URL,
    URL,
  );
});

test('running twice is a no-op the second time', () => {
  const cwd = tmpdir();
  applyEnv({ cwd, env: { ANTHROPIC_BASE_URL: URL } });
  const second = applyEnv({ cwd, env: { ANTHROPIC_BASE_URL: URL } });
  assert.equal(second.action, 'unchanged');
});

test('malformed JSON is left completely alone', () => {
  const cwd = tmpdir();
  const file = seed(cwd, '{ "env": { oops not json');
  const before = fs.readFileSync(file, 'utf8');

  const result = applyEnv({ cwd, env: { ANTHROPIC_BASE_URL: URL } });

  assert.equal(result.action, 'unreadable');
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'must not destroy the file');
});

test('a JSON array at the top level is refused', () => {
  const cwd = tmpdir();
  seed(cwd, '[]');
  assert.equal(applyEnv({ cwd, env: { ANTHROPIC_BASE_URL: URL } }).action, 'unreadable');
});

test('an empty file is treated as empty settings', () => {
  const cwd = tmpdir();
  seed(cwd, '   \n');
  const result = applyEnv({ cwd, env: { ANTHROPIC_BASE_URL: URL } });
  assert.equal(result.action, 'updated');
  assert.deepEqual(JSON.parse(fs.readFileSync(result.file, 'utf8')), {
    env: { ANTHROPIC_BASE_URL: URL },
  });
});

test('no temporary files are left behind', () => {
  const cwd = tmpdir();
  const result = applyEnv({ cwd, env: { ANTHROPIC_BASE_URL: URL } });
  const leftovers = fs.readdirSync(path.dirname(result.file)).filter((n) => n.includes('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('baseUrlFor renders the port and maps bind addresses to localhost', () => {
  assert.equal(baseUrlFor({ port: 8787 }), 'http://localhost:8787');
  assert.equal(baseUrlFor({ host: '127.0.0.1', port: 9000 }), 'http://localhost:9000');
  assert.equal(baseUrlFor({ host: '0.0.0.0', port: 8787 }), 'http://localhost:8787');
  assert.equal(baseUrlFor({ host: '192.168.1.5', port: 8787 }), 'http://192.168.1.5:8787');
});

// ---------------------------------------------------------------- a set of vars

test('several vars are written at once, and unrelated keys survive', () => {
  const cwd = tmpdir();
  seed(cwd, JSON.stringify({ permissions: { allow: ['Bash'] }, env: { KEEP: 'me' } }));

  const result = applyEnv({
    cwd,
    env: { ANTHROPIC_BASE_URL: URL, CLAUDE_CODE_ATTRIBUTION_HEADER: '0' },
  });

  assert.equal(result.action, 'updated');
  assert.deepEqual(result.changed.sort(), ['ANTHROPIC_BASE_URL', 'CLAUDE_CODE_ATTRIBUTION_HEADER']);
  assert.deepEqual(JSON.parse(fs.readFileSync(result.file, 'utf8')), {
    permissions: { allow: ['Bash'] },
    env: { KEEP: 'me', ANTHROPIC_BASE_URL: URL, CLAUDE_CODE_ATTRIBUTION_HEADER: '0' },
  });
});

test('a partially configured file reports only the key that changed', () => {
  const cwd = tmpdir();
  seed(cwd, JSON.stringify({ env: { ANTHROPIC_BASE_URL: URL } }));

  // The upgrade path: a file written before a second var joined the set.
  const result = applyEnv({
    cwd,
    env: { ANTHROPIC_BASE_URL: URL, CLAUDE_CODE_ATTRIBUTION_HEADER: '0' },
  });

  assert.equal(result.action, 'updated');
  assert.deepEqual(result.changed, ['CLAUDE_CODE_ATTRIBUTION_HEADER']);
  assert.deepEqual(result.previous, { CLAUDE_CODE_ATTRIBUTION_HEADER: undefined });
});

test('nothing to change is unchanged even with several vars', () => {
  const cwd = tmpdir();
  const env = { ANTHROPIC_BASE_URL: URL, CLAUDE_CODE_ATTRIBUTION_HEADER: '0' };
  applyEnv({ cwd, env });
  const second = applyEnv({ cwd, env });
  assert.equal(second.action, 'unchanged');
  assert.deepEqual(second.changed, []);
});

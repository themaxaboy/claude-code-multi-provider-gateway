import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureIgnored } from '../src/gitignore.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ccmpg-ignore-'));
}

const read = (cwd) => fs.readFileSync(path.join(cwd, '.gitignore'), 'utf8');

test('creates .gitignore when none exists', () => {
  const cwd = tmpdir();
  const result = ensureIgnored('.ccmpg.yaml', { cwd, comment: 'may hold a real API key' });

  assert.equal(result.action, 'created');
  assert.equal(read(cwd), '# may hold a real API key\n.ccmpg.yaml\n');
});

test('appends to an existing file without touching what is there', () => {
  const cwd = tmpdir();
  const before = 'node_modules/\ndist/\n*.log\n';
  fs.writeFileSync(path.join(cwd, '.gitignore'), before);

  const result = ensureIgnored('.ccmpg.yaml', { cwd });

  assert.equal(result.action, 'updated');
  const after = read(cwd);
  assert.ok(after.startsWith(before), 'existing rules must be untouched');
  assert.match(after, /^\.ccmpg\.yaml$/m);
});

test('adding the same entry twice is a no-op', () => {
  const cwd = tmpdir();
  ensureIgnored('.ccmpg.yaml', { cwd });
  const once = read(cwd);

  const result = ensureIgnored('.ccmpg.yaml', { cwd });

  assert.equal(result.action, 'unchanged');
  assert.equal(read(cwd), once, 'the file must not grow');
});

test('recognises a leading-slash form as already ignored', () => {
  const cwd = tmpdir();
  fs.writeFileSync(path.join(cwd, '.gitignore'), 'node_modules/\n/.ccmpg.yaml\n');
  assert.equal(ensureIgnored('.ccmpg.yaml', { cwd }).action, 'unchanged');
});

test('a similar-looking rule does not count as a match', () => {
  const cwd = tmpdir();
  fs.writeFileSync(path.join(cwd, '.gitignore'), 'ccmpg.yaml\n.ccmpg.yaml.bak\n');
  assert.equal(ensureIgnored('.ccmpg.yaml', { cwd }).action, 'updated');
});

test('a commented-out entry is not treated as active', () => {
  const cwd = tmpdir();
  fs.writeFileSync(path.join(cwd, '.gitignore'), '# .ccmpg.yaml\n');
  assert.equal(ensureIgnored('.ccmpg.yaml', { cwd }).action, 'updated');
  assert.match(read(cwd), /^\.ccmpg\.yaml$/m);
});

test('a file without a trailing newline still gets a clean append', () => {
  const cwd = tmpdir();
  fs.writeFileSync(path.join(cwd, '.gitignore'), 'node_modules/');

  ensureIgnored('.ccmpg.yaml', { cwd });

  const after = read(cwd);
  assert.match(after, /^node_modules\/$/m, 'the last rule must not be merged into ours');
  assert.match(after, /^\.ccmpg\.yaml$/m);
});

test('CRLF files stay CRLF', () => {
  const cwd = tmpdir();
  fs.writeFileSync(path.join(cwd, '.gitignore'), 'node_modules/\r\ndist/\r\n');

  ensureIgnored('.ccmpg.yaml', { cwd });

  const after = read(cwd);
  assert.ok(after.includes('.ccmpg.yaml\r\n'), 'must match the existing line endings');
  assert.ok(!/[^\r]\n/.test(after), 'no bare LF should be introduced');
});

test('the settings file can be ignored too', () => {
  const cwd = tmpdir();
  ensureIgnored('.ccmpg.yaml', { cwd });
  ensureIgnored('.claude/settings.local.json', { cwd });

  const after = read(cwd);
  assert.match(after, /^\.ccmpg\.yaml$/m);
  assert.match(after, /^\.claude\/settings\.local\.json$/m);
});

test('an empty file is handled without a stray blank line at the top', () => {
  const cwd = tmpdir();
  fs.writeFileSync(path.join(cwd, '.gitignore'), '');

  ensureIgnored('.ccmpg.yaml', { cwd });

  assert.doesNotMatch(read(cwd), /^\n\n/, 'no double blank line');
  assert.match(read(cwd), /^\.ccmpg\.yaml$/m);
});

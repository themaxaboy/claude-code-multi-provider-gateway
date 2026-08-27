import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { patch, ensureMap } from '../src/edit.js';
import { ConfigError } from '../src/config.js';

const WITH_COMMENTS = `version: 1

# Where requests get forwarded
providers:
  openrouter:
    base_url: https://openrouter.ai/api
    api_key: sk-or-v1-example   # paste your key here

# The name on the left is what you type in /model
models:
  minimax:
    model: minimax-m3:free
    provider: openrouter
`;

/** Run inside a throwaway cwd, since patch() resolves ./.ccmpg.yaml */
function inTempDir(t, contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccmpg-edit-'));
  const file = path.join(dir, '.ccmpg.yaml');
  if (contents !== undefined) fs.writeFileSync(file, contents);

  const previous = process.cwd();
  process.chdir(dir);
  t.after(() => process.chdir(previous));

  return file;
}

test('adding a provider keeps every comment', (t) => {
  const file = inTempDir(t, WITH_COMMENTS);

  patch({ global: false }, (doc) => {
    ensureMap(doc, 'providers');
    doc.setIn(['providers', 'z_ai', 'base_url'], 'https://api.z.ai/api/anthropic');
    doc.setIn(['providers', 'z_ai', 'api_key'], 'sk-z');
  });

  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /# Where requests get forwarded/);
  assert.match(text, /# The name on the left is what you type/);
  assert.match(text, /paste your key here/);
  assert.match(text, /z_ai:/);
  assert.match(text, /base_url: https:\/\/api\.z\.ai\/api\/anthropic/);
});

test('key order is preserved — new entries append', (t) => {
  const file = inTempDir(t, WITH_COMMENTS);

  patch({ global: false }, (doc) => {
    doc.setIn(['models', 'glm', 'model'], 'glm-4.6');
    doc.setIn(['models', 'glm', 'provider'], 'openrouter');
  });

  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.indexOf('version: 1') < text.indexOf('providers:'));
  assert.ok(text.indexOf('minimax:') < text.indexOf('glm:'), 'existing entries stay put');
});

test('an invalid edit throws and leaves the file untouched', (t) => {
  const file = inTempDir(t, WITH_COMMENTS);
  const before = fs.readFileSync(file, 'utf8');

  assert.throws(
    () =>
      patch({ global: false }, (doc) => {
        doc.setIn(['models', 'broken', 'model'], 'x');
        doc.setIn(['models', 'broken', 'provider'], 'does-not-exist');
      }),
    ConfigError,
  );

  assert.equal(fs.readFileSync(file, 'utf8'), before, 'nothing should have been written');
});

test('removing a provider leaves the rest of the document intact', (t) => {
  const file = inTempDir(t, WITH_COMMENTS);

  patch({ global: false }, (doc) => {
    doc.deleteIn(['models', 'minimax']);
    doc.deleteIn(['providers', 'openrouter']);
  });

  const text = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(text, /openrouter:/);
  assert.doesNotMatch(text, /minimax:/);
  assert.match(text, /# Where requests get forwarded/, 'comments survive deletion');
});

test('patching a file that does not exist yet creates a valid one', (t) => {
  const file = inTempDir(t, undefined);

  const result = patch({ global: false }, (doc) => {
    ensureMap(doc, 'providers');
    doc.setIn(['providers', 'first', 'base_url'], 'https://example.test');
  });

  assert.equal(result.created, true);
  assert.match(fs.readFileSync(file, 'utf8'), /first:/);
});

test('no temporary files are left behind', (t) => {
  const file = inTempDir(t, WITH_COMMENTS);

  patch({ global: false }, (doc) => {
    doc.setIn(['providers', 'x', 'base_url'], 'https://x.test');
  });

  const leftovers = fs.readdirSync(path.dirname(file)).filter((n) => n.includes('.tmp'));
  assert.deepEqual(leftovers, []);
});

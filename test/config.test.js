import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, interpolate, normalize, ConfigError } from '../src/config.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ccmpg-test-'));
}

function write(dir, name, text) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);
  return file;
}

const GLOBAL_YAML = `
version: 1
server:
  port: 8787
providers:
  openrouter:
    base_url: https://openrouter.ai/api/
    api_key: sk-or-global
  z_ai:
    base_url: https://api.z.ai/api/anthropic
    api_key: sk-z
models:
  glm:
    model: glm-4.6
    provider: z_ai
`;

const PROJECT_YAML = `
version: 1
server:
  port: 9000
providers:
  unsloth:
    base_url: http://127.0.0.1:8888
models:
  qwen:
    model: unsloth/Qwen3-30B-A3B-GGUF
    provider: unsloth
`;

test('global is the base and project overrides it key by key', () => {
  const dir = tmpdir();
  const globalPath = write(dir, 'global.yaml', GLOBAL_YAML);
  const projectPath = write(dir, 'project.yaml', PROJECT_YAML);

  const cfg = loadConfig({ globalPath, projectPath, env: {} });

  assert.deepEqual(Object.keys(cfg.providers).sort(), ['openrouter', 'unsloth', 'z_ai']);
  assert.deepEqual(Object.keys(cfg.models).sort(), ['glm', 'qwen']);
  assert.equal(cfg.server.port, 9000, 'project wins');
  assert.equal(cfg.server.host, '127.0.0.1', 'default when unset');
  assert.equal(cfg.sources.providers.openrouter, 'global');
  assert.equal(cfg.sources.providers.unsloth, 'project');
  assert.equal(cfg.files.length, 2);
});

test('globalOnly ignores the project file', () => {
  const dir = tmpdir();
  const globalPath = write(dir, 'global.yaml', GLOBAL_YAML);
  const projectPath = write(dir, 'project.yaml', PROJECT_YAML);

  const cfg = loadConfig({ globalPath, projectPath, globalOnly: true, env: {} });
  assert.equal(cfg.server.port, 8787);
  assert.equal(cfg.providers.unsloth, undefined);
});

test('a project provider replaces the global one of the same name', () => {
  const dir = tmpdir();
  const globalPath = write(dir, 'g.yaml', GLOBAL_YAML);
  const projectPath = write(
    dir,
    'p.yaml',
    'providers:\n  z_ai:\n    base_url: http://localhost:1234\n    api_key: sk-local\n',
  );
  const cfg = loadConfig({ globalPath, projectPath, env: {} });
  assert.equal(cfg.providers.z_ai.base_url, 'http://localhost:1234');
  assert.equal(cfg.sources.providers.z_ai, 'project');
  assert.equal(cfg.models.glm.provider, 'z_ai', 'the global model still resolves');
});

test('trailing slashes are stripped from base_url', () => {
  const dir = tmpdir();
  const cfg = loadConfig({
    globalPath: write(dir, 'g.yaml', GLOBAL_YAML),
    projectPath: path.join(dir, 'missing.yaml'),
    env: {},
  });
  assert.equal(cfg.providers.openrouter.base_url, 'https://openrouter.ai/api');
});

test('interpolate handles ${VAR} and ${VAR:-default}', () => {
  assert.equal(interpolate('${A}', { A: 'x' }), 'x');
  assert.equal(interpolate('${A:-fallback}', {}), 'fallback');
  assert.equal(interpolate('${A:-fallback}', { A: '' }), 'fallback', 'empty counts as unset');
  assert.equal(interpolate('${MISSING}', {}), '');
  assert.equal(interpolate('Bearer ${A}!', { A: 'k' }), 'Bearer k!');
});

test('env vars are substituted inside the config file', () => {
  const dir = tmpdir();
  const cfg = loadConfig({
    globalPath: write(
      dir,
      'g.yaml',
      'providers:\n  or:\n    base_url: https://openrouter.ai/api\n    api_key: ${OR_KEY}\n',
    ),
    projectPath: path.join(dir, 'missing.yaml'),
    env: { OR_KEY: 'sk-or-v1-real' },
  });
  assert.equal(cfg.providers.or.api_key, 'sk-or-v1-real');
});

test('a model pointing at a missing provider names both in the error', () => {
  const dir = tmpdir();
  const file = write(
    dir,
    'g.yaml',
    'providers:\n  a:\n    base_url: https://a\nmodels:\n  m:\n    model: x\n    provider: ghost\n',
  );
  assert.throws(
    () => loadConfig({ globalPath: file, projectPath: path.join(dir, 'none.yaml'), env: {} }),
    (error) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /"m"/);
      assert.match(error.message, /"ghost"/);
      assert.match(error.hint, /a/);
      return true;
    },
  );
});

test('a provider without base_url is rejected', () => {
  const dir = tmpdir();
  const file = write(dir, 'g.yaml', 'providers:\n  a:\n    api_key: k\n');
  assert.throws(
    () => loadConfig({ globalPath: file, projectPath: path.join(dir, 'none.yaml'), env: {} }),
    /base_url/,
  );
});

test('no config file at all hints at ccmpg init', () => {
  const dir = tmpdir();
  assert.throws(
    () => loadConfig({ globalPath: path.join(dir, 'a.yaml'), projectPath: path.join(dir, 'b.yaml') }),
    (error) => {
      assert.match(error.hint, /ccmpg init/);
      return true;
    },
  );
});

test('an empty providers map is valid — everything goes to Anthropic', () => {
  const dir = tmpdir();
  const cfg = loadConfig({
    globalPath: write(dir, 'g.yaml', 'version: 1\nserver:\n  port: 7777\n'),
    projectPath: path.join(dir, 'none.yaml'),
    env: {},
  });
  assert.deepEqual(cfg.providers, {});
  assert.equal(cfg.server.port, 7777);
});

test('any version other than 1 is rejected', () => {
  const dir = tmpdir();
  const file = write(dir, 'g.yaml', 'version: 2\n');
  assert.throws(
    () => loadConfig({ globalPath: file, projectPath: path.join(dir, 'none.yaml') }),
    /version: 1/,
  );
});

test('api_key: with no value is absent, not the string "null"', () => {
  // YAML `api_key:` parses to null, and String(null) is "null" — which reads as
  // a real credential downstream and sends `Bearer null` to the provider.
  const cfg = normalize(
    {
      version: 1,
      providers: { p: { base_url: 'https://example.test', api_key: null } },
      models: {},
    },
    { env: {} },
  );

  assert.equal(cfg.providers.p.api_key, undefined);
});

test('an unset ${ENV_VAR} leaves api_key empty rather than inventing one', () => {
  const cfg = normalize(
    {
      version: 1,
      providers: { p: { base_url: 'https://example.test', api_key: '${NOT_SET_ANYWHERE}' } },
      models: {},
    },
    { env: {} },
  );

  assert.equal(cfg.providers.p.api_key, '');
});

// Locate, load, merge and validate .ccmpg.yaml

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';

export const CONFIG_NAME = '.ccmpg.yaml';
export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';

export const DEFAULT_SERVER = { host: '127.0.0.1', port: 8787 };

/** An error the user can fix; the CLI prints the message without a stack. */
export class ConfigError extends Error {
  constructor(message, { hint } = {}) {
    super(message);
    this.name = 'ConfigError';
    this.hint = hint;
  }
}

export function globalConfigPath() {
  return path.join(os.homedir(), '.config', 'ccmpg', CONFIG_NAME);
}

export function projectConfigPath(cwd = process.cwd()) {
  return path.join(cwd, CONFIG_NAME);
}

export function configPath({ global = false, cwd } = {}) {
  return global ? globalConfigPath() : projectConfigPath(cwd);
}

// ---------------------------------------------------------------- ${ENV}

const ENV_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/** Supports ${VAR} and ${VAR:-default}; unset with no default yields "". */
export function interpolate(text, env = process.env) {
  return text.replace(ENV_PATTERN, (_match, name, fallback) => {
    const value = env[name];
    if (value !== undefined && value !== '') return value;
    return fallback ?? '';
  });
}

function interpolateDeep(value, env) {
  if (typeof value === 'string') return interpolate(value, env);
  if (Array.isArray(value)) return value.map((v) => interpolateDeep(v, env));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = interpolateDeep(v, env);
    return out;
  }
  return value;
}

// ---------------------------------------------------------------- loading

export function readConfigFile(file) {
  if (!fs.existsSync(file)) return null;

  let parsed;
  try {
    parsed = YAML.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new ConfigError(`Cannot read ${file}: ${error.message}`);
  }

  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    const kind = Array.isArray(parsed) ? 'a list' : typeof parsed;
    throw new ConfigError(`${file} must be a mapping, not ${kind}`);
  }
  return parsed;
}

/**
 * Global is the base; project overrides it key by key.
 * @returns {{merged: object, sources: {providers: object, models: object}}}
 */
export function mergeConfigs(globalRaw, projectRaw) {
  const sources = { providers: {}, models: {} };
  const merged = { version: 1, server: {}, providers: {}, models: {} };

  for (const [scope, raw] of [
    ['global', globalRaw],
    ['project', projectRaw],
  ]) {
    if (!raw) continue;

    if (raw.version !== undefined) merged.version = raw.version;
    Object.assign(merged.server, raw.server ?? {});

    for (const [name, value] of Object.entries(raw.providers ?? {})) {
      merged.providers[name] = value;
      sources.providers[name] = scope;
    }
    for (const [alias, value] of Object.entries(raw.models ?? {})) {
      merged.models[alias] = value;
      sources.models[alias] = scope;
    }
  }

  return { merged, sources };
}

// ---------------------------------------------------------------- validation

export function normalize(raw, { sources, files, env = process.env } = {}) {
  const data = interpolateDeep(raw, env);

  if (data.version !== undefined && Number(data.version) !== 1) {
    throw new ConfigError(`Only version: 1 is supported, but the file says version: ${data.version}`);
  }

  const server = { ...DEFAULT_SERVER, ...(data.server ?? {}) };
  server.port = Number(server.port);
  if (!Number.isInteger(server.port) || server.port < 1 || server.port > 65535) {
    throw new ConfigError(`Invalid server.port: ${data.server?.port}`);
  }

  const providers = {};
  for (const [name, entry] of Object.entries(data.providers ?? {})) {
    if (!entry || typeof entry !== 'object') {
      throw new ConfigError(`Provider "${name}" must be a mapping with a base_url`);
    }
    if (!entry.base_url) {
      throw new ConfigError(`Provider "${name}" has no base_url`);
    }
    providers[name] = {
      ...entry,
      base_url: String(entry.base_url).replace(/\/+$/, ''),
      api_key: entry.api_key === undefined ? undefined : String(entry.api_key),
    };
  }

  const models = {};
  for (const [alias, entry] of Object.entries(data.models ?? {})) {
    if (!entry || typeof entry !== 'object') {
      throw new ConfigError(`Model "${alias}" must be a mapping with model and provider`);
    }
    if (!entry.model) throw new ConfigError(`Model "${alias}" has no model key`);
    if (!entry.provider) throw new ConfigError(`Model "${alias}" has no provider key`);
    if (!providers[entry.provider]) {
      const known = Object.keys(providers);
      throw new ConfigError(
        `Model "${alias}" points at provider "${entry.provider}", which does not exist`,
        {
          hint: known.length
            ? `Known providers: ${known.join(', ')}`
            : 'No providers defined yet — try: ccmpg provider add',
        },
      );
    }
    models[alias] = { model: String(entry.model), provider: entry.provider };
  }

  return {
    version: 1,
    server,
    providers,
    models,
    sources: sources ?? { providers: {}, models: {} },
    files: files ?? [],
  };
}

/**
 * Load a ready-to-use config.
 * @param {{globalOnly?: boolean, cwd?: string, env?: object,
 *          globalPath?: string, projectPath?: string}} options
 */
export function loadConfig({
  globalOnly = false,
  cwd = process.cwd(),
  env = process.env,
  globalPath = globalConfigPath(),
  projectPath = projectConfigPath(cwd),
} = {}) {
  const globalRaw = readConfigFile(globalPath);
  const projectRaw = globalOnly ? null : readConfigFile(projectPath);

  const files = [];
  if (globalRaw) files.push({ path: globalPath, scope: 'global' });
  if (projectRaw) files.push({ path: projectPath, scope: 'project' });

  if (!files.length) {
    throw new ConfigError(
      globalOnly ? `No config at ${globalPath}` : `No ${CONFIG_NAME} found in this directory or at the global level`,
      { hint: `Create one with:  ccmpg init${globalOnly ? ' -g' : ''}` },
    );
  }

  const { merged, sources } = mergeConfigs(globalRaw, projectRaw);
  return normalize(merged, { sources, files, env });
}

import { loadConfig } from '../config.js';
import { ensureMap, patch } from '../edit.js';
import { ask, askSecret, askChoice, confirm } from '../prompt.js';
import { cyan, dim, green, red, yellow } from '../log.js';
import { maskKey, readScope, table } from './shared.js';

export async function provider(args, flags) {
  const [action = 'ls', name] = args;

  switch (action) {
    case 'add':
      return add(name, flags);
    case 'rm':
    case 'remove':
      return remove(name, flags);
    case 'ls':
    case 'list':
      return list(flags);
    default:
      console.error(red(`Unknown subcommand: provider ${action}`));
      console.error(dim('Expected one of: add, rm, ls'));
      return 2;
  }
}

async function add(nameArg, flags) {
  const existing = readScope(flags);

  const name = await ask(nameArg, {
    message: 'Provider name',
    need: 'a provider name',
    validate: (value) => {
      if (!value.trim()) return 'Required';
      if (!/^[A-Za-z0-9_-]+$/.test(value)) return 'Use letters, numbers, - and _ only';
      if (existing.providers?.[value]) return `"${value}" already exists in this scope`;
      return true;
    },
  });

  const baseUrl = await ask(flags['base-url'], {
    message: 'base_url',
    need: 'base-url',
    validate: (value) => {
      try {
        new URL(value);
        return true;
      } catch {
        return 'Must be a full URL, e.g. https://openrouter.ai/api';
      }
    },
  });

  const apiKey = await askSecret(flags['api-key'], {
    message: 'api_key (paste it, or type ${ENV_VAR})',
    need: 'api-key',
  });

  const { file } = patch({ global: flags.global }, (doc) => {
    ensureMap(doc, 'providers');
    doc.setIn(['providers', name, 'base_url'], baseUrl.replace(/\/+$/, ''));
    if (apiKey) doc.setIn(['providers', name, 'api_key'], apiKey);
  });

  console.log(`${green('added')} provider ${cyan(name)} ${dim('->')} ${file}`);
  console.log(dim(`  add a model with:  ccmpg model add${flags.global ? ' -g' : ''}`));
  return 0;
}

async function remove(nameArg, flags) {
  const scoped = readScope(flags);
  const names = Object.keys(scoped.providers ?? {});

  if (!names.length) {
    console.error(`No providers defined in the ${flags.global ? 'global' : 'project'} config.`);
    return 1;
  }

  const name = await askChoice(nameArg, {
    message: 'Which provider should be removed?',
    need: 'a provider name',
    choices: names.map((value) => ({
      value,
      name: value,
      description: scoped.providers[value]?.base_url,
    })),
  });

  if (!scoped.providers?.[name]) {
    console.error(red(`No provider named "${name}" in this scope.`));
    console.error(dim(`Known: ${names.join(', ')}`));
    return 1;
  }

  const dependents = Object.entries(scoped.models ?? {})
    .filter(([, entry]) => entry?.provider === name)
    .map(([alias]) => alias);

  if (dependents.length && !flags.cascade) {
    console.error(red(`Cannot remove "${name}" — these model aliases still point at it: ${dependents.join(', ')}`));
    console.error(dim('Remove them first, or pass --cascade to remove them together.'));
    return 1;
  }

  const what = dependents.length
    ? `Remove "${name}" and ${dependents.length} alias(es): ${dependents.join(', ')}?`
    : `Remove provider "${name}"?`;

  if (!(await confirm(what, { yes: flags.yes }))) {
    console.log(dim('cancelled'));
    return 0;
  }

  const { file } = patch({ global: flags.global }, (doc) => {
    doc.deleteIn(['providers', name]);
    for (const alias of dependents) doc.deleteIn(['models', alias]);
  });

  console.log(`${green('removed')} provider ${cyan(name)} ${dim('from')} ${file}`);
  for (const alias of dependents) console.log(dim(`  also removed model ${alias}`));
  return 0;
}

function list(flags) {
  const cfg = loadConfig({ globalOnly: flags.global });
  const names = Object.keys(cfg.providers);

  if (!names.length) {
    console.log(dim('No providers defined. Add one with:  ccmpg provider add'));
    return 0;
  }

  table(
    ['PROVIDER', 'BASE URL', 'API KEY', 'SCOPE'],
    names.map((name) => {
      const entry = cfg.providers[name];
      const key = entry.api_key
        ? maskKey(entry.api_key)
        : yellow('not set');
      return [name, entry.base_url, key, dim(cfg.sources.providers[name] ?? '-')];
    }),
  );
  return 0;
}

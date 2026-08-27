import { loadConfig } from '../config.js';
import { ensureMap, patch } from '../edit.js';
import { ask, askChoice, confirm } from '../prompt.js';
import { cyan, dim, green, red } from '../log.js';
import { readScope, table } from './shared.js';

export async function model(args, flags) {
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
      console.error(red(`Unknown subcommand: model ${action}`));
      console.error(dim('Expected one of: add, rm, ls'));
      return 2;
  }
}

async function add(aliasArg, flags) {
  const scoped = readScope(flags);
  // Providers may live in the global file while the alias goes in the project
  // one, so offer everything the gateway would actually see.
  const visible = safeMerged(flags);
  const providerNames = Object.keys(visible.providers ?? {});

  if (!providerNames.length) {
    console.error(red('No providers defined yet.'));
    console.error(dim(`Add one first:  ccmpg provider add${flags.global ? ' -g' : ''}`));
    return 1;
  }

  const alias = await ask(aliasArg, {
    message: 'Alias (what you type in /model)',
    need: 'a model alias',
    validate: (value) => {
      if (!value.trim()) return 'Required';
      if (scoped.models?.[value]) return `"${value}" already exists in this scope`;
      return true;
    },
  });

  const modelId = await ask(flags.model, {
    message: "Model id on the provider's side",
    need: 'model',
    validate: (value) => (value.trim() ? true : 'Required'),
  });

  const providerName = await askChoice(flags.provider, {
    message: 'Which provider?',
    need: 'provider',
    choices: providerNames.map((value) => ({
      value,
      name: value,
      description: visible.providers[value]?.base_url,
    })),
  });

  if (!visible.providers[providerName]) {
    console.error(red(`No provider named "${providerName}".`));
    console.error(dim(`Known: ${providerNames.join(', ')}`));
    return 1;
  }

  const { file } = patch({ global: flags.global }, (doc) => {
    ensureMap(doc, 'models');
    doc.setIn(['models', alias, 'model'], modelId);
    doc.setIn(['models', alias, 'provider'], providerName);
  });

  console.log(`${green('added')} model ${cyan(alias)} ${dim('->')} ${file}`);
  console.log(dim(`  use it with:  /model ${alias}`));
  return 0;
}

async function remove(aliasArg, flags) {
  const scoped = readScope(flags);
  const aliases = Object.keys(scoped.models ?? {});

  if (!aliases.length) {
    console.error(`No model aliases in the ${flags.global ? 'global' : 'project'} config.`);
    return 1;
  }

  const alias = await askChoice(aliasArg, {
    message: 'Which model alias should be removed?',
    need: 'a model alias',
    choices: aliases.map((value) => ({
      value,
      name: value,
      description: `${scoped.models[value]?.model}  ->  ${scoped.models[value]?.provider}`,
    })),
  });

  if (!scoped.models?.[alias]) {
    console.error(red(`No model alias named "${alias}" in this scope.`));
    console.error(dim(`Known: ${aliases.join(', ')}`));
    return 1;
  }

  if (!(await confirm(`Remove model "${alias}"?`, { yes: flags.yes }))) {
    console.log(dim('cancelled'));
    return 0;
  }

  const { file } = patch({ global: flags.global }, (doc) => {
    doc.deleteIn(['models', alias]);
  });

  console.log(`${green('removed')} model ${cyan(alias)} ${dim('from')} ${file}`);
  return 0;
}

function list(flags) {
  const cfg = loadConfig({ globalOnly: flags.global });
  const aliases = Object.keys(cfg.models);

  if (!aliases.length) {
    console.log(dim('No model aliases defined. Add one with:  ccmpg model add'));
    console.log(dim('Anything not listed here goes straight to api.anthropic.com.'));
    return 0;
  }

  table(
    ['ALIAS', 'MODEL', 'PROVIDER', 'SCOPE'],
    aliases.map((alias) => [
      alias,
      cfg.models[alias].model,
      cfg.models[alias].provider,
      dim(cfg.sources.models[alias] ?? '-'),
    ]),
  );
  return 0;
}

/** The merged view, or just this scope if the merged one does not validate. */
function safeMerged(flags) {
  try {
    return loadConfig({ globalOnly: flags.global });
  } catch {
    return readScope(flags);
  }
}

// `ccmpg config` — what the gateway will actually use, with keys masked.

import YAML from 'yaml';
import { ANTHROPIC_BASE_URL, loadConfig } from '../config.js';
import { cyan, dim, yellow } from '../log.js';
import { maskKey } from './shared.js';

export function show(flags) {
  const cfg = loadConfig({ globalOnly: flags.global });

  for (const file of cfg.files) {
    console.log(dim(`# ${file.scope.padEnd(7)} ${file.path}`));
  }
  console.log('');

  const providers = {};
  const unresolved = [];

  for (const [name, entry] of Object.entries(cfg.providers)) {
    const shown = { base_url: entry.base_url };
    if (entry.api_key === undefined) {
      shown.api_key = null;
    } else if (entry.api_key === '') {
      shown.api_key = null;
      unresolved.push(name);
    } else {
      shown.api_key = maskKey(entry.api_key);
    }
    providers[name] = shown;
  }

  console.log(
    YAML.stringify(
      { version: 1, server: cfg.server, providers, models: cfg.models },
      { lineWidth: 0 },
    ).trimEnd(),
  );

  console.log('');
  console.log(dim(`# anything not in models: goes to ${ANTHROPIC_BASE_URL}`));

  if (unresolved.length) {
    console.log('');
    for (const name of unresolved) {
      console.log(
        yellow(`! provider "${name}" has an empty api_key`) +
          dim(' — the ${ENV_VAR} it references is not set'),
      );
    }
  }

  return 0;
}

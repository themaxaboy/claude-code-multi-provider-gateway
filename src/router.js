// Pick the upstream for a request based on its model name. Pure — no I/O.

import { stripDiscoveryPrefix } from './models.js';

const ONE_M_SUFFIX = /\[1m\]$/i;

/**
 * Decide where a request goes.
 *
 * One rule: if the model name is in `models:`, send it to that provider.
 * Otherwise send it to Anthropic.
 *
 * The `[1m]` suffix is stripped only when routing to another provider — the
 * Anthropic path must keep it, since it is what requests the 1M context window.
 *
 * An `anthropic/<alias>` name also resolves to `<alias>`: that is the spelling
 * model discovery has to advertise for aliases Claude Code would otherwise
 * filter out of its picker. See src/models.js.
 *
 * @param {object|null} body  parsed request body
 * @param {object} cfg        normalized config
 * @returns {{providerName: string|null, provider: object|null, model: string,
 *            upstreamModel: string, body: object|null, rewritten: boolean}}
 *          a null providerName means api.anthropic.com
 */
export function resolve(body, cfg) {
  const raw = typeof body?.model === 'string' ? body.model : null;

  if (raw === null) {
    return {
      providerName: null,
      provider: null,
      model: 'unknown',
      upstreamModel: 'unknown',
      body,
      rewritten: false,
    };
  }

  // Suffix first, then the discovery prefix: `anthropic/minimax[1m]` has to
  // reach `minimax`, and stripping the prefix first would leave `[1m]` glued on.
  const stripped = raw.replace(ONE_M_SUFFIX, '');

  let alias = stripped;
  let entry = cfg?.models?.[alias];

  // Only after the literal name has had its chance, so an alias someone really
  // named `anthropic/x` still wins over the prefixed spelling of an alias `x`.
  if (!entry) {
    const bare = stripDiscoveryPrefix(alias);
    if (bare && cfg?.models?.[bare]) {
      alias = bare;
      entry = cfg.models[bare];
    }
  }

  if (!entry) {
    // Unknown model: forward the name untouched, `[1m]` included.
    return {
      providerName: null,
      provider: null,
      model: raw,
      upstreamModel: raw,
      body,
      rewritten: false,
    };
  }

  return {
    providerName: entry.provider,
    provider: cfg.providers[entry.provider],
    model: alias, // the alias — what shows up in the log
    upstreamModel: entry.model,
    body: { ...body, model: entry.model },
    rewritten: true,
  };
}

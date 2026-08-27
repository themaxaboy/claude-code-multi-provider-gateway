// Pick the upstream for a request based on its model name. Pure — no I/O.

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

  const stripped = raw.replace(ONE_M_SUFFIX, '');
  const entry = cfg?.models?.[stripped];

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
    model: stripped, // the alias — what shows up in the log
    upstreamModel: entry.model,
    body: { ...body, model: entry.model },
    rewritten: true,
  };
}

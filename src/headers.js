// Build outbound headers. Pure — no I/O.

/** Headers bound to the inbound connection; never forwarded. */
const HOP_BY_HOP = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'accept-encoding',
  'upgrade',
  'proxy-connection',
  'proxy-authorization',
  'te',
  'trailer',
]);

/** Responses drop content-encoding too — fetch already decoded the body. */
const RESPONSE_STRIP = new Set([...HOP_BY_HOP, 'content-encoding']);

/** Inbound credentials, dropped wholesale before a provider ever sees them. */
const INBOUND_CREDENTIALS = ['x-api-key', 'authorization', 'cookie'];

const OAUTH_BETA = 'oauth-2025-04-20';

/**
 * @param {object} incoming       headers from Claude Code (node lowercases them)
 * @param {object|null} provider  null means pass through to Anthropic
 */
export function buildRequestHeaders(incoming, provider) {
  const out = {};

  for (const [key, value] of Object.entries(incoming ?? {})) {
    const k = key.toLowerCase();
    if (HOP_BY_HOP.has(k)) continue;
    if (value === undefined) continue;
    out[k] = Array.isArray(value) ? value.join(', ') : String(value);
  }

  // Keep upstream from compressing: the SSE tap reads the body as plain text.
  out['accept-encoding'] = 'identity';

  // Anthropic gets every credential header exactly as it arrived.
  if (!provider) return out;

  // Everything below runs whether or not we have a key to send. A provider with
  // no api_key — or an ${ENV_VAR} that resolved to nothing — is precisely the
  // case where the user's Anthropic credential would otherwise leak to a third
  // party, so the scrub must not be conditional on having a replacement.
  for (const key of INBOUND_CREDENTIALS) delete out[key];

  if (provider.api_key) out['authorization'] = `Bearer ${provider.api_key}`;

  // Non-Anthropic providers usually 400 on this beta, but the others must stay.
  const beta = out['anthropic-beta'];
  if (beta) {
    const kept = beta
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s && s !== OAUTH_BETA);
    if (kept.length) out['anthropic-beta'] = kept.join(', ');
    else delete out['anthropic-beta'];
  }

  return out;
}

/** @param {Headers} headers  from the fetch Response */
export function buildResponseHeaders(headers) {
  const out = {};
  for (const [key, value] of headers) {
    const k = key.toLowerCase();
    if (RESPONSE_STRIP.has(k)) continue;
    out[k] = value;
  }
  return out;
}

export { HOP_BY_HOP, RESPONSE_STRIP, INBOUND_CREDENTIALS, OAUTH_BETA };

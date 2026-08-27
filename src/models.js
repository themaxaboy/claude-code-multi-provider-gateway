// The body of GET /v1/models — the one endpoint the gateway answers itself. Pure, no I/O.
//
// With CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1, Claude Code asks the gateway
// for a model list at startup and shows what comes back in the /model picker,
// labelled "From gateway". It reads only `id` and the optional `display_name`.
//
// The catch that shapes this whole module: Claude Code keeps an entry only when
// its id CONTAINS "claude" or "anthropic" anywhere, case-insensitively. A bare
// alias like `minimax` is dropped on the floor before it ever reaches the picker.
// So an alias that cannot survive that filter is advertised as `anthropic/<alias>`,
// and router.js resolves that spelling back to the alias.

/** The path we serve. Retrieve-by-id, /v1/models/{id}, stays a passthrough. */
export const MODELS_PATH = '/v1/models';

/** What we prepend to an alias that would otherwise be filtered out. */
export const DISCOVERY_PREFIX = 'anthropic/';

const KEPT_BY_CLAUDE_CODE = /claude|anthropic/i;

/** Would Claude Code keep an entry with this id? */
export function passesDiscoveryFilter(id) {
  return typeof id === 'string' && KEPT_BY_CLAUDE_CODE.test(id);
}

/** The id we advertise for a configured alias. */
export function discoveryIdFor(alias) {
  return passesDiscoveryFilter(alias) ? alias : `${DISCOVERY_PREFIX}${alias}`;
}

/**
 * `anthropic/minimax` -> `minimax`. Anything else -> null.
 *
 * The empty remainder is rejected too, so a request for the literal string
 * `anthropic/` can never turn into a cfg.models[''] lookup. Matching is
 * exact-case: Claude Code echoes the id back exactly as we advertised it, and
 * accepting `Anthropic/foo` would only widen the surface.
 */
export function stripDiscoveryPrefix(id) {
  if (typeof id !== 'string' || !id.startsWith(DISCOVERY_PREFIX)) return null;
  const bare = id.slice(DISCOVERY_PREFIX.length);
  return bare === '' ? null : bare;
}

/**
 * What the picker row reads. The alias comes first because it is the name the
 * user typed into .ccmpg.yaml and the only one they will recognise; the provider
 * disambiguates two lookalike aliases. Deliberately not the real model id — the
 * likes of `qwen/qwen3-coder-480b-a35b-instruct` blow the row width and add
 * nothing the user chose.
 */
export function displayNameFor(alias, entry) {
  return entry?.provider ? `${alias} (${entry.provider})` : alias;
}

/**
 * One entry per configured alias, in the id the picker will send back to us.
 *
 * @param {object} cfg  normalized config
 * @returns {Array<{type: 'model', id: string, display_name: string}>}
 */
export function localModelEntries(cfg) {
  const models = cfg?.models ?? {};
  const byId = new Map();

  const add = (id, alias) => {
    if (byId.has(id)) return;
    byId.set(id, { type: 'model', id, display_name: displayNameFor(alias, models[alias]) });
  };

  // Two passes so an alias literally named `anthropic/foo` beats the prefixed
  // spelling of an alias named `foo` — the same precedence router.js applies,
  // so the advertised list and the router can never disagree about who owns an
  // id. With no claude-flavoured aliases (the normal case) the first pass adds
  // nothing and the order is plain declaration order.
  for (const alias of Object.keys(models)) if (passesDiscoveryFilter(alias)) add(alias, alias);
  for (const alias of Object.keys(models)) if (!passesDiscoveryFilter(alias)) add(discoveryIdFor(alias), alias);

  return [...byId.values()];
}

/**
 * The configured aliases, plus whatever Anthropic's own /v1/models returned.
 *
 * The upstream half is best effort by contract: the caller passes null whenever
 * that request failed, timed out, or came back as something other than a list,
 * and we serve the local aliases alone rather than an error. Upstream entries
 * are copied verbatim, so they keep their own created_at and display_name; the
 * local ones carry no created_at, because there is no honest date for an alias
 * and Claude Code never reads the field.
 *
 * Paging params on the request are ignored — has_more: false terminates any
 * client that tries to page, and the list is at most a few dozen entries.
 *
 * @param {object} cfg  normalized config
 * @param {unknown} upstreamData  the `data` array from Anthropic, or null
 */
export function buildModelList(cfg, upstreamData) {
  const data = localModelEntries(cfg);
  const taken = new Set(data.map((entry) => entry.id));

  if (Array.isArray(upstreamData)) {
    for (const entry of upstreamData) {
      // A local alias wins the id: it is the one the router can actually route.
      if (!entry || typeof entry.id !== 'string' || taken.has(entry.id)) continue;
      taken.add(entry.id);
      data.push(entry);
    }
  }

  return {
    data,
    has_more: false,
    first_id: data.length ? data[0].id : null,
    last_id: data.length ? data[data.length - 1].id : null,
  };
}

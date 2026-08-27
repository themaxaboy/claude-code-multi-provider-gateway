# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`ccmpg` is an Anthropic-Messages-compatible proxy that lets Claude Code use models from
several providers in one session. It routes **per request**, by the `model` field in the body.

The README is written in Thai and is the user-facing spec. Code, comments, tests, and CLI
output are English.

## Commands

```bash
npm test                                   # whole suite
node --test test/router.test.js            # one file
node --test --test-name-pattern="\[1m\]"   # one test by name

npm run dev              # gateway + --watch + --verbose (needs a .ccmpg.yaml in cwd)
npm run link             # symlink `ccmpg` globally; edits take effect immediately
npm run install:global   # install from source instead (no live reload)
```

`npm test` is `node --test` with **no path argument** — passing `test/` fails on Windows
(`Cannot find module ...\test`). Node auto-discovers `**/*.test.js`.

There is no linter or build step. The package is ESM (`"type": "module"`), Node >= 20.

The script is `install:global`, never `install` — `install` is an npm **lifecycle hook** and
would fire on every plain `npm install`.

## Releasing

**Any change to shipped code means bumping `version` in `package.json` in the same commit.**
Users are told about new versions by comparing their installed `version` against the npm
registry, so a fix that ships under an unchanged version is invisible to everyone already
running ccmpg. Patch for fixes, minor for new commands or config keys, major for anything
that invalidates an existing `.ccmpg.yaml`.

`src/update.js` prints the notice from a cache and refreshes it in the background at most
once a day, on an unref'd socket so no command ever waits on the network. It is silenced by
`CCMPG_NO_UPDATE_CHECK=1`, and prints to stderr so piping stdout stays clean.

## Architecture

### The one routing rule

`src/router.js` decides everything: if `body.model` matches a key in `models:`, the request
goes to that provider with `body.model` rewritten to the provider's real model id. Otherwise
it goes to `https://api.anthropic.com`. The Anthropic fallback is hardcoded and not
configurable — that is what keeps Claude Code subscriptions working.

### The two paths are asymmetric — this is the core invariant

`src/headers.js` treats the two destinations differently, and conflating them is the easiest
way to break this project:

| | Anthropic path (`provider === null`) | Provider path |
| --- | --- | --- |
| `authorization` / `x-api-key` | forwarded untouched | replaced with `Bearer <provider.api_key>`, `x-api-key` **deleted** |
| `anthropic-beta: oauth-2025-04-20` | kept | stripped (other beta values kept) |
| `[1m]` model suffix | kept | stripped |

`oauth-2025-04-20` is the flag that marks the `Authorization: Bearer` as an OAuth token rather
than an API key, so it must travel with that credential and disappear when the credential is
replaced. `[1m]` requests the 1M context window and only Anthropic understands it.
Deleting `x-api-key` on the provider path is what stops the user's Anthropic credential from
leaking to a third party — `test/server.test.js` asserts this end to end.

### Config: two scopes, merged

`src/config.js` reads `./.ccmpg.yaml` (project) and `~/.config/ccmpg/.ccmpg.yaml` (global).
Global is the base; project overrides it **key by key** across `providers` and `models`, and
field by field across `server`. `sources` records where each entry came from so `provider ls`
can show it. `-g` on any command means "act on global only".

The filename is always `.ccmpg.yaml`; there is deliberately no `--config` flag and no
`CCMPG_CONFIG` env var.

`normalize()` is the single validation gate — it also runs inside `src/edit.js` *before* any
write, so an edit that would produce an invalid file throws and leaves the file untouched.

### Pure vs. I/O modules

`router.js`, `headers.js`, and `config.js`'s `normalize`/`interpolate` are pure and carry most
of the test coverage. `test/parity.test.js` is the safety net for the passthrough path: it issues
each request twice — direct to a stub and through the gateway — and asserts the two are
indistinguishable. Add a case there whenever you touch request or response handling. `server.js`, `daemon.js`, `edit.js`, `prompt.js` do I/O. Keep new logic
on the pure side where you can.

`createServer(cfg, { anthropicBaseUrl })` takes the fallback URL as a parameter purely so
tests can point it at a stub — production callers omit it.

### Streaming and the usage tap

`src/usage.js` returns a `TransformStream` that **enqueues each chunk before parsing it**, so
stats collection can never delay or corrupt the stream. It carries partial lines across chunk
boundaries; an SSE event split mid-chunk is still counted. This is why `accept-encoding` is
forced to `identity` on every outbound request — the tap reads the body as text.

### Protocol upgrades bypass fetch

`fetch` cannot carry a protocol upgrade, so `server.on('upgrade')` in `src/server.js` splices
the client socket to a raw `net`/`tls` connection and replays the request line from
`req.rawHeaders`. That path deliberately keeps `Upgrade` and `Connection` — the very headers
`buildRequestHeaders` strips — and forces `ALPNProtocols: ['http/1.1']` so TLS cannot negotiate
h2 under the hand-written bytes. Upgrades carry no JSON body, so they always take the Anthropic
fallback.

When writing tests that open tunnels, track sockets via `server.on('connection')` and destroy
them in teardown: an upgraded socket is detached from the HTTP server, so `closeAllConnections()`
does not see it and `server.close()` hangs forever. `test/parity.test.js` shows the pattern.

### Process model

`ccmpg start -d` spawns `node bin/ccmpg.js __serve ...` detached. `__serve` is a hidden
subcommand that runs the server in the foreground inside the child; it is not in `--help`.
`src/daemon.js` keeps a registry at `~/.local/state/ccmpg/daemons.json` keyed by `global` or
the absolute cwd, and prunes entries whose pid is dead on every `list()`.

`ccmpg startup` uses launchd on macOS, a systemd user unit on Linux, and the **Startup folder**
on Windows — not Task Scheduler, whose `ONLOGON` tasks require elevation.

### Do not try to fix `/remote-control`

`/remote-control` fails with "Remote Control initialization failed" whenever `ANTHROPIC_BASE_URL`
does not point at `api.anthropic.com`. Claude Code checks the env var itself and refuses before
sending anything, so no amount of proxying or header work here can change it — and
`_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL` is explicitly exempted from applying to it. This is
documented as a limitation in the README; it is not a ccmpg bug.

### Files init touches that are not ours

`ccmpg init` writes three things at project scope, and only the first is ccmpg's own:
`.ccmpg.yaml`, Claude Code's `.claude/settings.local.json` (via `src/claude-settings.js`), and
`.gitignore` (via `src/gitignore.js`). The latter two are merged or appended, never rewritten,
and both steps can be declined — interactively, or with `--no-settings` / `--no-gitignore`.

### Claude Code settings

`src/claude-settings.js` writes `ANTHROPIC_BASE_URL` into `.claude/settings.local.json`
(or `~/.claude/settings.json` with `-g`). These files belong to Claude Code and usually hold
permissions and hooks, so every write **merges**, and malformed JSON is reported and left
alone rather than overwritten.

## Conventions

- Commands live in `src/commands/`, are dispatched from `bin/ccmpg.js`, and **return an exit
  code** rather than calling `process.exit`.
- User-fixable failures throw `ConfigError` (optionally with a `hint`); `bin/ccmpg.js` prints
  the message without a stack. `NotATTYError` is handled the same way and tells the user which
  flag is missing.
- Every value-taking prompt goes through `src/prompt.js`, which returns a provided flag
  untouched and only asks for what is missing — so `add`/`rm` work both interactively and
  fully from flags. Non-TTY never hangs.
- Config edits go through `edit.js`'s `patch()`, which uses the `yaml` Document API to preserve
  comments and writes via temp-file + rename.

// Interactive questions, disabled when there is no terminal to ask on.

import { confirm as inquirerConfirm, input, password, select } from '@inquirer/prompts';
import { ConfigError } from './config.js';

/**
 * Thrown when a value is missing and we cannot ask for it — piped input, CI.
 * Commands turn this into "you are missing --some-flag".
 *
 * `need` is either a flag name (`base-url`) or a plain description
 * (`a provider name`) for values that arrive as positional arguments.
 */
export class NotATTYError extends Error {
  constructor(need) {
    const what = !need ? 'a value' : need.includes(' ') ? need : `--${need}`;
    super(`Missing ${what}, and there is no terminal to prompt on.`);
    this.name = 'NotATTYError';
    this.need = need;
  }
}

export function isInteractive() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function requireTTY(need) {
  if (!isInteractive()) throw new NotATTYError(need);
}

/**
 * Apply a prompt's own `validate` to a value that arrived as a flag.
 *
 * Without this, every rule below is enforced only when a human is watching —
 * which is how `provider add <existing> --api-key ...` came to overwrite a
 * stored credential in silence. Inquirer's contract: `true` accepts, a string
 * is the message describing the problem.
 */
function check(value, validate) {
  if (!validate) return value;
  const result = validate(value);
  if (result === true || result === undefined) return value;
  throw new ConfigError(typeof result === 'string' ? result : `Invalid value: ${value}`);
}

/** Returns `provided` untouched when given; otherwise asks. */
export async function ask(provided, { message, need, validate, defaultValue } = {}) {
  if (provided !== undefined && provided !== null && provided !== '') {
    return check(provided, validate);
  }
  requireTTY(need);
  return input({ message, validate, default: defaultValue });
}

export async function askSecret(provided, { message, need } = {}) {
  if (provided !== undefined && provided !== null && provided !== '') return provided;
  requireTTY(need);
  return password({ message, mask: '*' });
}

export async function askChoice(provided, { message, choices, need } = {}) {
  if (provided !== undefined && provided !== null && provided !== '') {
    const values = choices.map((c) => (typeof c === 'string' ? c : c.value));
    if (!values.includes(provided)) {
      throw new ConfigError(`Unknown value: ${provided}`, {
        hint: values.length ? `Known: ${values.join(', ')}` : undefined,
      });
    }
    return provided;
  }
  requireTTY(need);
  if (!choices.length) throw new Error(`Nothing to choose from for: ${message}`);
  return select({ message, choices });
}

/**
 * `yes` short-circuits to true so -y works everywhere.
 *
 * With no terminal and no `-y` this throws rather than assuming an answer:
 * `init` defaults this question to yes, and silently taking that default meant
 * a piped `ccmpg init` edited Claude Code's settings file uninvited.
 */
export async function confirm(message, { yes = false, defaultValue = false, need = 'yes' } = {}) {
  if (yes) return true;
  requireTTY(need);
  // defaultValue is what Enter means to a human looking at the question — it is
  // deliberately not reachable without one.
  return inquirerConfirm({ message, default: defaultValue });
}

// Interactive questions, disabled when there is no terminal to ask on.

import { confirm as inquirerConfirm, input, password, select } from '@inquirer/prompts';

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

/** Returns `provided` untouched when given; otherwise asks. */
export async function ask(provided, { message, need, validate, defaultValue } = {}) {
  if (provided !== undefined && provided !== null && provided !== '') return provided;
  requireTTY(need);
  return input({ message, validate, default: defaultValue });
}

export async function askSecret(provided, { message, need } = {}) {
  if (provided !== undefined && provided !== null && provided !== '') return provided;
  requireTTY(need);
  return password({ message, mask: '*' });
}

export async function askChoice(provided, { message, choices, need } = {}) {
  if (provided !== undefined && provided !== null && provided !== '') return provided;
  requireTTY(need);
  if (!choices.length) throw new Error(`Nothing to choose from for: ${message}`);
  return select({ message, choices });
}

/** `yes` short-circuits to true so -y works everywhere. */
export async function confirm(message, { yes = false, defaultValue = false } = {}) {
  if (yes) return true;
  if (!isInteractive()) return defaultValue;
  return inquirerConfirm({ message, default: defaultValue });
}

// Keep .ccmpg.yaml out of git — it may hold a real API key.
//
// Like the Claude Code settings file, .gitignore belongs to the user. Entries
// are appended, never rewritten, and adding one twice is a no-op.

import fs from 'node:fs';
import path from 'node:path';

export const IGNORE_NAME = '.gitignore';

export function ignorePath(cwd = process.cwd()) {
  return path.join(cwd, IGNORE_NAME);
}

/** Does any line already ignore this exact entry? */
function alreadyListed(text, entry) {
  return text.split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    return trimmed === entry || trimmed === `/${entry}`;
  });
}

/**
 * @returns {{file: string, action: 'created'|'updated'|'unchanged'}}
 */
export function ensureIgnored(entry, { cwd = process.cwd(), comment } = {}) {
  const file = ignorePath(cwd);
  const block = comment ? `# ${comment}\n${entry}\n` : `${entry}\n`;

  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, block);
    return { file, action: 'created' };
  }

  const text = fs.readFileSync(file, 'utf8');
  if (alreadyListed(text, entry)) return { file, action: 'unchanged' };

  // Match whatever line ending the file already uses.
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const needsBreak = text.length > 0 && !/\r?\n$/.test(text);

  const addition = (needsBreak ? eol : '') + eol + block.replace(/\n/g, eol);
  fs.appendFileSync(file, addition);

  return { file, action: 'updated' };
}

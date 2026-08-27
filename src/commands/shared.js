// Helpers shared by the config-editing commands.

import { loadDocument } from '../edit.js';
import { dim } from '../log.js';

/** The raw contents of just the scope being edited — not the merged view. */
export function readScope(flags) {
  const { doc } = loadDocument({ global: flags.global });
  return doc.toJS() ?? {};
}

/** sk-or-v1-c1f9…5320 — enough to recognise, not enough to use. */
export function maskKey(value) {
  if (!value) return '';
  if (value.startsWith('${')) return value; // an env reference is not a secret
  if (value.length <= 12) return `${value.slice(0, 2)}${'*'.repeat(value.length - 2)}`;
  return `${value.slice(0, 8)}\u2026${value.slice(-4)}`;
}

const strip = (s) => String(s).replace(/\u001b\[[0-9;]*m/g, '');

export function table(headers, rows) {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => strip(r[i]).length)),
  );

  const line = (cells) =>
    cells
      .map((cell, i) => cell + ' '.repeat(widths[i] - strip(cell).length))
      .join('  ')
      .trimEnd();

  console.log(dim(line(headers)));
  for (const row of rows) console.log(line(row));
}

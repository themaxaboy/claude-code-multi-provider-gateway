// Atomic edits to .ccmpg.yaml that keep comments and key order intact.

import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { ConfigError, configPath, normalize } from './config.js';

const EMPTY = `version: 1

server:
  host: 127.0.0.1
  port: 8787

providers:

models:
`;

export function loadDocument({ global = false } = {}) {
  const file = configPath({ global });

  if (!fs.existsSync(file)) {
    return { file, doc: YAML.parseDocument(EMPTY), created: true };
  }

  const doc = YAML.parseDocument(fs.readFileSync(file, 'utf8'));
  if (doc.errors?.length) {
    throw new ConfigError(`Cannot parse ${file}: ${doc.errors[0].message}`);
  }
  return { file, doc, created: false };
}

/**
 * Read, mutate, validate, then write — or write nothing at all.
 *
 * @param {{global?: boolean}} scope
 * @param {(doc: YAML.Document) => void} mutate
 * @returns {{file: string, created: boolean}}
 */
export function patch(scope, mutate) {
  const { file, doc, created } = loadDocument(scope);

  mutate(doc);

  // Validate the result before it ever reaches disk.
  normalize(doc.toJS() ?? {}, { env: process.env });

  const text = doc.toString({ lineWidth: 0 });
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);

  return { file, created };
}

/** `providers`/`models` may be an empty placeholder; make it a real map first. */
export function ensureMap(doc, key) {
  const node = doc.get(key);
  if (node === undefined || node === null) {
    doc.set(key, doc.createNode({}));
  }
  return doc.get(key);
}

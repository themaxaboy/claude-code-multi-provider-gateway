import test from 'node:test';
import assert from 'node:assert/strict';
import { maskKey, redactHeaders } from '../src/log.js';

test('maskKey keeps enough of a long key to recognise it', () => {
  assert.equal(maskKey('sk-or-v1-c1f9aaaabbbb5320'), 'sk-or-v1…5320');
});

test('maskKey survives keys too short to slice', () => {
  // '*'.repeat(value.length - 2) threw RangeError here, taking `ccmpg config`
  // down with a stack trace.
  for (const short of ['a', 'ab', 'abc', 'sk-12345678']) {
    const masked = maskKey(short);
    assert.equal(masked.includes(short), false, `${short} must not appear in ${masked}`);
  }
});

test('maskKey does not hide the length of a short key', () => {
  assert.equal(maskKey('a'), maskKey('abcdefgh'));
});

test('maskKey leaves an unresolved env reference readable', () => {
  assert.equal(maskKey('${OPENROUTER_KEY}'), '${OPENROUTER_KEY}');
});

test('maskKey handles empty and missing values', () => {
  assert.equal(maskKey(''), '');
  assert.equal(maskKey(undefined), '');
  assert.equal(maskKey(null), '');
});

test('redactHeaders masks every credential header but keeps the scheme', () => {
  const out = redactHeaders({
    authorization: 'Bearer sk-or-v1-c1f9aaaabbbb5320',
    'x-api-key': 'sk-ant-api03-abcdefghijklmnop',
    'proxy-authorization': 'Basic dXNlcjpwYXNzd29yZA==',
    cookie: 'session=aaaaaaaaaaaaaaaaaaaa',
    'anthropic-version': '2023-06-01',
  });

  assert.equal(out.authorization, 'Bearer sk-or-v1…5320');
  assert.equal(out['anthropic-version'], '2023-06-01', 'ordinary headers are untouched');

  const serialised = JSON.stringify(out);
  for (const secret of [
    'sk-or-v1-c1f9aaaabbbb5320',
    'sk-ant-api03-abcdefghijklmnop',
    'dXNlcjpwYXNzd29yZA==',
    'session=aaaaaaaaaaaaaaaaaaaa',
  ]) {
    assert.equal(serialised.includes(secret), false, `${secret} leaked into ${serialised}`);
  }
});

test('redactHeaders is case-insensitive about header names', () => {
  const out = redactHeaders({ Authorization: 'Bearer sk-ant-oat01-abcdefghijkl' });
  assert.equal(out.Authorization.includes('sk-ant-oat01-abcdefghijkl'), false);
});

test('redactHeaders tolerates no headers at all', () => {
  assert.deepEqual(redactHeaders(undefined), {});
});

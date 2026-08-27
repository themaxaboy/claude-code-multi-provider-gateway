import test from 'node:test';
import assert from 'node:assert/strict';
import { createUsageTap, formatUsage } from '../src/usage.js';

const enc = new TextEncoder();

/** Push chunks through the tap; return the bytes that came out and the stats. */
async function run(chunks) {
  const { stream, stats } = createUsageTap();
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();

  const collected = [];
  const pump = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      collected.push(value);
    }
  })();

  for (const c of chunks) await writer.write(enc.encode(c));
  await writer.close();
  await pump;

  return { stats, text: Buffer.concat(collected.map(Buffer.from)).toString() };
}

const MESSAGE_START =
  'data: {"type":"message_start","message":{"usage":{"input_tokens":18432,"cache_read_input_tokens":17920},"service_tier":"standard"}}\n\n';
const MESSAGE_DELTA =
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":612}}\n\n';

test('collects usage from message_start and message_delta', async () => {
  const { stats } = await run([MESSAGE_START, MESSAGE_DELTA]);
  assert.equal(stats.usage.input_tokens, 18432);
  assert.equal(stats.usage.output_tokens, 612);
  assert.equal(stats.usage.cache_read_input_tokens, 17920);
  assert.equal(stats.meta.stop_reason, 'end_turn');
  assert.equal(stats.meta.service_tier, 'standard');
});

test('an event split across a chunk boundary is still counted', async () => {
  const whole = MESSAGE_START + MESSAGE_DELTA;
  // cut right through the input_tokens number
  const cut = whole.indexOf('18432') + 2;
  const { stats } = await run([whole.slice(0, cut), whole.slice(cut)]);
  assert.equal(stats.usage.input_tokens, 18432, 'proxy.py misses this case');
  assert.equal(stats.usage.output_tokens, 612);
});

test('byte-at-a-time delivery still counts', async () => {
  const { stats } = await run([...(MESSAGE_START + MESSAGE_DELTA)]);
  assert.equal(stats.usage.input_tokens, 18432);
  assert.equal(stats.meta.stop_reason, 'end_turn');
});

test('forwarded bytes are identical to the input', async () => {
  const payload = MESSAGE_START + 'data: [DONE]\n\n' + MESSAGE_DELTA;
  const { text } = await run([payload]);
  assert.equal(text, payload);
});

test('a non-SSE body passes through without throwing', async () => {
  const { stats, text } = await run(['{"id":"msg_1","content":[]}']);
  assert.equal(text, '{"id":"msg_1","content":[]}');
  assert.deepEqual(stats.usage, {});
});

test('formatUsage matches the layout documented in the README', () => {
  assert.equal(
    formatUsage({
      usage: { input_tokens: 18432, output_tokens: 612, cache_read_input_tokens: 17920 },
      meta: { stop_reason: 'end_turn' },
    }),
    'in=18432 out=612 cache_hit=17920 stop=end_turn',
  );
  assert.equal(formatUsage(), '');
  assert.equal(
    formatUsage({ usage: {}, meta: { inference_geo: 'not_available' } }),
    '',
    'an unknown geo is not worth printing',
  );
});

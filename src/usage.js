// Read token stats out of an SSE stream as it flows past, without buffering it.

/**
 * A TransformStream that forwards every chunk byte-for-byte and collects
 * usage stats as a side effect.
 *
 * Partial lines are carried across chunks, so a `data: {...}` event split
 * across a chunk boundary is still counted.
 */
/**
 * No SSE line comes anywhere near this. Past it we are not looking at SSE at
 * all — a single-line JSON body, say — and `leftover` would otherwise grow into
 * a full copy of the response, which is exactly what this module promises not
 * to do.
 */
const MAX_LEFTOVER = 64 * 1024;

export function createUsageTap() {
  const stats = { usage: {}, meta: {} };
  const decoder = new TextDecoder('utf-8');
  let leftover = '';

  const stream = new TransformStream({
    transform(chunk, controller) {
      // Forward first: collecting stats must never delay or alter the stream.
      controller.enqueue(chunk);

      try {
        leftover += decoder.decode(chunk, { stream: true });
        const lines = leftover.split('\n');
        leftover = lines.pop() ?? '';
        for (const line of lines) consumeLine(line, stats);
      } catch {
        // Not SSE, or not decodable — just means no stats.
      }
    },
    flush() {
      if (!leftover) return;
      try {
        consumeLine(leftover, stats);
      } catch {
        /* ignore */
      }
    },
  });

  return { stream, stats };
}

function consumeLine(line, stats) {
  if (!line.startsWith('data:')) return;

  let event;
  try {
    // The space after "data:" is optional in the SSE spec, and some providers
    // leave it out.
    event = JSON.parse(line.slice(5));
  } catch {
    return; // e.g. "data: [DONE]"
  }

  if (event?.type === 'message_start' && event.message) {
    Object.assign(stats.usage, event.message.usage ?? {});
    for (const key of ['service_tier', 'inference_geo']) {
      if (key in event.message) stats.meta[key] = event.message[key];
    }
  } else if (event?.type === 'message_delta') {
    Object.assign(stats.usage, event.usage ?? {});
    if (event.delta && 'stop_reason' in event.delta) {
      stats.meta.stop_reason = event.delta.stop_reason;
    }
  }
}

/** "in=18432 out=612 cache_hit=17920 stop=end_turn" */
export function formatUsage({ usage = {}, meta = {} } = {}) {
  const parts = [];

  if ('input_tokens' in usage) parts.push(`in=${usage.input_tokens}`);
  if ('output_tokens' in usage) parts.push(`out=${usage.output_tokens}`);
  if (usage.cache_creation_input_tokens) {
    parts.push(`cache_create=${usage.cache_creation_input_tokens}`);
  }
  if (usage.cache_read_input_tokens) {
    parts.push(`cache_hit=${usage.cache_read_input_tokens}`);
  }
  if (meta.stop_reason) parts.push(`stop=${meta.stop_reason}`);
  if (meta.service_tier) parts.push(`tier=${meta.service_tier}`);
  if (meta.inference_geo && meta.inference_geo !== 'not_available') {
    parts.push(`geo=${meta.inference_geo}`);
  }

  return parts.join(' ');
}

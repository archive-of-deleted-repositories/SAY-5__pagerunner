import type { RunEvent } from './types.js';

export interface SubscribeOptions {
  baseUrl: string;
  runId: string;
  apiKey?: string;
  lastEventId?: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

/**
 * Subscribes to a run's SSE event stream and yields parsed events.
 * Honors `Last-Event-ID` so callers can resume after a disconnect.
 */
export async function* subscribeRunEvents(opts: SubscribeOptions): AsyncGenerator<RunEvent> {
  const fetchImpl = opts.fetch ?? fetch;
  const headers: Record<string, string> = { accept: 'text/event-stream' };
  if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;
  if (opts.lastEventId) headers['last-event-id'] = opts.lastEventId;

  const init: RequestInit = { headers };
  if (opts.signal) init.signal = opts.signal;
  const res = await fetchImpl(
    `${opts.baseUrl.replace(/\/$/, '')}/runs/${encodeURIComponent(opts.runId)}/events`,
    init,
  );
  if (!res.ok || !res.body) throw new Error(`SSE failed: ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const evt = parseEvent(chunk);
      if (evt) yield evt;
    }
  }
}

function parseEvent(chunk: string): RunEvent | null {
  let id = '';
  let type = '';
  const dataLines: string[] = [];
  for (const line of chunk.split('\n')) {
    if (line.startsWith('id:')) id = line.slice(3).trim();
    else if (line.startsWith('event:')) type = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (!type) return null;
  let data: Record<string, unknown> = {};
  if (dataLines.length) {
    try {
      data = JSON.parse(dataLines.join('\n')) as Record<string, unknown>;
    } catch {
      data = { raw: dataLines.join('\n') };
    }
  }
  return { id, type: type as RunEvent['type'], data };
}

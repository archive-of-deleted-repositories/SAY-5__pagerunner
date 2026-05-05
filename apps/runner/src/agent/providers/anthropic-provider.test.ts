import { AnthropicProvider } from './anthropic-provider';

interface FakeResponseInit {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  delayMs?: number;
}

const fakeResponse = (init: FakeResponseInit = {}): Response => {
  const body = init.body === undefined ? '' : JSON.stringify(init.body);
  return new Response(body, {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
};

describe('AnthropicProvider', () => {
  const baseObs = { domExcerpt: '<html><body>hello</body></html>', url: 'http://x.test/' };

  it('extracts a tool_use block as the next ToolCall', async () => {
    const fetchImpl = jest.fn(async () =>
      fakeResponse({
        status: 200,
        body: {
          id: 'msg_1',
          model: 'claude-sonnet-4-7-20250929',
          stop_reason: 'tool_use',
          content: [
            {
              type: 'tool_use',
              id: 't1',
              name: 'navigate',
              input: { url: 'http://target.test/', waitUntil: 'load' },
            },
          ],
          usage: { input_tokens: 120, output_tokens: 18 },
        },
      }),
    ) as unknown as typeof fetch;

    const p = new AnthropicProvider({ apiKey: 'key', fetchImpl });
    const res = await p.step(baseObs, []);
    expect(res.toolCall.tool).toBe('navigate');
    expect(res.toolCall.input).toEqual({ url: 'http://target.test/', waitUntil: 'load' });
    expect(res.tokensIn).toBe(120);
    expect(res.tokensOut).toBe(18);
    expect(res.costUsd).toBeGreaterThan(0);
  });

  it('coerces text-only response to a synthetic finish', async () => {
    const fetchImpl = jest.fn(async () =>
      fakeResponse({
        status: 200,
        body: {
          content: [{ type: 'text', text: 'I think we are done.' }],
          usage: { input_tokens: 10, output_tokens: 6 },
        },
      }),
    ) as unknown as typeof fetch;

    const p = new AnthropicProvider({ apiKey: 'key', fetchImpl });
    const res = await p.step(baseObs, []);
    expect(res.toolCall.tool).toBe('finish');
    expect(res.toolCall.input).toMatchObject({
      result: { text: 'I think we are done.' },
      reason: 'model-returned-text',
    });
  });

  it('throws RateLimitError on 429', async () => {
    const fetchImpl = jest.fn(async () =>
      fakeResponse({
        status: 429,
        body: { error: { message: 'too many' } },
        headers: { 'retry-after': '2' },
      }),
    ) as unknown as typeof fetch;

    const p = new AnthropicProvider({ apiKey: 'key', fetchImpl });
    await expect(p.step(baseObs, [])).rejects.toMatchObject({ code: 'RATE_LIMIT' });
  });

  it('throws UpstreamError on 500', async () => {
    const fetchImpl = jest.fn(async () =>
      fakeResponse({ status: 500, body: { error: { message: 'boom' } } }),
    ) as unknown as typeof fetch;

    const p = new AnthropicProvider({ apiKey: 'key', fetchImpl });
    await expect(p.step(baseObs, [])).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
  });

  it('throws AuthError on 401', async () => {
    const fetchImpl = jest.fn(async () =>
      fakeResponse({ status: 401, body: { error: { message: 'no key' } } }),
    ) as unknown as typeof fetch;

    const p = new AnthropicProvider({ apiKey: 'bad', fetchImpl });
    await expect(p.step(baseObs, [])).rejects.toMatchObject({ code: 'AUTH_ERROR' });
  });

  it('honours abort signal mid-request', async () => {
    const ac = new AbortController();
    const fetchImpl = jest.fn(
      async (_input: unknown, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    ) as unknown as typeof fetch;

    const p = new AnthropicProvider({ apiKey: 'key', fetchImpl });
    const stepPromise = p.step(baseObs, [], ac.signal);
    setTimeout(() => ac.abort(), 5);
    await expect(stepPromise).rejects.toMatchObject({ code: 'ABORTED' });
  });

  it('rejects construction without an api key', () => {
    expect(() => new AnthropicProvider({ apiKey: '' })).toThrow(/missing/);
  });
});

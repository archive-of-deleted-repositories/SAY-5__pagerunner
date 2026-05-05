import type { Server } from 'node:http';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { PlaywrightExecutor } from './playwright-executor';
import { start, stop } from '../../../../../tests/fixtures/sites/server';

/**
 * Skip the suite if Playwright's bundled Chromium hasn't been installed.
 * Locally we expect `pnpm exec playwright install chromium`; in CI the
 * test job calls the same. Skipping cleanly is preferable to crashing for
 * environments without browsers (e.g., the lint-only PR check).
 */
const cacheRoots = [
  process.env.PLAYWRIGHT_BROWSERS_PATH,
  join(homedir(), 'Library/Caches/ms-playwright'),
  join(homedir(), '.cache/ms-playwright'),
].filter((p): p is string => Boolean(p));
const hasChromium = (): boolean => {
  for (const root of cacheRoots) {
    if (!existsSync(root)) continue;
    try {
      const names = readdirSync(root);
      if (names.some((n) => /chromium/i.test(n))) return true;
    } catch {
      // ignore
    }
  }
  return false;
};

const maybe = hasChromium() ? describe : describe.skip;

maybe('PlaywrightExecutor', () => {
  jest.setTimeout(60_000);

  let server: Server;
  let baseUrl: string;
  let executor: PlaywrightExecutor;

  beforeAll(async () => {
    const handle = await start(0);
    server = handle.server;
    baseUrl = handle.url;
  });

  afterAll(async () => {
    await stop(server);
  });

  beforeEach(() => {
    executor = new PlaywrightExecutor({ launchOptions: { headless: true } });
  });

  afterEach(async () => {
    await executor.dispose();
  });

  it('navigates and captures DOM + screenshot', async () => {
    const result = await executor.execute({
      tool: 'navigate',
      input: { url: `${baseUrl}/login`, waitUntil: 'load' },
    });
    expect(result.output['url']).toContain('/login');
    expect(result.domAfter).toContain('<form');
    expect(result.artifacts?.screenshot).toBeInstanceOf(Buffer);
  });

  it('clicks an existing selector', async () => {
    await executor.execute({
      tool: 'navigate',
      input: { url: `${baseUrl}/login`, waitUntil: 'load' },
    });
    const result = await executor.execute({ tool: 'click', input: { selector: '#submit' } });
    expect(result.output).toMatchObject({ ok: true });
  });

  it('types into an input and submits', async () => {
    await executor.execute({
      tool: 'navigate',
      input: { url: `${baseUrl}/login`, waitUntil: 'load' },
    });
    const result = await executor.execute({
      tool: 'type',
      input: { selector: '#user', text: 'alice', submit: false },
    });
    expect(result.output).toMatchObject({ selector: '#user', text: 'alice' });
  });

  it('extracts a single text value', async () => {
    await executor.execute({
      tool: 'navigate',
      input: { url: `${baseUrl}/profile`, waitUntil: 'load' },
    });
    const result = await executor.execute({
      tool: 'extract',
      input: { selector: '#profile-name' },
    });
    expect(result.output['value']).toBe('alice');
  });

  it('extracts multiple values into an array', async () => {
    await executor.execute({
      tool: 'navigate',
      input: { url: `${baseUrl}/list`, waitUntil: 'load' },
    });
    const result = await executor.execute({
      tool: 'extract',
      input: { selector: '.item', multiple: true },
    });
    expect(result.output['values']).toEqual(['one', 'two']);
  });

  it('waits for a selector', async () => {
    await executor.execute({
      tool: 'navigate',
      input: { url: `${baseUrl}/login`, waitUntil: 'load' },
    });
    const result = await executor.execute({ tool: 'wait', input: { selector: '#submit' } });
    expect(result.output).toMatchObject({ selector: '#submit' });
  });

  it('finishes with a result payload', async () => {
    await executor.execute({
      tool: 'navigate',
      input: { url: `${baseUrl}/login`, waitUntil: 'load' },
    });
    const result = await executor.execute({
      tool: 'finish',
      input: { result: { ok: true }, reason: 'done' },
    });
    expect(result.output).toMatchObject({ final: true, result: { ok: true } });
  });

  it('throws SelectorNotFoundError for missing selectors', async () => {
    await executor.execute({
      tool: 'navigate',
      input: { url: `${baseUrl}/login`, waitUntil: 'load' },
    });
    await expect(
      executor.execute({ tool: 'click', input: { selector: '#does-not-exist' } }),
    ).rejects.toMatchObject({ code: 'SELECTOR_NOT_FOUND' });
  });

  it('captures console messages emitted on the page', async () => {
    const result = await executor.execute({
      tool: 'navigate',
      input: { url: `${baseUrl}/login`, waitUntil: 'load' },
    });
    expect(result.artifacts?.consoleMessages?.some((m) => m.includes('login page loaded'))).toBe(
      true,
    );
  });

  it('throws AbortError when signal is pre-aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      executor.execute({ tool: 'navigate', input: { url: baseUrl } }, ac.signal),
    ).rejects.toMatchObject({ code: 'ABORTED' });
  });

  it('surfaces a typed error for unreachable hosts', async () => {
    const tightExec = new PlaywrightExecutor({
      launchOptions: { headless: true },
      navigationTimeoutMs: 1_000,
      actionTimeoutMs: 1_000,
    });
    try {
      // 127.0.0.1:1 is on the loopback so name resolution is instant; we
      // just need the connect-timeout to fire under our short budget.
      await expect(
        tightExec.execute({
          tool: 'navigate',
          input: { url: 'http://127.0.0.1:1/' },
        }),
      ).rejects.toMatchObject({ code: expect.stringMatching(/NAVIGATION_TIMEOUT|TOOL_EXECUTION/) });
    } finally {
      await tightExec.dispose();
    }
  });
});

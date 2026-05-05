import type { Server } from 'node:http';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { PlaywrightExecutor } from './playwright-executor';
import { AnthropicProvider } from '../providers/anthropic-provider';
import { runAgent } from '../loop';
import { start, stop } from '../../../../../tests/fixtures/sites/server';

/**
 * End-to-end smoke against the mock fastify-style site using a real Anthropic
 * API key and a real Chromium. Skipped in CI (no key); local devs run it with
 * `ANTHROPIC_API_KEY=... pnpm test`.
 */
const cacheRoot =
  process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), 'Library/Caches/ms-playwright');
const linuxCache = join(homedir(), '.cache/ms-playwright');
const hasChromium = (): boolean => {
  for (const root of [cacheRoot, linuxCache]) {
    if (!existsSync(root)) continue;
    try {
      const names = readdirSync(root);
      if (names.some((n) => n.startsWith('chromium-'))) return true;
    } catch {
      // ignore
    }
  }
  return false;
};

const SHOULD_RUN = Boolean(process.env.ANTHROPIC_API_KEY) && hasChromium();
const maybe = SHOULD_RUN ? describe : describe.skip;

maybe('PlaywrightExecutor + AnthropicProvider e2e', () => {
  jest.setTimeout(180_000);

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

  it('drives the login page through real model + real browser', async () => {
    const provider = new AnthropicProvider({
      apiKey: process.env.ANTHROPIC_API_KEY ?? '',
      systemPrompt:
        `You are driving a browser. Navigate to ${baseUrl}/login, then call finish with result {"ok": true}. ` +
        'Only emit one tool call per turn.',
    });
    const result = await runAgent({
      llm: provider,
      executor,
      budget: { maxSteps: 6, maxCostUsd: 0.5, maxWallClockMs: 120_000, maxTokensPerStep: 2048 },
    });
    expect(['succeeded', 'failed']).toContain(result.status);
  });
});

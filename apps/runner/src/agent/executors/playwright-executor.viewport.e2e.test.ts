import type { Server } from 'node:http';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { PlaywrightExecutor } from './playwright-executor';
import { start, stop } from '../../../../../tests/fixtures/sites/server';

/**
 * Desktop + mobile viewport coverage for the `login_then_read_profile`
 * golden flow. We drive the executor end-to-end through navigate/type/
 * click/extract/finish at both 1280px (desktop) and 375px (mobile) so a
 * regression in the mobile-emulated path (touch events, isMobile UA, smaller
 * viewport) shows up in CI rather than at customer site #1.
 *
 * Skipped when Playwright's bundled Chromium is unavailable; the same gate
 * the rest of the executor suite uses.
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

interface ViewportCase {
  label: string;
  width: number;
  height: number;
  isMobile: boolean;
}

const VIEWPORTS: ViewportCase[] = [
  { label: 'desktop 1280', width: 1280, height: 720, isMobile: false },
  { label: 'mobile 375', width: 375, height: 667, isMobile: true },
];

maybe('PlaywrightExecutor login_then_read_profile across viewports', () => {
  jest.setTimeout(60_000);

  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const handle = await start(0);
    server = handle.server;
    baseUrl = handle.url;
  });

  afterAll(async () => {
    await stop(server);
  });

  for (const vp of VIEWPORTS) {
    it(`runs the flow at ${vp.label}`, async () => {
      const executor = new PlaywrightExecutor({
        launchOptions: { headless: true },
        viewport: { width: vp.width, height: vp.height, isMobile: vp.isMobile },
      });
      try {
        const navigate = await executor.execute({
          tool: 'navigate',
          input: { url: `${baseUrl}/login`, waitUntil: 'load' },
        });
        expect(navigate.output['url']).toContain('/login');
        expect(navigate.domAfter).toContain('<form');

        const typeUser = await executor.execute({
          tool: 'type',
          input: { selector: '#user', text: 'alice', submit: false },
        });
        expect(typeUser.output).toMatchObject({ selector: '#user', text: 'alice' });

        const typePw = await executor.execute({
          tool: 'type',
          input: { selector: '#pw', text: 'hunter2', submit: false },
        });
        expect(typePw.output).toMatchObject({ selector: '#pw', text: 'hunter2' });

        const click = await executor.execute({
          tool: 'click',
          input: { selector: '#submit' },
        });
        expect(click.output).toMatchObject({ ok: true });

        // Move to /profile and extract the value. Mock server is stateless;
        // the click target on /login is a button without a form action so we
        // navigate explicitly to model the post-login state.
        await executor.execute({
          tool: 'navigate',
          input: { url: `${baseUrl}/profile`, waitUntil: 'load' },
        });
        const extract = await executor.execute({
          tool: 'extract',
          input: { selector: '#profile-name' },
        });
        expect(extract.output).toMatchObject({ value: 'alice' });
      } finally {
        await executor.dispose();
      }
    });
  }
});

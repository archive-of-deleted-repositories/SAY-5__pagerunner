import {
  AbortError,
  NavigationTimeoutError,
  SelectorNotFoundError,
  ToolExecutionError,
} from '@pagerunner/shared';
import type { ToolCall } from '@pagerunner/agent-tools';
import type { Browser, BrowserContext, ConsoleMessage, LaunchOptions, Page } from 'playwright';
import type { ToolExecutionResult, ToolExecutor } from '../types.js';

export interface PlaywrightExecutorOptions {
  /** When unset, the executor will lazily import and launch chromium. */
  browser?: Browser;
  /** Override Playwright launch args. Headless defaults to true. */
  launchOptions?: LaunchOptions;
  /** Per-tool action timeout in ms. Default 15s. */
  actionTimeoutMs?: number;
  /** Per-navigation timeout in ms. Default 30s. */
  navigationTimeoutMs?: number;
}

const ACTION_TIMEOUT_DEFAULT = 15_000;
const NAVIGATION_TIMEOUT_DEFAULT = 30_000;

const isAbortError = (err: unknown): boolean => {
  if (err instanceof AbortError) return true;
  if (err instanceof Error && /aborted|abort/i.test(err.message)) return true;
  return false;
};

const isTimeout = (err: unknown): boolean => err instanceof Error && err.name === 'TimeoutError';

/**
 * Playwright-backed tool executor. Owns one BrowserContext per run. Each tool
 * maps directly to a Playwright primitive; orchestration belongs to the
 * agent loop. After every tool call, captures DOM, screenshot, and console
 * messages so the loop can persist them as artifacts.
 */
export class PlaywrightExecutor implements ToolExecutor {
  private browser: Browser | null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private readonly ownsBrowser: boolean;
  private readonly launchOptions: LaunchOptions;
  private readonly actionTimeoutMs: number;
  private readonly navigationTimeoutMs: number;
  private readonly consoleBuffer: string[] = [];
  private consoleListener: ((m: ConsoleMessage) => void) | null = null;

  constructor(opts: PlaywrightExecutorOptions = {}) {
    this.browser = opts.browser ?? null;
    this.ownsBrowser = !opts.browser;
    this.launchOptions = opts.launchOptions ?? { headless: true };
    this.actionTimeoutMs = opts.actionTimeoutMs ?? ACTION_TIMEOUT_DEFAULT;
    this.navigationTimeoutMs = opts.navigationTimeoutMs ?? NAVIGATION_TIMEOUT_DEFAULT;
  }

  private async ensurePage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;
    if (!this.browser) {
      const { chromium } = await import('playwright');
      this.browser = await chromium.launch(this.launchOptions);
    }
    this.context = await this.browser.newContext();
    this.context.setDefaultTimeout(this.actionTimeoutMs);
    this.context.setDefaultNavigationTimeout(this.navigationTimeoutMs);
    const page = await this.context.newPage();
    this.consoleListener = (msg: ConsoleMessage) => {
      this.consoleBuffer.push(`[${msg.type()}] ${msg.text()}`);
    };
    page.on('console', this.consoleListener);
    this.page = page;
    return page;
  }

  private async capture(page: Page): Promise<{ dom: string; result: ToolExecutionResult }> {
    const [dom, screenshot] = await Promise.all([
      page.content().catch(() => ''),
      page.screenshot({ fullPage: false }).catch(() => undefined),
    ]);
    const consoleMessages = [...this.consoleBuffer];
    this.consoleBuffer.length = 0;
    const artifacts: NonNullable<ToolExecutionResult['artifacts']> = { consoleMessages };
    if (screenshot) artifacts.screenshot = screenshot;
    return {
      dom,
      result: { output: {}, domAfter: dom, artifacts },
    };
  }

  async execute(call: ToolCall, signal?: AbortSignal): Promise<ToolExecutionResult> {
    if (signal?.aborted) throw new AbortError();
    const page = await this.ensurePage();

    const onAbort = (): void => {
      // Closing the page interrupts any in-flight Playwright primitive.
      void page.close().catch(() => undefined);
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    try {
      switch (call.tool) {
        case 'navigate': {
          const url = (call.input as { url: string }).url;
          const waitUntil =
            (call.input as { waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' }).waitUntil ??
            'load';
          try {
            await page.goto(url, { waitUntil, timeout: this.navigationTimeoutMs });
          } catch (err) {
            if (signal?.aborted) throw new AbortError();
            if (isTimeout(err)) throw new NavigationTimeoutError(url);
            throw new ToolExecutionError(
              err instanceof Error ? `navigate: ${err.message}` : String(err),
            );
          }
          const cap = await this.capture(page);
          return { ...cap.result, output: { url: page.url() } };
        }
        case 'click': {
          const selector = (call.input as { selector: string }).selector;
          const nth = (call.input as { nth?: number }).nth;
          try {
            const locator =
              nth !== undefined ? page.locator(selector).nth(nth) : page.locator(selector);
            await locator.click({ timeout: this.actionTimeoutMs });
          } catch (err) {
            if (signal?.aborted) throw new AbortError();
            if (isTimeout(err)) throw new SelectorNotFoundError(selector);
            throw new ToolExecutionError(
              err instanceof Error ? `click: ${err.message}` : String(err),
            );
          }
          const cap = await this.capture(page);
          return { ...cap.result, output: { selector, ok: true } };
        }
        case 'type': {
          const selector = (call.input as { selector: string }).selector;
          const text = (call.input as { text: string }).text;
          const submit = (call.input as { submit?: boolean }).submit ?? false;
          try {
            const locator = page.locator(selector);
            await locator.fill(text, { timeout: this.actionTimeoutMs });
            if (submit) await locator.press('Enter', { timeout: this.actionTimeoutMs });
          } catch (err) {
            if (signal?.aborted) throw new AbortError();
            if (isTimeout(err)) throw new SelectorNotFoundError(selector);
            throw new ToolExecutionError(
              err instanceof Error ? `type: ${err.message}` : String(err),
            );
          }
          const cap = await this.capture(page);
          return { ...cap.result, output: { selector, text, submit } };
        }
        case 'extract': {
          const selector = (call.input as { selector: string }).selector;
          const attribute = (call.input as { attribute?: string }).attribute;
          const multiple = (call.input as { multiple?: boolean }).multiple ?? false;
          try {
            const locator = page.locator(selector);
            const count = multiple ? await locator.count() : 1;
            if (!multiple && count === 0) throw new SelectorNotFoundError(selector);
            const values: string[] = [];
            for (let i = 0; i < count; i += 1) {
              const item = locator.nth(i);
              const value = attribute
                ? ((await item.getAttribute(attribute, { timeout: this.actionTimeoutMs })) ?? '')
                : ((await item.textContent({ timeout: this.actionTimeoutMs })) ?? '').trim();
              values.push(value);
            }
            const cap = await this.capture(page);
            const output: Record<string, unknown> = {
              selector,
              ...(multiple ? { values } : { value: values[0] ?? '' }),
            };
            return { ...cap.result, output };
          } catch (err) {
            if (signal?.aborted) throw new AbortError();
            if (err instanceof SelectorNotFoundError) throw err;
            if (isTimeout(err)) throw new SelectorNotFoundError(selector);
            throw new ToolExecutionError(
              err instanceof Error ? `extract: ${err.message}` : String(err),
            );
          }
        }
        case 'wait': {
          const selector = (call.input as { selector?: string }).selector;
          const ms = (call.input as { ms?: number }).ms;
          try {
            if (selector) {
              await page.waitForSelector(selector, { timeout: this.actionTimeoutMs });
            } else if (ms !== undefined) {
              await page.waitForTimeout(ms);
            }
          } catch (err) {
            if (signal?.aborted) throw new AbortError();
            if (isTimeout(err) && selector) throw new SelectorNotFoundError(selector);
            throw new ToolExecutionError(
              err instanceof Error ? `wait: ${err.message}` : String(err),
            );
          }
          const cap = await this.capture(page);
          return { ...cap.result, output: { selector: selector ?? null, ms: ms ?? 0 } };
        }
        case 'finish': {
          const result = (call.input as { result?: Record<string, unknown> }).result ?? {};
          const reason = (call.input as { reason?: string }).reason ?? 'done';
          const cap = await this.capture(page);
          return { ...cap.result, output: { final: true, result, reason } };
        }
        default: {
          throw new ToolExecutionError(`unknown tool: ${(call as { tool: string }).tool}`);
        }
      }
    } catch (err) {
      if (signal?.aborted || isAbortError(err)) throw new AbortError();
      throw err;
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  async dispose(): Promise<void> {
    if (this.consoleListener && this.page && !this.page.isClosed()) {
      this.page.off('console', this.consoleListener);
    }
    this.consoleListener = null;
    if (this.context) {
      await this.context.close().catch(() => undefined);
      this.context = null;
      this.page = null;
    }
    if (this.browser && this.ownsBrowser) {
      await this.browser.close().catch(() => undefined);
      this.browser = null;
    }
  }
}

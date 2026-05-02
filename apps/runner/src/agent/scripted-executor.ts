import type { ToolCall } from '@pagerunner/agent-tools';
import { SelectorNotFoundError } from '@pagerunner/shared';
import type { ToolExecutor } from './types.js';

/**
 * In-memory executor for tests. It tracks "navigated" URLs and pretends each
 * declared selector resolves successfully. Selectors prefixed with `MISSING:`
 * raise SelectorNotFoundError so the retry policy can be exercised without
 * needing a real browser.
 */
export class ScriptedExecutor implements ToolExecutor {
  private readonly visited: string[] = [];
  private readonly extracted: Record<string, string> = {};
  private failOnce = new Set<string>();

  failNextOn(selector: string): void {
    this.failOnce.add(selector);
  }

  setExtract(key: string, value: string): void {
    this.extracted[key] = value;
  }

  async execute(call: ToolCall): Promise<{ output: Record<string, unknown>; domAfter: string }> {
    switch (call.tool) {
      case 'navigate': {
        const url = (call.input as { url: string }).url;
        this.visited.push(url);
        return { output: { url }, domAfter: `<html><body>at ${url}</body></html>` };
      }
      case 'click':
      case 'type':
      case 'wait': {
        const sel = (call.input as { selector?: string }).selector ?? '';
        if (sel.startsWith('MISSING:')) throw new SelectorNotFoundError(sel);
        if (this.failOnce.has(sel)) {
          this.failOnce.delete(sel);
          throw new SelectorNotFoundError(sel);
        }
        return {
          output: { selector: sel, ok: true },
          domAfter: `<html><body>after ${call.tool}</body></html>`,
        };
      }
      case 'extract': {
        const sel = (call.input as { selector: string }).selector;
        const value = this.extracted[sel] ?? `value-of-${sel}`;
        return {
          output: { selector: sel, value },
          domAfter: `<html><body>extracted</body></html>`,
        };
      }
      case 'finish': {
        const result = (call.input as { result?: Record<string, unknown> }).result ?? {};
        return { output: { final: true, result }, domAfter: '' };
      }
    }
  }

  visitedUrls(): string[] {
    return [...this.visited];
  }
}

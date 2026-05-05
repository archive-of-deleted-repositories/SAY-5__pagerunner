import Anthropic from '@anthropic-ai/sdk';
import { AbortError, AuthError, RateLimitError, UpstreamError } from '@pagerunner/shared';
import { toAnthropicTools, type ToolCall, type ToolName } from '@pagerunner/agent-tools';
import type { AgentObservation, LLMProvider, LLMResponse } from '../types.js';
import { computeCostUsd } from '../pricing.js';

export const DEFAULT_MODEL = 'claude-sonnet-4-7-20250929';

export interface AnthropicProviderOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxOutputTokens?: number;
  systemPrompt?: string;
  /** Test hook: inject a custom fetch (e.g., msw / nock-fetch). */
  fetchImpl?: typeof fetch;
}

const SYSTEM_PROMPT_DEFAULT =
  'You are a browser-driving agent. On every turn, return exactly one tool call from the provided toolset. Use `finish` when the goal is met or unreachable.';

const TOOL_NAMES: ReadonlySet<ToolName> = new Set([
  'navigate',
  'click',
  'type',
  'extract',
  'wait',
  'finish',
]);

interface AnthropicErrorLike {
  status?: number;
  name?: string;
  headers?: Record<string, string> | undefined;
  message?: string;
  cause?: unknown;
}

const looksLikeAbort = (err: unknown): boolean => {
  if (err instanceof Error && err.name === 'AbortError') return true;
  if (err instanceof Error && /abort/i.test(err.message)) return true;
  if (typeof err === 'object' && err !== null) {
    const e = err as AnthropicErrorLike;
    if (e.name === 'AbortError') return true;
    if (e.cause && looksLikeAbort(e.cause)) return true;
  }
  return false;
};

const mapError = (err: unknown, abort?: AbortSignal): never => {
  if (err instanceof AbortError) throw err;
  if (abort?.aborted || looksLikeAbort(err)) throw new AbortError();
  const e = err as AnthropicErrorLike;
  const status = e.status;
  if (status === 401 || status === 403) {
    throw new AuthError(`anthropic auth failed: ${status}`);
  }
  if (status === 429) {
    const retry = e.headers?.['retry-after'];
    const retryMs = retry ? Number(retry) * 1_000 : undefined;
    throw new RateLimitError(
      'anthropic rate limit',
      retryMs && Number.isFinite(retryMs) ? retryMs : undefined,
    );
  }
  if (typeof status === 'number' && status >= 500) {
    throw new UpstreamError(`anthropic ${status}`, status);
  }
  if (typeof status === 'number') {
    throw new UpstreamError(`anthropic ${status}: ${e.message ?? ''}`, status);
  }
  throw new UpstreamError(err instanceof Error ? err.message : String(err));
};

/**
 * Production LLM provider backed by the Anthropic SDK. The provider is
 * intentionally thin: one HTTP call per `step`, no retries, typed errors so
 * the agent loop owns retry policy. Cancellation is honoured via AbortSignal.
 */
export class AnthropicProvider implements LLMProvider {
  readonly model: string;
  private readonly client: Anthropic;
  private readonly timeoutMs: number;
  private readonly maxOutputTokens: number;
  private readonly systemPrompt: string;
  private readonly transcript: Array<{
    role: 'user' | 'assistant';
    content: unknown;
  }> = [];

  constructor(opts: AnthropicProviderOptions) {
    if (!opts.apiKey) throw new AuthError('ANTHROPIC_API_KEY missing');
    this.model = opts.model ?? DEFAULT_MODEL;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.maxOutputTokens = opts.maxOutputTokens ?? 1_024;
    this.systemPrompt = opts.systemPrompt ?? SYSTEM_PROMPT_DEFAULT;

    const clientOpts: Record<string, unknown> = {
      apiKey: opts.apiKey,
      maxRetries: 0,
      timeout: this.timeoutMs,
    };
    if (opts.baseUrl) clientOpts['baseURL'] = opts.baseUrl;
    if (opts.fetchImpl) clientOpts['fetch'] = opts.fetchImpl;
    this.client = new Anthropic(clientOpts as ConstructorParameters<typeof Anthropic>[0]);
  }

  async step(
    observation: AgentObservation,
    history: ToolCall[],
    abort?: AbortSignal,
  ): Promise<LLMResponse> {
    if (this.transcript.length === 0) {
      this.transcript.push({
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Initial observation:\nURL: ${observation.url ?? '(none)'}\nDOM:\n${observation.domExcerpt}`,
          },
        ],
      });
    } else {
      this.transcript.push({
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Observation after step ${history.length}:\nURL: ${observation.url ?? '(unchanged)'}\nDOM:\n${observation.domExcerpt}${observation.lastError ? `\nError: ${observation.lastError}` : ''}`,
          },
        ],
      });
    }

    interface AnthropicMessage {
      content?: Array<{
        type: string;
        text?: string;
        name?: string;
        input?: Record<string, unknown>;
      }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    }
    let response: AnthropicMessage;
    try {
      const params = {
        model: this.model,
        max_tokens: this.maxOutputTokens,
        system: this.systemPrompt,
        tools: toAnthropicTools() as never,
        messages: this.transcript as never,
      };
      const reqOpts: { signal?: AbortSignal } = {};
      if (abort) reqOpts.signal = abort;
      response = (await this.client.messages.create(
        params as Parameters<typeof this.client.messages.create>[0],
        reqOpts as Parameters<typeof this.client.messages.create>[1],
      )) as unknown as AnthropicMessage;
    } catch (err) {
      mapError(err, abort);
      throw err; // unreachable
    }

    this.transcript.push({ role: 'assistant', content: response.content ?? [] });

    const tokensIn = response.usage?.input_tokens ?? 0;
    const tokensOut = response.usage?.output_tokens ?? 0;
    const costUsd = computeCostUsd(this.model, tokensIn, tokensOut);

    const blocks = response.content ?? [];
    const toolBlock = blocks.find((b) => b.type === 'tool_use');
    if (toolBlock?.name && TOOL_NAMES.has(toolBlock.name as ToolName)) {
      const toolCall: ToolCall = {
        tool: toolBlock.name as ToolCall['tool'],
        input: (toolBlock.input ?? {}) as Record<string, unknown>,
      };
      return { toolCall, tokensIn, tokensOut, costUsd };
    }

    // Model returned text without a tool call; coerce to a `finish` so the
    // loop's contract (one tool call per step) holds.
    const textBlock = blocks.find((b) => b.type === 'text');
    const text = textBlock?.text ?? '';
    const synthetic: ToolCall = {
      tool: 'finish',
      input: { result: { text }, reason: 'model-returned-text' },
    };
    return { toolCall: synthetic, tokensIn, tokensOut, costUsd };
  }
}

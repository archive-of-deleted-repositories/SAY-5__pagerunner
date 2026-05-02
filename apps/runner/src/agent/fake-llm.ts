import type { ToolCall } from '@pagerunner/agent-tools';
import type { AgentObservation, LLMProvider, LLMResponse } from './types.js';

/**
 * Deterministic LLM stand-in: replays a scripted sequence of tool calls.
 * The fake exists so the agent loop can be exercised in CI without an API
 * key and without flake. Each call returns the next scripted ToolCall and
 * a fixed token/cost cost so the budget enforcement is testable.
 */
export class FakeLLMProvider implements LLMProvider {
  readonly model = 'fake-llm';
  private cursor = 0;

  constructor(
    private readonly script: ToolCall[],
    private readonly costPerCallUsd = 0.001,
  ) {}

  async step(_obs: AgentObservation, _history: ToolCall[]): Promise<LLMResponse> {
    if (this.cursor >= this.script.length) {
      throw new Error('fake-llm script exhausted');
    }
    const call = this.script[this.cursor];
    if (!call) throw new Error('fake-llm script entry undefined');
    this.cursor += 1;
    return {
      toolCall: call,
      tokensIn: 200,
      tokensOut: 50,
      costUsd: this.costPerCallUsd,
    };
  }

  reset(): void {
    this.cursor = 0;
  }
}

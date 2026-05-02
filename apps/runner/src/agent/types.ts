import type { ToolCall } from '@pagerunner/agent-tools';

export interface AgentBudget {
  maxSteps: number;
  maxTokensPerStep: number;
  maxWallClockMs: number;
  maxCostUsd: number;
}

export const DEFAULT_BUDGET: AgentBudget = {
  maxSteps: 20,
  maxTokensPerStep: 4_000,
  maxWallClockMs: 120_000,
  maxCostUsd: 0.5,
};

export interface AgentObservation {
  domExcerpt: string;
  url?: string;
  lastError?: string;
}

export interface LLMResponse {
  toolCall: ToolCall;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

export interface LLMProvider {
  step(observation: AgentObservation, history: ToolCall[]): Promise<LLMResponse>;
  readonly model: string;
}

export interface ToolExecutor {
  execute(call: ToolCall): Promise<{ output: Record<string, unknown>; domAfter: string }>;
}

export interface AgentRunResult {
  status: 'succeeded' | 'failed' | 'budget_exceeded';
  steps: Array<{
    idx: number;
    tool: string;
    input: Record<string, unknown>;
    output?: Record<string, unknown>;
    latencyMs: number;
    retryCount: number;
    errorCode?: string;
  }>;
  totalCostUsd: number;
  totalTokensIn: number;
  totalTokensOut: number;
  errorCode?: string;
  finalResult?: Record<string, unknown>;
}

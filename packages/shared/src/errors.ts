export class PageRunnerError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class FlowValidationError extends PageRunnerError {
  constructor(message: string) {
    super(message, 'FLOW_INVALID', false);
  }
}

export class StepBudgetExceededError extends PageRunnerError {
  constructor(public readonly budget: number) {
    super(`step budget ${budget} exceeded`, 'STEP_BUDGET_EXCEEDED', false);
  }
}

export class CostBudgetExceededError extends PageRunnerError {
  constructor(public readonly budgetUsd: number) {
    super(`cost budget ${budgetUsd} exceeded`, 'COST_BUDGET_EXCEEDED', false);
  }
}

export class WallClockExceededError extends PageRunnerError {
  constructor(public readonly budgetMs: number) {
    super(`wall-clock budget ${budgetMs}ms exceeded`, 'WALL_CLOCK_EXCEEDED', false);
  }
}

export class SelectorNotFoundError extends PageRunnerError {
  constructor(public readonly selector: string) {
    super(`selector not found: ${selector}`, 'SELECTOR_NOT_FOUND', true);
  }
}

export class ToolValidationError extends PageRunnerError {
  constructor(message: string) {
    super(message, 'TOOL_INVALID', false);
  }
}

export class InfraError extends PageRunnerError {
  constructor(message: string) {
    super(message, 'INFRA_ERROR', true);
  }
}

export class IdempotencyConflictError extends PageRunnerError {
  constructor(key: string) {
    super(`idempotency key in use: ${key}`, 'IDEMPOTENCY_CONFLICT', false);
  }
}

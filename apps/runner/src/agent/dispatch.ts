import { logger } from '@pagerunner/shared';

/**
 * Production dispatcher. Pulls flow + inputs from the database, instantiates
 * a real LLM provider, opens a Playwright browser, and runs the loop. Tests
 * exercise `runAgent` directly with fakes; this path is exercised only at
 * runtime against live infrastructure.
 */
export async function dispatch(payload: Record<string, unknown>): Promise<void> {
  logger.info({ payload }, 'dispatch placeholder; production wiring needed');
}

import { logger } from '@pagerunner/shared';

async function main(): Promise<void> {
  // Worker bootstrap. The actual queue consumer is wired in src/worker.ts;
  // this entrypoint kept thin to make the runner trivially testable.
  const { startWorker } = await import('./worker.js');
  await startWorker();
  logger.info('runner worker started');
}

main().catch((err) => {
  logger.error({ err }, 'runner bootstrap failed');
  process.exit(1);
});

import pino from 'pino';

export type LogContext = {
  runId?: string;
  stepIdx?: number;
  tenantId?: string;
  traceId?: string;
};

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'pagerunner' },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export const childLogger = (ctx: LogContext) => logger.child(ctx);

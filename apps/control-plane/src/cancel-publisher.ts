import { Injectable, Optional } from '@nestjs/common';
import IORedis, { type Redis } from 'ioredis';

/**
 * Publishes cancellation requests on the `runs:cancel:<run_id>` channel.
 *
 * The dispatcher pods `psubscribe('runs:cancel:*')` on a dedicated Redis
 * connection. Whichever pod is currently driving the run hits its
 * in-memory `runId -> AbortController` map and aborts the agent loop;
 * other pods receive the message and no-op.
 *
 * Pub/sub is best-effort delivery. The local AbortController is the
 * source of truth for the running pod — if Redis disconnects mid-run,
 * the run completes normally, and the operator can retry the cancel
 * request once the connection recovers. Status is persisted in the DB
 * by the dispatcher when the abort lands; the `cancelling` -> `cancelled`
 * transition only happens once the agent loop actually unwinds.
 */
@Injectable()
export class CancelPublisher {
  private redis: Redis | null;
  private readonly ownsConnection: boolean;

  constructor(@Optional() redis?: Redis) {
    if (redis) {
      this.redis = redis;
      this.ownsConnection = false;
      return;
    }
    const url = process.env['REDIS_URL'];
    if (url) {
      this.redis = new IORedis(url, {
        // Publishing is non-blocking; we don't need infinite-retry semantics.
        maxRetriesPerRequest: 3,
        enableOfflineQueue: false,
        // The control-plane crashes on startup if we connect lazily and the
        // very first cancel publish fails — let ioredis report the error
        // through publish() instead.
        lazyConnect: true,
      });
      this.redis.connect().catch(() => undefined);
      this.ownsConnection = true;
    } else {
      this.redis = null;
      this.ownsConnection = false;
    }
  }

  /**
   * Publish a cancel request. Returns the integer subscriber count that
   * received the message (Redis's PUBLISH return value), or 0 when the
   * publisher is disabled (no REDIS_URL) or the connection is offline.
   */
  async publish(runId: string, reason: string): Promise<number> {
    if (!this.redis) return 0;
    try {
      const channel = `runs:cancel:${runId}`;
      const recipients = await this.redis.publish(channel, reason);
      return recipients;
    } catch {
      // Best-effort: pub/sub failures are not fatal. The local run will
      // still hit its budget caps eventually, and the operator's status
      // page will already show `cancelling` from the synchronous DB write.
      return 0;
    }
  }

  async dispose(): Promise<void> {
    if (this.redis && this.ownsConnection) {
      await this.redis.quit().catch(() => undefined);
      this.redis = null;
    }
  }
}

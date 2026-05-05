import type { Redis } from 'ioredis';

/**
 * Per-tenant counting semaphore backed by Redis. BullMQ's queue-level
 * rate limit is global; we need a per-key concurrency cap so noisy
 * tenants don't drain dispatcher capacity from quieter ones.
 *
 * Implementation is a lease: each acquire writes a unique token into a
 * sorted set with `score = expiresAt`. Cleanup of expired leases happens
 * inline so a crashed worker can't permanently hold a slot.
 */
export interface SemaphoreLease {
  release(): Promise<void>;
}

export class RedisSemaphore {
  constructor(
    private readonly redis: Redis,
    private readonly capacity: (key: string) => number,
    private readonly leaseTtlMs = 60_000,
  ) {}

  private keyFor(tenantId: string): string {
    return `pr:sem:${tenantId}`;
  }

  /** Try to acquire a lease. Returns null if at capacity. */
  async tryAcquire(tenantId: string): Promise<SemaphoreLease | null> {
    const key = this.keyFor(tenantId);
    const cap = this.capacity(tenantId);
    const now = Date.now();
    // Garbage-collect expired leases. ZREMRANGEBYSCORE removes by score range.
    await this.redis.zremrangebyscore(key, '-inf', now);
    const current = await this.redis.zcard(key);
    if (current >= cap) return null;
    const token = `${now}:${Math.random().toString(36).slice(2)}`;
    await this.redis.zadd(key, now + this.leaseTtlMs, token);
    return {
      release: async () => {
        await this.redis.zrem(key, token);
      },
    };
  }

  /**
   * Acquire with a soft timeout. Polls every 250ms; returns null on
   * timeout. Callers requeue the BullMQ job rather than blocking the worker.
   */
  async acquire(tenantId: string, timeoutMs = 30_000): Promise<SemaphoreLease | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const lease = await this.tryAcquire(tenantId);
      if (lease) return lease;
      await new Promise((r) => setTimeout(r, 250));
    }
    return null;
  }
}

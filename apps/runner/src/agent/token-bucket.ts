/**
 * Plain token bucket. Used per target_domain to enforce backpressure on
 * outgoing browser sessions. `rate` is tokens added per second, `capacity`
 * is the burst limit, both configurable per tenant in production.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;

  constructor(
    private readonly capacity: number,
    private readonly ratePerSec: number,
    private readonly clock: () => number = () => Date.now(),
  ) {
    if (capacity <= 0) throw new Error('capacity must be positive');
    if (ratePerSec <= 0) throw new Error('ratePerSec must be positive');
    this.tokens = capacity;
    this.lastRefillMs = clock();
  }

  private refill(): void {
    const now = this.clock();
    const elapsedSec = (now - this.lastRefillMs) / 1_000;
    if (elapsedSec <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.ratePerSec);
    this.lastRefillMs = now;
  }

  tryConsume(n = 1): boolean {
    this.refill();
    if (this.tokens >= n) {
      this.tokens -= n;
      return true;
    }
    return false;
  }

  /** Milliseconds until `n` tokens are available (0 if available now). */
  delayFor(n = 1): number {
    this.refill();
    if (this.tokens >= n) return 0;
    const deficit = n - this.tokens;
    return Math.ceil((deficit / this.ratePerSec) * 1_000);
  }

  available(): number {
    this.refill();
    return this.tokens;
  }
}

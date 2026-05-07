import fc from 'fast-check';
import { TokenBucket } from '../../apps/runner/src/agent/token-bucket';

/**
 * Property tests for the token bucket. The closed-form refill curve is:
 *   tokens(t) = min(capacity, tokens(0) + rate * t)
 * The bucket implementation does the same arithmetic incrementally with a
 * floating-point reservoir, so we tolerate ±1 token of slop when comparing
 * against the closed form (rounding + accumulation across many refills).
 */

describe('TokenBucket (property-based)', () => {
  it('bucket level matches the closed-form refill curve to within 1 token', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000 }),
        fc.integer({ min: 1, max: 1_000 }),
        fc.integer({ min: 0, max: 60_000 }),
        (capacity, ratePerSec, elapsedMs) => {
          let now = 0;
          const b = new TokenBucket(capacity, ratePerSec, () => now);
          // Drain the bucket so the curve starts at zero, then advance the
          // clock and check that the visible tokens match `rate * elapsed`.
          expect(b.tryConsume(capacity)).toBe(true);
          now += elapsedMs;
          const expected = Math.min(capacity, (ratePerSec * elapsedMs) / 1_000);
          const actual = b.available();
          expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('available level is monotonic non-decreasing under no consumption', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: 1, max: 100 }),
        fc.array(fc.integer({ min: 0, max: 5_000 }), { minLength: 1, maxLength: 20 }),
        (capacity, ratePerSec, deltas) => {
          let now = 0;
          const b = new TokenBucket(capacity, ratePerSec, () => now);
          b.tryConsume(capacity);
          let prev = b.available();
          for (const d of deltas) {
            now += d;
            const cur = b.available();
            expect(cur).toBeGreaterThanOrEqual(prev - 1e-9);
            prev = cur;
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('caps strictly at capacity even after long idle gaps', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: 1_000, max: 10_000_000 }),
        (capacity, ratePerSec, idleMs) => {
          let now = 0;
          const b = new TokenBucket(capacity, ratePerSec, () => now);
          now += idleMs;
          expect(b.available()).toBeLessThanOrEqual(capacity);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('replays a consume sequence with the same result as the closed form', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 5, max: 100 }),
        fc.integer({ min: 1, max: 50 }),
        fc.array(fc.tuple(fc.integer({ min: 0, max: 2_000 }), fc.integer({ min: 1, max: 10 })), {
          minLength: 1,
          maxLength: 30,
        }),
        (capacity, ratePerSec, ops) => {
          let now = 0;
          const b = new TokenBucket(capacity, ratePerSec, () => now);
          let modelTokens = capacity;
          for (const [waitMs, n] of ops) {
            now += waitMs;
            modelTokens = Math.min(capacity, modelTokens + (ratePerSec * waitMs) / 1_000);
            const consumed = b.tryConsume(n);
            const modelConsumed = modelTokens >= n;
            expect(consumed).toBe(modelConsumed);
            if (consumed) modelTokens -= n;
            // Cross-check the post-state to within ±1 token.
            expect(Math.abs(b.available() - modelTokens)).toBeLessThanOrEqual(1);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

import { TokenBucket } from '../../apps/runner/src/agent/token-bucket';

describe('TokenBucket', () => {
  it('starts full', () => {
    let now = 0;
    const b = new TokenBucket(10, 5, () => now);
    expect(b.available()).toBe(10);
  });

  it('consumes tokens', () => {
    let now = 0;
    const b = new TokenBucket(5, 1, () => now);
    expect(b.tryConsume(3)).toBe(true);
    expect(b.tryConsume(3)).toBe(false);
    expect(b.tryConsume(2)).toBe(true);
  });

  it('refills at the configured rate', () => {
    let now = 0;
    const b = new TokenBucket(5, 2, () => now);
    expect(b.tryConsume(5)).toBe(true);
    expect(b.tryConsume(1)).toBe(false);
    now += 1_000;
    expect(b.tryConsume(2)).toBe(true);
  });

  it('caps at capacity', () => {
    let now = 0;
    const b = new TokenBucket(5, 1, () => now);
    now += 10_000;
    expect(b.available()).toBe(5);
  });

  it('reports delay until tokens available', () => {
    let now = 0;
    const b = new TokenBucket(2, 2, () => now);
    expect(b.tryConsume(2)).toBe(true);
    expect(b.delayFor(1)).toBe(500);
    now += 500;
    expect(b.delayFor(1)).toBe(0);
  });

  it('rejects bad config', () => {
    expect(() => new TokenBucket(0, 1)).toThrow();
    expect(() => new TokenBucket(1, 0)).toThrow();
  });
});

import {
  HdrHistogram,
  MAX_BUCKETS,
  SUB_BUCKETS,
  ToolLatencyRegistry,
  bucketIndex,
  bucketLowerBound,
  bucketMidpoint,
  bucketUpperBound,
} from '../../packages/shared/src/hdr';

describe('bucketIndex', () => {
  it('clamps non-positive to bucket 0', () => {
    expect(bucketIndex(0)).toBe(0);
    expect(bucketIndex(-5)).toBe(0);
    expect(bucketIndex(NaN)).toBe(0);
  });

  it('uses identity mapping for v < SUB_BUCKETS', () => {
    for (let v = 1; v < SUB_BUCKETS; v++) {
      expect(bucketIndex(v)).toBe(v);
    }
  });

  it('is monotonic non-decreasing across the integer range', () => {
    let prev = 0;
    for (let v = 1; v <= 1_000_000; v *= 2) {
      const idx = bucketIndex(v);
      expect(idx).toBeGreaterThanOrEqual(prev);
      prev = idx;
    }
  });

  it('reconstructed lower bound matches the input value to within bucket width', () => {
    for (const v of [16, 17, 31, 32, 100, 999, 10_000, 1_000_000, 1_000_000_000]) {
      const idx = bucketIndex(v);
      const lo = bucketLowerBound(idx);
      const hi = bucketUpperBound(idx);
      expect(lo).toBeLessThanOrEqual(v);
      expect(hi).toBeGreaterThan(v);
    }
  });

  it('relative bucket width is at most ~12.5% (2 / SUB_BUCKETS) for v >= SUB_BUCKETS', () => {
    for (const v of [16, 100, 999, 10_000, 1_000_000, 1_000_000_000]) {
      const idx = bucketIndex(v);
      const lo = bucketLowerBound(idx);
      const hi = bucketUpperBound(idx);
      const width = (hi - lo) / Math.max(lo, 1);
      expect(width).toBeLessThanOrEqual(2 / SUB_BUCKETS + 1e-9);
    }
  });
});

describe('HdrHistogram percentiles', () => {
  it('returns 0 when empty', () => {
    const h = new HdrHistogram();
    expect(h.percentile(0.5)).toBe(0);
    expect(h.count()).toBe(0);
  });

  it('reports percentiles within ~6% of the true value for a uniform distribution', () => {
    const h = new HdrHistogram();
    const N = 1000;
    const values: number[] = [];
    for (let i = 1; i <= N; i++) {
      const v = i * 100; // 100 .. 100000 microseconds, evenly spaced
      values.push(v);
      h.record(v);
    }
    const sorted = [...values].sort((a, b) => a - b);
    const trueP = (p: number): number => {
      const pos = (sorted.length - 1) * p;
      const lo = Math.floor(pos);
      return sorted[lo] ?? 0;
    };
    for (const p of [0.5, 0.9, 0.95, 0.99]) {
      const reported = h.percentile(p);
      const truth = trueP(p);
      const rel = Math.abs(reported - truth) / truth;
      // Bucket geometric width is ~6.25%, midpoint reporting halves that on
      // average; allow 8% to absorb edge effects between adjacent buckets.
      expect(rel).toBeLessThanOrEqual(0.08);
    }
  });

  it('records sum and count correctly', () => {
    const h = new HdrHistogram();
    let expected = 0;
    for (let i = 1; i <= 100; i++) {
      h.record(i);
      expected += i;
    }
    expect(h.count()).toBe(100);
    expect(h.sum()).toBe(expected);
  });

  it('reset() zeros all state', () => {
    const h = new HdrHistogram();
    for (let i = 1; i <= 50; i++) h.record(i * 10);
    expect(h.count()).toBe(50);
    h.reset();
    expect(h.count()).toBe(0);
    expect(h.sum()).toBe(0);
    expect(h.percentile(0.5)).toBe(0);
  });

  it('percentiles() returns matching values', () => {
    const h = new HdrHistogram();
    for (let i = 1; i <= 1000; i++) h.record(i);
    const batch = h.percentiles([0.5, 0.95, 0.99]);
    expect(batch[0.5]).toBeCloseTo(h.percentile(0.5), 5);
    expect(batch[0.95]).toBeCloseTo(h.percentile(0.95), 5);
    expect(batch[0.99]).toBeCloseTo(h.percentile(0.99), 5);
  });
});

describe('HdrHistogram exportPrometheus', () => {
  it('emits TYPE, _bucket, _sum, _count lines parseable by a regex', () => {
    const h = new HdrHistogram();
    for (let i = 1; i <= 100; i++) h.record(i * 10);
    const out = h.exportPrometheus('pagerunner_step_latency_us', { tool: 'click' });

    expect(out).toMatch(/^# TYPE pagerunner_step_latency_us histogram$/m);
    // every bucket line carries the tool label
    expect(out).toMatch(
      /pagerunner_step_latency_us_bucket\{le="[+a-zA-Z0-9.]+",tool="click"\} \d+/,
    );
    expect(out).toMatch(/pagerunner_step_latency_us_bucket\{le="\+Inf",tool="click"\} 100/);
    expect(out).toMatch(/pagerunner_step_latency_us_sum\{tool="click"\} \d+/);
    expect(out).toMatch(/pagerunner_step_latency_us_count\{tool="click"\} 100/);
  });

  it('emitted bucket counts are monotonic non-decreasing and end at total count', () => {
    const h = new HdrHistogram();
    for (let i = 0; i < 500; i++) h.record(50 + i);
    const out = h.exportPrometheus('lat', {});
    const re = /lat_bucket\{le="([^"]+)"\} (\d+)/g;
    let prev = 0;
    let m: RegExpExecArray | null;
    let last = 0;
    while ((m = re.exec(out)) !== null) {
      const n = Number(m[2]);
      expect(n).toBeGreaterThanOrEqual(prev);
      prev = n;
      last = n;
    }
    expect(last).toBe(500);
  });

  it('handles the empty case', () => {
    const h = new HdrHistogram();
    const out = h.exportPrometheus('lat', {});
    expect(out).toContain('lat_bucket{le="+Inf"} 0');
    expect(out).toContain('lat_count 0');
    expect(out).toContain('lat_sum 0');
  });

  it('rejects invalid metric and label names', () => {
    const h = new HdrHistogram();
    expect(() => h.exportPrometheus('bad-name', {})).toThrow(/invalid metric name/);
    expect(() => h.exportPrometheus('ok', { 'bad-label': 'x' })).toThrow(/invalid label name/);
  });
});

describe('HdrHistogram concurrency (single-process JS atomicity)', () => {
  it('does not lose counts across N async iterators', async () => {
    const h = new HdrHistogram();
    const LOOPS = 8;
    const PER = 10_000;
    const tasks: Promise<void>[] = [];
    for (let l = 0; l < LOOPS; l++) {
      tasks.push(
        (async () => {
          for (let i = 0; i < PER; i++) {
            h.record(((l * 31 + i) % 4096) + 1);
            // Yield occasionally so the runtime interleaves tasks.
            if ((i & 0x3ff) === 0) await Promise.resolve();
          }
        })(),
      );
    }
    await Promise.all(tasks);
    expect(h.count()).toBe(LOOPS * PER);
  });
});

describe('HdrHistogram bounds', () => {
  it('handles values larger than 2^32 without overflow', () => {
    const h = new HdrHistogram();
    h.record(5_000_000_000); // 5s in microseconds
    expect(h.count()).toBe(1);
    expect(h.percentile(0.5)).toBeGreaterThan(4_000_000_000);
  });

  it('bucketMidpoint is between bucket bounds', () => {
    for (const idx of [0, 10, 16, 100, 500, MAX_BUCKETS - 1]) {
      const lo = bucketLowerBound(idx);
      const hi = bucketUpperBound(idx);
      const mid = bucketMidpoint(idx);
      expect(mid).toBeGreaterThanOrEqual(lo);
      expect(mid).toBeLessThanOrEqual(hi);
    }
  });
});

describe('ToolLatencyRegistry', () => {
  it('records per-tool', () => {
    const r = new ToolLatencyRegistry(['click', 'navigate']);
    for (let i = 1; i <= 100; i++) r.record('click', i * 10);
    for (let i = 1; i <= 50; i++) r.record('navigate', i * 100);
    const snap = r.snapshot([0.5, 0.95]);
    const click = snap.find((s) => s.tool === 'click');
    const nav = snap.find((s) => s.tool === 'navigate');
    expect(click?.samples).toBe(100);
    expect(nav?.samples).toBe(50);
    expect(click?.percentilesUs[0.5]).toBeGreaterThan(0);
    expect(nav?.percentilesUs[0.95]).toBeGreaterThan(click?.percentilesUs[0.95] ?? 0);
  });

  it('lazily creates histograms for unknown tools', () => {
    const r = new ToolLatencyRegistry();
    r.record('extract', 500);
    expect(r.tools()).toEqual(['extract']);
    expect(r.get('extract')?.count()).toBe(1);
  });

  it('exportPrometheus emits one block per tool', () => {
    const r = new ToolLatencyRegistry(['click', 'wait']);
    r.record('click', 100);
    r.record('wait', 200);
    const out = r.exportPrometheus('step_latency_us');
    expect(out.match(/# TYPE step_latency_us histogram/g)?.length).toBe(2);
    expect(out).toContain('tool="click"');
    expect(out).toContain('tool="wait"');
  });
});

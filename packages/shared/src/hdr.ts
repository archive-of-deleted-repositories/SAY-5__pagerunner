/**
 * HDR-style log-bucketed latency histogram.
 *
 * Pattern: single typed array of counters indexed by:
 *
 *     bucket = floor(log2(value_us)) * SUB_BUCKETS + topBitsBelowLeading1
 *
 * with SUB_BUCKETS=16 (4 bits below the leading 1). ~6% relative error per
 * bucket, no allocation on record.
 *
 * Locking: not used. The dispatcher is single-process Node — `BigInt64Array`
 * counter increments are atomic from the JS engine's perspective. If this
 * ever runs across worker_threads, swap to `Atomics.add` on a SharedArrayBuffer
 * or move aggregation to Redis. The single-process invariant is documented at
 * the call sites.
 */

export const SUB_BUCKET_BITS = 4;
export const SUB_BUCKETS = 1 << SUB_BUCKET_BITS; // 16
export const MAX_LOG2 = 64;
export const MAX_BUCKETS = MAX_LOG2 * SUB_BUCKETS; // 1024

/**
 * Map a positive integer microsecond value to its bucket index.
 *
 * Values <= 0 map to bucket 0. Values < SUB_BUCKETS (i.e. 1..15) are stored
 * one-per-bucket starting at index `value_us`. From 16 upward we use
 * `floor(log2(v)) * SUB_BUCKETS + bottom_4_bits_below_leading_1`.
 */
export function bucketIndex(value_us: number): number {
  if (!Number.isFinite(value_us) || value_us <= 0) return 0;
  const v = Math.floor(value_us);
  if (v < SUB_BUCKETS) return v;
  // For v < 2^32 use Math.clz32; above that fall back to Math.log2.
  let log2: number;
  if (v < 0x1_0000_0000) {
    log2 = 31 - Math.clz32(v);
  } else {
    log2 = Math.floor(Math.log2(v));
  }
  if (log2 >= MAX_LOG2) log2 = MAX_LOG2 - 1;
  // Take the SUB_BUCKET_BITS bits immediately below the leading 1.
  const shift = log2 - SUB_BUCKET_BITS;
  const sub = Number((BigInt(v) >> BigInt(shift)) & BigInt(SUB_BUCKETS - 1));
  return log2 * SUB_BUCKETS + sub;
}

/** Lower bound (inclusive) of the bucket in microseconds. */
export function bucketLowerBound(idx: number): number {
  if (idx < SUB_BUCKETS) return idx;
  const log2 = Math.floor(idx / SUB_BUCKETS);
  const sub = idx % SUB_BUCKETS;
  // Reconstruct: leading 1 at position log2, sub in next SUB_BUCKET_BITS bits.
  // value_us >= (1 << log2) | (sub << (log2 - SUB_BUCKET_BITS))
  const shift = log2 - SUB_BUCKET_BITS;
  // Use BigInt for shifts >= 32.
  const base = BigInt(1) << BigInt(log2);
  const subShifted = BigInt(sub) << BigInt(shift);
  const out = base | subShifted;
  // Guard against precision loss; values above 2^53 are not meaningful for latency.
  if (out > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER;
  return Number(out);
}

/** Upper bound (exclusive) of the bucket in microseconds. */
export function bucketUpperBound(idx: number): number {
  return bucketLowerBound(idx + 1);
}

/** Geometric midpoint of the bucket — the value we report for percentiles. */
export function bucketMidpoint(idx: number): number {
  const lo = bucketLowerBound(idx);
  const hi = bucketUpperBound(idx);
  // Arithmetic mean is fine within a bucket of ~6% width.
  return (lo + hi) / 2;
}

export class HdrHistogram {
  private readonly counts: BigInt64Array = new BigInt64Array(MAX_BUCKETS);
  private totalCount = BigInt(0);
  private totalSumUs = BigInt(0);

  /** Record one sample in microseconds. Negative or NaN values map to bucket 0. */
  record(value_us: number): void {
    const idx = bucketIndex(value_us);
    this.counts[idx] = (this.counts[idx] ?? BigInt(0)) + BigInt(1);
    this.totalCount += BigInt(1);
    if (Number.isFinite(value_us) && value_us > 0) {
      this.totalSumUs += BigInt(Math.floor(value_us));
    }
  }

  /** Total number of recorded samples. */
  count(): number {
    return Number(this.totalCount);
  }

  /** Cumulative sum of recorded values in microseconds. */
  sum(): number {
    return Number(this.totalSumUs);
  }

  /**
   * Percentile in microseconds. `p` in [0, 1].
   *
   * Returns the geometric midpoint of the bucket where the running CDF first
   * reaches `ceil(total * p)`. Returns 0 if no samples.
   */
  percentile(p: number): number {
    const total = this.totalCount;
    if (total === BigInt(0)) return 0;
    const clamped = Math.max(0, Math.min(1, p));
    // Use BigInt arithmetic to avoid 2^53 overflow at high counts.
    const targetBig =
      clamped === 0
        ? BigInt(1)
        : ceilDivBigInt(total * BigInt(Math.round(clamped * 1_000_000)), BigInt(1_000_000));
    const target = targetBig === BigInt(0) ? BigInt(1) : targetBig;
    let running = BigInt(0);
    for (let i = 0; i < MAX_BUCKETS; i++) {
      const c = this.counts[i] ?? BigInt(0);
      if (c === BigInt(0)) continue;
      running += c;
      if (running >= target) return bucketMidpoint(i);
    }
    // Should not be reached — fallthrough returns the last non-empty bucket midpoint.
    for (let i = MAX_BUCKETS - 1; i >= 0; i--) {
      if ((this.counts[i] ?? BigInt(0)) > BigInt(0)) return bucketMidpoint(i);
    }
    return 0;
  }

  /** Batched percentiles. Single pass for efficiency. */
  percentiles(ps: number[]): Record<number, number> {
    const out: Record<number, number> = {};
    for (const p of ps) out[p] = this.percentile(p);
    return out;
  }

  /** Zero all counters. */
  reset(): void {
    this.counts.fill(BigInt(0));
    this.totalCount = BigInt(0);
    this.totalSumUs = BigInt(0);
  }

  /**
   * Prometheus exposition format. Emits cumulative `_bucket{le="..."}`,
   * `_sum`, `_count` lines. `le` values are bucket upper bounds in
   * microseconds; the special `+Inf` bucket is included as required.
   *
   * Only buckets with non-zero cumulative count are emitted to keep output
   * compact — empty leading buckets contribute zeroes to the CDF anyway, and
   * a Prometheus parser handles missing buckets correctly because the cumulative
   * count is monotonic. (We do emit the leading non-zero bucket and every one
   * thereafter through `+Inf`.)
   */
  exportPrometheus(name: string, labels: Record<string, string> = {}): string {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
      throw new Error(`invalid metric name: ${name}`);
    }
    const labelStr = formatLabels(labels);
    const lines: string[] = [];
    lines.push(`# TYPE ${name} histogram`);
    let cumulative = BigInt(0);
    let firstNonZero = -1;
    for (let i = 0; i < MAX_BUCKETS; i++) {
      if ((this.counts[i] ?? BigInt(0)) > BigInt(0)) {
        firstNonZero = i;
        break;
      }
    }
    if (firstNonZero === -1) {
      lines.push(`${name}_bucket${withLe(labelStr, '+Inf')} 0`);
      lines.push(`${name}_sum${labelStr} 0`);
      lines.push(`${name}_count${labelStr} 0`);
      return lines.join('\n') + '\n';
    }
    let lastEmittedIdx = -1;
    for (let i = firstNonZero; i < MAX_BUCKETS; i++) {
      const c = this.counts[i] ?? BigInt(0);
      cumulative += c;
      if (c === BigInt(0) && i !== MAX_BUCKETS - 1) continue;
      const le = bucketUpperBound(i);
      lines.push(`${name}_bucket${withLe(labelStr, leString(le))} ${cumulative.toString()}`);
      lastEmittedIdx = i;
    }
    void lastEmittedIdx;
    lines.push(`${name}_bucket${withLe(labelStr, '+Inf')} ${this.totalCount.toString()}`);
    lines.push(`${name}_sum${labelStr} ${this.totalSumUs.toString()}`);
    lines.push(`${name}_count${labelStr} ${this.totalCount.toString()}`);
    return lines.join('\n') + '\n';
  }
}

function ceilDivBigInt(a: bigint, b: bigint): bigint {
  if (a === BigInt(0)) return BigInt(0);
  return (a + b - BigInt(1)) / b;
}

function leString(le: number): string {
  if (!Number.isFinite(le)) return '+Inf';
  return String(le);
}

function formatLabels(labels: Record<string, string>): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return '';
  const parts = keys.map((k) => {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k)) {
      throw new Error(`invalid label name: ${k}`);
    }
    const v = labels[k] ?? '';
    return `${k}="${escapeLabelValue(v)}"`;
  });
  return `{${parts.join(',')}}`;
}

function withLe(existing: string, le: string): string {
  const lePair = `le="${le}"`;
  if (existing === '') return `{${lePair}}`;
  // Insert le as the first label inside the existing braces.
  return `{${lePair},${existing.slice(1, -1)}}`;
}

function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

/**
 * Per-tool latency registry. Pre-creates one HDR per tool name so
 * `record()` is allocation-free on the hot path.
 */
export class ToolLatencyRegistry {
  private readonly histograms = new Map<string, HdrHistogram>();

  constructor(tools: readonly string[] = []) {
    for (const t of tools) this.histograms.set(t, new HdrHistogram());
  }

  record(tool: string, value_us: number): void {
    let h = this.histograms.get(tool);
    if (!h) {
      h = new HdrHistogram();
      this.histograms.set(tool, h);
    }
    h.record(value_us);
  }

  get(tool: string): HdrHistogram | undefined {
    return this.histograms.get(tool);
  }

  tools(): string[] {
    return Array.from(this.histograms.keys()).sort();
  }

  reset(): void {
    for (const h of this.histograms.values()) h.reset();
  }

  /** Per-tool percentile snapshot in microseconds. */
  snapshot(percentiles: number[]): Array<{
    tool: string;
    samples: number;
    percentilesUs: Record<number, number>;
  }> {
    return this.tools().map((tool) => {
      const h = this.histograms.get(tool);
      if (!h) return { tool, samples: 0, percentilesUs: {} };
      return { tool, samples: h.count(), percentilesUs: h.percentiles(percentiles) };
    });
  }

  exportPrometheus(name: string, labels: Record<string, string> = {}): string {
    const chunks: string[] = [];
    for (const tool of this.tools()) {
      const h = this.histograms.get(tool);
      if (!h) continue;
      chunks.push(h.exportPrometheus(name, { ...labels, tool }));
    }
    return chunks.join('');
  }
}

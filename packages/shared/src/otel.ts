/**
 * OpenTelemetry helpers. The actual SDK is initialised in entrypoints
 * (control-plane main, runner main) so the shared package stays free of
 * heavy auto-instrumentation imports.
 *
 * `withSpan` is intentionally minimal: when no global tracer is set, the
 * function still runs and records timings via the returned attributes,
 * which keeps unit tests free of the OTel SDK.
 */
export type SpanAttrs = Record<string, string | number | boolean | undefined>;

export interface MinimalSpan {
  setAttributes(attrs: SpanAttrs): void;
  recordException(err: unknown): void;
  end(): void;
}

export interface MinimalTracer {
  startSpan(name: string, attrs?: SpanAttrs): MinimalSpan;
}

let activeTracer: MinimalTracer | null = null;

export const setTracer = (t: MinimalTracer | null): void => {
  activeTracer = t;
};

export const getTracer = (): MinimalTracer | null => activeTracer;

export async function withSpan<T>(
  name: string,
  attrs: SpanAttrs,
  fn: (span: MinimalSpan) => Promise<T>,
): Promise<T> {
  const span: MinimalSpan = activeTracer?.startSpan(name, attrs) ?? noopSpan(attrs);
  const start = Date.now();
  try {
    const result = await fn(span);
    span.setAttributes({ duration_ms: Date.now() - start, status: 'ok' });
    return result;
  } catch (err) {
    span.recordException(err);
    span.setAttributes({ duration_ms: Date.now() - start, status: 'error' });
    throw err;
  } finally {
    span.end();
  }
}

function noopSpan(initial: SpanAttrs): MinimalSpan {
  let attrs: SpanAttrs = { ...initial };
  return {
    setAttributes(next) {
      attrs = { ...attrs, ...next };
    },
    recordException(_err) {
      // intentionally inert in unit-test mode
    },
    end() {
      // attrs is captured but not emitted; kept for future debug hooks
      void attrs;
    },
  };
}

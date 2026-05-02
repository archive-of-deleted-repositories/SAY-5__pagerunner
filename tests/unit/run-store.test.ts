import { RunStore } from '../../apps/control-plane/src/run-store';

describe('RunStore', () => {
  it('creates and lists runs newest-first', () => {
    const s = new RunStore();
    const a = s.create({ flowId: 'flow_a', flowVersion: 1, inputs: {} });
    const b = s.create({ flowId: 'flow_a', flowVersion: 1, inputs: {} });
    const list = s.list({});
    expect(list.runs.map((r) => r.id)).toEqual([b.id, a.id]);
  });

  it('returns existing run on idempotency replay', () => {
    const s = new RunStore();
    const a = s.create({ flowId: 'flow_a', flowVersion: 1, inputs: {}, idempotencyKey: 'k1' });
    const b = s.create({ flowId: 'flow_a', flowVersion: 1, inputs: {}, idempotencyKey: 'k1' });
    expect(b.id).toBe(a.id);
  });

  it('paginates with cursor', () => {
    const s = new RunStore();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(s.create({ flowId: 'f', flowVersion: 1, inputs: {} }).id);
    }
    const page1 = s.list({ limit: 2 });
    expect(page1.runs).toHaveLength(2);
    expect(page1.nextCursor).toBeDefined();
    const page2 = s.list({ limit: 2, cursor: page1.nextCursor! });
    expect(page2.runs).toHaveLength(2);
    expect(page2.runs[0]!.id).not.toBe(page1.runs[1]!.id);
  });

  it('cancels queued and running runs only', () => {
    const s = new RunStore();
    const r = s.create({ flowId: 'f', flowVersion: 1, inputs: {} });
    expect(s.cancel(r.id)).toBe(true);
    expect(s.cancel(r.id)).toBe(false); // already cancelled
  });

  it('appends and reads steps', () => {
    const s = new RunStore();
    const r = s.create({ flowId: 'f', flowVersion: 1, inputs: {} });
    s.appendStep({
      runId: r.id,
      idx: 0,
      tool: 'navigate',
      input: { url: 'http://x' },
      status: 'succeeded',
      retryCount: 0,
    });
    expect(s.getSteps(r.id)).toHaveLength(1);
  });
});

import fc from 'fast-check';
import { MemoryRunStore } from '@pagerunner/db';

/**
 * Idempotency contract: for a given (tenant_id, idempotency_key) pair, the
 * second `create` call must return the exact same run row as the first one,
 * not a freshly minted row. This holds for arbitrary key shapes, repeated
 * collisions, and interleaved tenants.
 */

describe('RunStore idempotency-key collision (property-based)', () => {
  it('returns the existing run row on a duplicate (tenant, key) pair', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 64 }),
        fc.string({ minLength: 1, maxLength: 32 }),
        (key, tenantId) => {
          const store = new MemoryRunStore();
          const a = store.create({
            flowId: 'flow_1',
            flowVersion: 1,
            inputs: {},
            tenantId,
            idempotencyKey: key,
          });
          const b = store.create({
            flowId: 'flow_1',
            flowVersion: 1,
            inputs: { changed: true },
            tenantId,
            idempotencyKey: key,
          });
          expect(b.id).toBe(a.id);
          expect(b.idempotencyKey).toBe(key);
          // Inputs are not overwritten on collision; first-write wins.
          expect(b.inputs).toEqual(a.inputs);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('separate tenants with the same key produce distinct runs', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 32 }),
        fc.string({ minLength: 1, maxLength: 16 }),
        fc.string({ minLength: 1, maxLength: 16 }),
        (key, tenantA, tenantB) => {
          fc.pre(tenantA !== tenantB);
          const store = new MemoryRunStore();
          const a = store.create({
            flowId: 'flow_1',
            flowVersion: 1,
            inputs: {},
            tenantId: tenantA,
            idempotencyKey: key,
          });
          const b = store.create({
            flowId: 'flow_1',
            flowVersion: 1,
            inputs: {},
            tenantId: tenantB,
            idempotencyKey: key,
          });
          expect(b.id).not.toBe(a.id);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('repeated collisions on the same key always return the same id', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 32 }),
        fc.integer({ min: 2, max: 20 }),
        (key, repeats) => {
          const store = new MemoryRunStore();
          const first = store.create({
            flowId: 'flow_1',
            flowVersion: 1,
            inputs: {},
            tenantId: 'public',
            idempotencyKey: key,
          });
          for (let i = 0; i < repeats; i++) {
            const r = store.create({
              flowId: 'flow_1',
              flowVersion: 1,
              inputs: { i },
              tenantId: 'public',
              idempotencyKey: key,
            });
            expect(r.id).toBe(first.id);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('omitted idempotency key always produces a fresh run', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 10 }), (n) => {
        const store = new MemoryRunStore();
        const ids = new Set<string>();
        for (let i = 0; i < n; i++) {
          const r = store.create({
            flowId: 'flow_1',
            flowVersion: 1,
            inputs: {},
            tenantId: 'public',
          });
          ids.add(r.id);
        }
        expect(ids.size).toBe(n);
      }),
      { numRuns: 50 },
    );
  });
});

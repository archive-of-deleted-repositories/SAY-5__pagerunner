import fc from 'fast-check';
import { validateDag } from '../../apps/control-plane/src/dag-validator';
import { FlowValidationError } from '@pagerunner/shared';

/**
 * Property tests for the DAG validator. The unit tests pin down hand-picked
 * cases; these explore the random-input space so cycles, unreachable nodes,
 * and duplicate ids are detected in DAGs we never saw.
 *
 * Each generator produces a DAG with `count` nodes labelled `n0..n{count-1}`.
 * The base shape is a linear chain that ends at a `finish` node so the happy
 * path is well-formed; mutators then inject the failure mode under test.
 */

interface DagNode {
  id: string;
  tool: string;
  next?: string;
  branches?: Record<string, string>;
}
interface Dag {
  nodes: DagNode[];
}

const idFor = (i: number): string => `n${i}`;

const linearChain = (count: number): Dag => {
  const nodes: DagNode[] = [];
  for (let i = 0; i < count - 1; i++) {
    nodes.push({ id: idFor(i), tool: 'navigate', next: idFor(i + 1) });
  }
  nodes.push({ id: idFor(count - 1), tool: 'finish' });
  return { nodes };
};

const countArb = fc.integer({ min: 1, max: 50 });

describe('validateDag (property-based)', () => {
  it('accepts every linear chain that terminates at finish', () => {
    fc.assert(
      fc.property(countArb, (count) => {
        expect(() => validateDag(linearChain(count))).not.toThrow();
      }),
      { numRuns: 200 },
    );
  });

  it('detects cycles inserted at any position', () => {
    fc.assert(
      fc.property(
        fc
          .integer({ min: 2, max: 50 })
          .chain((count) =>
            fc.tuple(
              fc.constant(count),
              fc.integer({ min: 0, max: count - 2 }),
              fc.integer({ min: 0, max: count - 2 }),
            ),
          ),
        ([count, fromIdx, backIdx]) => {
          const dag = linearChain(count);
          // Re-point node `fromIdx` so its next loops back to `backIdx <= fromIdx`,
          // guaranteeing a cycle inside the chain.
          const target = Math.min(fromIdx, backIdx);
          const node = dag.nodes[fromIdx];
          if (!node) return;
          node.next = idFor(target);
          // The cycle severs reachability of the finish node, so either
          // "cycle" OR "unreachable"/"finish" is a valid rejection — the
          // cycle is what we care about, but DFS may surface the reach
          // problem first. Both indicate the validator caught it.
          expect(() => validateDag(dag)).toThrow(FlowValidationError);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('flags unreachable nodes added off the main chain', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 40 }),
        fc.integer({ min: 1, max: 5 }),
        (chainLen, orphans) => {
          const dag = linearChain(chainLen);
          for (let k = 0; k < orphans; k++) {
            dag.nodes.push({ id: `orphan_${k}`, tool: 'navigate' });
          }
          expect(() => validateDag(dag)).toThrow(/unreachable|finish/);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('rejects duplicate node ids regardless of position', () => {
    fc.assert(
      fc.property(
        fc
          .integer({ min: 2, max: 30 })
          .chain((count) => fc.tuple(fc.constant(count), fc.integer({ min: 0, max: count - 1 }))),
        ([count, dupIdx]) => {
          const dag = linearChain(count);
          // Append a duplicate of node `dupIdx` to the end. The chain still
          // points to its original successors so the validator has a
          // duplicate to find before any other shape check fires.
          const original = dag.nodes[dupIdx];
          if (!original) return;
          dag.nodes.push({ id: original.id, tool: 'navigate' });
          expect(() => validateDag(dag)).toThrow(/duplicate/);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('detects unknown next pointers anywhere in the graph', () => {
    fc.assert(
      fc.property(
        fc
          .integer({ min: 2, max: 30 })
          .chain((count) => fc.tuple(fc.constant(count), fc.integer({ min: 0, max: count - 1 }))),
        ([count, brokenIdx]) => {
          const dag = linearChain(count);
          const node = dag.nodes[brokenIdx];
          if (!node) return;
          node.next = 'definitely_not_a_real_id';
          expect(() => validateDag(dag)).toThrow(/unknown|finish|unreachable/);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('accepts DAGs with branch tables when every branch lands on a real node', () => {
    fc.assert(
      fc.property(fc.integer({ min: 3, max: 20 }), (count) => {
        // Build: n0 -[branches]-> { hot: n1, cold: n_count-1 (finish) }; n1 -> ... -> n_count-1
        const nodes: DagNode[] = [];
        nodes.push({
          id: idFor(0),
          tool: 'extract',
          branches: { hot: idFor(1), cold: idFor(count - 1) },
        });
        for (let i = 1; i < count - 1; i++) {
          nodes.push({ id: idFor(i), tool: 'navigate', next: idFor(i + 1) });
        }
        nodes.push({ id: idFor(count - 1), tool: 'finish' });
        expect(() => validateDag({ nodes })).not.toThrow();
      }),
      { numRuns: 100 },
    );
  });
});

import { validateDag } from '../../apps/control-plane/src/dag-validator';

describe('validateDag', () => {
  const happy = {
    nodes: [
      { id: 'a', tool: 'navigate', next: 'b' },
      { id: 'b', tool: 'click', next: 'c' },
      { id: 'c', tool: 'finish' },
    ],
  };

  it('accepts a valid linear DAG', () => {
    expect(() => validateDag(happy)).not.toThrow();
  });

  it('rejects empty DAG', () => {
    expect(() => validateDag({ nodes: [] })).toThrow(/at least one/);
  });

  it('rejects duplicate node ids', () => {
    expect(() =>
      validateDag({
        nodes: [
          { id: 'a', tool: 'navigate', next: 'a' },
          { id: 'a', tool: 'finish' },
        ],
      }),
    ).toThrow(/duplicate/);
  });

  it('rejects unknown next pointer', () => {
    expect(() =>
      validateDag({
        nodes: [
          { id: 'a', tool: 'navigate', next: 'missing' },
          { id: 'b', tool: 'finish' },
        ],
      }),
    ).toThrow(/unknown next/);
  });

  it('rejects cycles', () => {
    expect(() =>
      validateDag({
        nodes: [
          { id: 'a', tool: 'navigate', next: 'b' },
          { id: 'b', tool: 'click', next: 'a' },
          { id: 'c', tool: 'finish' },
        ],
      }),
    ).toThrow(/cycle/);
  });

  it('rejects unreachable nodes', () => {
    expect(() =>
      validateDag({
        nodes: [
          { id: 'a', tool: 'navigate', next: 'b' },
          { id: 'b', tool: 'finish' },
          { id: 'orphan', tool: 'click' },
        ],
      }),
    ).toThrow(/unreachable/);
  });

  it('requires reachable finish', () => {
    expect(() =>
      validateDag({
        nodes: [{ id: 'a', tool: 'navigate' }],
      }),
    ).toThrow(/finish/);
  });

  it('accepts branches', () => {
    const dag = {
      nodes: [
        { id: 'a', tool: 'extract', branches: { hot: 'b', cold: 'c' } },
        { id: 'b', tool: 'finish' },
        { id: 'c', tool: 'finish' },
      ],
    };
    expect(() => validateDag(dag)).not.toThrow();
  });
});

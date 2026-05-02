import { TOOLS, validateToolCall, toolJsonSchemas } from '../../packages/agent-tools/src';

describe('agent-tools', () => {
  it('exports a schema per tool name', () => {
    const names = ['navigate', 'click', 'type', 'extract', 'wait', 'finish'];
    for (const n of names) {
      expect((TOOLS as Record<string, unknown>)[n]).toBeDefined();
    }
  });

  it('validateToolCall enforces shape', () => {
    expect(() =>
      validateToolCall({ tool: 'navigate', input: { url: 'http://x.test/' } }),
    ).not.toThrow();
    expect(() => validateToolCall({ tool: 'navigate', input: { url: 'not-a-url' } })).toThrow();
    expect(() => validateToolCall({ tool: 'click', input: {} })).toThrow();
  });

  it('emits json schema per tool', () => {
    const schemas = toolJsonSchemas();
    expect(Object.keys(schemas).sort()).toEqual(
      ['click', 'extract', 'finish', 'navigate', 'type', 'wait'].sort(),
    );
  });
});

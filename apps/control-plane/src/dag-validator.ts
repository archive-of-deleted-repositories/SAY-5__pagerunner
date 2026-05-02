import { FlowValidationError } from '@pagerunner/shared';

export interface Dag {
  nodes: Array<{ id: string; tool: string; next?: string; branches?: Record<string, string> }>;
}

export function validateDag(dag: Dag): void {
  if (!dag?.nodes || dag.nodes.length === 0) {
    throw new FlowValidationError('dag must have at least one node');
  }

  const ids = new Set<string>();
  for (const n of dag.nodes) {
    if (ids.has(n.id)) throw new FlowValidationError(`duplicate node id: ${n.id}`);
    ids.add(n.id);
  }

  for (const n of dag.nodes) {
    if (n.next && !ids.has(n.next)) {
      throw new FlowValidationError(`node ${n.id} references unknown next: ${n.next}`);
    }
    if (n.branches) {
      for (const [k, v] of Object.entries(n.branches)) {
        if (!ids.has(v)) {
          throw new FlowValidationError(`node ${n.id} branch ${k} references unknown: ${v}`);
        }
      }
    }
  }

  // Cycle detection via DFS three-colour marking.
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const colour = new Map<string, number>();
  const byId = new Map(dag.nodes.map((n) => [n.id, n]));
  for (const n of dag.nodes) colour.set(n.id, WHITE);

  const visit = (id: string): void => {
    colour.set(id, GREY);
    const node = byId.get(id)!;
    const neighbours: string[] = [];
    if (node.next) neighbours.push(node.next);
    if (node.branches) neighbours.push(...Object.values(node.branches));
    for (const nb of neighbours) {
      const c = colour.get(nb);
      if (c === GREY) throw new FlowValidationError(`cycle detected through ${id} -> ${nb}`);
      if (c === WHITE) visit(nb);
    }
    colour.set(id, BLACK);
  };

  for (const n of dag.nodes) {
    if (colour.get(n.id) === WHITE) visit(n.id);
  }

  // Reachability: at least one terminal `finish` reachable from first node.
  const start = dag.nodes[0]!;
  const reachable = new Set<string>();
  const stack = [start.id];
  while (stack.length) {
    const cur = stack.pop()!;
    if (reachable.has(cur)) continue;
    reachable.add(cur);
    const node = byId.get(cur)!;
    if (node.next) stack.push(node.next);
    if (node.branches) stack.push(...Object.values(node.branches));
  }
  const hasFinish = dag.nodes.some((n) => n.tool === 'finish' && reachable.has(n.id));
  if (!hasFinish) throw new FlowValidationError('no reachable finish node');

  for (const n of dag.nodes) {
    if (!reachable.has(n.id)) throw new FlowValidationError(`unreachable node: ${n.id}`);
  }
}

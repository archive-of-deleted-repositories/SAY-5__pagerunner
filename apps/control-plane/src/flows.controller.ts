import { Body, Controller, Get, NotFoundException, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { FlowStore } from './flow-store.js';

const CreateFlowBody = z.object({
  name: z.string().min(1).max(120),
  dag: z.object({
    nodes: z.array(
      z.object({
        id: z.string().min(1),
        tool: z.enum(['navigate', 'click', 'type', 'extract', 'wait', 'finish']),
        next: z.string().optional(),
        branches: z.record(z.string()).optional(),
      }),
    ),
  }),
});

@Controller('flows')
export class FlowsController {
  constructor(private readonly store: FlowStore) {}

  @Post()
  create(@Body() body: unknown): unknown {
    const parsed = CreateFlowBody.parse(body);
    const dag = {
      nodes: parsed.dag.nodes.map((n) => {
        const node: { id: string; tool: string; next?: string; branches?: Record<string, string> } =
          {
            id: n.id,
            tool: n.tool,
          };
        if (n.next !== undefined) node.next = n.next;
        if (n.branches !== undefined) node.branches = n.branches;
        return node;
      }),
    };
    return this.store.create({ name: parsed.name, dag });
  }

  @Get(':id')
  get(@Param('id') id: string): unknown {
    const flow = this.store.get(id);
    if (!flow) throw new NotFoundException(`flow ${id} not found`);
    return flow;
  }
}

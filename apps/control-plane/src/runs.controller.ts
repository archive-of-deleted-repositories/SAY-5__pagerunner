import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { FlowStore } from './flow-store.js';
import { RunStore, type RunStatus } from './run-store.js';
import { EventBus } from './event-bus.js';

const CreateRunBody = z.object({
  flowId: z.string().min(1),
  inputs: z.record(z.unknown()).default({}),
});

const ListRunsQuery = z.object({
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'dlq', 'cancelled']).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

@Controller('runs')
export class RunsController {
  constructor(
    private readonly flowStore: FlowStore,
    private readonly runStore: RunStore,
    private readonly bus: EventBus,
  ) {}

  @Post()
  create(@Body() body: unknown, @Headers('idempotency-key') idemHeader?: string): unknown {
    const parsed = CreateRunBody.parse(body);
    const flow = this.flowStore.get(parsed.flowId);
    if (!flow) throw new NotFoundException(`flow ${parsed.flowId} not found`);
    const opts: {
      flowId: string;
      flowVersion: number;
      inputs: Record<string, unknown>;
      idempotencyKey?: string;
    } = {
      flowId: parsed.flowId,
      flowVersion: flow.version,
      inputs: parsed.inputs,
    };
    if (idemHeader) opts.idempotencyKey = idemHeader;
    return this.runStore.create(opts);
  }

  @Get()
  list(@Query() query: Record<string, string>): unknown {
    const parsed = ListRunsQuery.parse(query);
    const opts: { status?: RunStatus; cursor?: string; limit?: number } = {};
    if (parsed.status) opts.status = parsed.status;
    if (parsed.cursor) opts.cursor = parsed.cursor;
    if (parsed.limit) opts.limit = parsed.limit;
    return this.runStore.list(opts);
  }

  @Get(':id')
  get(@Param('id') id: string): unknown {
    const run = this.runStore.get(id);
    if (!run) throw new NotFoundException(`run ${id} not found`);
    return { ...run, steps: this.runStore.getSteps(id) };
  }

  @Post(':id/cancel')
  cancel(@Param('id') id: string): { ok: true } {
    const ok = this.runStore.cancel(id);
    if (!ok) throw new BadRequestException(`run ${id} not cancellable`);
    return { ok: true };
  }

  @Get(':id/events')
  events(
    @Param('id') id: string,
    @Headers('last-event-id') lastEventId: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): void {
    const run = this.runStore.get(id);
    if (!run) throw new NotFoundException(`run ${id} not found`);

    res.setHeader('content-type', 'text/event-stream');
    res.setHeader('cache-control', 'no-cache');
    res.setHeader('connection', 'keep-alive');
    res.flushHeaders?.();

    const send = (evt: { id: string; type: string; data: unknown }): void => {
      res.write(`id: ${evt.id}\n`);
      res.write(`event: ${evt.type}\n`);
      res.write(`data: ${JSON.stringify(evt.data)}\n\n`);
    };

    for (const evt of this.bus.buffered(id, lastEventId)) send(evt);

    const unsubscribe = this.bus.subscribe(id, send);
    req.on('close', () => {
      unsubscribe();
      res.end();
    });
  }
}

import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'node:events';

export interface RunEvent {
  id: string;
  type: 'step.started' | 'step.succeeded' | 'step.failed' | 'run.completed' | 'run.failed';
  data: Record<string, unknown>;
}

/**
 * Event bus with a per-run ring buffer so SSE consumers can resume after a
 * disconnect via the `Last-Event-ID` header. In production this would back
 * onto Redis pub/sub plus a TTL'd Postgres journal; the in-memory buffer
 * captures the resume contract for tests.
 */
@Injectable()
export class EventBus {
  private readonly emitter = new EventEmitter();
  private readonly buffers = new Map<string, RunEvent[]>();
  private readonly maxPerRun = 256;

  publish(runId: string, evt: RunEvent): void {
    const buf = this.buffers.get(runId) ?? [];
    buf.push(evt);
    if (buf.length > this.maxPerRun) buf.shift();
    this.buffers.set(runId, buf);
    this.emitter.emit(runId, evt);
  }

  buffered(runId: string, after?: string): RunEvent[] {
    const buf = this.buffers.get(runId) ?? [];
    if (!after) return [...buf];
    const idx = buf.findIndex((e) => e.id === after);
    return idx >= 0 ? buf.slice(idx + 1) : [...buf];
  }

  subscribe(runId: string, handler: (evt: RunEvent) => void): () => void {
    this.emitter.on(runId, handler);
    return () => this.emitter.off(runId, handler);
  }
}

import { Test } from '@nestjs/testing';
import { RunsController } from './runs.controller';
import { FlowStore } from './flow-store';
import { RunStore } from './run-store';
import { EventBus } from './event-bus';
import { CancelPublisher } from './cancel-publisher';

/**
 * Unit-level coverage for the cancel endpoint's status-machine and
 * pub/sub fan-out. The CancelPublisher is stubbed so we can assert what
 * gets published without standing up Redis. The two-pod end-to-end
 * coverage lives in `apps/runner/src/agent/dispatch.distributed-cancel.test.ts`.
 */

class StubCancelPublisher {
  public publishes: Array<{ runId: string; reason: string }> = [];
  async publish(runId: string, reason: string): Promise<number> {
    this.publishes.push({ runId, reason });
    return 1;
  }
  async dispose(): Promise<void> {
    // no-op
  }
}

describe('RunsController.cancel', () => {
  let controller: RunsController;
  let flowStore: FlowStore;
  let runStore: RunStore;
  let publisher: StubCancelPublisher;

  beforeEach(async () => {
    publisher = new StubCancelPublisher();
    const moduleRef = await Test.createTestingModule({
      controllers: [RunsController],
      providers: [FlowStore, RunStore, EventBus, { provide: CancelPublisher, useValue: publisher }],
    }).compile();
    controller = moduleRef.get(RunsController);
    flowStore = moduleRef.get(FlowStore);
    runStore = moduleRef.get(RunStore);
  });

  const seedRun = (status: 'queued' | 'running' | 'cancelling' | 'succeeded'): string => {
    const flow = flowStore.create({
      name: 'demo',
      dag: { nodes: [{ id: 'f', tool: 'finish' }] },
    });
    const run = runStore.create({ flowId: flow.id, flowVersion: flow.version, inputs: {} });
    runStore.setStatus(run.id, status);
    return run.id;
  };

  it('cancels a queued run inline without publishing', async () => {
    const id = seedRun('queued');
    const result = await controller.cancel(id);
    expect(result).toEqual({ ok: true, recipients: 0 });
    expect(runStore.get(id)?.status).toBe('cancelled');
    expect(publisher.publishes).toHaveLength(0);
  });

  it('publishes for a running run and marks status as cancelling', async () => {
    const id = seedRun('running');
    const result = await controller.cancel(id);
    expect(result.ok).toBe(true);
    expect(result.recipients).toBeGreaterThanOrEqual(1);
    expect(runStore.get(id)?.status).toBe('cancelling');
    expect(publisher.publishes).toEqual([{ runId: id, reason: 'user-requested' }]);
  });

  it('re-publishes idempotently when the run is already cancelling', async () => {
    const id = seedRun('cancelling');
    const result = await controller.cancel(id);
    expect(result.ok).toBe(true);
    expect(runStore.get(id)?.status).toBe('cancelling');
    expect(publisher.publishes).toHaveLength(1);
  });

  it('rejects cancelling a terminal run', async () => {
    const id = seedRun('succeeded');
    await expect(controller.cancel(id)).rejects.toThrow(/not cancellable/);
    expect(publisher.publishes).toHaveLength(0);
  });

  it('returns 404 for an unknown run id', async () => {
    await expect(controller.cancel('run_does_not_exist')).rejects.toThrow(/not found/);
  });
});

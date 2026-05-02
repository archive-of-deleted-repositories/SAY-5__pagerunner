import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { AddressInfo } from 'node:net';
import { PageRunnerClient } from '../../packages/sdk/src';
import { AppModule } from '../../apps/control-plane/src/app.module';

describe('SDK round-trip against control-plane', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    await app.listen(0);
    const server = app.getHttpServer();
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  it('creates a flow then a run and reads it back', async () => {
    const client = new PageRunnerClient({ baseUrl });
    const flow = await client.createFlow({
      name: 'roundtrip',
      dag: {
        nodes: [
          { id: 'n', tool: 'navigate', next: 'f' },
          { id: 'f', tool: 'finish' },
        ],
      },
    });
    expect(flow.id).toMatch(/^flow_/);
    expect(flow.version).toBe(1);

    const run = await client.createRun({ flowId: flow.id, idempotencyKey: 'idem-1' });
    expect(run.id).toMatch(/^run_/);

    const replay = await client.createRun({ flowId: flow.id, idempotencyKey: 'idem-1' });
    expect(replay.id).toBe(run.id);

    const detail = await client.getRun(run.id);
    expect(detail.id).toBe(run.id);
    expect(detail.steps).toEqual([]);
  });

  it('rejects flows missing a finish node', async () => {
    const client = new PageRunnerClient({ baseUrl });
    await expect(
      client.createFlow({
        name: 'bad',
        dag: { nodes: [{ id: 'n', tool: 'navigate' }] },
      }),
    ).rejects.toThrow(/HTTP/);
  });
});

import { EventBus } from '../../apps/control-plane/src/event-bus';

describe('EventBus', () => {
  it('buffers events and resumes via Last-Event-ID', () => {
    const bus = new EventBus();
    bus.publish('r1', { id: '1', type: 'step.started', data: { idx: 0 } });
    bus.publish('r1', { id: '2', type: 'step.succeeded', data: { idx: 0 } });
    bus.publish('r1', { id: '3', type: 'step.started', data: { idx: 1 } });

    const all = bus.buffered('r1');
    expect(all).toHaveLength(3);

    const resumed = bus.buffered('r1', '1');
    expect(resumed.map((e) => e.id)).toEqual(['2', '3']);
  });

  it('delivers live events to subscribers', () => {
    const bus = new EventBus();
    const seen: string[] = [];
    const off = bus.subscribe('r2', (e) => seen.push(e.id));
    bus.publish('r2', { id: '1', type: 'run.completed', data: {} });
    off();
    bus.publish('r2', { id: '2', type: 'run.completed', data: {} });
    expect(seen).toEqual(['1']);
  });
});

import { Module } from '@nestjs/common';
import { FlowsController } from './flows.controller.js';
import { RunsController } from './runs.controller.js';
import { ArtifactsController } from './artifacts.controller.js';
import { HealthController } from './health.controller.js';
import { FlowStore } from './flow-store.js';
import { RunStore } from './run-store.js';
import { EventBus } from './event-bus.js';

@Module({
  controllers: [HealthController, FlowsController, RunsController, ArtifactsController],
  providers: [FlowStore, RunStore, EventBus],
})
export class AppModule {}

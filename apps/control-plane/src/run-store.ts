import { Injectable } from '@nestjs/common';
import { MemoryRunStore } from '@pagerunner/db';

/**
 * NestJS-injectable adapter around the package-level MemoryRunStore. The
 * control-plane keeps the same surface it had in Sprint 0; production
 * deployments swap this for a PgRunStore via a different module import.
 */
export type {
  RunStatus,
  StoredRun,
  StoredStep,
  CreateRunInput,
  ListRunsOpts,
  ListRunsResult,
  RunStoreLike,
} from '@pagerunner/db';

@Injectable()
export class RunStore extends MemoryRunStore {}

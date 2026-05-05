/* eslint-disable no-console */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

/**
 * Regenerates the golden_v1 fake-provider artifact under eval/runs/<timestamp>.json
 * so the committed baseline (eval/baselines/golden_v1_fake.json) is never
 * overwritten by accident. To refresh the baseline, copy the latest run over
 * it explicitly.
 */
function main(): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out = join('eval/runs', `${stamp}.json`);
  const args = [
    'tsx',
    'eval/cli.ts',
    'run',
    '--suite',
    'golden_v1',
    '--provider',
    'fake',
    '--output',
    out,
  ];
  const r = spawnSync('pnpm', ['exec', ...args], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

main();

/* eslint-disable no-console */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { verifyTrace, formatMarkdownReport, type RunTrace } from './replay.js';

/**
 * Replays every committed golden trace and asserts determinism_score == 1.0
 * across the suite. Used by the `replay-determinism-smoke` CI job.
 */

const REPLAYS_DIR = join(process.cwd(), 'eval/replays');

async function main(): Promise<void> {
  const files = readdirSync(REPLAYS_DIR)
    .filter((f) => f.endsWith('.trace.json'))
    .sort();
  if (files.length === 0) {
    console.error(`no traces found under ${REPLAYS_DIR}`);
    process.exit(2);
  }

  let failed = 0;
  for (const file of files) {
    const trace = JSON.parse(readFileSync(join(REPLAYS_DIR, file), 'utf8')) as RunTrace;
    const report = await verifyTrace(trace);
    const status = report.replaysMatch ? 'OK' : 'DRIFT';
    console.info(
      `[${status}] ${file} flow=${report.flowId} score=${report.determinismScore.toFixed(4)} drifts=${report.driftCount}`,
    );
    if (!report.replaysMatch) {
      failed += 1;
      process.stderr.write(formatMarkdownReport(report));
    }
  }

  if (failed > 0) {
    console.error(`replay smoke failed: ${failed}/${files.length} traces drifted`);
    process.exit(1);
  }
  console.info(`replay smoke passed: ${files.length}/${files.length} traces deterministic`);
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(msg);
  process.exit(1);
});

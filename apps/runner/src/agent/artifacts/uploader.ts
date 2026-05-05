/**
 * Stub interface — the production implementation is wired in Task 1.5.
 * Defining the interface here lets the dispatcher reference it without
 * forcing the S3 client into the dispatcher tests.
 */
export interface ArtifactUploader {
  upload(
    tenantId: string,
    runId: string,
    stepIdx: number,
    kind: 'dom' | 'screenshot' | 'console' | 'trace',
    data: Buffer,
  ): Promise<string>;
}

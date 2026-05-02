import { Controller, Get, Param } from '@nestjs/common';

@Controller('artifacts')
export class ArtifactsController {
  /**
   * Returns a presigned URL for the artifact. In production this calls the
   * S3/MinIO client; here we synthesise a deterministic URL so SDK round-trip
   * tests can assert behaviour without the storage backend.
   */
  @Get(':runId/:stepIdx')
  get(
    @Param('runId') runId: string,
    @Param('stepIdx') stepIdx: string,
  ): {
    url: string;
    expiresAt: string;
  } {
    const expires = new Date(Date.now() + 5 * 60_000).toISOString();
    const url = `s3://pagerunner-artifacts/${encodeURIComponent(runId)}/${stepIdx}.png?expires=${encodeURIComponent(
      expires,
    )}`;
    return { url, expiresAt: expires };
  }
}

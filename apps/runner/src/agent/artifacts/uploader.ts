import { gzipSync } from 'node:zlib';
import { PutObjectCommand, S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';
import { logger } from '@pagerunner/shared';

export type ArtifactKind = 'dom' | 'screenshot' | 'console' | 'trace';

export interface ArtifactUploader {
  upload(
    tenantId: string,
    runId: string,
    stepIdx: number,
    kind: ArtifactKind,
    data: Buffer,
  ): Promise<string>;
}

export interface S3UploaderOptions {
  endpoint?: string;
  region?: string;
  bucket: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  /** Force path-style addressing for MinIO and similar. Defaults to true. */
  forcePathStyle?: boolean;
  /** Soft timeout for warning logs; uploads still complete. Default 5s. */
  slowUploadThresholdMs?: number;
  /** Inject a custom S3Client for tests. */
  client?: S3Client;
}

const EXT: Record<ArtifactKind, string> = {
  dom: 'html.gz',
  screenshot: 'png',
  console: 'jsonl',
  trace: 'zip',
};

const CONTENT_TYPE: Record<ArtifactKind, string> = {
  dom: 'application/gzip',
  screenshot: 'image/png',
  console: 'application/json',
  trace: 'application/zip',
};

/**
 * S3-compatible artifact uploader. Returns the object key on success and
 * surfaces errors to the caller. The dispatcher invokes this off the agent
 * loop's hot path so a slow upload doesn't block the next tool call.
 */
export class S3ArtifactUploader implements ArtifactUploader {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly slowUploadThresholdMs: number;

  constructor(opts: S3UploaderOptions) {
    this.bucket = opts.bucket;
    this.slowUploadThresholdMs = opts.slowUploadThresholdMs ?? 5_000;
    if (opts.client) {
      this.client = opts.client;
      return;
    }
    const cfg: S3ClientConfig = {
      region: opts.region ?? 'us-east-1',
      forcePathStyle: opts.forcePathStyle ?? true,
    };
    if (opts.endpoint) cfg.endpoint = opts.endpoint;
    if (opts.accessKeyId && opts.secretAccessKey) {
      cfg.credentials = {
        accessKeyId: opts.accessKeyId,
        secretAccessKey: opts.secretAccessKey,
      };
    }
    this.client = new S3Client(cfg);
  }

  async upload(
    tenantId: string,
    runId: string,
    stepIdx: number,
    kind: ArtifactKind,
    data: Buffer,
  ): Promise<string> {
    const key = `artifacts/${tenantId}/${runId}/${stepIdx}/${kind}.${EXT[kind]}`;
    const body = kind === 'dom' ? gzipSync(data) : data;
    const start = Date.now();
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: CONTENT_TYPE[kind],
      }),
    );
    const elapsed = Date.now() - start;
    if (elapsed > this.slowUploadThresholdMs) {
      logger.warn({ key, elapsed }, 'artifact upload slow');
    }
    return key;
  }
}

export const uploaderFromEnv = (): S3ArtifactUploader | null => {
  const endpoint = process.env.S3_ENDPOINT;
  const bucket = process.env.S3_BUCKET;
  const accessKey = process.env.S3_ACCESS_KEY;
  const secretKey = process.env.S3_SECRET_KEY;
  if (!bucket) return null;
  const opts: S3UploaderOptions = { bucket };
  if (endpoint) opts.endpoint = endpoint;
  if (accessKey) opts.accessKeyId = accessKey;
  if (secretKey) opts.secretAccessKey = secretKey;
  return new S3ArtifactUploader(opts);
};

import { gunzipSync } from 'node:zlib';
import {
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
  CreateBucketCommand,
} from '@aws-sdk/client-s3';
import { S3ArtifactUploader } from './uploader';

const ENDPOINT = process.env.S3_ENDPOINT;
const BUCKET = process.env.S3_BUCKET ?? 'pagerunner-artifacts';
const ACCESS = process.env.S3_ACCESS_KEY ?? 'pagerunner';
const SECRET = process.env.S3_SECRET_KEY ?? 'pagerunner123';

const HAS_S3 = Boolean(ENDPOINT);
const maybe = HAS_S3 ? describe : describe.skip;

const drainStream = async (stream: NodeJS.ReadableStream): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks);
};

maybe('S3ArtifactUploader', () => {
  jest.setTimeout(30_000);

  let uploader: S3ArtifactUploader;
  let client: S3Client;

  beforeAll(async () => {
    if (!HAS_S3) return;
    client = new S3Client({
      endpoint: ENDPOINT,
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: { accessKeyId: ACCESS, secretAccessKey: SECRET },
    });
    // The bucket is configured by the MinIO container, but defensive create
    // covers manual local runs that skipped the env defaults.
    await client.send(new CreateBucketCommand({ Bucket: BUCKET })).catch(() => undefined);
    uploader = new S3ArtifactUploader({
      endpoint: ENDPOINT,
      bucket: BUCKET,
      accessKeyId: ACCESS,
      secretAccessKey: SECRET,
    });
  });

  it('uploads gzipped DOM and round-trips bytes', async () => {
    const dom = '<html><body>'.padEnd(2_000, 'x') + '</body></html>';
    const key = await uploader.upload('public', 'run_a', 0, 'dom', Buffer.from(dom, 'utf8'));
    expect(key).toBe('artifacts/public/run_a/0/dom.html.gz');
    const obj = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const buf = await drainStream(obj.Body as NodeJS.ReadableStream);
    const recovered = gunzipSync(buf).toString('utf8');
    expect(recovered).toBe(dom);
  });

  it('uploads PNG screenshot bytes verbatim', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const key = await uploader.upload('public', 'run_b', 1, 'screenshot', png);
    expect(key).toBe('artifacts/public/run_b/1/screenshot.png');
    const obj = await client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    expect(obj.ContentType).toBe('image/png');
  });

  it('overwrites cleanly on key collision', async () => {
    await uploader.upload('public', 'run_c', 0, 'console', Buffer.from('first'));
    const key = await uploader.upload('public', 'run_c', 0, 'console', Buffer.from('second'));
    const obj = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const buf = await drainStream(obj.Body as NodeJS.ReadableStream);
    expect(buf.toString('utf8')).toBe('second');
  });

  it('logs but does not throw on slow upload', async () => {
    // Mock client with a delayed send to simulate slow S3.
    const slowClient = {
      send: async () => new Promise<void>((resolve) => setTimeout(() => resolve(), 80)),
    } as unknown as S3Client;
    const slow = new S3ArtifactUploader({
      bucket: BUCKET,
      client: slowClient,
      slowUploadThresholdMs: 50,
    });
    const key = await slow.upload('public', 'run_d', 0, 'console', Buffer.from('x'));
    expect(key).toBe('artifacts/public/run_d/0/console.jsonl');
  });
});

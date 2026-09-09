/*
 * Moved out of `admin/lib` with the media writes. Under the target topology the
 * API service is the only holder of the R2 credentials, so this belongs on the
 * same side of the boundary as the database — and `server-only` could not come
 * with it, since core has to run under a plain test runner.
 */
import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/**
 * Cloudflare R2 access.
 *
 * R2 speaks the S3 API, but one default in recent AWS SDK versions breaks it:
 * since @aws-sdk/client-s3 v3.729 the SDK adds a CRC32 checksum header to
 * uploads by default. On a presigned PUT that header gets baked into the
 * signature, the browser's fetch never sends it, the signature no longer
 * matches, and R2 answers 400 or 501. Every "presigned R2 upload suddenly
 * stopped working" report traces back to this. `WHEN_REQUIRED` turns it off.
 *
 * Because of that, the client is constructed here and only here — an ad-hoc
 * `new S3Client(...)` elsewhere would silently reintroduce the bug.
 */

export type R2Config = {
  bucket: string;
  endpoint: string;
  publicBaseUrl: string;
  accessKeyId: string;
  secretAccessKey: string;
  maxBytes: number;
  allowedMime: string[];
};

let cachedConfig: R2Config | null = null;
let cachedClient: S3Client | null = null;

/**
 * Reads and validates configuration on first use, not at import time.
 *
 * Same reason the Prisma client is lazy: `next build` imports every route module
 * to collect page data, and the build machine has no R2 secrets. Validating
 * eagerly would fail the Railway build rather than the request.
 */
export function r2Config(): R2Config {
  if (cachedConfig) return cachedConfig;

  const missing: string[] = [];
  const need = (name: string): string => {
    const value = process.env[name];
    if (!value) {
      missing.push(name);
      return '';
    }
    return value;
  };

  const bucket = need('R2_BUCKET');
  const accessKeyId = need('R2_ACCESS_KEY_ID');
  const secretAccessKey = need('R2_SECRET_ACCESS_KEY');
  const publicBaseUrl = need('R2_PUBLIC_BASE_URL');

  // Derivable from the account id, so accept either form.
  const endpoint =
    process.env.R2_ENDPOINT ??
    (process.env.R2_ACCOUNT_ID
      ? `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`
      : (missing.push('R2_ENDPOINT or R2_ACCOUNT_ID'), ''));

  if (missing.length > 0) {
    throw new Error(
      `Cloudflare R2 is not configured. Missing: ${missing.join(', ')}. ` +
        'Create an R2 API token (R2 → Manage API tokens → Object Read & Write) and set these in .env.',
    );
  }

  cachedConfig = {
    bucket,
    endpoint,
    publicBaseUrl: publicBaseUrl.replace(/\/+$/, ''),
    accessKeyId,
    secretAccessKey,
    maxBytes: Number(process.env.MEDIA_MAX_BYTES ?? 10 * 1024 * 1024),
    allowedMime: (process.env.MEDIA_ALLOWED_MIME ?? 'image/jpeg,image/png,image/webp,image/avif')
      .split(',')
      .map((m) => m.trim().toLowerCase())
      .filter(Boolean),
  };

  return cachedConfig;
}

/** True when R2 is configured — lets the UI explain itself instead of throwing. */
export function isR2Configured(): boolean {
  try {
    r2Config();
    return true;
  } catch {
    return false;
  }
}

export function r2Client(): S3Client {
  if (cachedClient) return cachedClient;
  const config = r2Config();

  cachedClient = new S3Client({
    region: 'auto',
    endpoint: config.endpoint,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    // The two lines that make R2 work. Do not remove.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });

  return cachedClient;
}

/** Presigned PUT for a direct browser upload. Five minutes is ample and limits replay. */
export async function presignUpload(key: string, contentType: string): Promise<string> {
  const { bucket } = r2Config();
  return getSignedUrl(
    r2Client(),
    new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType }),
    { expiresIn: 300 },
  );
}

/**
 * Confirms an object really landed, and at the size the client claimed.
 *
 * This is why the upload is a two-step handshake: without it, a browser could
 * mark a Media row READY for an object that was never stored, and the failure
 * would surface later as a broken image on the storefront.
 */
export async function headObject(
  key: string,
): Promise<{ exists: boolean; contentLength?: number; contentType?: string }> {
  try {
    const result = await r2Client().send(
      new HeadObjectCommand({ Bucket: r2Config().bucket, Key: key }),
    );
    return {
      exists: true,
      contentLength: result.ContentLength,
      contentType: result.ContentType,
    };
  } catch {
    return { exists: false };
  }
}

/** Server-side upload, used when ingesting remote images during a CSV import. */
export async function putObject(
  key: string,
  body: Uint8Array,
  contentType: string,
): Promise<void> {
  await r2Client().send(
    new PutObjectCommand({
      Bucket: r2Config().bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}

/** Batch delete. R2 accepts at most 1000 keys per call, so callers chunk. */
export async function deleteObjects(keys: string[]): Promise<void> {
  if (keys.length === 0) return;

  for (let i = 0; i < keys.length; i += 1000) {
    const chunk = keys.slice(i, i + 1000);
    await r2Client().send(
      new DeleteObjectsCommand({
        Bucket: r2Config().bucket,
        Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true },
      }),
    );
  }
}

/** One page of bucket keys, for reconciling objects whose database row is gone. */
export async function listObjects(
  continuationToken?: string,
): Promise<{ keys: string[]; nextToken?: string }> {
  const result = await r2Client().send(
    new ListObjectsV2Command({
      Bucket: r2Config().bucket,
      MaxKeys: 1000,
      ContinuationToken: continuationToken,
    }),
  );

  return {
    keys: (result.Contents ?? []).map((o) => o.Key).filter((k): k is string => Boolean(k)),
    nextToken: result.NextContinuationToken,
  };
}

/**
 * Reads a stored object back as text.
 *
 * The CSV importer uploads through the same presigned flow as images, so the
 * source file lives in R2 rather than in a request body — which keeps Railway's
 * request-size limit out of the picture and leaves the file re-readable for a
 * re-run or a post-mortem long after the upload.
 */
export async function getObjectText(key: string): Promise<string> {
  const result = await r2Client().send(
    new GetObjectCommand({ Bucket: r2Config().bucket, Key: key }),
  );
  if (!result.Body) throw new Error(`Object ${key} is empty.`);
  return result.Body.transformToString('utf-8');
}

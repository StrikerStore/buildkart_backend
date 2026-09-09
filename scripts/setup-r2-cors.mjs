/**
 * Applies the CORS policy the browser needs to upload directly to R2.
 *
 * Uploads go straight from the browser to R2 rather than through the server, so
 * the bucket itself has to allow the admin's origin. Without this every upload
 * dies at the preflight with "No 'Access-Control-Allow-Origin' header" — and
 * server-side tests never catch it, because server-to-server requests are not
 * subject to CORS at all.
 *
 * Idempotent: re-running replaces the policy with whatever this file declares.
 *
 * Usage:
 *   node scripts/setup-r2-cors.mjs            # apply, then read back
 *   node scripts/setup-r2-cors.mjs --show     # read back only
 */
import { config as loadEnv } from 'dotenv';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  S3Client,
  PutBucketCorsCommand,
  GetBucketCorsCommand,
} from '@aws-sdk/client-s3';

// The R2 credentials live with the service that uses them.
// The R2 credentials live with the service that uses them, one level up.
const backendDir = join(dirname(fileURLToPath(import.meta.url)), '..');
loadEnv({ path: join(backendDir, '.env'), quiet: true });

/**
 * Origins allowed to upload. Keep this list tight — it is the set of sites a
 * browser will let talk to the bucket with your credentials' blessing.
 * Additional origins can be supplied as R2_CORS_ORIGINS (comma-separated).
 */
const ORIGINS = [
  'http://localhost:3001',
  'http://127.0.0.1:3001',
  'https://admin.buildkart.co',
  ...(process.env.R2_CORS_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
];

const bucket = process.env.R2_BUCKET;
const endpoint =
  process.env.R2_ENDPOINT ??
  (process.env.R2_ACCOUNT_ID
    ? `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`
    : undefined);

if (!bucket || !endpoint || !process.env.R2_ACCESS_KEY_ID) {
  console.error('R2 is not configured. Set R2_BUCKET, R2_ACCOUNT_ID and the API token in .env.');
  process.exit(1);
}

const client = new S3Client({
  region: 'auto',
  endpoint,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});

const rules = [
  {
    // The presigned PUT the uploader makes. GET and HEAD are here so a future
    // client-side read or resumable check does not need a policy change.
    AllowedOrigins: ORIGINS,
    AllowedMethods: ['PUT', 'GET', 'HEAD'],
    // The signature covers `host` and the browser sends `content-type`; a
    // wildcard keeps this working if a future header joins the signed set.
    AllowedHeaders: ['*'],
    // ETag is the only response header the uploader could want to read.
    ExposeHeaders: ['ETag'],
    // Cache the preflight for an hour so a multi-image upload sends one OPTIONS
    // rather than one per file.
    MaxAgeSeconds: 3600,
  },
];

async function show() {
  try {
    const current = await client.send(new GetBucketCorsCommand({ Bucket: bucket }));
    console.log(JSON.stringify(current.CORSRules, null, 2));
  } catch (error) {
    const name = error?.name ?? '';
    if (name.includes('NoSuchCORSConfiguration')) {
      console.log('No CORS policy is set on this bucket.');
    } else {
      throw error;
    }
  }
}

if (process.argv.includes('--show')) {
  await show();
} else {
  await client.send(
    new PutBucketCorsCommand({ Bucket: bucket, CORSConfiguration: { CORSRules: rules } }),
  );
  console.log(`Applied CORS policy to bucket "${bucket}" for:`);
  for (const origin of ORIGINS) console.log(`  - ${origin}`);
  console.log('\nRead back from R2:');
  await show();
}

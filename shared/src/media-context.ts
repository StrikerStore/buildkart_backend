/**
 * Where images are read from.
 *
 * Lives in `shared`, not `core`, because none of it is a secret: the CDN base
 * URL is a public hostname customers resolve anyway, and the transform flag is
 * a rendering decision. Both apps need it to build an `<img src>`, and neither
 * should have to reach a database — or hold an R2 credential — to do so.
 * Whether R2 is *writable* is a different question, and that one stays on the
 * server as `isR2Configured`.
 *
 * This three-line block was copy-pasted into six pages — banners, media,
 * products, the product form options, an order detail and the CSV export — each
 * reading the same two environment variables and calling the same two helpers.
 * Six copies of a rule is five chances for one of them to drift, and the failure
 * would be silent: a page that renders unresized originals over a slow
 * connection looks fine in development and costs the customer seconds on a
 * budget phone.
 */
import { normalizePublicBaseUrl, transformsAvailable } from './media.ts';

/** The minimum an image row needs to be rendered. Matches Prisma's `Media` select. */
export type MediaImageDto = {
  id: string;
  r2Key: string;
  filename: string;
  altTextEn: string | null;
};

export type MediaUrlContext = {
  publicBaseUrl: string | null;
  transformsEnabled: boolean;
};

/**
 * Reads `R2_PUBLIC_BASE_URL` and `R2_IMAGE_TRANSFORMS`.
 *
 * `transformsAvailable` auto-detects: off for `*.r2.dev` (Cloudflare's own
 * domain, where Image Transformations cannot be enabled) and on for a custom
 * zone. `R2_IMAGE_TRANSFORMS` overrides it, which matters for a custom domain
 * whose zone has not had transformations turned on yet — without the override
 * every resized URL 404s.
 *
 * The environment is a parameter so a test can pass one without touching the
 * real process.
 */
export function mediaContext(env: NodeJS.ProcessEnv = process.env): MediaUrlContext {
  const publicBaseUrl = normalizePublicBaseUrl(env.R2_PUBLIC_BASE_URL);
  return {
    publicBaseUrl,
    transformsEnabled: publicBaseUrl
      ? transformsAvailable(publicBaseUrl, env.R2_IMAGE_TRANSFORMS)
      : false,
  };
}

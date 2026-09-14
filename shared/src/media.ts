/**
 * Every image URL in BuildKart is built here and nowhere else.
 *
 * Today that means Cloudflare's on-the-fly transformation path. Those are billed
 * per unique transformation with a modest free allowance, and one CSV import of
 * 291 images rendered at three widths burns ~900 of them. If that pricing turns
 * out badly, the fix is to pre-generate sized variants with sharp at upload time
 * — which stays a one-file change only as long as no component hardcodes a
 * `/cdn-cgi/image/` string.
 */

export type MediaRef = {
  r2Key: string;
  width?: number | null;
  height?: number | null;
  altTextEn?: string | null;
  altTextHi?: string | null;
};

export type MediaTransform = {
  /** Target width in CSS pixels. Omit for the original. */
  w?: number;
  /** 1-100. Defaults to 75, which is indistinguishable from 90 at these sizes. */
  q?: number;
  fit?: 'cover' | 'contain' | 'scale-down';
};

/**
 * The admin is restricted to this set. Every distinct width is a separately
 * billed transformation, so new sizes are a deliberate decision, not an
 * incidental one — hence a const tuple rather than an open number.
 */
export const ADMIN_THUMB = 80;
export const ADMIN_THUMB_2X = 160;
export const ADMIN_PREVIEW = 400;

function publicBase(): string {
  const base = process.env.R2_PUBLIC_BASE_URL ?? process.env.NEXT_PUBLIC_R2_PUBLIC_BASE_URL;
  if (!base) {
    throw new Error('R2_PUBLIC_BASE_URL is not set — cannot build media URLs.');
  }
  return base.replace(/\/+$/, '');
}

/**
 * Whether `/cdn-cgi/image/` resizing is available on a given public base.
 *
 * Cloudflare requires Image Transformations to be enabled **per zone**, and a
 * zone is a domain in your own account. An `r2.dev` public development URL is
 * Cloudflare's domain, not yours, so transformations can never be enabled on it
 * and a transformation path there yields a broken image rather than an error.
 *
 * Auto-detection keeps the common case correct with no configuration: r2.dev
 * off, custom domain on. `R2_IMAGE_TRANSFORMS=false` forces it off for a custom
 * domain whose zone has not had the feature switched on yet.
 */
export function transformsAvailable(baseUrl: string, override?: string | undefined): boolean {
  if (override === 'false' || override === '0') return false;
  if (override === 'true' || override === '1') return true;

  const hostname = hostnameOf(baseUrl);
  // An unparseable base is a configuration mistake, not a reason to take the
  // page down. Fall back to plain object URLs; the media screen reports the
  // bad value separately.
  if (hostname === null) return false;
  return !/\.r2\.dev$/i.test(hostname);
}

/** Hostname of a base URL, tolerating a missing scheme. Null when unusable. */
export function hostnameOf(baseUrl: string): string | null {
  const trimmed = baseUrl.trim();
  if (trimmed === '') return null;
  // A bare "cdn.example.com" is what people naturally paste out of a dashboard.
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    return new URL(candidate).hostname;
  } catch {
    return null;
  }
}

/**
 * Returns the base URL with a scheme, or null when it cannot be salvaged.
 * Every media URL goes through this, so a pasted bare hostname still works.
 */
export function normalizePublicBaseUrl(baseUrl: string | null | undefined): string | null {
  if (!baseUrl) return null;
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (trimmed === '') return null;
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    new URL(candidate);
    return candidate;
  } catch {
    return null;
  }
}

/**
 * Builds a URL for a stored object. The single place any media URL is
 * constructed, on the server and in the browser alike.
 *
 * When transformations are available, `format=auto` is the setting that
 * actually matters for this audience: it serves AVIF or WebP based on the
 * Accept header, which on a budget Android phone over a weak connection is the
 * difference between a page that loads and one that doesn't. When they are not,
 * the original object is served and the width is simply ignored.
 */
export function buildMediaUrl(
  baseUrl: string,
  transformsEnabled: boolean,
  media: MediaRef | string,
  transform: MediaTransform = {},
): string {
  const key = (typeof media === 'string' ? media : media.r2Key).replace(/^\/+/, '');
  const base = baseUrl.replace(/\/+$/, '');

  const { w, q = 75, fit } = transform;
  if (w === undefined || !transformsEnabled) return `${base}/${key}`;

  const params = [`width=${w}`, `quality=${q}`, 'format=auto'];
  if (fit) params.push(`fit=${fit}`);
  return `${base}/cdn-cgi/image/${params.join(',')}/${key}`;
}

/** Server-side convenience that reads configuration from the environment. */
export function mediaUrl(media: MediaRef | string, transform: MediaTransform = {}): string {
  const base = publicBase();
  return buildMediaUrl(
    base,
    transformsAvailable(base, process.env.R2_IMAGE_TRANSFORMS),
    media,
    transform,
  );
}

/** Alt text with the same English fallback rule as every other translated field. */
export function mediaAlt(media: MediaRef, locale: 'en' | 'hi' = 'en'): string {
  if (locale === 'hi' && media.altTextHi && media.altTextHi.trim() !== '') return media.altTextHi;
  return media.altTextEn ?? '';
}

/**
 * Object key layout: `products/2026/08/<ulid>.webp`.
 *
 * Date-partitioned so a bucket listing during GC stays paginable as the catalog
 * grows, and ULID-named so keys sort by creation time and never collide.
 */
export function buildR2Key(
  prefix: 'products' | 'categories' | 'banners' | 'imports' | 'support' | 'reviews',
  id: string,
  ext: string,
): string {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const safeExt = ext.replace(/^\.+/, '').toLowerCase();
  return `${prefix}/${yyyy}/${mm}/${id}.${safeExt}`;
}

const MIME_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'text/csv': 'csv',
};

export function extensionForMime(mimeType: string): string | null {
  return MIME_EXTENSIONS[mimeType.toLowerCase()] ?? null;
}

/**
 * A filename split into the part a person would rename and the extension.
 *
 * A leading dot is part of the name, not an extension: `.htaccess` has no
 * extension, and treating it as one would turn a second copy into `_2.htaccess`.
 */
export function splitFilename(filename: string): { stem: string; extension: string } {
  const dot = filename.lastIndexOf('.');
  if (dot <= 0) return { stem: filename, extension: '' };
  return { stem: filename.slice(0, dot), extension: filename.slice(dot) };
}

/** Media.filename is `VARCHAR(255)`; a name that would overflow is trimmed. */
const FILENAME_MAX = 255;

/**
 * Picks a filename not already in `taken`, appending `_2`, `_3`, … as needed.
 *
 * Duplicate names are legal — the library is keyed by id, and R2 keys are
 * ULIDs — but two rows reading `IMG_0431.jpg` are indistinguishable in the
 * picker, which is where the file is actually chosen. Numbering the second one
 * is what a desktop file manager does, and it is what the person uploading
 * expects.
 *
 * Comparison is case-insensitive: `Logo.png` and `logo.png` are the same file
 * to a human scanning a grid, whatever the database collation happens to say.
 */
export function uniqueFilename(desired: string, taken: Iterable<string>): string {
  const lowered = new Set<string>();
  for (const name of taken) lowered.add(name.trim().toLowerCase());

  if (!lowered.has(desired.trim().toLowerCase())) return desired;

  const { stem, extension } = splitFilename(desired);

  /*
   * A trailing `_<number>` is treated as our own counter — so a second
   * `logo_2.png` becomes `logo_3.png` rather than `logo_2_2.png` — but only
   * when the name without it is actually in the library, which is the one
   * condition under which we would have written that suffix.
   *
   * Without that check the rule eats real names. Phones hand back `IMG_0431.jpg`
   * and `DSC_0042.jpg`, and stripping those to `IMG` and `DSC` would file the
   * second copy of a photo as `IMG_2.jpg` — the original name gone, and every
   * unrelated photo from the same camera fighting over the same counter.
   */
  const stripped = stem.replace(/_\d+$/, '');
  const base =
    stripped !== '' && stripped !== stem && lowered.has(`${stripped}${extension}`.toLowerCase())
      ? stripped
      : stem;

  // Bounded so a pathological library cannot spin here; past the ceiling the
  // duplicate name is simply allowed through rather than failing the upload.
  for (let n = 2; n <= 1000; n += 1) {
    const suffix = `_${n}${extension}`;
    const room = FILENAME_MAX - suffix.length;
    const candidate = `${base.slice(0, Math.max(1, room))}${suffix}`;
    if (!lowered.has(candidate.toLowerCase())) return candidate;
  }

  return desired;
}

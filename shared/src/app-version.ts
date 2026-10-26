/**
 * Which builds of the mobile app the shop still serves.
 *
 * A website is rebuilt with every change; an installed app is not. A phone that
 * last updated three months ago is still calling the procedures as they were
 * then, so the shop needs a way to say "this build is too old — update" before
 * the API stops understanding it. That is the whole job of this module: the
 * rule lives here, in `shared`, so the API that publishes the numbers and the
 * app that compares itself against them read the same code from the contract.
 *
 * Versions are plain `major.minor.patch` — the `version` in the app's
 * `app.config.ts`, which is what a customer sees in the store listing. No
 * pre-release tags: a store build is a release.
 */
import { z } from 'zod';

const VERSION = /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/;

export const appVersionSchema = z
  .string()
  .trim()
  .regex(VERSION, 'Use the form 1.4.0');

/** A store link, or nothing yet — the app is not listed on day one. */
const storeUrl = z
  .string()
  .trim()
  .max(300)
  .refine((value) => value === '' || value.startsWith('https://'), 'Must start with https://');

/**
 * The stored setting, `apps.mobile`.
 *
 * Defaults to `0.0.0` throughout: until the owner sets a minimum, every build
 * is supported and nobody is told to update.
 */
export const appConfigSettingSchema = z
  .object({
    minSupportedVersion: appVersionSchema.default('0.0.0'),
    latestVersion: appVersionSchema.default('0.0.0'),
    androidStoreUrl: storeUrl.default(''),
    iosStoreUrl: storeUrl.default(''),
  })
  .default({
    minSupportedVersion: '0.0.0',
    latestVersion: '0.0.0',
    androidStoreUrl: '',
    iosStoreUrl: '',
  });

/**
 * What the admin's "Apps" screen submits.
 *
 * Stricter than the stored shape: every field is required, and the minimum
 * cannot be ahead of the latest — that would tell every phone to update to a
 * build that does not exist.
 */
export const appConfigInputSchema = z
  .object({
    minSupportedVersion: appVersionSchema,
    latestVersion: appVersionSchema,
    androidStoreUrl: storeUrl,
    iosStoreUrl: storeUrl,
  })
  .refine((value) => compareAppVersions(value.minSupportedVersion, value.latestVersion) <= 0, {
    message: 'The minimum version cannot be newer than the latest version',
    path: ['minSupportedVersion'],
  });

export type AppConfigInput = z.infer<typeof appConfigInputSchema>;

/** What `content.appConfig` returns to the app. */
export type AppConfigDto = {
  minSupportedVersion: string;
  latestVersion: string;
  storeUrls: { android: string | null; ios: string | null };
};

function parts(version: string): [number, number, number] | null {
  const match = VERSION.exec(version.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Orders two versions: negative when `a` is older, positive when newer.
 *
 * Numeric per part, never as strings — as text, `1.10.0` sorts before `1.9.0`
 * and the shop would tell its newest build to update. A malformed version
 * counts as the oldest possible, so a build reporting garbage is asked to
 * update rather than waved through.
 */
export function compareAppVersions(a: string, b: string): number {
  const left = parts(a) ?? [-1, -1, -1];
  const right = parts(b) ?? [-1, -1, -1];
  for (let i = 0; i < 3; i += 1) {
    const diff = left[i]! - right[i]!;
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * What the app should do about its own version.
 *
 * - `required` — below the minimum. The app shows only the update screen,
 *   because the API may no longer understand it.
 * - `available` — supported, but a newer build is out. A dismissible nudge.
 * - `current` — nothing to do.
 */
export function appUpdateStatus(
  installed: string,
  config: Pick<AppConfigDto, 'minSupportedVersion' | 'latestVersion'>,
): 'required' | 'available' | 'current' {
  if (compareAppVersions(installed, config.minSupportedVersion) < 0) return 'required';
  if (compareAppVersions(installed, config.latestVersion) < 0) return 'available';
  return 'current';
}

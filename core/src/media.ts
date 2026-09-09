/**
 * Media URL configuration moved to `@buildkart/shared`.
 *
 * It carries no secret — a CDN hostname and a rendering flag — so it had no
 * business behind a package that reaches the database. Re-exported here so
 * core's own modules keep one import path; the admin now takes it from shared
 * directly and needs neither core nor a database to render an image.
 */
export {
  mediaContext,
  type MediaImageDto,
  type MediaUrlContext,
} from '@buildkart/shared';

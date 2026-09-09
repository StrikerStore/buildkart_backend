/**
 * CSV import vocabulary.
 *
 * These mirror the `ImportJobStatus` and `ImportIssueSeverity` enums in
 * `schema.prisma`, the same way `ORDER_STATUSES` and `PAYMENT_METHODS` already
 * mirror theirs. Duplicating a handful of string literals is the price of
 * keeping this package free of any database dependency — and it is what lets an
 * import progress screen name a status without the app it runs in being able to
 * reach MySQL.
 *
 * If a status is added to the schema, add it here too. The mirror is small
 * enough that a mismatch shows up immediately as a type error at the boundary.
 */

export const IMPORT_JOB_STATUSES = [
  'UPLOADED',
  'PARSING',
  'DRY_RUN_READY',
  'COMMITTING',
  'IMPORTING_IMAGES',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const;

export type ImportJobStatus = (typeof IMPORT_JOB_STATUSES)[number];

export const IMPORT_ISSUE_SEVERITIES = ['ERROR', 'WARNING'] as const;

export type ImportIssueSeverity = (typeof IMPORT_ISSUE_SEVERITIES)[number];

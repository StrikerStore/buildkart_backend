import { z } from 'zod';

/**
 * The return type of every Server Action in the admin.
 *
 * Actions never throw for expected failures. A thrown Server Action error is
 * redacted in production to an opaque digest, so the owner would see "an error
 * occurred" instead of "handle already in use" — the exact moment the message
 * matters most. Errors travel as data instead: the form feeds `fieldErrors`
 * into react-hook-form's `setError` and renders `formErrors` in an alert.
 */
export type ActionResult<T = void> =
  | ({ ok: true } & (T extends void ? { data?: undefined } : { data: T }))
  | {
      ok: false;
      formErrors: string[];
      fieldErrors: Record<string, string>;
    };

export function actionOk(): ActionResult<void>;
export function actionOk<T>(data: T): ActionResult<T>;
export function actionOk<T>(data?: T): ActionResult<T> {
  return { ok: true, data } as ActionResult<T>;
}

export function actionError(
  formErrors: string | string[],
  fieldErrors: Record<string, string> = {},
): ActionResult<never> {
  return {
    ok: false,
    formErrors: Array.isArray(formErrors) ? formErrors : [formErrors],
    fieldErrors,
  };
}

/** Flattens a zod failure into the shape the admin forms consume. */
export function actionErrorFromZod(error: z.ZodError): ActionResult<never> {
  const flat = z.flattenError(error);
  const fieldErrors: Record<string, string> = {};
  for (const [field, messages] of Object.entries(flat.fieldErrors)) {
    const first = (messages as string[] | undefined)?.[0];
    if (first) fieldErrors[field] = first;
  }
  return {
    ok: false,
    formErrors: flat.formErrors,
    fieldErrors,
  };
}

/** Cursor pagination shared by every admin index page. */
export const paginationSchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  direction: z.enum(['forward', 'backward']).default('forward'),
});
export type Pagination = z.infer<typeof paginationSchema>;

export const idSchema = z.string().min(1).max(64);

/** Trims, then converts "" to undefined — Polaris inputs submit empty strings. */
export const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? undefined : v))
    .optional();

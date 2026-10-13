/**
 * The Marketing settings screen: Meta's Conversions API.
 *
 * Secret handling is the payment screen's, unchanged — the token field is
 * write-only, blank keeps what is stored, and `clearAccessToken` is the only
 * way to remove one.
 */
import { z } from 'zod';

export const metaMarketingSchema = z
  .object({
    enabled: z.boolean().default(false),
    /** Digits only; Events Manager shows it under the dataset's name. */
    pixelId: z
      .string()
      .trim()
      .regex(/^\d{0,20}$/, 'The pixel id is the number shown in Events Manager')
      .default(''),
    accessToken: z.string().trim().max(1024).default(''),
    clearAccessToken: z.boolean().default(false),
    testEventCode: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9]{0,32}$/, 'Copy the code exactly, e.g. TEST12345')
      .default(''),
    /** Accepted with or without `act_`, stored as digits. */
    adAccountId: z
      .string()
      .trim()
      .transform((value) => value.replace(/^act_/i, ''))
      .pipe(z.string().regex(/^\d{0,20}$/, 'The ad account id is the number after act_'))
      .default(''),
    insightsToken: z.string().trim().max(1024).default(''),
    clearInsightsToken: z.boolean().default(false),
  })
  .superRefine((value, ctx) => {
    if (value.enabled && value.pixelId === '') {
      ctx.addIssue({ code: 'custom', path: ['pixelId'], message: 'Needed to send events' });
    }
  });
export type MetaMarketingInput = z.infer<typeof metaMarketingSchema>;

import { z } from 'zod';
import { PRICE_ALERT_KINDS } from '../app-notifications.ts';

/** An Expo push token, as `getExpoPushTokenAsync` returns it. */
const pushToken = z
  .string()
  .trim()
  .max(255)
  .regex(/^Expo(nent)?PushToken\[[^\]]+\]$/, 'Not a push token');

export const registerDeviceSchema = z.object({
  token: pushToken,
  platform: z.enum(['android', 'ios']),
  appVersion: z.string().trim().max(32).optional(),
});
export type RegisterDeviceInput = z.infer<typeof registerDeviceSchema>;

export const unregisterDeviceSchema = z.object({ token: pushToken });

export const appNotificationsQuerySchema = z.object({
  cursor: z.string().trim().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(30),
});

/** Marks these read, or every one when no ids are given. */
export const markNotificationsReadSchema = z.object({
  ids: z.array(z.string().trim().min(1).max(64)).max(100).optional(),
});

export const savePriceAlertSchema = z
  .object({
    variantId: z.string().trim().min(1).max(64),
    kind: z.enum(PRICE_ALERT_KINDS),
    /** The price to watch for, DROP_BELOW only. */
    targetPrice: z.coerce.number().positive('Enter a price').max(10_000_000).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.kind === 'DROP_BELOW' && value.targetPrice === undefined) {
      ctx.addIssue({ code: 'custom', path: ['targetPrice'], message: 'Enter the price to watch for' });
    }
  });
export type SavePriceAlertInput = z.infer<typeof savePriceAlertSchema>;

export const priceAlertIdSchema = z.object({ id: z.string().trim().min(1).max(64) });

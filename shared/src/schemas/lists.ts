import { z } from 'zod';

/**
 * Saved lists — a customer's own named lists of materials (the mobile app's
 * "Lists"). Like the cart, a list holds ids and quantities and nothing that
 * could be a price; it is priced when shown, at that day's rates.
 */

/** Lists per customer. A contractor with more than this has a spreadsheet. */
export const SAVED_LISTS_MAX = 50;
/** Lines per list — the cart's own ceiling, so a list always fits in a cart. */
export const SAVED_LIST_ITEMS_MAX = 50;

const listName = z.string().trim().min(1, 'Give the list a name').max(80, 'Keep the name under 80 characters');
const listId = z.string().trim().min(1).max(64);
const variantId = z.string().trim().min(1).max(64);

export const createSavedListSchema = z.object({
  name: listName,
  items: z
    .array(z.object({ variantId, quantity: z.coerce.number().int().min(1).max(999) }))
    .max(SAVED_LIST_ITEMS_MAX)
    .default([]),
});
export type CreateSavedListInput = z.infer<typeof createSavedListSchema>;

export const renameSavedListSchema = z.object({ id: listId, name: listName });

export const savedListIdSchema = z.object({ id: listId });

/** Sets one line; 0 takes it off the list. */
export const setSavedListItemSchema = z.object({
  listId,
  variantId,
  quantity: z.coerce.number().int().min(0).max(999),
});
export type SetSavedListItemInput = z.infer<typeof setSavedListItemSchema>;

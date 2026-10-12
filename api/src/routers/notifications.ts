/**
 * Customer messages: the templates, and the credentials behind them.
 *
 * Its own router rather than more procedures on `content`, because none of it
 * is content the storefront reads — there is no public procedure here at all.
 * WhatsApp sends through AiSensy (`core/src/notify`); the procedures below
 * configure it, submit templates for approval, test them and read the log.
 */
import { z } from 'zod';
import {
  deleteNotificationTemplate,
  getNotificationProviders,
  getNotificationTemplate,
  getNotificationsPage,
  listNotificationMessages,
  listNotificationTemplates,
  refreshWhatsappTemplate,
  saveEmailProvider,
  saveNotificationTemplate,
  saveSmsProvider,
  saveWhatsappProvider,
  sendWhatsappTest,
  submitWhatsappTemplate,
} from '@buildkart/core';
import { NOTIFICATION_CHANNELS } from '@buildkart/shared';
import { adminProcedure, router } from '../trpc.ts';

/** Inputs stay `unknown`: core owns the schema and validates it itself. */
const payload = z.unknown();

const templateKey = z.object({
  event: z.string().min(1).max(64),
  channel: z.enum(NOTIFICATION_CHANNELS),
  locale: z.enum(['en', 'hi']),
});

export const notificationsRouter = router({
  page: adminProcedure.query(({ ctx }) => getNotificationsPage(ctx.actor)),
  templates: adminProcedure.query(({ ctx }) => listNotificationTemplates(ctx.actor)),
  template: adminProcedure
    .input(templateKey)
    .query(({ ctx, input }) => getNotificationTemplate(ctx.actor, input)),
  providers: adminProcedure.query(({ ctx }) => getNotificationProviders(ctx.actor)),

  saveTemplate: adminProcedure
    .input(payload)
    .mutation(({ ctx, input }) => saveNotificationTemplate(ctx.actor, input)),
  deleteTemplate: adminProcedure
    .input(payload)
    .mutation(({ ctx, input }) => deleteNotificationTemplate(ctx.actor, input)),

  saveSmsProvider: adminProcedure
    .input(payload)
    .mutation(({ ctx, input }) => saveSmsProvider(ctx.actor, input)),
  saveWhatsappProvider: adminProcedure
    .input(payload)
    .mutation(({ ctx, input }) => saveWhatsappProvider(ctx.actor, input)),
  saveEmailProvider: adminProcedure
    .input(payload)
    .mutation(({ ctx, input }) => saveEmailProvider(ctx.actor, input)),

  submitWhatsappTemplate: adminProcedure
    .input(payload)
    .mutation(({ ctx, input }) => submitWhatsappTemplate(ctx.actor, input)),
  refreshWhatsappTemplate: adminProcedure
    .input(payload)
    .mutation(({ ctx, input }) => refreshWhatsappTemplate(ctx.actor, input)),
  sendWhatsappTest: adminProcedure
    .input(payload)
    .mutation(({ ctx, input }) => sendWhatsappTest(ctx.actor, input)),

  /** The outbound log, newest first, optionally for one order or customer. */
  messages: adminProcedure
    .input(payload)
    .query(({ ctx, input }) => listNotificationMessages(ctx.actor, input)),
});

/**
 * Banner and homepage-section writes.
 *
 * This is the shape of the storefront, edited by the owner: which artwork runs
 * where, and what the home page is made of, top to bottom. The storefront reads
 * these rows on every visit, so when the API arrives these are the writes whose
 * success has to invalidate its cache.
 */
import { prisma } from '@buildkart/database';
import {
  actionError,
  actionErrorFromZod,
  actionOk,
  bannerSchema,
  homepageSectionSchema,
  reorderSchema,
  announcementBarSchema,
  seoDefaultsSchema,
  toggleActiveSchema,
  type ActionResult,
} from '@buildkart/shared';
import { assertPermission, type Actor } from '../actor.ts';
import { recordAudit } from '../audit.ts';

// ---------------------------------------------------------------------------
// Banners
// ---------------------------------------------------------------------------

export async function saveBanner(actor: Actor, input: unknown): Promise<ActionResult<{ id: string }>> {
  assertPermission(actor, 'content:write');

  const parsed = bannerSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const data = parsed.data;

  /*
   * The media has to exist and be READY. A banner pointing at a half-finished
   * upload renders as a broken image on the shop's front page, which is the
   * most visible place it could possibly fail.
   */
  const ids = [data.mediaIdDesktop, data.mediaIdMobile].filter(Boolean) as string[];
  const media = await prisma.media.findMany({
    where: { id: { in: ids } },
    select: { id: true, status: true },
  });
  if (media.length !== ids.length || media.some((row) => row.status !== 'READY')) {
    return actionError('Choose an image that has finished uploading.', {
      mediaIdDesktop: 'Pick a ready image',
    });
  }

  const values = {
    titleEn: data.titleEn ?? null,
    titleHi: data.titleHi ?? null,
    mediaIdDesktop: data.mediaIdDesktop,
    mediaIdMobile: data.mediaIdMobile ?? null,
    linkUrl: data.linkUrl ?? null,
    placement: data.placement,
    isActive: data.isActive,
    startsAt: data.startsAt ? new Date(data.startsAt) : null,
    endsAt: data.endsAt ? new Date(data.endsAt) : null,
  };

  const saved = data.id
    ? await prisma.banner.update({ where: { id: data.id }, data: values })
    : await prisma.banner.create({
        data: {
          ...values,
          // New banners go to the end of their placement, so adding one never
          // reshuffles what is already arranged.
          position:
            ((
              await prisma.banner.aggregate({
                where: { placement: data.placement },
                _max: { position: true },
              })
            )._max.position ?? -1) + 1,
        },
      });

  await recordAudit(actor, {
    action: data.id ? 'banner.update' : 'banner.create',
    entityType: 'Banner',
    entityId: saved.id,
    diff: values,
  });

  return actionOk({ id: saved.id });
}

export async function setBannerActive(actor: Actor, input: unknown): Promise<ActionResult<void>> {
  assertPermission(actor, 'content:write');

  const parsed = toggleActiveSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);

  const existing = await prisma.banner.findUnique({ where: { id: parsed.data.id } });
  if (!existing) return actionError('That banner no longer exists.');

  await prisma.banner.update({
    where: { id: parsed.data.id },
    data: { isActive: parsed.data.isActive },
  });

  await recordAudit(actor, {
    action: parsed.data.isActive ? 'banner.enable' : 'banner.disable',
    entityType: 'Banner',
    entityId: parsed.data.id,
  });

  return actionOk();
}

export async function deleteBanner(actor: Actor, input: unknown): Promise<ActionResult<void>> {
  assertPermission(actor, 'content:write');

  const parsed = toggleActiveSchema.pick({ id: true }).safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);

  const existing = await prisma.banner.findUnique({ where: { id: parsed.data.id } });
  if (!existing) return actionError('That banner has already been removed.');

  // Only the banner goes. The image stays in the library, which is the whole
  // point of having one — it may well be used somewhere else.
  await prisma.banner.delete({ where: { id: parsed.data.id } });

  await recordAudit(actor, {
    action: 'banner.delete',
    entityType: 'Banner',
    entityId: parsed.data.id,
    diff: { titleEn: existing.titleEn, placement: existing.placement },
  });

  return actionOk();
}

/**
 * Writes the new order after a drag.
 *
 * Positions are rewritten in one transaction from the order given, rather than
 * nudged one at a time, so an interrupted reorder cannot leave two banners
 * claiming the same slot.
 */
export async function reorderBanners(actor: Actor, input: unknown): Promise<ActionResult<void>> {
  assertPermission(actor, 'content:write');

  const parsed = reorderSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);

  await prisma.$transaction(
    parsed.data.ids.map((id, index) =>
      prisma.banner.update({ where: { id }, data: { position: index } }),
    ),
  );

  await recordAudit(actor, {
    action: 'banner.reorder',
    entityType: 'Banner',
    entityId: `${parsed.data.ids.length} banners`,
  });

  return actionOk();
}

// ---------------------------------------------------------------------------
// Homepage sections
// ---------------------------------------------------------------------------

/**
 * Saves a homepage section.
 *
 * Only the config keys that the chosen type actually uses are stored. Keeping
 * the others would leave stale product ids sitting inside a tag section, ready
 * to take effect the moment someone switched the type back.
 */
export async function saveHomepageSection(
  actor: Actor,
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  assertPermission(actor, 'content:write');

  const parsed = homepageSectionSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const data = parsed.data;

  const config: Record<string, unknown> = { limit: data.config.limit };
  if (data.type === 'CATEGORY_GRID') config.categoryIds = data.config.categoryIds;
  if (data.type === 'PRODUCT_CAROUSEL') config.productIds = data.config.productIds;
  if (data.type === 'TAG_CAROUSEL') config.tagId = data.config.tagId;

  const values = {
    type: data.type,
    titleEn: data.titleEn ?? null,
    titleHi: data.titleHi ?? null,
    configJson: config as never,
    isActive: data.isActive,
  };

  const saved = data.id
    ? await prisma.homepageSection.update({ where: { id: data.id }, data: values })
    : await prisma.homepageSection.create({
        data: {
          ...values,
          // New sections land at the bottom, so adding one never reshuffles a
          // homepage someone has already arranged.
          position:
            ((await prisma.homepageSection.aggregate({ _max: { position: true } }))._max.position ??
              -1) + 1,
        },
      });

  await recordAudit(actor, {
    action: data.id ? 'homepage.update' : 'homepage.create',
    entityType: 'HomepageSection',
    entityId: saved.id,
    diff: values,
  });

  return actionOk({ id: saved.id });
}

export async function setHomepageSectionActive(
  actor: Actor,
  input: unknown,
): Promise<ActionResult<void>> {
  assertPermission(actor, 'content:write');

  const parsed = toggleActiveSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);

  const existing = await prisma.homepageSection.findUnique({ where: { id: parsed.data.id } });
  if (!existing) return actionError('That section no longer exists.');

  await prisma.homepageSection.update({
    where: { id: parsed.data.id },
    data: { isActive: parsed.data.isActive },
  });

  await recordAudit(actor, {
    action: parsed.data.isActive ? 'homepage.enable' : 'homepage.disable',
    entityType: 'HomepageSection',
    entityId: parsed.data.id,
  });

  return actionOk();
}

export async function deleteHomepageSection(
  actor: Actor,
  input: unknown,
): Promise<ActionResult<void>> {
  assertPermission(actor, 'content:write');

  const parsed = toggleActiveSchema.pick({ id: true }).safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);

  const existing = await prisma.homepageSection.findUnique({ where: { id: parsed.data.id } });
  if (!existing) return actionError('That section has already been removed.');

  await prisma.homepageSection.delete({ where: { id: parsed.data.id } });

  await recordAudit(actor, {
    action: 'homepage.delete',
    entityType: 'HomepageSection',
    entityId: parsed.data.id,
    diff: { type: existing.type, titleEn: existing.titleEn },
  });

  return actionOk();
}

/** Rewrites every position in one transaction, so no two sections share a slot. */
export async function reorderHomepageSections(
  actor: Actor,
  input: unknown,
): Promise<ActionResult<void>> {
  assertPermission(actor, 'content:write');

  const parsed = reorderSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);

  await prisma.$transaction(
    parsed.data.ids.map((id, index) =>
      prisma.homepageSection.update({ where: { id }, data: { position: index } }),
    ),
  );

  await recordAudit(actor, {
    action: 'homepage.reorder',
    entityType: 'HomepageSection',
    entityId: `${parsed.data.ids.length} sections`,
  });

  return actionOk();
}

// ---------------------------------------------------------------------------
// SEO
// ---------------------------------------------------------------------------

export async function saveSeoDefaults(actor: Actor, input: unknown): Promise<ActionResult<void>> {
  assertPermission(actor, 'content:write');

  const parsed = seoDefaultsSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const data = parsed.data;

  await prisma.setting.upsert({
    where: { key: 'seo.defaults' },
    create: { key: 'seo.defaults', value: data as never },
    update: { value: data as never },
  });

  await recordAudit(actor, {
    action: 'seo.update',
    entityType: 'Setting',
    entityId: 'seo.defaults',
    diff: data,
  });

  return actionOk();
}

// ---------------------------------------------------------------------------
// Announcement bar
// ---------------------------------------------------------------------------

/**
 * Saves the whole bar in one write.
 *
 * The list replaces rather than merges, which is what makes reordering and
 * deletion work at all: the form owns the order, and a per-message endpoint
 * would need a stable id for rows that have never needed one.
 */
export async function saveAnnouncementBar(actor: Actor, input: unknown): Promise<ActionResult> {
  assertPermission(actor, 'content:write');

  const parsed = announcementBarSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const data = parsed.data;

  await prisma.setting.upsert({
    where: { key: 'content.announcements' },
    create: { key: 'content.announcements', value: data as never },
    update: { value: data as never },
  });

  await recordAudit(actor, {
    action: 'announcements.update',
    entityType: 'Setting',
    entityId: 'content.announcements',
    diff: data,
  });

  return actionOk();
}

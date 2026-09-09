/**
 * Banners and homepage sections — the admin-managed shape of the storefront.
 *
 * These are the reads the storefront will lean on hardest, which is why they
 * moved first. The admin variants here return everything, including inactive
 * and out-of-window rows, because the whole job of those screens is to manage
 * them. The storefront's variants (Phase 6) will apply the visibility filters,
 * and they will live beside these so the two cannot drift.
 */
import { prisma } from '@buildkart/database';
import {
  homepageSectionConfigSchema,
  HOMEPAGE_SECTION_TYPES,
  type HomepageSectionType,
} from '@buildkart/shared';
import { parseSetting } from '@buildkart/shared';
import type {
  AnnouncementBarDto,
  SeoDefaultsDto,
  StorefrontAnnouncementsDto,
} from '@buildkart/shared';
import { assertPermission, type Actor } from '../actor.ts';
import { dateToIso } from '../dto.ts';
import { loadPickerOptions, type PickerOptions } from './pickers.ts';
import type { BannerDto, HomepageSectionDto, HomepageSectionRow } from '@buildkart/shared';
export type { BannerDto, HomepageSectionDto, HomepageSectionRow };
export type { AnnouncementBarDto, StorefrontAnnouncementsDto };





const IMAGE_SELECT = { id: true, r2Key: true, filename: true, altTextEn: true } as const;

/** Every banner, in the order the admin arranged them. */
export async function listBanners(actor: Actor): Promise<BannerDto[]> {
  assertPermission(actor, 'content:write');

  const banners = await prisma.banner.findMany({
    orderBy: [{ placement: 'asc' }, { position: 'asc' }],
    include: {
      mediaDesktop: { select: IMAGE_SELECT },
      mediaMobile: { select: IMAGE_SELECT },
    },
  });

  return banners.map((banner) => ({
    id: banner.id,
    titleEn: banner.titleEn,
    titleHi: banner.titleHi,
    mediaDesktop: banner.mediaDesktop,
    mediaMobile: banner.mediaMobile,
    linkUrl: banner.linkUrl,
    placement: banner.placement,
    position: banner.position,
    isActive: banner.isActive,
    startsAt: dateToIso(banner.startsAt),
    endsAt: dateToIso(banner.endsAt),
  }));
}



const KNOWN_TYPES = new Set<string>(HOMEPAGE_SECTION_TYPES);

/**
 * Maps one row, or `null` if this build does not know its type.
 *
 * `HomepageSection.type` is a String column plus a zod union rather than a
 * database enum, because section kinds churn as the storefront grows and every
 * MySQL enum change is a migration on a live table. The price of that choice is
 * paid here: a row can hold a type written by a newer deploy, or one retired by
 * this one. Dropping it beats crashing the page — and beats rendering an empty
 * shell that looks like the section is broken rather than absent.
 *
 * A malformed `configJson` degrades to the schema's defaults for the same
 * reason: one bad row should cost its own section, not the page.
 */
export function toHomepageSectionDto(row: HomepageSectionRow): HomepageSectionDto | null {
  if (!KNOWN_TYPES.has(row.type)) return null;

  const parsed = homepageSectionConfigSchema.safeParse(row.configJson);
  const config = parsed.success ? parsed.data : homepageSectionConfigSchema.parse({});

  return {
    id: row.id,
    type: row.type as HomepageSectionType,
    titleEn: row.titleEn,
    titleHi: row.titleHi,
    categoryIds: config.categoryIds,
    productIds: config.productIds,
    tagId: config.tagId ?? null,
    limit: config.limit,
    markers: config.markers,
    position: row.position,
    isActive: row.isActive,
  };
}

/** Every section, top to bottom, minus any whose type this build cannot render. */
export async function listHomepageSections(actor: Actor): Promise<HomepageSectionDto[]> {
  assertPermission(actor, 'content:write');

  const sections = await prisma.homepageSection.findMany({ orderBy: { position: 'asc' } });

  return sections
    .map(toHomepageSectionDto)
    .filter((section): section is HomepageSectionDto => section !== null);
}

/** What the section form can point at. See `loadPickerOptions` for the caps. */
export async function listHomepageSectionOptions(actor: Actor): Promise<PickerOptions> {
  assertPermission(actor, 'content:write');
  // Active categories only: a section pointing at a hidden category renders an
  // empty rail on the storefront.
  return loadPickerOptions({ activeCategoriesOnly: true });
}

// ---------------------------------------------------------------------------
// SEO
// ---------------------------------------------------------------------------

/**
 * Site-wide SEO defaults.
 *
 * Takes no actor, like `getSettings`: the storefront renders the home title and
 * meta description to anyone who visits. Changing them needs `content:write`,
 * which is the mutation beside it.
 */
export async function getSeoDefaults(): Promise<SeoDefaultsDto> {
  const row = await prisma.setting.findUnique({ where: { key: 'seo.defaults' } });
  return parseSetting('seo.defaults', row?.value);
}

// ---------------------------------------------------------------------------
// Announcement bar
// ---------------------------------------------------------------------------

/**
 * The bar as the admin edits it — every message, parked ones included.
 *
 * Behind `content:write` rather than public, unlike `getAnnouncementBar` below:
 * a message the owner has switched off is a draft, and a draft is not something
 * an anonymous request gets to read.
 */
export async function getAnnouncementBarAdmin(actor: Actor): Promise<AnnouncementBarDto> {
  assertPermission(actor, 'content:write');
  const row = await prisma.setting.findUnique({ where: { key: 'content.announcements' } });
  return parseSetting('content.announcements', row?.value);
}

/**
 * The bar as the storefront renders it.
 *
 * Public, and reduced here rather than in the browser: the switch and each
 * message's own toggle are resolved away, so what crosses the wire is the list
 * that is actually going to be shown. A bar that is off, or has nothing in it,
 * comes back as an empty list rather than as a flag the component has to
 * remember to check.
 *
 * Takes no actor for the same reason `getSeoDefaults` does not — this is text
 * rendered to every visitor. Changing it needs `content:write`.
 */
export async function getAnnouncementBar(): Promise<StorefrontAnnouncementsDto> {
  const row = await prisma.setting.findUnique({ where: { key: 'content.announcements' } });
  const bar = parseSetting('content.announcements', row?.value);

  return {
    rotateSeconds: bar.rotateSeconds,
    items: bar.enabled
      ? bar.items
          .filter((item) => item.isActive && item.textEn !== '')
          .map(({ textEn, textHi, url }) => ({ textEn, textHi, url }))
      : [],
  };
}

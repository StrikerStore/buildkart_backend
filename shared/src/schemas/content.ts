import { z } from 'zod';
import { optionalText } from './common.ts';

/**
 * Pages, menus and blog posts — the words the storefront says that are not a
 * product.
 *
 * Body HTML is validated only for *length* here. Its safety is the sanitiser's
 * job, on the write path, because a zod refinement that rejected unsafe markup
 * would hand the author an error instead of a cleaned-up document — and the
 * cleaning has to happen either way.
 */

const BODY_MAX = 200_000;

const slugField = z
  .string()
  .trim()
  .toLowerCase()
  .max(191)
  .transform((v) => (v === '' ? undefined : v))
  .optional()
  .refine(
    (v) => v === undefined || /^[a-z0-9]+(-[a-z0-9]+)*$/.test(v),
    'Use lowercase letters, numbers and hyphens only',
  );

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

/**
 * A VarChar plus this union rather than a database enum, for the reason
 * `HomepageSection.type` gives: page kinds churn and every MySQL enum change is
 * an ALTER on a live table.
 */
export const PAGE_KINDS = ['STANDARD', 'POLICY'] as const;
export type PageKind = (typeof PAGE_KINDS)[number];

export const PAGE_KIND_LABELS: Record<PageKind, string> = {
  STANDARD: 'Standard page',
  POLICY: 'Policy',
};

/**
 * The pages a payment gateway asks to see before approving a merchant account,
 * seeded as drafts so the owner edits rather than remembers.
 */
export const POLICY_SLUGS = [
  'privacy-policy',
  'terms-and-conditions',
  'refund-policy',
  'shipping-policy',
] as const;

export const pageSchema = z.object({
  id: z.string().max(64).optional(),
  slug: slugField,
  kind: z.enum(PAGE_KINDS).default('STANDARD'),
  titleEn: z.string().trim().min(1, 'Give the page a title').max(255),
  titleHi: optionalText(255),
  bodyHtmlEn: optionalText(BODY_MAX),
  bodyHtmlHi: optionalText(BODY_MAX),
  seoTitle: optionalText(255),
  seoDescription: optionalText(320),
  isPublished: z.boolean().default(false),
});
export type PageInput = z.infer<typeof pageSchema>;

// ---------------------------------------------------------------------------
// Blog
// ---------------------------------------------------------------------------

export const blogPostSchema = z.object({
  id: z.string().max(64).optional(),
  slug: slugField,
  titleEn: z.string().trim().min(1, 'Give the post a title').max(255),
  titleHi: optionalText(255),
  excerptEn: optionalText(500),
  excerptHi: optionalText(500),
  bodyHtmlEn: optionalText(BODY_MAX),
  bodyHtmlHi: optionalText(BODY_MAX),
  coverMediaId: optionalText(64),
  authorName: optionalText(191),
  seoTitle: optionalText(255),
  seoDescription: optionalText(320),
  isPublished: z.boolean().default(false),
});
export type BlogPostInput = z.infer<typeof blogPostSchema>;

// ---------------------------------------------------------------------------
// Menus
// ---------------------------------------------------------------------------

/** The menus the storefront asks for by handle. Fixed, because it renders them. */
export const MENU_HANDLES = ['header', 'footer', 'mobile'] as const;
export type MenuHandle = (typeof MENU_HANDLES)[number];

export const MENU_LABELS: Record<MenuHandle, string> = {
  header: 'Header',
  footer: 'Footer',
  mobile: 'Mobile menu',
};

export const MENU_TARGET_KINDS = ['CATEGORY', 'PAGE', 'BLOG', 'PRODUCT', 'URL'] as const;
export type MenuTargetKind = (typeof MENU_TARGET_KINDS)[number];

export const MENU_TARGET_LABELS: Record<MenuTargetKind, string> = {
  CATEGORY: 'Category',
  PAGE: 'Page',
  BLOG: 'Blog',
  PRODUCT: 'Product',
  URL: 'Web address',
};

/**
 * One link. `targetId` names a record for the first four kinds and is absent
 * for a raw URL; the write resolves either into `url`, which is what the
 * storefront actually renders.
 */
export const menuItemSchema = z
  .object({
    id: z.string().max(64).optional(),
    labelEn: z.string().trim().min(1, 'Give the link a label').max(191),
    labelHi: optionalText(191),
    targetKind: z.enum(MENU_TARGET_KINDS),
    targetId: optionalText(64),
    /** Only read for `URL`; the others resolve their own href from `targetId`. */
    url: optionalText(512),
    isActive: z.boolean().default(true),
    /** One level of nesting only — enforced by the shape, not by a runtime check. */
    children: z
      .array(
        z.object({
          id: z.string().max(64).optional(),
          labelEn: z.string().trim().min(1, 'Give the link a label').max(191),
          labelHi: optionalText(191),
          targetKind: z.enum(MENU_TARGET_KINDS),
          targetId: optionalText(64),
          url: optionalText(512),
          isActive: z.boolean().default(true),
        }),
      )
      .max(30)
      .default([]),
  })
  .superRefine((value, ctx) => {
    const check = (kind: MenuTargetKind, targetId?: string, url?: string, path: (string | number)[] = []) => {
      if (kind === 'URL') {
        if (!url?.trim()) {
          ctx.addIssue({ code: 'custom', path: [...path, 'url'], message: 'Enter a web address' });
        } else if (!/^(https?:\/\/|\/|#)/.test(url.trim())) {
          // A menu link that is not a URL renders as a dead entry in the header,
          // which is the most visible place on the site to have one.
          ctx.addIssue({
            code: 'custom',
            path: [...path, 'url'],
            message: 'Start with https://, / or #',
          });
        }
      } else if (!targetId?.trim()) {
        ctx.addIssue({
          code: 'custom',
          path: [...path, 'targetId'],
          message: `Choose which ${MENU_TARGET_LABELS[kind].toLowerCase()} to link to`,
        });
      }
    };

    check(value.targetKind, value.targetId, value.url);
    value.children.forEach((child, index) =>
      check(child.targetKind, child.targetId, child.url, ['children', index]),
    );
  });
export type MenuItemInput = z.infer<typeof menuItemSchema>;

/** A whole menu is saved at once: reordering and nesting are one edit, not many. */
export const saveMenuSchema = z.object({
  handle: z.enum(MENU_HANDLES),
  items: z.array(menuItemSchema).max(50),
});
export type SaveMenuInput = z.infer<typeof saveMenuSchema>;

// ---------------------------------------------------------------------------
// SEO defaults
// ---------------------------------------------------------------------------

export const seoDefaultsSchema = z.object({
  homeTitleEn: z.string().trim().max(70).default(''),
  homeTitleHi: z.string().trim().max(70).default(''),
  homeDescriptionEn: z.string().trim().max(320).default(''),
  homeDescriptionHi: z.string().trim().max(320).default(''),
  /** `%s` is replaced by the page's own title. */
  titleTemplate: z
    .string()
    .trim()
    .max(120)
    .default('%s | BuildKart')
    .refine((v) => v === '' || v.includes('%s'), 'Include %s where the page title should go'),
  defaultOgMediaId: z.string().trim().max(64).default(''),
  /** Off while the shop is being set up, so a half-built site is not indexed. */
  robotsIndexable: z.boolean().default(true),
});
export type SeoDefaultsInput = z.infer<typeof seoDefaultsSchema>;

/**
 * What search results truncate at. Not enforced — a longer title is legal and
 * merely gets cut — so these drive a warning on the form, not a validation error.
 */
export const SEO_TITLE_LIMIT = 60;
export const SEO_DESCRIPTION_LIMIT = 160;

// ---------------------------------------------------------------------------
// Announcement bar
// ---------------------------------------------------------------------------

/**
 * Short enough to fit one line of a 360px phone.
 *
 * Enforced rather than advisory, unlike the SEO limits above, and the reason is
 * the bar itself: it is a fixed-height strip, so a message that does not fit
 * either truncates mid-word or pushes the header down the page. Refusing the
 * text at the point it is typed is the only version of this the owner can act
 * on — the other two are discovered by a customer.
 */
export const ANNOUNCEMENT_TEXT_LIMIT = 90;

export const announcementBarSchema = z.object({
  enabled: z.boolean().default(true),
  /**
   * Coerced because the form sends a string. Floored at two seconds: below that
   * a message is gone before it can be read, which is worse than not showing it.
   */
  rotateSeconds: z.coerce.number().int().min(2, 'At least 2 seconds').max(30).default(5),
  items: z
    .array(
      z.object({
        textEn: z.string().trim().max(ANNOUNCEMENT_TEXT_LIMIT).default(''),
        textHi: z.string().trim().max(ANNOUNCEMENT_TEXT_LIMIT).default(''),
        /*
         * Empty means the message is not a link — a plain string rather than
         * `optionalText`, which maps '' to undefined. That is the right shape
         * for a nullable column and the wrong one here: this lands in a JSON
         * blob whose read schema declares `url: string`, so writing undefined
         * would drop the key and make the write and the read disagree about a
         * field neither of them needs to be clever about.
         */
        url: z.string().trim().max(512).default(''),
        isActive: z.boolean().default(true),
      }),
    )
    .max(10, 'Ten messages is already more than anyone will read')
    /*
     * A row with no English text is dropped rather than rejected. The form adds
     * an empty row when the owner clicks Add, so an unfilled one is the normal
     * way to change your mind — refusing the save would make the button a trap.
     * Hindi alone is not enough: English is the fallback every locale falls
     * back to, so a row without it would render blank for half the audience.
     */
    .transform((items) => items.filter((item) => item.textEn !== ''))
    .default([]),
});
export type AnnouncementBarInput = z.infer<typeof announcementBarSchema>;

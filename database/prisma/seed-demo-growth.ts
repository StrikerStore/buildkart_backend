import { prisma } from '../src/client.ts';

/**
 * Demo data for the growth screens: delivery areas, discounts, area requests,
 * banners and the homepage.
 *
 * Split out for the same reason the order book was — the catalogue, the orders
 * and the shop's configuration are three different stories. Runs after both, so
 * discounts and homepage sections can point at real categories and tags.
 */

const TODAY = new Date();
const daysAgo = (n: number) => new Date(TODAY.getTime() - n * 86_400_000);
const daysAhead = (n: number) => new Date(TODAY.getTime() + n * 86_400_000);

/** Real Indore pincodes, with promises that vary the way they actually would. */
const AREAS = [
  { pincode: '452001', areaNameEn: 'Nehru Nagar & Bhawarkua', areaNameHi: 'नेहरू नगर', promiseHours: 4, cutoffTime: '18:00' },
  { pincode: '452010', areaNameEn: 'Vijay Nagar & Scheme 78', areaNameHi: 'विजय नगर', promiseHours: 4, cutoffTime: '18:00' },
  { pincode: '452015', areaNameEn: 'Sanwer Road Industrial', areaNameHi: 'सांवेर रोड', promiseHours: 6, cutoffTime: '16:00' },
  { pincode: '452016', areaNameEn: 'Lasudia & MR-10', areaNameHi: 'लसूड़िया', promiseHours: 4, cutoffTime: '18:00' },
  { pincode: '452018', areaNameEn: 'Old Palasia', areaNameHi: 'पुरानी पलासिया', promiseHours: 4, cutoffTime: '18:00' },
  // Deliberately paused, so the "listed but paused" state has something behind it.
  { pincode: '453331', areaNameEn: 'Rau & Bypass', areaNameHi: 'राऊ', promiseHours: 8, cutoffTime: '15:00', isActive: false },
];

/**
 * The delivery charge for flat-priced products — the owner's own example: a
 * base by what the cart is worth, plus every distance range the trip passes
 * through, and free from ₹10,000.
 */
const DELIVERY_CHARGES = {
  roadFactor: 1.3,
  slabs: [
    { from: '0.00', base: '300.00' },
    { from: '1000.00', base: '200.00' },
    { from: '5000.00', base: '100.00' },
  ],
  ranges: [
    { upToKm: 5, addition: '30.00' },
    { upToKm: 10, addition: '15.00' },
    { upToKm: 20, addition: '10.00' },
  ],
  freeAbove: '10000.00',
};

/** Cement is priced by distance: ₹10 a bag at the gate, ₹5 more per 5 km started. */
const DISTANCE_PRICED_TYPES = ['Cement'];

/** Pincodes people asked for, including one that has since opened. */
const REQUESTS = [
  { pincode: '452020', phones: ['9826022001', '9826022002', '9826022003', '9826022004'] },
  { pincode: '453551', phones: ['9826022005', '9826022006'] },
  { pincode: '452005', phones: ['9826022007'] },
  // Already serviceable: shows the "mark as told" path with people waiting.
  { pincode: '452016', phones: ['9826022008', '9826022009'] },
];

export async function seedGrowth(): Promise<{
  areas: number;
  requests: number;
  discounts: number;
  banners: number;
  sections: number;
}> {
  // --- delivery areas ------------------------------------------------------
  for (const [index, area] of AREAS.entries()) {
    await prisma.serviceablePincode.create({
      data: {
        pincode: area.pincode,
        areaNameEn: area.areaNameEn,
        areaNameHi: area.areaNameHi,
        city: 'Indore',
        promiseHours: area.promiseHours,
        cutoffTime: area.cutoffTime,
        isActive: area.isActive ?? true,
        position: index,
      },
    });
  }

  await prisma.setting.upsert({
    where: { key: 'delivery.charges' },
    create: { key: 'delivery.charges', value: DELIVERY_CHARGES },
    update: { value: DELIVERY_CHARGES },
  });

  await prisma.product.updateMany({
    where: { productType: { in: DISTANCE_PRICED_TYPES } },
    data: {
      pricingKind: 'DISTANCE',
      distanceBaseAddition: '10.00',
      distanceBlockKm: 5,
      distancePerBlockAddition: '5.00',
    },
  });

  let requestCount = 0;
  for (const group of REQUESTS) {
    for (const [index, phone] of group.phones.entries()) {
      await prisma.pincodeRequest.create({
        data: {
          pincode: group.pincode,
          phone,
          // Someone who asked three times is a stronger signal than three
          // people asking once, and the screen totals both.
          count: (index % 3) + 1,
          firstRequestedAt: daysAgo(20 - index),
          lastRequestedAt: daysAgo(index),
        },
      });
      requestCount += 1;
    }
  }

  // --- discounts -----------------------------------------------------------
  const cement = await prisma.category.findUnique({ where: { slug: 'cement' } });
  const clearanceTag = await prisma.tag.findFirst({ where: { nameEn: 'Clearance' } });

  const discounts = [
    {
      code: 'MONSOON20',
      trigger: 'CODE' as const,
      type: 'PERCENT' as const,
      value: '20',
      maxDiscountAmount: '2000.00',
      minOrderValue: '5000.00',
      usageLimit: 200,
      perCustomerLimit: 1,
      usageCount: 37,
      startsAt: daysAgo(15),
      endsAt: daysAhead(20),
      appliesToAll: true,
    },
    {
      code: 'FIRST500',
      trigger: 'CODE' as const,
      type: 'FIXED_AMOUNT' as const,
      value: '500.00',
      minOrderValue: '10000.00',
      perCustomerLimit: 1,
      usageCount: 12,
      startsAt: daysAgo(45),
      appliesToAll: true,
    },
    {
      // Narrowed to cement: the case worth being able to see on screen.
      code: 'CEMENT10',
      trigger: 'CODE' as const,
      type: 'PERCENT' as const,
      value: '10',
      usageCount: 4,
      startsAt: daysAgo(5),
      endsAt: daysAhead(10),
      appliesToAll: false,
      categoryIds: cement ? [cement.id] : [],
    },
    {
      // No code: applies on its own once the order is big enough.
      trigger: 'AUTOMATIC' as const,
      type: 'FREE_DELIVERY' as const,
      value: '0',
      minOrderValue: '15000.00',
      usageCount: 21,
      startsAt: daysAgo(60),
      appliesToAll: true,
    },
    {
      code: 'CLEARANCE15',
      trigger: 'CODE' as const,
      type: 'PERCENT' as const,
      value: '15',
      usageCount: 0,
      startsAt: daysAgo(90),
      // Already over, so the Expired state has something behind it.
      endsAt: daysAgo(30),
      appliesToAll: false,
      tagIds: clearanceTag ? [clearanceTag.id] : [],
    },
    {
      code: 'DIWALI25',
      trigger: 'CODE' as const,
      type: 'PERCENT' as const,
      value: '25',
      maxDiscountAmount: '3000.00',
      usageLimit: 500,
      usageCount: 0,
      // Not started yet: the Scheduled state.
      startsAt: daysAhead(30),
      endsAt: daysAhead(45),
      isActive: true,
      appliesToAll: true,
    },
  ];

  for (const entry of discounts) {
    const { categoryIds, tagIds, ...values } = entry as typeof entry & {
      categoryIds?: string[];
      tagIds?: string[];
    };
    const discount = await prisma.discount.create({ data: values });

    if (categoryIds?.length) {
      await prisma.discountCategory.createMany({
        data: categoryIds.map((categoryId) => ({ discountId: discount.id, categoryId })),
      });
    }
    if (tagIds?.length) {
      await prisma.discountTag.createMany({
        data: tagIds.map((tagId) => ({ discountId: discount.id, tagId })),
      });
    }
  }

  // --- banners -------------------------------------------------------------
  // Only real uploads can be placed; a banner pointing at nothing would render
  // as a broken image on the shop's front page.
  const media = await prisma.media.findMany({ where: { status: 'READY' }, take: 2 });
  let bannerCount = 0;
  if (media[0]) {
    await prisma.banner.create({
      data: {
        titleEn: 'Monsoon waterproofing',
        titleHi: 'मानसून वॉटरप्रूफिंग',
        mediaIdDesktop: media[0].id,
        mediaIdMobile: media[1]?.id ?? null,
        linkUrl: '/category/cement',
        placement: 'HOME_HERO',
        position: 0,
        isActive: true,
      },
    });
    bannerCount += 1;

    await prisma.banner.create({
      data: {
        titleEn: 'Bulk rates on TMT bars',
        mediaIdDesktop: media[0].id,
        linkUrl: '/category/sariya',
        placement: 'HOME_STRIP',
        position: 0,
        isActive: true,
        startsAt: daysAgo(3),
        endsAt: daysAhead(14),
      },
    });
    bannerCount += 1;
  }

  // --- homepage ------------------------------------------------------------
  const categories = await prisma.category.findMany({
    where: { parentId: null, isActive: true },
    orderBy: { position: 'asc' },
    take: 6,
    select: { id: true },
  });
  const bestseller = await prisma.tag.findFirst({ where: { nameEn: 'Bestseller' } });
  const featured = await prisma.product.findMany({
    where: { status: 'ACTIVE' },
    orderBy: { nameEn: 'asc' },
    take: 6,
    select: { id: true },
  });

  const sections = [
    { type: 'CATEGORY_GRID', titleEn: 'Shop by category', titleHi: 'श्रेणी से खरीदें', configJson: { categoryIds: categories.map((c) => c.id), limit: 12 } },
    { type: 'RATE_TICKER', titleEn: "Today's rates", titleHi: 'आज के भाव', configJson: { limit: 8 } },
    ...(bestseller
      ? [{ type: 'TAG_CAROUSEL', titleEn: 'Bestsellers', titleHi: 'सबसे ज़्यादा बिकने वाले', configJson: { tagSlug: bestseller.slug, limit: 12 } }]
      : []),
    { type: 'PRODUCT_CAROUSEL', titleEn: 'Picked for contractors', configJson: { productIds: featured.map((p) => p.id), limit: 12 } },
    { type: 'BANNER_STRIP', titleEn: null, configJson: { limit: 4 } },
    // Closes the banner block: the hero, the promo cards and the promise read
    // as one unit before the merchandising starts.
    { type: 'TRUST_STRIP', titleEn: null, configJson: { markers: ['fast', 'cod', 'genuine', 'rates'] } },
    // Last, below the shop's own bands: a returning shopper's history should
    // not push this week's merchandising below the fold.
    { type: 'RECENTLY_VIEWED', titleEn: null, configJson: { limit: 12 } },
  ];

  for (const [index, section] of sections.entries()) {
    await prisma.homepageSection.create({
      data: {
        type: section.type,
        titleEn: section.titleEn ?? null,
        titleHi: (section as { titleHi?: string }).titleHi ?? null,
        configJson: section.configJson as never,
        position: index,
        isActive: true,
      },
    });
  }

  return {
    areas: AREAS.length,
    requests: requestCount,
    discounts: discounts.length,
    banners: bannerCount,
    sections: sections.length,
  };
}

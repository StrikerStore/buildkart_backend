import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// One .env at the repo root serves every workspace. dotenv resolves relative to
// process.cwd(), which is packages/database when npm runs this script, so the
// path is pinned to this file's own location instead.
loadEnv({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.env'), quiet: true });
import { prisma } from '../src/client.ts';
import { matrixKeyOf, generateSku } from '@buildkart/shared';
import { seedOrders, DEMO_CUSTOMERS } from './seed-demo-orders.ts';
import { seedGrowth } from './seed-demo-growth.ts';
import { seedSupport } from './seed-demo-support.ts';

/**
 * Demo catalogue.
 *
 * Fills every screen built so far with realistic BuildKart data — cement,
 * sariya, plywood, sunmica, wires, sanitary — so the admin can be judged with
 * content rather than empty states. Deliberately covers the awkward cases as
 * well as the happy ones: two-axis variants, out-of-stock and low-stock rows,
 * drafts and archived products, a scheduled publish, bilingual names, custom
 * fields, badge and workflow tags, a tag-driven category, price history and an
 * inventory ledger.
 *
 * Catalogue only. The owner account and store settings are never touched, so
 * this is safe to re-run: it clears the catalogue and rebuilds it.
 *
 *   npm run db:seed:demo
 */

const TODAY = new Date();
const daysAgo = (n: number) => new Date(TODAY.getTime() - n * 86_400_000);

async function clearCatalogue() {
  // Order matters: rules and joins before the rows they point at.
  // Orders lead, because Order -> Customer is Restrict and OrderItem carries
  // references into the catalogue cleared below it.
  await prisma.discountRedemption.deleteMany({});
  await prisma.discountCategory.deleteMany({});
  await prisma.discountProduct.deleteMany({});
  await prisma.discountTag.deleteMany({});
  await prisma.banner.deleteMany({});
  await prisma.homepageSection.deleteMany({});
  await prisma.pincodeRequest.deleteMany({});
  await prisma.serviceablePincode.deleteMany({});
  await prisma.orderStatusEvent.deleteMany({});
  await prisma.paymentTransaction.deleteMany({});
  await prisma.orderItem.deleteMany({});
  await prisma.order.deleteMany({});
  await prisma.discount.deleteMany({});
  await prisma.address.deleteMany({});
  await prisma.customer.deleteMany({});

  await prisma.categoryTagRule.deleteMany({});
  await prisma.inventoryAdjustment.deleteMany({});
  await prisma.priceHistory.deleteMany({});
  await prisma.importImageTask.deleteMany({});
  await prisma.importJobIssue.deleteMany({});
  await prisma.importJob.deleteMany({});
  await prisma.metafield.deleteMany({});
  await prisma.metafieldDefinition.deleteMany({});
  await prisma.productImage.deleteMany({});
  await prisma.product.deleteMany({});
  await prisma.tag.deleteMany({});
  await prisma.brand.deleteMany({});
  await prisma.category.deleteMany({ where: { parentId: { not: null } } });
  await prisma.category.deleteMany({});

  // Uploads that were presigned but never confirmed are debris the nightly GC
  // would sweep anyway; clearing them keeps the media library honest.
  await prisma.media.deleteMany({ where: { status: { in: ['PENDING', 'FAILED'] } } });
}

type VariantSeed = {
  values: string[];
  price: string;
  bulkPrice?: string;
  compareAt?: string;
  cost?: string;
  stock: number;
  lowStock?: number;
};

type ProductSeed = {
  handle: string;
  nameEn: string;
  nameHi?: string;
  bodyEn?: string;
  category: string;
  brand?: string;
  type?: string;
  status?: 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
  scheduledIn?: number;
  rateVolatile?: boolean;
  unitEn?: string;
  unitHi?: string;
  keywords?: string;
  tags?: string[];
  axes?: Array<{ name: string; values: string[] }>;
  variants: VariantSeed[];
  fields?: Record<string, string | string[] | boolean>;
};

const CATEGORIES = [
  {
    slug: 'cement',
    nameEn: 'Cement',
    nameHi: 'सीमेंट',
    rateVolatile: true,
    children: [
      { slug: 'opc-cement', nameEn: 'OPC Cement', nameHi: 'ओपीसी सीमेंट' },
      { slug: 'ppc-cement', nameEn: 'PPC Cement', nameHi: 'पीपीसी सीमेंट' },
    ],
  },
  { slug: 'sariya', nameEn: 'Sariya (TMT Bars)', nameHi: 'सरिया', rateVolatile: true },
  { slug: 'plywood', nameEn: 'Plywood & Boards', nameHi: 'प्लाईवुड' },
  { slug: 'sunmica', nameEn: 'Sunmica & Laminates', nameHi: 'सनमाइका' },
  { slug: 'electrical', nameEn: 'Electrical', nameHi: 'बिजली का सामान' },
  { slug: 'sanitary', nameEn: 'Tiles & Sanitary', nameHi: 'टाइल्स और सैनिटरी' },
];

const BRANDS = [
  'UltraTech',
  'ACC',
  'Ambuja',
  'Tata Tiscon',
  'JSW Neosteel',
  'Century Ply',
  'Greenply',
  'Merino',
  'Havells',
  'Finolex',
  'Jaquar',
  'Asian Paints',
];

const TAGS = [
  {
    slug: 'bestseller',
    nameEn: 'Bestseller',
    nameHi: 'सबसे ज़्यादा बिकने वाला',
    description: 'Top sellers, reviewed monthly',
    scope: 'PUBLIC' as const,
    showAsBadge: true,
    badgeLabelEn: 'Bestseller',
    badgeTone: 'BRAND' as const,
    position: 1,
  },
  {
    slug: 'new-arrival',
    nameEn: 'New Arrival',
    nameHi: 'नया',
    scope: 'PUBLIC' as const,
    showAsBadge: true,
    badgeLabelEn: 'New',
    badgeTone: 'INFO' as const,
    position: 2,
  },
  {
    slug: 'clearance',
    nameEn: 'Clearance',
    nameHi: 'क्लीयरेंस',
    description: 'Discounted stock being run down',
    scope: 'PUBLIC' as const,
    showAsBadge: true,
    badgeLabelEn: 'Clearance',
    badgeTone: 'CRITICAL' as const,
    position: 3,
  },
  {
    slug: 'isi-marked',
    nameEn: 'ISI Marked',
    scope: 'PUBLIC' as const,
    showAsBadge: true,
    badgeLabelEn: 'ISI',
    badgeTone: 'SUCCESS' as const,
    position: 4,
  },
  // Internal: workflow only, never shown to a customer.
  {
    slug: 'needs-review',
    nameEn: 'Needs Review',
    description: 'Description or photos still to check',
    scope: 'INTERNAL' as const,
    position: 10,
  },
  {
    slug: 'priority-restock',
    nameEn: 'Priority Restock',
    description: 'Reorder before it runs out',
    scope: 'INTERNAL' as const,
    position: 11,
  },
  {
    slug: 'pending-photos',
    nameEn: 'Pending Photos',
    scope: 'INTERNAL' as const,
    position: 12,
  },
];

const DEFINITIONS = [
  {
    key: 'grade',
    nameEn: 'Grade',
    nameHi: 'ग्रेड',
    type: 'SINGLE_LINE_TEXT' as const,
    isFilterable: true,
    description: 'Strength grade, e.g. OPC 53 or Fe500',
    choices: ['OPC 43', 'OPC 53', 'PPC', 'Fe500', 'Fe550', 'Fe600'],
  },
  {
    key: 'thickness',
    nameEn: 'Thickness',
    type: 'DIMENSION' as const,
    isFilterable: true,
    description: 'Sheet or board thickness with its unit',
  },
  {
    key: 'isi_certified',
    nameEn: 'ISI Certified',
    type: 'BOOLEAN' as const,
    isFilterable: true,
  },
  {
    key: 'applications',
    nameEn: 'Applications',
    type: 'LIST_SINGLE_LINE_TEXT' as const,
    isFilterable: true,
    description: 'Where it is typically used',
  },
  {
    key: 'warranty_years',
    nameEn: 'Warranty (years)',
    type: 'NUMBER_INTEGER' as const,
  },
];

const PRODUCTS: ProductSeed[] = [
  {
    handle: 'ultratech-opc-53-50kg',
    nameEn: 'UltraTech Cement OPC 53 Grade, 50 kg',
    nameHi: 'अल्ट्राटेक सीमेंट ओपीसी 53 ग्रेड, 50 किग्रा',
    bodyEn:
      '<p>High-strength OPC 53 grade cement for structural concrete, columns and beams. Consistent setting time and low chloride content.</p>',
    category: 'opc-cement',
    brand: 'UltraTech',
    type: 'Cement',
    rateVolatile: true,
    unitEn: 'per bag',
    unitHi: 'प्रति बोरी',
    keywords: 'cement, siment, ultratech, opc, 53 grade',
    tags: ['Bestseller', 'ISI Marked'],
    variants: [{ values: [], price: '432.00', bulkPrice: '415.00', cost: '385.00', stock: 240, lowStock: 40 }],
    fields: { grade: 'OPC 53', isi_certified: true, applications: ['Columns', 'Beams', 'Slabs'] },
  },
  {
    handle: 'acc-ppc-50kg',
    nameEn: 'ACC Suraksha PPC Cement, 50 kg',
    nameHi: 'एसीसी सुरक्षा पीपीसी सीमेंट, 50 किग्रा',
    bodyEn: '<p>Portland Pozzolana cement for plaster, brickwork and general masonry. Smoother finish and better workability than OPC.</p>',
    category: 'ppc-cement',
    brand: 'ACC',
    type: 'Cement',
    rateVolatile: true,
    unitEn: 'per bag',
    unitHi: 'प्रति बोरी',
    keywords: 'cement, ppc, acc, plaster',
    tags: ['ISI Marked'],
    variants: [{ values: [], price: '398.00', bulkPrice: '382.00', cost: '356.00', stock: 180, lowStock: 40 }],
    fields: { grade: 'PPC', isi_certified: true, applications: ['Plaster', 'Brickwork'] },
  },
  {
    handle: 'ambuja-plus-ppc-50kg',
    nameEn: 'Ambuja Plus PPC Cement, 50 kg',
    nameHi: 'अंबुजा प्लस पीपीसी सीमेंट, 50 किग्रा',
    category: 'ppc-cement',
    brand: 'Ambuja',
    type: 'Cement',
    rateVolatile: true,
    unitEn: 'per bag',
    keywords: 'cement, ambuja, ppc',
    variants: [{ values: [], price: '405.00', bulkPrice: '390.00', cost: '362.00', stock: 26, lowStock: 40 }],
    tags: ['Priority Restock'],
    fields: { grade: 'PPC', isi_certified: true },
  },
  {
    handle: 'tata-tiscon-tmt-sariya',
    nameEn: 'Tata Tiscon 550SD TMT Sariya',
    nameHi: 'टाटा टिस्कॉन 550SD सरिया',
    bodyEn: '<p>High-ductility TMT bars with superior earthquake resistance. Rib pattern gives strong bonding with concrete.</p>',
    category: 'sariya',
    brand: 'Tata Tiscon',
    type: 'TMT Bar',
    rateVolatile: true,
    unitEn: 'per kg',
    unitHi: 'प्रति किलो',
    keywords: 'sariya, saria, sarya, tmt, rebar, steel, tata',
    tags: ['Bestseller', 'ISI Marked'],
    axes: [{ name: 'Size', values: ['8mm', '10mm', '12mm', '16mm', '20mm'] }],
    variants: [
      { values: ['8mm'], price: '74.50', bulkPrice: '71.00', cost: '66.00', stock: 1800, lowStock: 500 },
      { values: ['10mm'], price: '72.00', bulkPrice: '68.50', cost: '64.00', stock: 2400, lowStock: 500 },
      { values: ['12mm'], price: '70.50', bulkPrice: '67.00', cost: '62.50', stock: 3100, lowStock: 500 },
      { values: ['16mm'], price: '69.80', bulkPrice: '66.50', cost: '62.00', stock: 420, lowStock: 500 },
      { values: ['20mm'], price: '69.20', bulkPrice: '66.00', cost: '61.50', stock: 0, lowStock: 500 },
    ],
    fields: { grade: 'Fe550', isi_certified: true, applications: ['Columns', 'Slabs', 'Foundation'] },
  },
  {
    handle: 'jsw-neosteel-fe500d',
    nameEn: 'JSW Neosteel Fe500D TMT Sariya',
    nameHi: 'जेएसडब्ल्यू नियोस्टील Fe500D सरिया',
    category: 'sariya',
    brand: 'JSW Neosteel',
    type: 'TMT Bar',
    rateVolatile: true,
    unitEn: 'per kg',
    keywords: 'sariya, saria, tmt, jsw, fe500',
    axes: [{ name: 'Size', values: ['8mm', '10mm', '12mm'] }],
    variants: [
      { values: ['8mm'], price: '73.00', bulkPrice: '70.00', cost: '65.00', stock: 900, lowStock: 300 },
      { values: ['10mm'], price: '71.20', bulkPrice: '68.00', cost: '63.50', stock: 1200, lowStock: 300 },
      { values: ['12mm'], price: '69.90', bulkPrice: '66.80', cost: '62.00', stock: 240, lowStock: 300 },
    ],
    fields: { grade: 'Fe500', isi_certified: true },
  },
  {
    handle: 'century-club-prime-plywood',
    nameEn: 'Century Club Prime BWP Plywood, 8 x 4 ft',
    nameHi: 'सेंचुरी क्लब प्राइम बीडब्ल्यूपी प्लाईवुड',
    bodyEn: '<p>Boiling-water-proof plywood with a 25-year warranty. Borer and termite treated, suitable for kitchens and bathrooms.</p>',
    category: 'plywood',
    brand: 'Century Ply',
    type: 'Plywood',
    unitEn: 'per sheet',
    unitHi: 'प्रति शीट',
    keywords: 'plywood, ply, bwp, marine, century',
    tags: ['Bestseller'],
    // Two axes: the case a single-axis importer gets wrong.
    axes: [
      { name: 'Thickness', values: ['12mm', '16mm', '19mm'] },
      { name: 'Grade', values: ['BWP', 'MR'] },
    ],
    variants: [
      { values: ['12mm', 'BWP'], price: '2450.00', bulkPrice: '2340.00', cost: '2080.00', stock: 42, lowStock: 10 },
      { values: ['12mm', 'MR'], price: '1890.00', bulkPrice: '1810.00', cost: '1610.00', stock: 55, lowStock: 10 },
      { values: ['16mm', 'BWP'], price: '3120.00', bulkPrice: '2990.00', cost: '2650.00', stock: 28, lowStock: 10 },
      { values: ['16mm', 'MR'], price: '2410.00', bulkPrice: '2310.00', cost: '2050.00', stock: 31, lowStock: 10 },
      { values: ['19mm', 'BWP'], price: '3680.00', bulkPrice: '3520.00', cost: '3120.00', stock: 6, lowStock: 10 },
      { values: ['19mm', 'MR'], price: '2870.00', bulkPrice: '2750.00', cost: '2440.00', stock: 19, lowStock: 10 },
    ],
    fields: { thickness: '19 mm', isi_certified: true, warranty_years: '25', applications: ['Kitchen', 'Wardrobe', 'Furniture'] },
  },
  {
    handle: 'greenply-mr-plywood',
    nameEn: 'Greenply Ecotec MR Plywood, 8 x 4 ft',
    category: 'plywood',
    brand: 'Greenply',
    type: 'Plywood',
    unitEn: 'per sheet',
    keywords: 'plywood, ply, mr, greenply, commercial',
    axes: [{ name: 'Thickness', values: ['6mm', '9mm', '12mm', '18mm'] }],
    variants: [
      { values: ['6mm'], price: '1180.00', cost: '1010.00', stock: 64, lowStock: 15 },
      { values: ['9mm'], price: '1520.00', cost: '1310.00', stock: 48, lowStock: 15 },
      { values: ['12mm'], price: '1840.00', cost: '1580.00', stock: 12, lowStock: 15 },
      { values: ['18mm'], price: '2620.00', cost: '2260.00', stock: 22, lowStock: 15 },
    ],
    fields: { warranty_years: '7', applications: ['Partition', 'False ceiling'] },
  },
  {
    handle: 'merino-sunmica-1mm',
    nameEn: 'Merino Decorative Laminate 1 mm, 8 x 4 ft',
    nameHi: 'मेरिनो सनमाइका 1 मिमी',
    bodyEn: '<p>Scratch-resistant decorative laminate for furniture surfaces. Wide range of finishes.</p>',
    category: 'sunmica',
    brand: 'Merino',
    type: 'Laminate',
    unitEn: 'per sheet',
    unitHi: 'प्रति शीट',
    keywords: 'sunmica, laminate, merino, mica',
    tags: ['New Arrival'],
    axes: [{ name: 'Finish', values: ['Glossy', 'Matte', 'Textured'] }],
    variants: [
      { values: ['Glossy'], price: '1340.00', compareAt: '1580.00', cost: '1120.00', stock: 38, lowStock: 10 },
      { values: ['Matte'], price: '1290.00', compareAt: '1520.00', cost: '1080.00', stock: 44, lowStock: 10 },
      { values: ['Textured'], price: '1470.00', compareAt: '1720.00', cost: '1240.00', stock: 9, lowStock: 10 },
    ],
    fields: { thickness: '1 mm', applications: ['Furniture', 'Shutters'] },
  },
  {
    handle: 'havells-fr-wire-90m',
    nameEn: 'Havells Life Line FR Wire, 90 m coil',
    nameHi: 'हैवेल्स लाइफ लाइन एफआर वायर, 90 मीटर',
    bodyEn: '<p>Flame-retardant PVC insulated copper wire for domestic and commercial wiring.</p>',
    category: 'electrical',
    brand: 'Havells',
    type: 'Wire',
    unitEn: 'per coil',
    unitHi: 'प्रति कॉइल',
    keywords: 'wire, cable, havells, copper, tar',
    tags: ['Bestseller', 'ISI Marked'],
    axes: [{ name: 'Size', values: ['1.0 sq mm', '1.5 sq mm', '2.5 sq mm', '4.0 sq mm'] }],
    variants: [
      { values: ['1.0 sq mm'], price: '1090.00', bulkPrice: '1040.00', cost: '920.00', stock: 34, lowStock: 12 },
      { values: ['1.5 sq mm'], price: '1580.00', bulkPrice: '1510.00', cost: '1340.00', stock: 51, lowStock: 12 },
      { values: ['2.5 sq mm'], price: '2490.00', bulkPrice: '2380.00', cost: '2120.00', stock: 27, lowStock: 12 },
      { values: ['4.0 sq mm'], price: '3860.00', bulkPrice: '3700.00', cost: '3290.00', stock: 4, lowStock: 12 },
    ],
    fields: { isi_certified: true, applications: ['House wiring', 'Conduit'] },
  },
  {
    handle: 'finolex-pvc-conduit',
    nameEn: 'Finolex PVC Conduit Pipe, 3 m',
    category: 'electrical',
    brand: 'Finolex',
    type: 'Conduit',
    unitEn: 'per length',
    keywords: 'conduit, pipe, finolex, pvc',
    axes: [{ name: 'Size', values: ['20mm', '25mm', '32mm'] }],
    variants: [
      { values: ['20mm'], price: '148.00', cost: '124.00', stock: 320, lowStock: 60 },
      { values: ['25mm'], price: '196.00', cost: '166.00', stock: 210, lowStock: 60 },
      { values: ['32mm'], price: '268.00', cost: '228.00', stock: 48, lowStock: 60 },
    ],
    fields: { isi_certified: true },
  },
  {
    handle: 'jaquar-continental-basin-mixer',
    nameEn: 'Jaquar Continental Single Lever Basin Mixer',
    nameHi: 'जगुआर कॉन्टिनेंटल बेसिन मिक्सर',
    bodyEn: '<p>Chrome-finished single lever basin mixer with ceramic cartridge.</p>',
    category: 'sanitary',
    brand: 'Jaquar',
    type: 'Tap',
    unitEn: 'per piece',
    keywords: 'tap, mixer, jaquar, basin, nal',
    tags: ['New Arrival'],
    variants: [{ values: [], price: '4290.00', compareAt: '4890.00', cost: '3560.00', stock: 14, lowStock: 5 }],
    fields: { warranty_years: '10', applications: ['Bathroom', 'Wash basin'] },
  },
  {
    handle: 'asian-paints-tile-adhesive-20kg',
    nameEn: 'Asian Paints SmartCare Tile Adhesive, 20 kg',
    nameHi: 'एशियन पेंट्स टाइल एडहेसिव, 20 किग्रा',
    category: 'sanitary',
    brand: 'Asian Paints',
    type: 'Adhesive',
    unitEn: 'per bag',
    unitHi: 'प्रति बोरी',
    keywords: 'adhesive, tile, gum, chemical',
    variants: [{ values: [], price: '612.00', bulkPrice: '588.00', cost: '512.00', stock: 0, lowStock: 20 }],
    tags: ['Priority Restock'],
    fields: { applications: ['Floor tiles', 'Wall tiles'] },
  },
  {
    handle: 'ultratech-white-cement-5kg',
    nameEn: 'UltraTech White Cement Wall Putty, 5 kg',
    category: 'cement',
    brand: 'UltraTech',
    type: 'Putty',
    unitEn: 'per bag',
    keywords: 'putty, white cement, wall',
    tags: ['Clearance'],
    variants: [{ values: [], price: '285.00', compareAt: '340.00', cost: '236.00', stock: 62, lowStock: 15 }],
  },
  {
    handle: 'greenply-club-plus-19mm',
    nameEn: 'Greenply Club Plus BWP Plywood 19 mm',
    category: 'plywood',
    brand: 'Greenply',
    type: 'Plywood',
    unitEn: 'per sheet',
    // Still being prepared: a draft with photos outstanding.
    status: 'DRAFT',
    tags: ['Needs Review', 'Pending Photos'],
    variants: [{ values: [], price: '3450.00', cost: '2980.00', stock: 0, lowStock: 5 }],
    fields: { thickness: '19 mm', warranty_years: '15' },
  },
  {
    handle: 'monsoon-waterproofing-kit',
    nameEn: 'Monsoon Waterproofing Starter Kit',
    nameHi: 'मानसून वॉटरप्रूफिंग किट',
    bodyEn: '<p>Seasonal bundle: waterproof coating, sealant and applicator.</p>',
    category: 'sanitary',
    brand: 'Asian Paints',
    type: 'Kit',
    unitEn: 'per kit',
    // Scheduled: goes live on its own before the season.
    status: 'DRAFT',
    scheduledIn: 6,
    tags: ['New Arrival'],
    variants: [{ values: [], price: '2190.00', cost: '1840.00', stock: 30, lowStock: 8 }],
  },
  {
    handle: 'legacy-mica-sheet',
    nameEn: 'Legacy Mica Sheet 0.8 mm (discontinued)',
    category: 'sunmica',
    brand: 'Merino',
    type: 'Laminate',
    unitEn: 'per sheet',
    // Archived: kept so past orders still resolve.
    status: 'ARCHIVED',
    variants: [{ values: [], price: '880.00', cost: '740.00', stock: 0 }],
  },
];

async function main() {
  console.log('Seeding the demo catalogue…\n');
  await clearCatalogue();

  // --- categories -----------------------------------------------------------
  const categoryIds = new Map<string, string>();
  let position = 100;
  for (const category of CATEGORIES) {
    const created = await prisma.category.create({
      data: {
        slug: category.slug,
        nameEn: category.nameEn,
        nameHi: category.nameHi,
        position,
        isRateVolatile: category.rateVolatile ?? false,
      },
    });
    categoryIds.set(category.slug, created.id);
    position += 100;

    let childPosition = 100;
    for (const child of category.children ?? []) {
      const createdChild = await prisma.category.create({
        data: {
          slug: child.slug,
          nameEn: child.nameEn,
          nameHi: child.nameHi,
          parentId: created.id,
          position: childPosition,
          // Inherit the daily-rate flag, so Today's Rates picks these up too.
          isRateVolatile: category.rateVolatile ?? false,
        },
      });
      categoryIds.set(child.slug, createdChild.id);
      childPosition += 100;
    }
  }
  console.log(`  ${categoryIds.size} categories`);

  // --- brands ---------------------------------------------------------------
  const brandIds = new Map<string, string>();
  for (const name of BRANDS) {
    const created = await prisma.brand.create({
      data: { slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), nameEn: name },
    });
    brandIds.set(name, created.id);
  }
  console.log(`  ${brandIds.size} brands`);

  // --- tags -----------------------------------------------------------------
  const tagIds = new Map<string, string>();
  for (const tag of TAGS) {
    const created = await prisma.tag.create({ data: tag });
    tagIds.set(tag.nameEn, created.id);
  }
  console.log(`  ${tagIds.size} tags`);

  // A category that fills itself from a tag rather than by assignment.
  const clearance = await prisma.category.create({
    data: {
      slug: 'clearance',
      nameEn: 'Clearance',
      nameHi: 'क्लीयरेंस',
      descriptionEn: 'Stock being run down, gathered automatically by tag.',
      position: position,
      autoMatch: 'ALL',
      autoRules: { create: [{ tagId: tagIds.get('Clearance')!, operator: 'INCLUDES' }] },
    },
  });
  categoryIds.set('clearance', clearance.id);

  // --- custom fields --------------------------------------------------------
  const definitionIds = new Map<string, string>();
  for (const [index, definition] of DEFINITIONS.entries()) {
    const created = await prisma.metafieldDefinition.create({
      data: {
        ownerType: 'PRODUCT',
        namespace: 'custom',
        key: definition.key,
        nameEn: definition.nameEn,
        nameHi: definition.nameHi,
        description: definition.description,
        type: definition.type,
        isFilterable: definition.isFilterable ?? false,
        position: index,
        validations: definition.choices ? { choices: definition.choices } : undefined,
      },
    });
    definitionIds.set(definition.key, created.id);
  }
  console.log(`  ${definitionIds.size} custom fields`);

  // --- products -------------------------------------------------------------
  let variantCount = 0;
  for (const seed of PRODUCTS) {
    const axes = seed.axes ?? [];
    const status = seed.status ?? 'ACTIVE';

    const product = await prisma.product.create({
      data: {
        handle: seed.handle,
        nameEn: seed.nameEn,
        nameHi: seed.nameHi,
        bodyHtmlEn: seed.bodyEn,
        status,
        publishedAt: status === 'ACTIVE' ? daysAgo(20) : null,
        scheduledPublishAt: seed.scheduledIn ? daysAgo(-seed.scheduledIn) : null,
        categoryId: categoryIds.get(seed.category),
        brandId: seed.brand ? brandIds.get(seed.brand) : null,
        productType: seed.type,
        isRateVolatile: seed.rateVolatile ?? false,
        searchKeywords: seed.keywords,
        hasVariants: axes.length > 0,
        seoTitle: seed.nameEn,
        options: {
          create: axes.map((axis, index) => ({
            name: axis.name,
            position: index + 1,
            values: { create: axis.values.map((value, i) => ({ value, position: i })) },
          })),
        },
        tags: {
          create: (seed.tags ?? [])
            .map((name) => tagIds.get(name))
            .filter((id): id is string => Boolean(id))
            .map((tagId) => ({ tagId })),
        },
      },
    });

    for (const [index, variant] of seed.variants.entries()) {
      const created = await prisma.productVariant.create({
        data: {
          productId: product.id,
          matrixKey: matrixKeyOf(variant.values),
          option1Value: variant.values[0] ?? null,
          option2Value: variant.values[1] ?? null,
          option3Value: variant.values[2] ?? null,
          sku: generateSku(seed.nameEn, variant.values),
          price: variant.price,
          bulkPrice: variant.bulkPrice,
          compareAtPrice: variant.compareAt,
          costPerItem: variant.cost,
          unitLabelEn: seed.unitEn,
          unitLabelHi: seed.unitHi,
          stockQty: variant.stock,
          lowStockThreshold: variant.lowStock ?? 0,
          position: index,
          // Rate-volatile lines look like they were priced a few days ago, so
          // Today's Rates opens with real work to do rather than all-done.
          priceUpdatedAt: seed.rateVolatile ? daysAgo(2) : daysAgo(30),
        },
      });
      variantCount += 1;

      // A little history, so the ledger and the rates screen have context.
      if (seed.rateVolatile) {
        await prisma.priceHistory.createMany({
          data: [
            { variantId: created.id, price: variant.price, bulkPrice: variant.bulkPrice, source: 'CSV_IMPORT', createdAt: daysAgo(9) },
            { variantId: created.id, price: variant.price, bulkPrice: variant.bulkPrice, source: 'RATES_SCREEN', createdAt: daysAgo(2) },
          ],
        });
      }
    }

    // --- custom field values -------------------------------------------------
    for (const [key, value] of Object.entries(seed.fields ?? {})) {
      const definitionId = definitionIds.get(key);
      const definition = DEFINITIONS.find((d) => d.key === key);
      if (!definitionId || !definition) continue;

      const stored = Array.isArray(value) ? value : typeof value === 'boolean' ? value : value;
      await prisma.metafield.create({
        data: {
          ownerType: 'PRODUCT',
          ownerId: product.id,
          definitionId,
          namespace: 'custom',
          key,
          type: definition.type,
          value: stored as never,
          valueText: Array.isArray(value) ? value.join('; ') : String(value),
        },
      });
    }
  }
  console.log(`  ${PRODUCTS.length} products, ${variantCount} variants`);

  // --- inventory ledger ------------------------------------------------------
  const tracked = await prisma.productVariant.findMany({
    where: { stockQty: { gt: 0 } },
    take: 6,
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  for (const [index, variant] of tracked.entries()) {
    await prisma.inventoryAdjustment.create({
      data: {
        variantId: variant.id,
        delta: index % 2 === 0 ? 50 : -6,
        reason: 'MANUAL',
        note: index % 2 === 0 ? 'Delivery from supplier' : 'Damaged in transit',
        createdAt: daysAgo(index + 1),
      },
    });
  }
  console.log(`  ${tracked.length} inventory movements`);

  // --- images ----------------------------------------------------------------
  // Only confirmed uploads exist to attach; real product photography arrives
  // through the CSV import or the media library.
  const media = await prisma.media.findMany({ where: { status: 'READY' }, take: 3 });
  if (media.length > 0) {
    const products = await prisma.product.findMany({ take: media.length, orderBy: { handle: 'asc' } });
    for (const [index, product] of products.entries()) {
      const image = media[index % media.length]!;
      await prisma.productImage.create({
        data: { productId: product.id, mediaId: image.id, position: 0 },
      });
    }
    console.log(`  ${products.length} products given a placeholder image`);
  }

  // --- customers and orders --------------------------------------------------
  const orderCount = await seedOrders();
  console.log(`  ${DEMO_CUSTOMERS.length} customers, ${orderCount} orders`);

  // --- delivery, discounts and content ---------------------------------------
  const growth = await seedGrowth();
  console.log(
    `  ${growth.areas} delivery areas, ${growth.requests} area requests, ${growth.discounts} discounts, ${growth.banners} banners, ${growth.sections} homepage sections`,
  );

  /*
   * Last, deliberately: a ticket points at a customer and usually at an order,
   * so both have to exist before this runs.
   */
  const support = await seedSupport();
  console.log(`  ${support.tickets} support conversations, ${support.messages} messages`);

  const summary = {
    categories: await prisma.category.count(),
    products: await prisma.product.count(),
    variants: await prisma.productVariant.count(),
    tags: await prisma.tag.count(),
    brands: await prisma.brand.count(),
    fields: await prisma.metafieldDefinition.count(),
    values: await prisma.metafield.count(),
    customers: await prisma.customer.count(),
    orders: await prisma.order.count(),
    pincodes: await prisma.serviceablePincode.count(),
    discounts: await prisma.discount.count(),
    sections: await prisma.homepageSection.count(),
    supportTickets: await prisma.supportTicket.count(),
  };
  console.log('\nDone.', JSON.stringify(summary));
}

main()
  .catch((error) => {
    console.error('Demo seed failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

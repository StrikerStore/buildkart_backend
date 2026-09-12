/**
 * The integration-test harness.
 *
 * These tests run against a real MySQL — a *separate* one, `<db>_test`, created
 * by `npm run db:test:setup`. Nothing here can be proved with a mock: the
 * behaviour worth testing is a transaction that has to roll back as a unit, a
 * compare-and-swap that has to lose a race, and a decimal column that has to
 * come back as the same money that went in.
 *
 * `DATABASE_URL` is redirected *before* core is imported, because the Prisma
 * client is created lazily on first use and reads the variable then. Import
 * order is load-bearing here, which is why every test file goes through
 * `loadCore()` rather than importing core at the top.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
loadEnv({ path: join(repoRoot, 'backend', '.env'), quiet: true });

const raw = process.env.DATABASE_URL;
if (!raw) {
  throw new Error('DATABASE_URL is not set. See backend/.env.example.');
}

const testUrl = new URL(raw);
if (!testUrl.pathname.endsWith('_test')) {
  testUrl.pathname = `${testUrl.pathname}_test`;
}

/*
 * The guard that matters. Every test below truncates tables, so pointing this
 * at the development database would delete a real catalogue. Refusing loudly is
 * the only acceptable behaviour when the name looks wrong.
 */
if (!testUrl.pathname.endsWith('_test')) {
  throw new Error(`Refusing to run destructive tests against "${testUrl.pathname}".`);
}

process.env.DATABASE_URL = testUrl.toString();

/** Imported after the redirect above, never before. */
export async function loadCore() {
  return import('../index.ts');
}

export async function loadPrisma() {
  const { prisma } = await import('@buildkart/database');
  return prisma;
}

/**
 * Empties every table these tests touch, children first.
 *
 * Truncate rather than delete-all so auto-increments and the like reset too,
 * with foreign key checks off for the duration — the order would otherwise have
 * to be a perfect topological sort, and one new relation would break it.
 */
export async function resetDatabase() {
  const prisma = await loadPrisma();
  const tables = [
    'InventoryAdjustment',
    'PriceHistory',
    'OrderStatusEvent',
    'PaymentTransaction',
    'OrderItem',
    'DiscountRedemption',
    'Order',
    'Address',
    'Customer',
    'DiscountCategory',
    'DiscountProduct',
    'DiscountTag',
    'Discount',
    'ProductTag',
    'ProductImage',
    'ProductOptionValue',
    'ProductOption',
    'ProductVariant',
    'Metafield',
    'MetafieldDefinition',
    'Product',
    'CategoryTagRule',
    'Category',
    'Tag',
    'Brand',
    'Banner',
    'HomepageSection',
    'Media',
    'ServiceablePincode',
    'PincodeRequest',
    'AdminAuditLog',
    'LoginAttempt',
    'AdminUser',
    'Setting',
  ];

  await prisma.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 0');
  for (const table of tables) {
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE \`${table}\``);
  }
  await prisma.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 1');
}

/** An OWNER actor, since these tests are about domain rules, not permissions. */
export async function ownerActor(adminId = 'test-admin') {
  const prisma = await loadPrisma();
  await prisma.adminUser.upsert({
    where: { id: adminId },
    create: {
      id: adminId,
      email: `${adminId}@test.local`,
      name: 'Test Owner',
      passwordHash: 'not-a-real-hash',
      role: 'OWNER',
    },
    update: {},
  });
  return { kind: 'admin' as const, adminId, role: 'OWNER' as const, ip: '127.0.0.1' };
}

/** A product with one variant, priced and in stock. The unit of most fixtures. */
export async function seedProduct(options: {
  handle: string;
  price: string;
  /** A bulk ladder for this variant. Quantity rungs unless stated otherwise. */
  tiers?: Array<{ minQuantity?: number; minAmount?: string; unitPrice: string }>;
  stockQty?: number;
  inventoryTracked?: boolean;
  inventoryPolicy?: 'DENY' | 'CONTINUE';
  /** Defaults to 0 — untaxed, so every pre-tax test keeps its old totals. */
  taxPercent?: number;
  /** Defaults to true, matching the column and the whole catalogue. */
  taxInclusive?: boolean;
  hsnCode?: string;
}) {
  const prisma = await loadPrisma();
  const product = await prisma.product.create({
    data: {
      handle: options.handle,
      nameEn: options.handle,
      status: 'ACTIVE',
      publishedAt: new Date(),
      taxPercent: options.taxPercent ?? 0,
      taxInclusive: options.taxInclusive ?? true,
      hsnCode: options.hsnCode ?? null,
      variants: {
        create: {
          matrixKey: '',
          price: options.price,
          tiers: {
            create: (options.tiers ?? []).map((tier, index) => ({
              basis: tier.minQuantity !== undefined ? ('QUANTITY' as const) : ('AMOUNT' as const),
              minQuantity: tier.minQuantity ?? null,
              minAmount: tier.minAmount ?? null,
              unitPrice: tier.unitPrice,
              position: index,
            })),
          },
          stockQty: options.stockQty ?? 100,
          inventoryTracked: options.inventoryTracked ?? true,
          inventoryPolicy: options.inventoryPolicy ?? 'DENY',
          isActive: true,
        },
      },
    },
    include: { variants: true },
  });
  return { product, variant: product.variants[0]! };
}

/** The settings these tests depend on, at known values. */
export async function seedSettings() {
  const prisma = await loadPrisma();
  await prisma.setting.upsert({
    where: { key: 'order.numberSequence' },
    create: { key: 'order.numberSequence', value: { prefix: 'BK-', next: 1001 } },
    update: { value: { prefix: 'BK-', next: 1001 } },
  });
}

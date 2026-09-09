import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// One .env at the repo root serves every workspace. dotenv resolves relative to
// process.cwd(), which is packages/database when npm runs this script, so the
// path is pinned to this file's own location instead.
loadEnv({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.env'), quiet: true });
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { prisma } from '../src/client.ts';
import { DEFAULT_GST_RATES, MENU_HANDLES, MENU_LABELS, allDefaultSettings } from '@buildkart/shared';

/**
 * Development and first-run seed.
 *
 * Idempotent throughout: every write is an upsert, so running it against a
 * database that already has data updates nothing it shouldn't and never
 * duplicates. That matters because this is also the bootstrap path for the
 * production database — the owner account has to be creatable exactly once,
 * safely, on a live instance.
 */

const OWNER_EMAIL = (process.env.SEED_OWNER_EMAIL ?? 'owner@buildkart.co').toLowerCase();
const OWNER_NAME = process.env.SEED_OWNER_NAME ?? 'BuildKart Owner';

async function seedOwner() {
  const existing = await prisma.adminUser.findUnique({
    where: { email: OWNER_EMAIL },
    select: { id: true },
  });

  if (existing) {
    console.log(`  owner ${OWNER_EMAIL} already exists — left untouched`);
    return;
  }

  // A supplied password is used as-is; otherwise generate one and print it once.
  // Never a hardcoded default: this account can edit every price in the store.
  const generated = !process.env.SEED_OWNER_PASSWORD;
  const password = process.env.SEED_OWNER_PASSWORD ?? randomBytes(12).toString('base64url');

  await prisma.adminUser.create({
    data: {
      email: OWNER_EMAIL,
      name: OWNER_NAME,
      passwordHash: await bcrypt.hash(password, 12),
      role: 'OWNER',
    },
  });

  console.log(`  created owner ${OWNER_EMAIL}`);
  if (generated) {
    console.log('');
    console.log('  ┌─────────────────────────────────────────────────────────┐');
    console.log('  │  Generated password — shown once, store it now:         │');
    console.log(`  │  ${password.padEnd(53)}│`);
    console.log('  └─────────────────────────────────────────────────────────┘');
    console.log('');
  }
}

async function seedSettings() {
  const defaults = allDefaultSettings();

  for (const { key, value } of defaults) {
    // createMany-with-skipDuplicates would be one round trip, but upsert keeps
    // the intent obvious and this runs a handful of times in a project's life.
    await prisma.setting.upsert({
      where: { key },
      create: { key, value: value as never },
      update: {}, // never clobber a value the owner has changed
    });
  }

  console.log(`  ensured ${defaults.length} settings`);
}

/**
 * The five Indian GST slabs.
 *
 * Also seeded by the migration that creates the table, so a deployed database
 * already has them. This exists for the `db push` path, where migrations never
 * run — and it upserts on `name`, so running both is harmless.
 *
 * 18% is the default because it is the commonest slab for hardware and
 * fittings; a shop selling mostly cement will change it in one click.
 */
async function seedTaxRates() {
  for (const [index, rate] of DEFAULT_GST_RATES.entries()) {
    await prisma.taxRate.upsert({
      where: { name: rate.name },
      create: {
        name: rate.name,
        percent: rate.percent,
        isDefault: rate.percent === '18.00',
        position: index * 100,
      },
      update: {}, // never clobber a rate the owner has edited
    });
  }

  console.log(`  ensured ${DEFAULT_GST_RATES.length} tax rates`);
}

/**
 * The menus the storefront asks for by handle.
 *
 * Also created by the migration, so a deployed database already has them. This
 * covers the `db push` path, where migrations never run — and it upserts, so
 * running both is harmless.
 */
async function seedMenus() {
  for (const handle of MENU_HANDLES) {
    await prisma.menu.upsert({
      where: { handle },
      create: { handle, nameEn: MENU_LABELS[handle] },
      update: {}, // never rename a menu the owner has renamed
    });
  }

  console.log(`  ensured ${MENU_HANDLES.length} menus`);
}

/**
 * The answers a building-materials shop gives every week.
 *
 * Seeded rather than left empty because the point of a saved reply is that it
 * is there the first time you need it — an owner who has to write five of them
 * before the feature helps will write none. All five are editable and
 * deletable; these are a starting point, not a policy.
 *
 * Keyed on `title` with an empty `update`, like the tax rates above: running
 * the seed twice must never overwrite wording the owner has changed.
 */
const STARTER_REPLIES = [
  {
    title: 'Order is on the way',
    bodyEn:
      'Your order has left our godown and is on the way. The driver will call you before reaching.',
    bodyHi: 'आपका ऑर्डर गोदाम से निकल चुका है और रास्ते में है। ड्राइवर पहुँचने से पहले कॉल करेगा।',
  },
  {
    title: 'Delivery running late',
    bodyEn:
      'Sorry for the delay. The delivery is running late today and should reach you by this evening.',
    bodyHi: 'देरी के लिए माफ़ी। आज डिलीवरी में देर हो रही है, शाम तक पहुँच जाएगी।',
  },
  {
    title: 'Ask for a photo',
    bodyEn: 'Could you send a photo of the material you received? It helps us sort this out faster.',
    bodyHi: 'क्या आप मिले हुए सामान की फोटो भेज सकते हैं? इससे हम जल्दी हल कर पाएंगे।',
  },
  {
    title: 'Replacement being sent',
    bodyEn: 'We are sending a replacement. It will reach you with your next delivery, at no charge.',
    bodyHi: 'हम बदलकर भेज रहे हैं। अगली डिलीवरी के साथ बिना किसी शुल्क के पहुँच जाएगा।',
  },
  {
    title: 'Rate for a bulk order',
    bodyEn:
      'For a bulk quantity we can offer a better rate. Tell us the material and how much you need.',
    bodyHi: 'बल्क में लेने पर हम बेहतर रेट दे सकते हैं। बताइए कौन सा सामान और कितना चाहिए।',
  },
];

async function seedSupportReplies() {
  for (const [index, reply] of STARTER_REPLIES.entries()) {
    const existing = await prisma.supportCannedReply.findFirst({
      where: { title: reply.title },
      select: { id: true },
    });
    if (existing) continue;

    await prisma.supportCannedReply.create({
      data: { ...reply, position: index * 10 },
    });
  }

  console.log(`  ensured ${STARTER_REPLIES.length} saved replies`);
}

async function main() {
  console.log('Seeding BuildKart…');
  await seedOwner();
  await seedSettings();
  await seedTaxRates();
  await seedMenus();
  await seedSupportReplies();
  console.log('Done.');
}

main()
  .catch((error) => {
    console.error('Seed failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

import { prisma } from '../src/client.ts';
import { ulid } from 'ulid';

/**
 * Demo support conversations.
 *
 * Split out like the order book and the growth data, and it runs **last**: a
 * ticket points at a real customer and often at a real order, so neither can be
 * invented here.
 *
 * The set is chosen to put every state the inbox can show on the screen at
 * once — one waiting on the shop, one the shop has answered, one resolved, one
 * general question with no order behind it, and one long enough to prove the
 * thread scrolls. Without that, "Awaiting reply" is a tab nobody can tell is
 * working until a real customer writes in.
 */

const TODAY = new Date();
const minutesAgo = (n: number) => new Date(TODAY.getTime() - n * 60_000);

type SeedMessage = {
  from: 'CUSTOMER' | 'ADMIN';
  body: string;
  /** Minutes before now, so a thread reads in the right order. */
  at: number;
};

type SeedTicket = {
  /** Matched against DEMO_CUSTOMERS by phone — the one stable handle they have. */
  phone: string;
  topic: 'ORDER' | 'DELIVERY' | 'PAYMENT' | 'PRODUCT' | 'OTHER';
  /** Attach the customer's most recent order, when the chat is about one. */
  linkOrder: boolean;
  status: 'OPEN' | 'WAITING_ON_CUSTOMER' | 'RESOLVED';
  messages: SeedMessage[];
};

const TICKETS: SeedTicket[] = [
  // Awaiting reply, about an order. The case the inbox exists for.
  {
    phone: '9826011001',
    topic: 'DELIVERY',
    linkOrder: true,
    status: 'OPEN',
    messages: [
      { from: 'CUSTOMER', body: 'भैया माल कब तक आएगा? मिस्त्री साइट पर बैठा है।', at: 42 },
    ],
  },

  // The shop has answered and is waiting. Should not appear in the badge count.
  {
    phone: '9826011002',
    topic: 'ORDER',
    linkOrder: true,
    status: 'WAITING_ON_CUSTOMER',
    messages: [
      { from: 'CUSTOMER', body: 'I ordered 20 bags but the slip says 18. Can you check?', at: 260 },
      {
        from: 'ADMIN',
        body: 'Checked the order — 20 bags were loaded. Could you count what reached the site and tell us?',
        at: 240,
      },
    ],
  },

  // Awaiting reply, several messages deep, so the thread has something to scroll.
  {
    phone: '9826011003',
    topic: 'PAYMENT',
    linkOrder: true,
    status: 'OPEN',
    messages: [
      { from: 'CUSTOMER', body: 'पेमेंट कट गया लेकिन ऑर्डर नहीं दिख रहा।', at: 190 },
      { from: 'ADMIN', body: 'नंबर बताइए जिससे पेमेंट किया था, हम देख लेते हैं।', at: 180 },
      { from: 'CUSTOMER', body: 'उसी नंबर से जो अकाउंट में है।', at: 172 },
      { from: 'ADMIN', body: 'मिल गया — ऑर्डर बन गया है, पर्ची भेज रहे हैं।', at: 160 },
      { from: 'CUSTOMER', body: 'पर्ची नहीं आई अभी तक।', at: 25 },
    ],
  },

  // A general question with no order behind it: the "before buying" case, which
  // is what the right-hand panel's recent-orders fallback is for.
  {
    phone: '9826011005',
    topic: 'PRODUCT',
    linkOrder: false,
    status: 'OPEN',
    messages: [
      {
        from: 'CUSTOMER',
        body: 'Do you stock 12mm ply in waterproof grade? Need it for a kitchen.',
        at: 15,
      },
    ],
  },

  // Closed, so the Resolved tab is not empty on a fresh install.
  {
    phone: '9826011004',
    topic: 'DELIVERY',
    linkOrder: true,
    status: 'RESOLVED',
    messages: [
      { from: 'CUSTOMER', body: 'गाड़ी टोल पर रुकी है, ड्राइवर का नंबर दे दीजिए।', at: 3_100 },
      { from: 'ADMIN', body: 'ड्राइवर अभी कॉल करेगा आपको।', at: 3_080 },
      { from: 'CUSTOMER', body: 'माल पहुँच गया, धन्यवाद।', at: 2_900 },
    ],
  },
];

export async function seedSupport(): Promise<{ tickets: number; messages: number }> {
  // Idempotent the way the rest of the demo seed is: a second run must not
  // double the inbox. Demo tickets are the only ones a demo database has, so
  // clearing them wholesale is safe — and the cascade takes the messages.
  await prisma.supportTicket.deleteMany({});

  // One counter for the whole batch, matching what `allocateTicketNumber`
  // would have produced had these arrived one at a time.
  let nextNumber = 1001;
  let messageCount = 0;

  for (const seed of TICKETS) {
    const customer = await prisma.customer.findUnique({
      where: { phone: seed.phone },
      select: { id: true },
    });
    // The customer seed runs first, but a partial demo database should skip a
    // ticket rather than fail the whole seed.
    if (!customer) continue;

    const order = seed.linkOrder
      ? await prisma.order.findFirst({
          where: { customerId: customer.id },
          orderBy: { placedAt: 'desc' },
          select: { id: true },
        })
      : null;

    const ordered = [...seed.messages].sort((a, b) => b.at - a.at);
    const last = ordered.at(-1)!;
    const lastMessageAt = minutesAgo(last.at);

    await prisma.supportTicket.create({
      data: {
        ticketNumber: `S-${nextNumber}`,
        customerId: customer.id,
        orderId: order?.id ?? null,
        topic: seed.topic,
        status: seed.status,
        lastMessageAt,
        lastMessageFrom: last.from,
        /*
         * A customer has read their own words, so the unread dot only shows
         * where the shop spoke last. The admin's read timestamp is left null on
         * anything still awaiting a reply — that is what an unopened ticket is.
         */
        customerLastReadAt: last.from === 'CUSTOMER' ? lastMessageAt : minutesAgo(last.at + 1),
        adminLastReadAt: last.from === 'ADMIN' ? lastMessageAt : null,
        resolvedAt: seed.status === 'RESOLVED' ? lastMessageAt : null,
        messages: {
          create: ordered.map((message) => ({
            // ULIDs, and generated in order, because the poll cursor depends on
            // ids sorting by creation time. Seeded rows must honour that too.
            id: ulid(minutesAgo(message.at).getTime()),
            authorRole: message.from,
            body: message.body,
            createdAt: minutesAgo(message.at),
          })),
        },
      },
    });

    nextNumber += 1;
    messageCount += ordered.length;
  }

  // Leave the counter where a real ticket would carry on from, so the first one
  // the owner receives is not a duplicate of a demo number.
  await prisma.setting.upsert({
    where: { key: 'support.ticketSequence' },
    create: { key: 'support.ticketSequence', value: { next: nextNumber } },
    update: { value: { next: nextNumber } },
  });

  return { tickets: nextNumber - 1001, messages: messageCount };
}

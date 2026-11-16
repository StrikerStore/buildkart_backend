/**
 * What an order event says as an app notification, in English and Hindi.
 *
 * Short and code-written: a push is a title and a line, and the order page it
 * opens says the rest. Events that are not about a customer's own order — the
 * sign-in code, the shop's own alerts, privacy notices — have no copy here, so
 * they are never pushed.
 */
import type { NotificationEvent } from '@buildkart/shared';

type Copy = { titleEn: string; titleHi: string; bodyEn: string; bodyHi: string };

const COPY: Partial<Record<NotificationEvent, Copy>> = {
  'order.placed': {
    titleEn: 'Order {orderNumber} placed',
    titleHi: 'ऑर्डर {orderNumber} मिल गया',
    bodyEn: 'We will confirm it shortly.',
    bodyHi: 'हम जल्द ही इसकी पुष्टि करेंगे।',
  },
  'order.confirmed': {
    titleEn: 'Order {orderNumber} confirmed',
    titleHi: 'ऑर्डर {orderNumber} कन्फ़र्म',
    bodyEn: 'It is being packed for delivery.',
    bodyHi: 'डिलीवरी के लिए पैक हो रहा है।',
  },
  'order.dispatched': {
    titleEn: 'Order {orderNumber} is on its way',
    titleHi: 'ऑर्डर {orderNumber} रास्ते में है',
    bodyEn: 'Track it in the app.',
    bodyHi: 'ऐप में ट्रैक करें।',
  },
  'delivery.outForDelivery': {
    titleEn: 'Order {orderNumber} is out for delivery',
    titleHi: 'ऑर्डर {orderNumber} डिलीवरी के लिए निकला',
    bodyEn: 'Track it in the app.',
    bodyHi: 'ऐप में ट्रैक करें।',
  },
  'delivery.partDelivered': {
    titleEn: 'Part of order {orderNumber} delivered',
    titleHi: 'ऑर्डर {orderNumber} का कुछ हिस्सा पहुँचा',
    bodyEn: 'The rest is on its way.',
    bodyHi: 'बाकी रास्ते में है।',
  },
  'order.delivered': {
    titleEn: 'Order {orderNumber} delivered',
    titleHi: 'ऑर्डर {orderNumber} पहुँच गया',
    bodyEn: 'Thank you for ordering with BuildKart.',
    bodyHi: 'BuildKart से ऑर्डर करने के लिए धन्यवाद।',
  },
  'order.cancelled': {
    titleEn: 'Order {orderNumber} cancelled',
    titleHi: 'ऑर्डर {orderNumber} रद्द',
    bodyEn: 'Open the app for the details.',
    bodyHi: 'जानकारी के लिए ऐप खोलें।',
  },
  'payment.received': {
    titleEn: 'Payment received for {orderNumber}',
    titleHi: '{orderNumber} का भुगतान मिल गया',
    bodyEn: 'Thank you.',
    bodyHi: 'धन्यवाद।',
  },
  'payment.refunded': {
    titleEn: 'Refund for {orderNumber} started',
    titleHi: '{orderNumber} का रिफ़ंड शुरू',
    bodyEn: 'It reaches your account in a few working days.',
    bodyHi: 'कुछ कामकाजी दिनों में आपके खाते में आएगा।',
  },
};

const fill = (text: string, values: Record<string, string>) =>
  text.replace(/\{(\w+)\}/g, (match, name: string) => values[name] ?? match);

/** The push for an order event, or null when the event is not pushed or has no order number. */
export function pushCopyFor(event: NotificationEvent, values: Record<string, string>): Copy | null {
  const copy = COPY[event];
  if (!copy || !values.orderNumber) return null;
  return {
    titleEn: fill(copy.titleEn, values),
    titleHi: fill(copy.titleHi, values),
    bodyEn: fill(copy.bodyEn, values),
    bodyHi: fill(copy.bodyHi, values),
  };
}

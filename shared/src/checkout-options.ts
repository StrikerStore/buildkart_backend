/**
 * How a customer pays, as opposed to who processes it.
 *
 * A shopper picking "UPI" or "Debit card" has no idea — and should not need
 * one — whether Razorpay or PayU is behind it. The checkout offers these
 * options; the owner's gateway priority and per-gateway toggles decide which
 * processor each one is sent to. Keeping the two vocabularies apart is what
 * lets the owner move cards from one gateway to another without a single word
 * changing on the storefront.
 */
import type { PaymentInstrument } from './payments.ts';

/** The online options, in the order the storefront lists them. COD is not one. */
export const CHECKOUT_OPTIONS = [
  'UPI',
  'CREDIT_CARD',
  'DEBIT_CARD',
  'NETBANKING',
  'WALLET',
  'PAYLATER',
  'EMI',
] as const;
export type CheckoutOption = (typeof CHECKOUT_OPTIONS)[number];

/** The gateways a checkout option can be routed to. */
export const ONLINE_GATEWAYS = ['RAZORPAY', 'PAYU'] as const;
export type OnlineGateway = (typeof ONLINE_GATEWAYS)[number];

export const CHECKOUT_OPTION_LABELS: Record<CheckoutOption, { en: string; hi: string }> = {
  UPI: { en: 'UPI', hi: 'UPI' },
  CREDIT_CARD: { en: 'Credit card', hi: 'क्रेडिट कार्ड' },
  DEBIT_CARD: { en: 'Debit card', hi: 'डेबिट कार्ड' },
  NETBANKING: { en: 'Net banking', hi: 'नेट बैंकिंग' },
  WALLET: { en: 'Wallets', hi: 'वॉलेट' },
  PAYLATER: { en: 'Pay Later', hi: 'बाद में भुगतान' },
  EMI: { en: 'EMI', hi: 'EMI' },
};

export const CHECKOUT_OPTION_HINTS: Record<CheckoutOption, { en: string; hi: string }> = {
  UPI: {
    en: 'Google Pay, PhonePe, Paytm, BHIM or any UPI app',
    hi: 'Google Pay, PhonePe, Paytm, BHIM या कोई भी UPI ऐप',
  },
  CREDIT_CARD: { en: 'Visa, Mastercard, RuPay, Amex', hi: 'Visa, Mastercard, RuPay, Amex' },
  DEBIT_CARD: { en: 'Visa, Mastercard, RuPay', hi: 'Visa, Mastercard, RuPay' },
  NETBANKING: { en: 'All major banks', hi: 'सभी बड़े बैंक' },
  WALLET: { en: 'Paytm, PhonePe, Amazon Pay, Mobikwik', hi: 'Paytm, PhonePe, Amazon Pay, Mobikwik' },
  PAYLATER: { en: 'Simpl, LazyPay, ICICI PayLater and more', hi: 'Simpl, LazyPay, ICICI PayLater आदि' },
  EMI: { en: 'Card and cardless EMI', hi: 'कार्ड और बिना कार्ड EMI' },
};

/**
 * What each gateway can take. Both Indian aggregators cover every option; the
 * table exists so a future gateway that cannot (a pure-UPI one, say) is
 * expressible, and so the admin form shows only boxes that mean something.
 */
export const GATEWAY_CAPABILITIES: Record<OnlineGateway, readonly CheckoutOption[]> = {
  RAZORPAY: CHECKOUT_OPTIONS,
  PAYU: CHECKOUT_OPTIONS,
};

/** The ledger's word for an option. Credit and debit are both a card there. */
export function toInstrument(option: CheckoutOption): PaymentInstrument {
  switch (option) {
    case 'CREDIT_CARD':
    case 'DEBIT_CARD':
      return 'CARD';
    default:
      return option;
  }
}

/** One online gateway's routing-relevant configuration. */
export type GatewayRoute = {
  gateway: OnlineGateway;
  enabled: boolean;
  displayOrder: number;
  checkoutOptions: readonly CheckoutOption[];
};

/**
 * The gateways that may take an option, best first.
 *
 * The first is where the customer is sent; the rest are fallbacks for when the
 * first one's API refuses to open a payment. Ordered by the owner's priority
 * (`displayOrder`), then by name so a tie is stable rather than arbitrary.
 */
export function routeOption(
  option: CheckoutOption,
  gateways: readonly GatewayRoute[],
): OnlineGateway[] {
  return gateways
    .filter(
      (entry) =>
        entry.enabled &&
        GATEWAY_CAPABILITIES[entry.gateway].includes(option) &&
        entry.checkoutOptions.includes(option),
    )
    .sort((a, b) => a.displayOrder - b.displayOrder || a.gateway.localeCompare(b.gateway))
    .map((entry) => entry.gateway);
}

/** The options at least one gateway will take, in storefront order. */
export function availableOptions(gateways: readonly GatewayRoute[]): CheckoutOption[] {
  return CHECKOUT_OPTIONS.filter((option) => routeOption(option, gateways).length > 0);
}

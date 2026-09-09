/**
 * What checkout is made of.
 *
 * The storefront's checkout does not exist yet. This module and the settings
 * behind it define the contract it will read: which steps run in what order,
 * which fields are asked for, what the page says, and how it looks.
 *
 * **The catalogue is code; the configuration is data.** An admin that could
 * invent its own field keys would produce a checkout the storefront has no way
 * to render — so the keys, the steps and the layouts live here as closed sets,
 * and what is stored per shop is which of them are on, in what order, and what
 * they are called on screen.
 */

// ---------------------------------------------------------------------------
// Layout and steps
// ---------------------------------------------------------------------------

export const CHECKOUT_LAYOUTS = ['ONE_PAGE', 'MULTI_STEP'] as const;
export type CheckoutLayout = (typeof CHECKOUT_LAYOUTS)[number];

export const CHECKOUT_LAYOUT_LABELS: Record<CheckoutLayout, string> = {
  ONE_PAGE: 'One page',
  MULTI_STEP: 'Step by step',
};

export const CHECKOUT_LAYOUT_HINTS: Record<CheckoutLayout, string> = {
  ONE_PAGE: 'Everything on one screen. Fewer taps, more scrolling.',
  MULTI_STEP: 'One thing at a time. Better on a phone with a long address form.',
};

/**
 * The steps a checkout can be built from.
 *
 * REVIEW and PAYMENT are not optional and not reorderable past each other —
 * see `checkoutFlowSchema`. The rest are a shop's choice.
 */
export const CHECKOUT_STEPS = ['CONTACT', 'ADDRESS', 'DELIVERY', 'PAYMENT', 'REVIEW'] as const;
export type CheckoutStep = (typeof CHECKOUT_STEPS)[number];

export const CHECKOUT_STEP_LABELS: Record<CheckoutStep, string> = {
  CONTACT: 'Contact',
  ADDRESS: 'Delivery address',
  DELIVERY: 'Delivery slot',
  PAYMENT: 'Payment',
  REVIEW: 'Review',
};

export const CHECKOUT_STEP_HINTS: Record<CheckoutStep, string> = {
  CONTACT: 'Name and phone number.',
  ADDRESS: 'Where the goods are going.',
  DELIVERY: 'Which day, where the shop offers a choice.',
  PAYMENT: 'How they are paying.',
  REVIEW: 'The order, once more, before it is placed.',
};

/** Steps that must always run: an order cannot be placed without them. */
export const REQUIRED_STEPS: readonly CheckoutStep[] = ['CONTACT', 'ADDRESS', 'PAYMENT'];

export const PROGRESS_STYLES = ['NUMBERED', 'BAR', 'NONE'] as const;
export type ProgressStyle = (typeof PROGRESS_STYLES)[number];

export const PROGRESS_STYLE_LABELS: Record<ProgressStyle, string> = {
  NUMBERED: 'Numbered steps',
  BAR: 'Progress bar',
  NONE: 'Nothing',
};

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

export const CHECKOUT_FIELDS = [
  'name',
  'phone',
  'email',
  'pincode',
  'addressLine1',
  'addressLine2',
  'landmark',
  'city',
  'state',
  'gstin',
  'orderNote',
  'deliveryDate',
] as const;
export type CheckoutFieldKey = (typeof CHECKOUT_FIELDS)[number];

export type CheckoutFieldSpec = {
  key: CheckoutFieldKey;
  /** The default label, used when the shop has not renamed it. */
  label: string;
  step: CheckoutStep;
  /**
   * Cannot be hidden or made optional. Delivery is impossible without a phone
   * number and a pincode, and a checkout configured without them would take
   * orders the shop cannot fulfil.
   */
  locked?: boolean;
  hint?: string;
};

export const CHECKOUT_FIELD_SPECS: Record<CheckoutFieldKey, CheckoutFieldSpec> = {
  name: { key: 'name', label: 'Full name', step: 'CONTACT' },
  phone: {
    key: 'phone',
    label: 'Phone number',
    step: 'CONTACT',
    locked: true,
    hint: 'The customer is identified by this. It cannot be turned off.',
  },
  email: { key: 'email', label: 'Email', step: 'CONTACT', hint: 'Only needed if you email receipts.' },
  pincode: {
    key: 'pincode',
    label: 'Pincode',
    step: 'ADDRESS',
    locked: true,
    hint: 'Decides whether you deliver there, and what it costs.',
  },
  addressLine1: { key: 'addressLine1', label: 'Address', step: 'ADDRESS' },
  addressLine2: { key: 'addressLine2', label: 'Address line 2', step: 'ADDRESS' },
  landmark: {
    key: 'landmark',
    label: 'Landmark',
    step: 'ADDRESS',
    hint: 'Worth asking for on a building site with no house number.',
  },
  city: { key: 'city', label: 'City', step: 'ADDRESS' },
  state: {
    key: 'state',
    label: 'State',
    step: 'ADDRESS',
    hint: 'Decides whether GST prints as CGST + SGST or as IGST.',
  },
  gstin: {
    key: 'gstin',
    label: 'GSTIN',
    step: 'ADDRESS',
    hint: 'For contractors who need the invoice in a company name.',
  },
  orderNote: { key: 'orderNote', label: 'Note for the shop', step: 'REVIEW' },
  deliveryDate: { key: 'deliveryDate', label: 'Preferred delivery day', step: 'DELIVERY' },
};

export function isLockedField(key: CheckoutFieldKey): boolean {
  return CHECKOUT_FIELD_SPECS[key].locked === true;
}

/** Sensible starting point: everything a delivery needs, nothing it does not. */
export const DEFAULT_FIELD_STATE: Record<CheckoutFieldKey, { visible: boolean; required: boolean }> =
  {
    name: { visible: true, required: true },
    phone: { visible: true, required: true },
    email: { visible: false, required: false },
    pincode: { visible: true, required: true },
    addressLine1: { visible: true, required: true },
    addressLine2: { visible: true, required: false },
    landmark: { visible: true, required: false },
    city: { visible: true, required: true },
    state: { visible: true, required: true },
    gstin: { visible: false, required: false },
    orderNote: { visible: true, required: false },
    deliveryDate: { visible: false, required: false },
  };

// ---------------------------------------------------------------------------
// Location picker
// ---------------------------------------------------------------------------

/**
 * The map-and-pin address picker every quick-commerce app opens with.
 *
 * It exists because a typed address is a bad way to find a building site. The
 * customer drops a pin, the map hands back coordinates, those reverse-geocode
 * to a pincode, and the pincode decides whether the shop delivers there and
 * what it charges — which is the one question the rest of checkout depends on.
 *
 * `Address.latitude` / `longitude` have been in the schema since the first
 * migration waiting for exactly this.
 */
export const MAP_PROVIDERS = ['GOOGLE', 'MAPBOX', 'OSM'] as const;
export type MapProvider = (typeof MAP_PROVIDERS)[number];

export const MAP_PROVIDER_LABELS: Record<MapProvider, string> = {
  GOOGLE: 'Google Maps',
  MAPBOX: 'Mapbox',
  OSM: 'OpenStreetMap',
};

export const MAP_PROVIDER_HINTS: Record<MapProvider, string> = {
  GOOGLE: 'Best address data in India. Needs a billing account.',
  MAPBOX: 'Cheaper at volume; Indian addresses are thinner.',
  OSM: 'Free, no key. Reverse geocoding is rate-limited and often vague.',
};

/** OSM needs no credentials; the other two do. */
export function providerNeedsKey(provider: MapProvider): boolean {
  return provider !== 'OSM';
}

/**
 * Roughly the centre of India, used when the shop has not set its own.
 *
 * A map that opens on the wrong continent is worse than one that opens
 * zoomed out — the customer cannot tell whether it is broken or just lost.
 */
export const DEFAULT_MAP_CENTER = { lat: 22.9734, lng: 78.6569, zoom: 5 };

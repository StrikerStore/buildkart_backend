/**
 * Turning a device coordinate into a pincode.
 *
 * The storefront can ask a phone where it is and get a latitude and longitude
 * back in one tap. It cannot get a **pincode** — and a pincode is what this
 * shop's whole delivery model is keyed on, because `ServiceablePincode` is what
 * the owner edits and what every delivery charge hangs off. So the coordinate
 * has to be resolved to one, server-side.
 *
 * Server-side for two reasons, both load-bearing. The geocoding key is sealed
 * in `checkout.location` and must never reach a browser; and a client that
 * resolved its own pincode could simply claim a serviced one, which would put
 * the delivery charge under the customer's control.
 *
 * Three providers because the admin already offers three. OSM needs no key,
 * which makes it the honest default for a shop that has not signed up for
 * anything yet — the alternative is a location picker that does nothing until
 * somebody enters billing details with Google.
 */
import { prisma } from '@buildkart/database';
import { parseSetting, type PlaceSuggestionDto } from '@buildkart/shared';
import { openSecret } from '../secrets.ts';

export type ResolvedPlace = {
  /** Six digits, or null when the provider could not give one. */
  pincode: string | null;
  /** The neighbourhood, when the provider names one. */
  areaName: string | null;
  city: string | null;
  state: string | null;
  /** The whole address as one line, for showing the customer what we found. */
  formatted: string | null;
};

/**
 * A small in-process cache of resolved coordinates.
 *
 * Keyed on the coordinate rounded to about 100 metres, which is the resolution
 * at which the answer stops changing: two taps from the same building must not
 * be two billable geocoding calls. Nominatim's usage policy asks for caching in
 * as many words, and Google charges per request.
 *
 * In-process, so it dies with the container and is not shared between them.
 * That is fine — this is a cost and courtesy measure, not a correctness one.
 */
const CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 500;
const cache = new Map<string, { at: number; place: ResolvedPlace }>();

function cacheKey(lat: number, lng: number): string {
  return `${lat.toFixed(3)},${lng.toFixed(3)}`;
}

function readCache(key: string): ResolvedPlace | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  return hit.place;
}

function writeCache(key: string, place: ResolvedPlace): void {
  // Oldest out first. A Map iterates in insertion order, so the first key is
  // the oldest — enough of an eviction policy for a bounded courtesy cache.
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { at: Date.now(), place });
}

/** Six digits somewhere in a string, which is what an Indian PIN looks like. */
function firstPincode(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = /\b(\d{6})\b/.exec(value);
  return match?.[1] ?? null;
}

type LocationConfig = {
  provider: 'GOOGLE' | 'MAPBOX' | 'OSM';
  key: string;
};

async function locationConfig(): Promise<LocationConfig> {
  const row = await prisma.setting.findUnique({ where: { key: 'checkout.location' } });
  const stored = parseSetting('checkout.location', row?.value);

  let key = '';
  try {
    key = openSecret(stored.serverGeocodeKeyEnc, 'checkout.location.serverGeocodeKey');
  } catch {
    /*
     * No key, or no encryption key to open it with. Not an error: OSM works
     * without one, and falling back is better than a picker that fails closed
     * on a shop that has not configured anything yet.
     */
    key = '';
  }

  // A keyed provider with no key cannot answer, so use the one that can.
  if ((stored.provider === 'GOOGLE' || stored.provider === 'MAPBOX') && !key) {
    return { provider: 'OSM', key: '' };
  }

  return { provider: stored.provider, key };
}

/** Every provider call is bounded — a slow geocoder must not hang a checkout. */
const TIMEOUT_MS = 5000;

async function fetchJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function google(lat: number, lng: number, key: string): Promise<ResolvedPlace | null> {
  const url =
    `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}` +
    `&result_type=street_address|premise|sublocality|postal_code&key=${encodeURIComponent(key)}`;

  const body = (await fetchJson(url)) as {
    results?: Array<{
      formatted_address?: string;
      address_components?: Array<{ long_name?: string; types?: string[] }>;
    }>;
  } | null;

  const first = body?.results?.[0];
  if (!first) return null;

  const components = first.address_components ?? [];
  const pick = (type: string) =>
    components.find((component) => component.types?.includes(type))?.long_name ?? null;

  return {
    pincode: firstPincode(pick('postal_code')) ?? firstPincode(first.formatted_address),
    areaName: pick('sublocality_level_1') ?? pick('sublocality') ?? pick('neighborhood'),
    city: pick('locality') ?? pick('administrative_area_level_2'),
    state: pick('administrative_area_level_1'),
    formatted: first.formatted_address ?? null,
  };
}

async function mapbox(lat: number, lng: number, key: string): Promise<ResolvedPlace | null> {
  const url =
    `https://api.mapbox.com/geocoding/v5/mapbox.places/${lng},${lat}.json` +
    `?types=address,postcode,neighborhood,place&access_token=${encodeURIComponent(key)}`;

  const body = (await fetchJson(url)) as {
    features?: Array<{
      place_name?: string;
      place_type?: string[];
      text?: string;
      context?: Array<{ id?: string; text?: string }>;
    }>;
  } | null;

  const first = body?.features?.[0];
  if (!first) return null;

  const context = first.context ?? [];
  const fromContext = (prefix: string) =>
    context.find((entry) => entry.id?.startsWith(prefix))?.text ?? null;

  return {
    pincode: firstPincode(fromContext('postcode')) ?? firstPincode(first.place_name),
    areaName: fromContext('neighborhood') ?? fromContext('locality'),
    city: fromContext('place'),
    state: fromContext('region'),
    formatted: first.place_name ?? null,
  };
}

async function osm(lat: number, lng: number): Promise<ResolvedPlace | null> {
  const url =
    `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`;

  /*
   * Nominatim's usage policy requires an identifying User-Agent and refuses
   * requests without one. It is a free service run on donated hardware; the
   * cache above and this header are the rent.
   */
  const body = (await fetchJson(url, {
    'User-Agent': 'BuildKart/1.0 (storefront delivery-area lookup)',
    'Accept-Language': 'en',
  })) as {
    display_name?: string;
    address?: Record<string, string | undefined>;
  } | null;

  const address = body?.address;
  if (!address) return null;

  return {
    pincode: firstPincode(address.postcode) ?? firstPincode(body?.display_name),
    areaName:
      address.suburb ?? address.neighbourhood ?? address.residential ?? address.city_district ?? null,
    city: address.city ?? address.town ?? address.village ?? address.state_district ?? null,
    state: address.state ?? null,
    formatted: body?.display_name ?? null,
  };
}

// ---------------------------------------------------------------------------
// Forward search
// ---------------------------------------------------------------------------

/*
 * A place the customer can pick to centre the map on.
 *
 * The shape lives in `@buildkart/shared` and is re-exported here: it is part of
 * the API's public type surface, and the contract build refuses to publish a
 * declaration that reaches into this package.
 *
 * There is deliberately **no pincode on it.** A search hit is a hint about
 * roughly where to look, not an address: Nominatim happily returns parks and
 * road junctions, and one of the five hits for "vijay nagar indore" has no
 * postcode at all. Taking a pincode from here would reintroduce exactly the
 * imprecision the pin-drop exists to remove — so the authoritative pincode
 * always comes from reverse-geocoding the *final confirmed pin*.
 */
export type { PlaceSuggestionDto as PlaceSuggestion };

/**
 * Search results, cached by normalised query.
 *
 * Search fires on typing, which makes it a different rate-limit problem from
 * the reverse lookup: Nominatim asks for no more than one request a second, and
 * a customer typing "vijay nagar" would blow through that on its own. The
 * client debounces; this catches everything the debounce lets through, plus
 * every other customer searching the same handful of localities.
 */
const searchCache = new Map<string, { at: number; results: PlaceSuggestionDto[] }>();

function normalizeQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Six is what fits on a phone without scrolling the map off the screen. */
const SEARCH_LIMIT = 6;

async function googleSearch(query: string, key: string): Promise<PlaceSuggestionDto[]> {
  const url =
    `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}` +
    `&components=country:IN&key=${encodeURIComponent(key)}`;

  const body = (await fetchJson(url)) as {
    results?: Array<{
      formatted_address?: string;
      geometry?: { location?: { lat?: number; lng?: number } };
      address_components?: Array<{ long_name?: string; types?: string[] }>;
    }>;
  } | null;

  return (body?.results ?? []).slice(0, SEARCH_LIMIT).flatMap((result) => {
    const lat = result.geometry?.location?.lat;
    const lng = result.geometry?.location?.lng;
    if (typeof lat !== 'number' || typeof lng !== 'number') return [];

    const parts = (result.formatted_address ?? '').split(',').map((part) => part.trim());
    return [
      {
        label: parts[0] ?? result.formatted_address ?? query,
        sublabel: parts.slice(1).join(', ') || null,
        latitude: lat,
        longitude: lng,
      },
    ];
  });
}

async function mapboxSearch(query: string, key: string): Promise<PlaceSuggestionDto[]> {
  const url =
    `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json` +
    `?country=in&limit=${SEARCH_LIMIT}&access_token=${encodeURIComponent(key)}`;

  const body = (await fetchJson(url)) as {
    features?: Array<{ text?: string; place_name?: string; center?: [number, number] }>;
  } | null;

  return (body?.features ?? []).flatMap((feature) => {
    const centre = feature.center;
    if (!centre || centre.length < 2) return [];

    const [lng, lat] = centre;
    if (typeof lat !== 'number' || typeof lng !== 'number') return [];

    return [
      {
        label: feature.text ?? feature.place_name ?? query,
        // Mapbox's `place_name` starts with `text`; drop it so the two lines
        // do not repeat the same words.
        sublabel: (feature.place_name ?? '').split(',').slice(1).join(', ').trim() || null,
        latitude: lat,
        longitude: lng,
      },
    ];
  });
}

async function osmSearch(query: string): Promise<PlaceSuggestionDto[]> {
  const url =
    `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}` +
    `&format=jsonv2&countrycodes=in&addressdetails=1&limit=${SEARCH_LIMIT}`;

  const body = (await fetchJson(url, {
    // Required by Nominatim's usage policy; requests without it are refused.
    'User-Agent': 'BuildKart/1.0 (storefront delivery-area lookup)',
    'Accept-Language': 'en',
  })) as Array<{
    lat?: string;
    lon?: string;
    name?: string;
    display_name?: string;
  }> | null;

  return (body ?? []).flatMap((row) => {
    const lat = Number(row.lat);
    const lng = Number(row.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [];

    const parts = (row.display_name ?? '').split(',').map((part) => part.trim());
    return [
      {
        label: row.name || parts[0] || query,
        sublabel: parts.slice(1, 4).join(', ') || null,
        latitude: lat,
        longitude: lng,
      },
    ];
  });
}

/**
 * Localities matching a typed query, for centring the map.
 *
 * The escape hatch for a customer who will not or cannot share their location:
 * they search their area, the map goes there, and they drag the pin to the
 * exact spot. That last step is what keeps the "no pincode picking" rule
 * honest — nothing here decides serviceability.
 *
 * Returns an empty list rather than throwing, for the same reason
 * `reverseGeocode` returns null: a rate-limited or unreachable provider is an
 * ordinary event, and the answer is a quiet "no matches", not an error screen.
 */
export async function searchPlaces(query: string): Promise<PlaceSuggestionDto[]> {
  const normalized = normalizeQuery(query);
  // Below three characters every query matches half of India.
  if (normalized.length < 3) return [];

  const cached = searchCache.get(normalized);
  if (cached && Date.now() - cached.at <= CACHE_TTL_MS) return cached.results;

  const config = await locationConfig();

  const results =
    config.provider === 'GOOGLE'
      ? await googleSearch(normalized, config.key)
      : config.provider === 'MAPBOX'
        ? await mapboxSearch(normalized, config.key)
        : await osmSearch(normalized);

  if (searchCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = searchCache.keys().next().value;
    if (oldest !== undefined) searchCache.delete(oldest);
  }
  searchCache.set(normalized, { at: Date.now(), results });

  return results;
}

/**
 * A coordinate to a place, or null when nothing could be resolved.
 *
 * Null rather than a throw: a geocoder being down, rate-limited or simply
 * unable to name a spot in a field is an ordinary outcome, and the storefront's
 * answer to it is to ask them to move the pin — not to show an error.
 */
export async function reverseGeocode(lat: number, lng: number): Promise<ResolvedPlace | null> {
  const key = cacheKey(lat, lng);
  const cached = readCache(key);
  if (cached) return cached;

  const config = await locationConfig();

  const place =
    config.provider === 'GOOGLE'
      ? await google(lat, lng, config.key)
      : config.provider === 'MAPBOX'
        ? await mapbox(lat, lng, config.key)
        : await osm(lat, lng);

  if (place) writeCache(key, place);
  return place;
}

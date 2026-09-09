/**
 * "Where am I, and do you deliver here?" — answered from a device coordinate.
 *
 * This is the storefront's new front door. Asking a contractor to type a
 * pincode is asking them to know one, and on a plot that may not have an
 * address yet they often do not. Their phone does.
 *
 * The chain is: coordinate → pincode (via `geocode.ts`) → `ServiceablePincode`.
 * Every step happens here, on the server, because the middle one holds a sealed
 * key and the last one decides a delivery charge. A client that resolved its
 * own pincode could claim a serviced one.
 */
import { prisma } from '@buildkart/database';
import type { DeviceLocationDto } from '@buildkart/shared';
import { decimalToString } from '../dto.ts';
import { reverseGeocode } from './geocode.ts';

/**
 * How many serviced areas to name in the out-of-range message.
 *
 * A count, and deliberately **no distance**.
 *
 * An earlier version ranked these by kilometres, using a customer's saved pin
 * as a stand-in for the area's location. Real data killed it: an address filed
 * under Indore pincode 452001 carried Bengaluru coordinates — somebody who had
 * granted location while travelling — which made the screen announce that a
 * neighbouring Indore suburb was 1,147 km from Bhopal.
 *
 * One customer's pin is not an area's location, and no amount of outlier
 * filtering makes it one while the shop has a handful of pins in total. The
 * list is useful without a number: "right now we reach Vijay Nagar, Nehru Nagar
 * and Old Palasia" says we are nearby, and cannot be wrong.
 *
 * The proper fix is a coordinate on `ServiceablePincode` itself, set by the
 * owner beside the delivery charge. That is a migration and an admin field; when
 * it exists the distance can come back, measured against the shop's own data
 * rather than inferred from its customers'.
 */
const NEARBY_LIMIT = 5;

/**
 * Resolves a device coordinate into a delivery answer.
 *
 * Never throws for a location we do not serve. "We are not there yet" is the
 * single most common answer a growing shop gives, and it is a *result* with a
 * next step attached — the notify-me request — not a failure.
 */
export async function resolveDeviceLocation(input: {
  latitude: number;
  longitude: number;
}): Promise<DeviceLocationDto> {
  const { latitude, longitude } = input;

  const place = await reverseGeocode(latitude, longitude);

  const base = {
    latitude: String(latitude),
    longitude: String(longitude),
    pincode: place?.pincode ?? null,
    areaName: place?.areaName ?? null,
    city: place?.city ?? null,
    state: place?.state ?? null,
    formatted: place?.formatted ?? null,
  };

  /*
   * No pincode means the geocoder could not name the spot — a field, a new
   * layout, or simply a provider outage. The storefront's answer is to ask for
   * one by hand, so this is reported as its own outcome rather than as "not
   * serviced", which would be a claim we cannot support.
   */
  if (!place?.pincode) {
    return { ...base, resolved: false, serviced: false, area: null, nearby: [] };
  }

  const area = await prisma.serviceablePincode.findUnique({
    where: { pincode: place.pincode },
  });

  if (area?.isActive) {
    return {
      ...base,
      resolved: true,
      serviced: true,
      area: {
        pincode: area.pincode,
        // The owner's name for the area beats the geocoder's: "Vijay Nagar &
        // Scheme 78" is what their customers say, and the map's "Scheme No 78"
        // is not.
        areaName: area.areaNameEn,
        city: area.city,
        deliveryCharge: decimalToString(area.deliveryCharge),
        freeAbove: decimalToString(area.freeDeliveryAbove),
        promiseHours: area.promiseHours,
      },
      nearby: [],
    };
  }

  /*
   * Out of range. Name the places we *do* cover, because "not yet" lands very
   * differently when it comes with "but we are already in Indore" — that reads
   * as a shop expanding toward you rather than one with no interest in you.
   */
  const serviced = await prisma.serviceablePincode.findMany({
    where: { isActive: true },
    // The owner's own ordering: they know which areas are worth naming first.
    orderBy: [{ position: 'asc' }],
    take: NEARBY_LIMIT,
    select: { pincode: true, areaNameEn: true, city: true, promiseHours: true },
  });

  return {
    ...base,
    resolved: true,
    serviced: false,
    area: null,
    nearby: serviced.map((row) => ({
      pincode: row.pincode,
      areaName: row.areaNameEn,
      city: row.city,
      promiseHours: row.promiseHours,
    })),
  };
}

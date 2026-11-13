/**
 * Place search for the FireSync Globe, using OpenStreetMap Nominatim.
 *
 * Usage policy (https://operations.osmfoundation.org/policies/nominatim/): max 1 request per
 * second, no bulk use, no search-as-you-type, results must be attributed to OpenStreetMap.
 * So: search runs on submit only, requests are spaced >= 1 s apart, in-flight requests are aborted,
 * and the UI shows "© OpenStreetMap contributors" next to the results.
 * The browser sends its own Referer; custom User-Agent headers cannot be set from browser JS.
 */

import { BoundingBox } from '../types/fire';

export const NOMINATIM_ATTRIBUTION = 'Search © OpenStreetMap contributors (Nominatim)';
const ENDPOINT = 'https://nominatim.openstreetmap.org/search';
const MIN_INTERVAL_MS = 1000;

export interface PlaceResult {
  name: string;
  lat: number;
  lng: number;
  /** Present for countries/regions; west may be > east when the place crosses the antimeridian. */
  bbox?: BoundingBox;
  kind: string;
}

interface NominatimRow {
  display_name?: string;
  lat?: string;
  lon?: string;
  boundingbox?: string[]; // [south, north, west, east]
  type?: string;
  addresstype?: string;
}

export class GeocodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeocodeError';
  }
}

/** Parses Nominatim JSON rows; ignores rows without usable coordinates. */
export function parseNominatim(rows: unknown): PlaceResult[] {
  if (!Array.isArray(rows)) return [];
  const out: PlaceResult[] = [];
  for (const r of rows as NominatimRow[]) {
    const lat = Number(r.lat);
    const lng = Number(r.lon);
    if (!r.display_name || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) continue;

    let bbox: BoundingBox | undefined;
    if (Array.isArray(r.boundingbox) && r.boundingbox.length === 4) {
      const [south, north, west, east] = r.boundingbox.map(Number);
      if ([south, north, west, east].every(Number.isFinite) && south <= north) {
        bbox = { south, north, west, east };
      }
    }
    out.push({ name: r.display_name, lat, lng, bbox, kind: r.addresstype || r.type || 'place' });
  }
  return out;
}

export function buildSearchUrl(query: string, limit = 5): string {
  const params = new URLSearchParams({
    q: query.trim(),
    format: 'jsonv2',
    limit: String(limit),
    'accept-language': 'en',
  });
  return `${ENDPOINT}?${params.toString()}`;
}

let lastRequestAt = 0;

/**
 * Searches for a place. Throws GeocodeError with a user-facing message on failure;
 * rethrows AbortError untouched so callers can ignore cancelled searches.
 */
export async function searchPlaces(query: string, signal?: AbortSignal): Promise<PlaceResult[]> {
  const q = query.trim();
  if (q.length < 2) return [];

  const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, wait);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(t);
          reject(new DOMException('Aborted', 'AbortError'));
        },
        { once: true }
      );
    });
  }
  lastRequestAt = Date.now();

  let res: Response;
  try {
    res = await fetch(buildSearchUrl(q), { signal, headers: { Accept: 'application/json' } });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new GeocodeError('Place search is unreachable. Check your connection and try again.');
  }
  if (res.status === 429) throw new GeocodeError('Place search is busy. Wait a few seconds and try again.');
  if (!res.ok) throw new GeocodeError(`Place search failed (HTTP ${res.status}).`);

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new GeocodeError('Place search returned an unreadable answer.');
  }
  return parseNominatim(json);
}

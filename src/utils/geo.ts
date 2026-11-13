/**
 * Viewport / bounding-box helpers for the FireSync Globe.
 *
 * Pure functions only (no DOM, no MapLibre) so they can be unit-tested with `tsx --test`.
 * FIRMS "area" requests need `west,south,east,north` in -180..180 / -90..90 with west < east,
 * so a viewport that crosses the antimeridian must be split into two requests.
 */

import { BoundingBox } from '../types/fire';

/** Do not request fires below this map zoom (MapLibre zoom: 0 = whole world in 512 px). */
export const MIN_LOAD_ZOOM = 3;
/** Do not request a viewport wider/taller than this many degrees (keeps FIRMS responses small). */
export const MAX_LOAD_SPAN_DEG = 70;
/** Viewport boxes are snapped outward to whole degrees so small pans re-use the server cache. */
export const BBOX_SNAP_DEG = 1;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function clampLat(lat: number): number {
  return clamp(lat, -90, 90);
}

export function clampLng(lng: number): number {
  return clamp(lng, -180, 180);
}

/** Wraps any longitude into [-180, 180). */
export function wrapLng(lng: number): number {
  return ((((lng + 180) % 360) + 360) % 360) - 180;
}

/** Clamps every edge of a box into the valid lat/lng range (does not reorder edges). */
export function clampBbox(b: BoundingBox): BoundingBox {
  return {
    west: clampLng(b.west),
    south: clampLat(b.south),
    east: clampLng(b.east),
    north: clampLat(b.north),
  };
}

/**
 * Converts a raw viewport (as returned by `map.getBounds()`, which may be un-wrapped, e.g.
 * west = -200 or east = 190) into one or two valid boxes.
 *  - width >= 360  -> whole world in one box
 *  - crosses the antimeridian -> two boxes: [west..180] and [-180..east]
 *  - west > east is read as "crosses the antimeridian" (already wrapped input)
 * Returns [] for non-finite input.
 */
export function splitBboxAtAntimeridian(
  west: number,
  south: number,
  east: number,
  north: number
): BoundingBox[] {
  if (![west, south, east, north].every(Number.isFinite)) return [];

  let s = clampLat(south);
  let n = clampLat(north);
  if (s > n) [s, n] = [n, s];

  let width = east - west;
  if (width < 0) width += 360; // wrapped input, e.g. west 170, east -170
  if (width >= 360) return [{ west: -180, south: s, east: 180, north: n }];

  const w = wrapLng(west);
  const e = w + width;
  if (e <= 180) return [{ west: w, south: s, east: e, north: n }];
  return [
    { west: w, south: s, east: 180, north: n },
    { west: -180, south: s, east: e - 360, north: n },
  ];
}

/** Snaps a box outward to a `step`-degree grid, clamped, never zero-width/height. */
export function snapBboxOutward(b: BoundingBox, step = BBOX_SNAP_DEG): BoundingBox {
  let west = clampLng(Math.floor(b.west / step) * step);
  let east = clampLng(Math.ceil(b.east / step) * step);
  let south = clampLat(Math.floor(b.south / step) * step);
  let north = clampLat(Math.ceil(b.north / step) * step);

  if (east <= west) {
    east = Math.min(180, west + step);
    if (east <= west) west = east - step;
  }
  if (north <= south) {
    north = Math.min(90, south + step);
    if (north <= south) south = north - step;
  }
  return { west, south, east, north };
}

/** Raw viewport -> snapped, valid boxes (1 or 2). */
export function viewportToBboxes(
  raw: { west: number; south: number; east: number; north: number },
  snapStep = BBOX_SNAP_DEG
): BoundingBox[] {
  return splitBboxAtAntimeridian(raw.west, raw.south, raw.east, raw.north).map((b) =>
    snapBboxOutward(b, snapStep)
  );
}

/** "west,south,east,north" for the FIRMS area endpoint (4 decimals max, no exponent notation). */
export function bboxToArea(b: BoundingBox): string {
  const f = (n: number) => String(Number(n.toFixed(4)));
  return `${f(b.west)},${f(b.south)},${f(b.east)},${f(b.north)}`;
}

/** Stable key for a set of boxes (used to detect "viewport really changed"). */
export function bboxesKey(boxes: BoundingBox[]): string {
  return boxes.map(bboxToArea).join('|');
}

/** Total longitude span and the largest latitude span of a set of boxes, in degrees. */
export function bboxesSpan(boxes: BoundingBox[]): { lngSpan: number; latSpan: number } {
  let lngSpan = 0;
  let latSpan = 0;
  for (const b of boxes) {
    lngSpan += b.east - b.west;
    latSpan = Math.max(latSpan, b.north - b.south);
  }
  return { lngSpan, latSpan };
}

/** True when the viewport is zoomed in far enough (and small enough) to load fires for it. */
export function shouldLoadViewport(
  zoom: number,
  boxes: BoundingBox[],
  minZoom = MIN_LOAD_ZOOM,
  maxSpanDeg = MAX_LOAD_SPAN_DEG
): boolean {
  if (boxes.length === 0 || zoom < minZoom) return false;
  const { lngSpan, latSpan } = bboxesSpan(boxes);
  return lngSpan <= maxSpanDeg && latSpan <= maxSpanDeg;
}

/**
 * Lowest zoom at which a container `widthPx` wide shows no more than `maxSpanDeg` of longitude
 * (MapLibre world = 512 * 2^zoom px). A degree of longitude is shorter away from the equator, so
 * pass the view's latitude to get the right floor there.
 */
export function minZoomForLngSpan(
  widthPx: number,
  maxSpanDeg = MAX_LOAD_SPAN_DEG,
  latDeg = 0
): number {
  if (!(widthPx > 0) || !(maxSpanDeg > 0)) return MIN_LOAD_ZOOM;
  const cos = Math.max(0.2, Math.cos((clampLat(latDeg) * Math.PI) / 180));
  return Math.max(MIN_LOAD_ZOOM, Math.log2((widthPx * 360) / (512 * maxSpanDeg * cos)));
}

/** Shifts `lng` by multiples of 360 so it lies within 180 degrees of `refLng`. */
export function unwrapLngNear(lng: number, refLng: number): number {
  return lng + 360 * Math.round((refLng - lng) / 360);
}

/**
 * Bounding box of a set of lng/lat samples (e.g. unprojected screen points), antimeridian-safe:
 * longitudes are unwrapped around `centerLng`, so the result may have east > 180 or west < -180
 * (which splitBboxAtAntimeridian/viewportToBboxes then split). Returns null for empty/non-finite input.
 */
export function bboxFromSamples(
  samples: { lng: number; lat: number }[],
  centerLng: number
): { west: number; south: number; east: number; north: number } | null {
  if (samples.length === 0 || samples.some((p) => !Number.isFinite(p.lng) || !Number.isFinite(p.lat))) {
    return null;
  }
  const lngs = samples.map((p) => unwrapLngNear(p.lng, centerLng));
  const lats = samples.map((p) => p.lat);
  return {
    west: Math.min(...lngs),
    east: Math.max(...lngs),
    south: Math.min(...lats),
    north: Math.max(...lats),
  };
}

/** Merges observation lists from several requests, de-duplicating by `id`. */
export function dedupeById<T extends { id: string }>(lists: T[][]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const list of lists) {
    for (const item of list) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(item);
    }
  }
  return out;
}

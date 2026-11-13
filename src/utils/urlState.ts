/**
 * Shareable map view state <-> URL query string.
 *
 * Pure functions, no DOM access. `decodeViewState` never throws: any malformed
 * or out-of-range field falls back to its default (see DEFAULT_VIEW_STATE).
 *
 * Query params: lat, lng, z (zoom), d (days 1..5), layers (comma list of
 * modis,viirs; present-but-empty means "no layers"), t (timeline 0..1),
 * date (optional YYYY-MM-DD), view ("map" = flat World map; absent = 3D Globe, the default),
 * aoi (optional compact polygon: `lon,lat;lon,lat;...` in GeoJSON order).
 */

import type { AoiPolygon } from '../types/fire';
import { decodePolygon, encodePolygon, validatePolygon } from './polygon';

export type LayerId = 'modis' | 'viirs';

/** The two views of the one map: the 3D globe (default) or the flat, north-up World map. */
export type MapView = 'globe' | 'map';
export const DEFAULT_MAP_VIEW: MapView = 'globe';

export interface ViewState {
  lat: number;
  lng: number;
  zoom: number;
  /** Look-back window in days, integer 1..5. */
  days: number;
  /** Visible sensor layers. MODIS and VIIRS are always independent layers. */
  layers: LayerId[];
  /** Timeline position, 0 (start of window) .. 1 (latest). */
  timeline: number;
  /** Optional pinned date, YYYY-MM-DD (UTC). */
  date?: string;
  /** Map view. Absent = 'globe' (the default is never written to the URL). */
  view?: MapView;
  /** Optional polygon AOI in [lon, lat] order. bbox is derived from it server-side as a prefilter. */
  aoi?: AoiPolygon;
}

export const LAT_MIN = -90;
export const LAT_MAX = 90;
export const ZOOM_MIN = 0;
export const ZOOM_MAX = 22;
export const DAYS_MIN = 1;
export const DAYS_MAX = 5;
export const ALL_LAYERS: readonly LayerId[] = ['modis', 'viirs'];

export const DEFAULT_VIEW_STATE: Readonly<ViewState> = Object.freeze({
  lat: 20,
  lng: 0,
  zoom: 2,
  days: 1,
  layers: ['modis', 'viirs'] as LayerId[],
  timeline: 1,
});

function defaults(): ViewState {
  return { ...DEFAULT_VIEW_STATE, layers: [...DEFAULT_VIEW_STATE.layers] };
}

/** Strict numeric parse: rejects '', whitespace, NaN, +-Infinity, "12abc". */
function parseNumber(raw: string | null): number | null {
  if (raw === null) return null;
  const s = raw.trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function clampLat(lat: number): number {
  return clamp(lat, LAT_MIN, LAT_MAX);
}

export function clampZoom(zoom: number): number {
  return clamp(zoom, ZOOM_MIN, ZOOM_MAX);
}

/**
 * Wraps longitude into [-180, 180] across the antimeridian. -180 and 180 are
 * both preserved (idempotent); 540 -> 180, -540 -> -180, 190 -> -170.
 */
export function wrapLng(lng: number): number {
  if (!Number.isFinite(lng)) return NaN;
  if (lng >= -180 && lng <= 180) return lng;
  const wrapped = ((((lng + 180) % 360) + 360) % 360) - 180;
  return wrapped === -180 && lng > 0 ? 180 : wrapped;
}

function isValidDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function canonicalLayers(layers: readonly string[]): LayerId[] {
  return ALL_LAYERS.filter((l) => layers.includes(l));
}

/** Compact number text: fixed decimals, trailing zeros and "-0" removed. */
function fmt(n: number, decimals: number): string {
  return String(Number(n.toFixed(decimals)));
}

/** Encodes a view state to a query string (no leading '?'). Values are normalised first. */
export function encodeViewState(state: ViewState): string {
  const p = new URLSearchParams();
  const lat = Number.isFinite(state.lat) ? clampLat(state.lat) : DEFAULT_VIEW_STATE.lat;
  const lngRaw = wrapLng(state.lng);
  const lng = Number.isFinite(lngRaw) ? lngRaw : DEFAULT_VIEW_STATE.lng;
  const zoom = Number.isFinite(state.zoom) ? clampZoom(state.zoom) : DEFAULT_VIEW_STATE.zoom;
  const days =
    Number.isInteger(state.days) && state.days >= DAYS_MIN && state.days <= DAYS_MAX
      ? state.days
      : DEFAULT_VIEW_STATE.days;
  const timeline =
    Number.isFinite(state.timeline) && state.timeline >= 0 && state.timeline <= 1
      ? state.timeline
      : DEFAULT_VIEW_STATE.timeline;

  p.set('lat', fmt(lat, 4));
  p.set('lng', fmt(lng, 4));
  p.set('z', fmt(zoom, 2));
  p.set('d', String(days));
  p.set('layers', canonicalLayers(state.layers ?? []).join(','));
  p.set('t', fmt(timeline, 3));
  if (state.date !== undefined && isValidDate(state.date)) p.set('date', state.date);
  if (state.view === 'map') p.set('view', 'map');
  if (state.aoi) {
    const valid = validatePolygon(state.aoi);
    if (valid.ok) p.set('aoi', encodePolygon(valid.polygon));
  }
  return p.toString();
}

/**
 * Decodes a query string (with or without leading '?') or URLSearchParams.
 * Never throws. Rules per field:
 *  - lat, zoom: numeric but out of range -> clamped; not numeric -> default
 *  - lng: numeric -> wrapped across the antimeridian; not numeric -> default
 *  - days: must be an integer 1..5, else default
 *  - layers: unknown tokens ignored; present but empty -> none visible;
 *    non-empty with no valid token -> default
 *  - timeline: must be within 0..1, else default
 *  - date: must be a real YYYY-MM-DD calendar date, else omitted
 *  - view: "map" -> World map; anything else (including "globe") -> the default, key omitted
 *  - aoi: valid compact polygon -> applied; malformed / degenerate -> omitted
 */
export function decodeViewState(input: string | URLSearchParams | null | undefined): ViewState {
  const out = defaults();
  try {
    const p =
      input instanceof URLSearchParams
        ? input
        : new URLSearchParams(typeof input === 'string' ? input : '');

    const lat = parseNumber(p.get('lat'));
    if (lat !== null) out.lat = clampLat(lat);

    const lng = parseNumber(p.get('lng'));
    if (lng !== null) {
      const w = wrapLng(lng);
      if (Number.isFinite(w)) out.lng = w;
    }

    const zoom = parseNumber(p.get('z'));
    if (zoom !== null) out.zoom = clampZoom(zoom);

    const days = parseNumber(p.get('d'));
    if (days !== null && Number.isInteger(days) && days >= DAYS_MIN && days <= DAYS_MAX) {
      out.days = days;
    }

    const layersRaw = p.get('layers');
    if (layersRaw !== null) {
      const tokens = layersRaw
        .split(',')
        .map((t) => t.trim().toLowerCase())
        .filter((t) => t !== '');
      if (tokens.length === 0) {
        out.layers = [];
      } else {
        const valid = canonicalLayers(tokens);
        if (valid.length > 0) out.layers = valid;
      }
    }

    const t = parseNumber(p.get('t'));
    if (t !== null && t >= 0 && t <= 1) out.timeline = t;

    const date = p.get('date');
    if (date !== null && isValidDate(date)) out.date = date;

    if (p.get('view') === 'map') out.view = 'map';

    const aoiRaw = p.get('aoi');
    if (aoiRaw !== null) {
      const aoi = decodePolygon(aoiRaw);
      if (aoi) out.aoi = aoi;
    }
  } catch {
    return defaults();
  }
  return out;
}

/**
 * Pure helpers for sharing / exporting the 3D Globe view (no DOM, no MapLibre).
 *
 *  - buildShareUrl / parseShareParams: view state <-> link. Only the known view params are ever written,
 *    so a link carries no secrets and no API keys.
 *  - selectVisibleDetections: THE definition of "visible detections" (see VISIBLE_DETECTIONS_DEFINITION).
 *  - buildShareFilename: ASCII-only export file names.
 *  - layoutCaptureFooter: text lines of the PNG capture footer.
 *
 * Science rules: MODIS and VIIRS are always counted separately and never summed.
 */

import type { AoiPolygon, CanonicalObservation } from '../types/fire';
import { EXPORT_DISCLAIMER } from './export';
import {
  ALL_LAYERS,
  DAYS_MAX,
  DAYS_MIN,
  decodeViewState,
  encodeViewState,
  clampLat,
  clampZoom,
  wrapLng,
  type LayerId,
  type MapView,
  type ViewState,
} from './urlState';
import { observationsAtOrBefore } from './timeline';

// ---------------------------------------------------------------------------
// Visible detections
// ---------------------------------------------------------------------------

/** Shown in the UI and in the docs, next to the export / capture actions. */
export const VISIBLE_DETECTIONS_DEFINITION =
  'Visible detections: the detections loaded for the current globe area whose sensor layer is switched on and, ' +
  'while the timeline is active, whose time is at or before the timeline position.';

export interface SensorCounts {
  MODIS: number;
  VIIRS: number;
}

type VisibleCandidate = Pick<CanonicalObservation, 'sensor' | 'datetime_utc'>;

const LAYER_OF_SENSOR: Record<'MODIS' | 'VIIRS', LayerId> = { MODIS: 'modis', VIIRS: 'viirs' };

/**
 * Loaded detections whose sensor layer is on and, when `cutoffMs` is a number, with time <= cutoffMs.
 * `cutoffMs` null / undefined: no timeline, no time filter. Input order is preserved. Records whose sensor
 * is neither MODIS nor VIIRS are dropped (never guessed). Never mutates the input.
 */
export function selectVisibleDetections<T extends VisibleCandidate>(
  detections: readonly T[],
  layers: readonly LayerId[],
  cutoffMs: number | null | undefined,
): T[] {
  const on = new Set<LayerId>(layers);
  const bySensor = detections.filter(
    (d) => !!d && (d.sensor === 'MODIS' || d.sensor === 'VIIRS') && on.has(LAYER_OF_SENSOR[d.sensor]),
  );
  if (typeof cutoffMs !== 'number') return bySensor;
  return observationsAtOrBefore(bySensor, cutoffMs);
}

/** Per-sensor counts. There is deliberately no combined total. */
export function countBySensor(detections: readonly Pick<CanonicalObservation, 'sensor'>[]): SensorCounts {
  const c: SensorCounts = { MODIS: 0, VIIRS: 0 };
  for (const d of detections) {
    if (d && (d.sensor === 'MODIS' || d.sensor === 'VIIRS')) c[d.sensor] += 1;
  }
  return c;
}

// ---------------------------------------------------------------------------
// Share URL
// ---------------------------------------------------------------------------

/** What a link carries. `timeline` is null while the timeline bar is closed (then no `t` param is written). */
export interface ShareState {
  lat: number;
  lng: number;
  zoom: number;
  days: number;
  layers: LayerId[];
  timeline: number | null;
  date?: string;
  /** 'map' = World map. Omitted / 'globe': the default (no `view` param is written). */
  view?: MapView;
  /** Optional polygon AOI shared across pages and URLs. */
  aoi?: AoiPolygon;
}

/** The query string (no leading '?') for a view: only the known view params, never anything else. */
export function buildShareQuery(state: ShareState): string {
  const view: ViewState = {
    lat: state.lat,
    lng: state.lng,
    zoom: state.zoom,
    days: state.days,
    layers: state.layers,
    timeline: state.timeline ?? 1,
    date: state.date,
    view: state.view,
    aoi: state.aoi,
  };
  const params = new URLSearchParams(encodeViewState(view));
  if (state.timeline === null || !Number.isFinite(state.timeline)) params.delete('t');
  return params.toString();
}

/**
 * Link for a view: `<origin><path>?lat=&lng=&z=&d=&layers=[&t=][&date=]`.
 * Only those params are written: any query, hash or credentials in `origin` / `path` are dropped, so no
 * secrets or API keys can leak into a link. If `origin` is not a valid http(s) origin the result is the
 * relative `<path>?<query>`.
 */
export function buildShareUrl(origin: string, path: string, state: ShareState): string {
  const query = buildShareQuery(state);

  let cleanPath = typeof path === 'string' ? path.split(/[?#]/)[0] : '/';
  if (!cleanPath.startsWith('/')) cleanPath = `/${cleanPath}`;

  try {
    const o = new URL(origin);
    if (o.protocol !== 'http:' && o.protocol !== 'https:') throw new Error('not http(s)');
    // URL.origin drops username, password, path, query and hash.
    return `${o.origin}${cleanPath}?${query}`;
  } catch {
    return `${cleanPath}?${query}`;
  }
}

/** Query params owned by the share link. Everything else in the address bar is left alone. */
export const VIEW_PARAM_KEYS = ['lat', 'lng', 'z', 'd', 'layers', 't', 'date', 'view', 'aoi'] as const;

/** `search` without the view params (no leading '?'); unknown params are kept. Never throws. */
export function clearViewParams(search: string | null | undefined): string {
  try {
    const p = new URLSearchParams(typeof search === 'string' ? search : '');
    for (const k of VIEW_PARAM_KEYS) p.delete(k);
    return p.toString();
  } catch {
    return '';
  }
}

/** `search` with the view params replaced by `state` (no leading '?'); unknown params are kept. */
export function mergeViewParams(search: string | null | undefined, state: ShareState): string {
  const rest = clearViewParams(search);
  const view = buildShareQuery(state);
  return rest ? `${rest}&${view}` : view;
}

/** Which parts of the view the query string actually contained (valid values only). */
export interface ParsedShareParams {
  /** Always fully populated: defaults fill whatever was absent or malformed. */
  state: ViewState;
  /** lat AND lng were both present and numeric: only then is a camera applied (otherwise keep the home view). */
  hasCamera: boolean;
  hasDays: boolean;
  hasLayers: boolean;
  /** A `t` param was present and numeric (clamped into 0..1). */
  hasTimeline: boolean;
  /** A valid `view` param (`map` or `globe`) was present. */
  hasView: boolean;
  /** A valid polygon AOI was present. */
  hasAoi: boolean;
  /** Any of the above: the view comes from the URL (the idle globe rotation must not start). */
  fromUrl: boolean;
}

function numeric(raw: string | null): number | null {
  if (raw === null || raw.trim() === '') return null;
  const n = Number(raw.trim());
  return Number.isFinite(n) ? n : null;
}

/**
 * Reads a query string (location.search). Never throws; unknown params are ignored; malformed or hostile
 * values fall back to the defaults of decodeViewState. Differences from decodeViewState, needed to tell
 * "absent" from "default": presence flags, and `t` out of range is clamped to 0..1 instead of dropped.
 */
export function parseShareParams(search: string | null | undefined): ParsedShareParams {
  let state: ViewState = decodeViewState(undefined);
  const none: ParsedShareParams = {
    state,
    hasCamera: false,
    hasDays: false,
    hasLayers: false,
    hasTimeline: false,
    hasView: false,
    hasAoi: false,
    fromUrl: false,
  };
  try {
    const raw = typeof search === 'string' ? search : '';
    const p = new URLSearchParams(raw);
    state = decodeViewState(p);

    const lat = numeric(p.get('lat'));
    const lng = numeric(p.get('lng'));
    const hasCamera = lat !== null && lng !== null && Number.isFinite(wrapLng(lng));
    if (hasCamera) {
      // decodeViewState already clamped / wrapped; zoom absent keeps its default.
      state = { ...state, lat: clampLat(lat), lng: wrapLng(lng) };
    }

    const zoom = numeric(p.get('z'));
    if (zoom !== null) state = { ...state, zoom: clampZoom(zoom) };

    const d = numeric(p.get('d'));
    const hasDays = d !== null && Number.isInteger(d) && d >= DAYS_MIN && d <= DAYS_MAX;

    const layersRaw = p.get('layers');
    // Present-but-empty means "no layers"; present with no valid token falls back to the default (not applied).
    const layerTokens =
      layersRaw === null
        ? []
        : layersRaw
            .split(',')
            .map((s) => s.trim().toLowerCase())
            .filter((s) => s !== '');
    const hasLayers =
      layersRaw !== null && (layerTokens.length === 0 || layerTokens.some((s) => (ALL_LAYERS as readonly string[]).includes(s)));

    const t = numeric(p.get('t'));
    const hasTimeline = t !== null;
    if (t !== null) state = { ...state, timeline: Math.min(1, Math.max(0, t)) };

    const viewRaw = p.get('view');
    const hasView = viewRaw === 'map' || viewRaw === 'globe';

    // decodeViewState has already validated and decoded the compact polygon.
    const hasAoi = Array.isArray(state.aoi) && state.aoi.length >= 3;

    return {
      state,
      hasCamera,
      hasDays,
      hasLayers,
      hasTimeline,
      hasView,
      hasAoi,
      fromUrl: hasCamera || hasDays || hasLayers || hasTimeline || hasView || hasAoi,
    };
  } catch {
    return none;
  }
}

/** Snaps a day count to the nearest option the UI offers (ties go to the smaller window). */
export function snapDays(days: number, options: readonly number[]): number {
  let best = options[0];
  for (const o of options) {
    if (Math.abs(o - days) < Math.abs(best - days)) best = o;
  }
  return best;
}

/** Timeline position 0..1 -> step index 0..stepCount-1 (clamped; 0 when there are no steps). */
export function timelineStepFromFraction(fraction: number, stepCount: number): number {
  if (!Number.isFinite(fraction) || stepCount <= 1) return 0;
  return Math.round(Math.min(1, Math.max(0, fraction)) * (stepCount - 1));
}

/** Step index -> position 0..1 (1 when there is a single step or none). */
export function timelineFractionFromStep(step: number, stepCount: number): number {
  if (!Number.isFinite(step) || stepCount <= 1) return 1;
  return Math.min(1, Math.max(0, step / (stepCount - 1)));
}

// ---------------------------------------------------------------------------
// File names
// ---------------------------------------------------------------------------

export type ShareFileExt = 'csv' | 'geojson' | 'png';

function asciiSlug(s: string, max = 32): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, max)
    .replace(/-+$/g, '');
}

/** `YYYYMMDDTHHMMSSZ` in UTC. */
export function utcStamp(now: Date): string {
  const d = Number.isNaN(now.getTime()) ? new Date(0) : now;
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');
}

function coordLabel(lat: number, lng: number): string {
  const la = Math.abs(clampLat(lat)).toFixed(2) + (lat < 0 ? 'S' : 'N');
  const wl = wrapLng(lng);
  const lo = Math.abs(Number.isFinite(wl) ? wl : 0).toFixed(2) + (wl < 0 ? 'W' : 'E');
  return `${la}-${lo}`;
}

/**
 * `firesync_<area-or-view>_<days>d_<UTC timestamp>.<ext>`, ASCII only. The middle part is the slug of `area`
 * when it has any ASCII letters or digits, otherwise the view centre like `20.00N-60.00E`.
 */
export function buildShareFilename(opts: {
  area?: string | null;
  view?: { lat: number; lng: number } | null;
  days: number;
  ext: ShareFileExt;
  now?: Date;
}): string {
  const slug = opts.area ? asciiSlug(opts.area) : '';
  const middle = slug || (opts.view ? coordLabel(opts.view.lat, opts.view.lng) : 'view');
  const days = Number.isInteger(opts.days) && opts.days > 0 ? opts.days : 1;
  return `firesync_${middle}_${days}d_${utcStamp(opts.now ?? new Date())}.${opts.ext}`;
}

// ---------------------------------------------------------------------------
// Capture footer
// ---------------------------------------------------------------------------

export const CAPTURE_FIRMS_CREDIT = 'Fire data: NASA FIRMS (MODIS and VIIRS active fire)';

export interface CaptureFooterInput {
  /** Moment the view was captured. */
  viewTime: Date;
  counts: SensorCounts;
  /** Credits to print, e.g. ['Fire data: NASA FIRMS ...', 'Imagery: NASA EOSDIS GIBS']. */
  attribution: readonly string[];
  /** Look-back window in days (optional). */
  days?: number;
  /** Active timeline cutoff in epoch ms (optional; omitted when no timeline is active). */
  timelineCutoffMs?: number | null;
  /** Wrap width in characters (default 90, minimum 20). */
  maxChars?: number;
}

function iso(ms: Date | number): string {
  const d = ms instanceof Date ? ms : new Date(ms);
  return Number.isNaN(d.getTime()) ? 'unknown' : d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line === '') line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      out.push(line);
      line = word;
    }
    while (line.length > width) {
      out.push(line.slice(0, width));
      line = line.slice(width);
    }
  }
  if (line !== '') out.push(line);
  return out;
}

/**
 * Footer lines, in order: legend sentence, per-sensor counts (separate, never summed), UTC time of the view
 * (plus the timeline position when active), attribution. Long lines are wrapped at `maxChars`.
 */
export function layoutCaptureFooter(input: CaptureFooterInput): string[] {
  const width = Math.max(20, Math.floor(input.maxChars ?? 90));
  const c = input.counts;
  const windowText = input.days && input.days > 0 ? ` · last ${input.days} day${input.days > 1 ? 's' : ''}` : '';
  const counts = `MODIS ${c.MODIS.toLocaleString('en-US')} · VIIRS ${c.VIIRS.toLocaleString('en-US')} (shown separately, not summed)${windowText}`;
  let time = `View time (UTC): ${iso(input.viewTime)}`;
  if (typeof input.timelineCutoffMs === 'number') time += ` · timeline up to ${iso(input.timelineCutoffMs)}`;
  const credits = input.attribution.filter((a) => a.trim() !== '').join(' · ');

  return [EXPORT_DISCLAIMER, counts, time, ...(credits ? [credits] : [])].flatMap((l) => wrap(l, width));
}

/**
 * NASA GIBS (Global Imagery Browse Services) WMTS helpers for the FireSync Globe.
 *
 * Pure builders only: no network calls, no DOM, no MapLibre runtime import (types only).
 * GIBS is free and needs no API key.
 *
 * VERIFICATION STATUS (unverified values are listed in GIBS_CONFIG.unverified):
 *  - Checked against NASA's GIBS API docs and the public WMS/TWMS GetCapabilities listings.
 *  - The raw WMTS GetCapabilities XML (~5 MB) could NOT be read in the authoring environment,
 *    so every value that depends on it is listed in GIBS_CONFIG.unverified and carries the
 *    marker UNVERIFIED_MARKER. Re-check those against
 *    https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/1.0.0/WMTSCapabilities.xml
 *    before shipping.
 */

import type { RasterLayerSpecification, RasterSourceSpecification } from 'maplibre-gl';

export const UNVERIFIED_MARKER = 'UNVERIFIED - check GIBS GetCapabilities';

export type GibsLayerKey = 'baseMap' | 'trueColor';

export interface GibsLayerConfig {
  /** WMTS layer identifier. */
  id: string;
  title: string;
  /** WMTS TileMatrixSet identifier (Web Mercator, reprojected by GIBS on the fly). */
  tileMatrixSet: string;
  /** Highest tile matrix (zoom) index served; MapLibre `maxzoom`. */
  maxZoom: number;
  /** File extension used in REST tile URLs. */
  extension: 'jpg' | 'jpeg' | 'png';
  /** Whether the layer has a TIME dimension (daily layers) or is static. */
  hasTime: boolean;
  /** Earliest valid YYYY-MM-DD for time layers (see `unverified`). */
  minDate?: string;
}

export const GIBS_CONFIG = {
  /** GIBS "best available" WMTS, Web Mercator (EPSG:3857). REST root has no trailing slash. */
  endpoint: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best',
  /** Same server under extra DNS names (docs: only aliases, helps browser connection limits). */
  hosts: ['gibs.earthdata.nasa.gov', 'gibs-a.earthdata.nasa.gov', 'gibs-b.earthdata.nasa.gov', 'gibs-c.earthdata.nasa.gov'],
  /** GIBS Web Mercator tiles are 256 px. */
  tileSize: 256,
  layers: {
    /** Calm static global base: MODIS Blue Marble with shaded relief and bathymetry, 500 m. */
    baseMap: {
      id: 'BlueMarble_ShadedRelief_Bathymetry',
      title: 'Blue Marble (shaded relief + bathymetry)',
      tileMatrixSet: 'GoogleMapsCompatible_Level8', // UNVERIFIED (see below)
      maxZoom: 8, // UNVERIFIED (see below)
      extension: 'jpeg', // UNVERIFIED (see below)
      hasTime: false,
    },
    /** Daily true-color: VIIRS NOAA-20 corrected reflectance, 250 m. */
    trueColor: {
      id: 'VIIRS_NOAA20_CorrectedReflectance_TrueColor',
      title: 'True color (VIIRS / NOAA-20 corrected reflectance)',
      tileMatrixSet: 'GoogleMapsCompatible_Level9',
      maxZoom: 9,
      extension: 'jpg',
      hasTime: true,
      minDate: '2018-01-05', // UNVERIFIED (see below)
    },
  } satisfies Record<GibsLayerKey, GibsLayerConfig>,
  /**
   * Newest selectable date = today (UTC) minus this many days. The current UTC day's mosaic is
   * built as satellites orbit, so many of its tiles are empty (per GIBS docs), so today is never requested.
   * Observed 2026-11-07 in a browser (VIIRS_NOAA20_CorrectedReflectance_TrueColor): 2026-11-06 complete,
   * 2026-11-05 completely black at zoom 5 and 6, 2026-11-04 complete. Black tiles come back with HTTP 200,
   * so tile errors do not trigger the fallback. Good and black days follow no known lag rule and the
   * cause of the gaps is unknown; the user steps the date by hand instead of relying on this default.
   */
  lagDays: 1,
  attribution: 'Imagery: NASA EOSDIS Global Imagery Browse Services (GIBS)',
  /**
   * Everything below could not be confirmed from the raw WMTS GetCapabilities document.
   * Each entry says what the value is, where it came from, and what to check.
   */
  unverified: {
    'layers.baseMap.tileMatrixSet': `${UNVERIFIED_MARKER}: Level8 inferred from 500 m layer resolution; a third-party WMTS map definition also uses GoogleMapsCompatible_Level8.`,
    'layers.baseMap.maxZoom': `${UNVERIFIED_MARKER}: 8, derived from Level8 (GIBS docs: Level9 = zoom 0..9 at 305.7 m/px min).`,
    'layers.baseMap.extension': `${UNVERIFIED_MARKER}: "jpeg" (format is image/jpeg per docs; the exact ResourceURL extension for this layer was not read).`,
    'layers.baseMap.urlShape': `${UNVERIFIED_MARKER}: static layer URL built without a time segment, .../{layer}/default/{tileMatrixSet}/{z}/{y}/{x}.jpeg.`,
    'layers.trueColor.minDate': `${UNVERIFIED_MARKER}: 2018-01-05 comes from a third-party project note ("GIBS has NOAA-20 imagery from 5 Jan 2018 onwards"), not from the layer's Dimension element.`,
    'layers.trueColor.latestDate': `${UNVERIFIED_MARKER}: the layer's current <Default>/end of time range was not read; lagDays = 1 (yesterday UTC) is an unverified default: a browser check on 2026-11-07 found 2026-11-05 black while 2026-11-04 and 2026-11-06 were complete, so no fixed lag is guaranteed to be complete.`,
  },
} as const;

/** Fallback basemap used when GIBS tiles fail. Same Esri dark-gray raster the Globe already uses. */
export const GIBS_FALLBACK_BASEMAP = {
  sourceId: 'fallback-base',
  layerId: 'fallback-base-layer',
  tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}'],
  tileSize: 256,
  maxZoom: 16,
  attribution: '&copy; Esri, HERE, Garmin, &copy; OpenStreetMap contributors',
  /** Solid colour that needs no network at all (last resort under the raster). */
  backgroundColor: '#0a1020',
  /** Switch to the fallback after this many consecutive GIBS tile errors. */
  errorThreshold: 3,
} as const;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

/** Format a Date as YYYY-MM-DD in UTC (GIBS time dimension is UTC dates). */
export function formatGibsDate(date: Date): string {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new RangeError('formatGibsDate: invalid Date');
  }
  return date.toISOString().slice(0, 10);
}

/** Strictly parse YYYY-MM-DD to a UTC-midnight Date; null if malformed or not a real date. */
export function parseGibsDate(value: string): Date | null {
  const m = DATE_RE.exec(value);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return formatGibsDate(d) === value ? d : null;
}

/** Newest date we will request: today (UTC) minus lagDays. */
export function latestGibsDate(now: Date = new Date(), lagDays: number = GIBS_CONFIG.lagDays): string {
  const today = parseGibsDate(formatGibsDate(now))!;
  return formatGibsDate(new Date(today.getTime() - lagDays * DAY_MS));
}

export interface ClampOptions {
  now?: Date;
  lagDays?: number;
  /** Earliest allowed YYYY-MM-DD. Defaults to the true-color layer's minDate. */
  minDate?: string;
}

/**
 * Clamp a requested date into [minDate, today - lagDays] and return YYYY-MM-DD.
 * Missing or unparseable input resolves to the latest allowed date.
 */
export function clampGibsDate(requested?: Date | string | null, opts: ClampOptions = {}): string {
  const max = latestGibsDate(opts.now, opts.lagDays);
  const min = opts.minDate ?? GIBS_CONFIG.layers.trueColor.minDate;

  let value: string | null = null;
  if (requested instanceof Date) {
    value = Number.isNaN(requested.getTime()) ? null : formatGibsDate(requested);
  } else if (typeof requested === 'string') {
    value = parseGibsDate(requested.trim()) ? requested.trim() : null;
  }
  if (value === null) return max;
  if (value > max) return max; // ISO dates compare correctly as strings
  if (value < min) return min;
  return value;
}

export interface StepOptions {
  now?: Date;
  lagDays?: number;
  /** Earliest allowed YYYY-MM-DD. Defaults to the true-color layer's minDate. */
  minDate?: string;
}

/** Step a YYYY-MM-DD date by whole days (UTC), clamped to [minDate, today - lagDays]. Pure: `now` is injected. */
export function stepGibsDate(current: string, delta: number, opts: StepOptions = {}): string {
  const max = latestGibsDate(opts.now, opts.lagDays);
  const min = opts.minDate ?? GIBS_CONFIG.layers.trueColor.minDate;
  const base = parseGibsDate(clampGibsDate(current, opts))!; // invalid or out-of-range input is clamped first
  const stepped = formatGibsDate(new Date(base.getTime() + Math.trunc(delta) * DAY_MS));
  if (stepped > max) return max;
  if (stepped < min) return min;
  return stepped;
}

/** Whether a step of +1 or -1 day would change the date (false at the ends; used to disable the arrows). */
export function canStepGibsDate(current: string, delta: 1 | -1, opts: StepOptions = {}): boolean {
  return stepGibsDate(current, delta, opts) !== clampGibsDate(current, opts);
}

export interface TileUrlOptions {
  /** Requested date for time layers; clamped. Ignored for static layers. */
  date?: Date | string | null;
  now?: Date;
  /** One of GIBS_CONFIG.hosts. Defaults to the primary host. */
  host?: string;
}

function endpointFor(host?: string): string {
  if (!host) return GIBS_CONFIG.endpoint;
  if (!(GIBS_CONFIG.hosts as readonly string[]).includes(host)) {
    throw new RangeError(`buildGibsTileUrl: unknown GIBS host "${host}"`);
  }
  return `https://${host}/wmts/epsg3857/best`;
}

/**
 * REST WMTS tile URL template with MapLibre {z}/{y}/{x} placeholders
 * (WMTS TileRow = y, TileCol = x; GoogleMapsCompatible origin is top-left, same as XYZ).
 */
export function buildGibsTileUrl(layerKey: GibsLayerKey, opts: TileUrlOptions = {}): string {
  const layer: GibsLayerConfig = GIBS_CONFIG.layers[layerKey];
  const root = endpointFor(opts.host);
  const timePart = layer.hasTime ? `/${clampGibsDate(opts.date, { now: opts.now, minDate: layer.minDate })}` : '';
  return `${root}/${layer.id}/default${timePart}/${layer.tileMatrixSet}/{z}/{y}/{x}.${layer.extension}`;
}

/** MapLibre raster source for a GIBS layer. */
export function buildGibsRasterSource(layerKey: GibsLayerKey, opts: TileUrlOptions = {}): RasterSourceSpecification {
  const layer: GibsLayerConfig = GIBS_CONFIG.layers[layerKey];
  return {
    type: 'raster',
    tiles: [buildGibsTileUrl(layerKey, opts)],
    tileSize: GIBS_CONFIG.tileSize,
    minzoom: 0,
    maxzoom: layer.maxZoom,
    attribution: GIBS_CONFIG.attribution,
  };
}

/** Source id; includes the date for time layers so a date change means a new source. */
export function gibsSourceId(layerKey: GibsLayerKey, opts: TileUrlOptions = {}): string {
  const layer: GibsLayerConfig = GIBS_CONFIG.layers[layerKey];
  return layer.hasTime
    ? `gibs-${layerKey}-${clampGibsDate(opts.date, { now: opts.now, minDate: layer.minDate })}`
    : `gibs-${layerKey}`;
}

export interface GibsLayerOptions {
  opacity?: number;
}

/** MapLibre raster layer bound to `sourceId`. */
export function buildGibsRasterLayer(
  layerKey: GibsLayerKey,
  sourceId: string,
  opts: GibsLayerOptions = {},
): RasterLayerSpecification {
  return {
    id: `${sourceId}-layer`,
    type: 'raster',
    source: sourceId,
    paint: { 'raster-opacity': opts.opacity ?? 1, 'raster-fade-duration': 150 },
  };
}

/** Source + layer + ids in one call. */
export function buildGibsLayer(layerKey: GibsLayerKey, opts: TileUrlOptions & GibsLayerOptions = {}) {
  const sourceId = gibsSourceId(layerKey, opts);
  return {
    sourceId,
    layerId: `${sourceId}-layer`,
    source: buildGibsRasterSource(layerKey, opts),
    layer: buildGibsRasterLayer(layerKey, sourceId, opts),
  };
}

/** Fallback raster source (no GIBS dependency). */
export function buildFallbackRasterSource(): RasterSourceSpecification {
  const f = GIBS_FALLBACK_BASEMAP;
  return { type: 'raster', tiles: [...f.tiles], tileSize: f.tileSize, maxzoom: f.maxZoom, attribution: f.attribution };
}

export function buildFallbackRasterLayer(): RasterLayerSpecification {
  return { id: GIBS_FALLBACK_BASEMAP.layerId, type: 'raster', source: GIBS_FALLBACK_BASEMAP.sourceId };
}

/** True once consecutive GIBS tile errors reach the configured threshold. */
export function shouldUseFallback(consecutiveTileErrors: number): boolean {
  return consecutiveTileErrors >= GIBS_FALLBACK_BASEMAP.errorThreshold;
}

/**
 * Basemap logic for the FireSync globe (pure: no DOM, no MapLibre runtime import).
 * Builds on the existing, verified src/utils/gibs.ts; nothing here talks to the network.
 */
import type { RasterLayerSpecification, RasterSourceSpecification } from 'maplibre-gl';
import {
  GIBS_CONFIG,
  buildFallbackRasterLayer,
  buildFallbackRasterSource,
  buildGibsLayer,
  clampGibsDate,
  GIBS_FALLBACK_BASEMAP,
  shouldUseFallback,
} from '../../utils/gibs';

export type BasemapId = 'satellite' | 'bluemarble' | 'dark';

export const DEFAULT_BASEMAP: BasemapId = 'satellite';

/** Shown next to the existing attribution for the active GIBS basemap. */
export const GIBS_ATTRIBUTION = 'Imagery: NASA EOSDIS GIBS';

/** Imagery credit for the Satellite basemap, with the (UTC) date of the daily composite. */
export function satelliteCredit(date: string): string {
  return `${GIBS_ATTRIBUTION} (VIIRS NOAA-20 true color, ${date})`;
}

/** One-sentence note shown under the date row. */
export function imageryDateNote(date: string): string {
  return `Daily composite for ${date} (UTC). Black areas mean no imagery for that day (gaps, or polar night), not absence of fire.`;
}

/** Only the Satellite basemap is a daily product; Blue Marble and Dark have no date. */
export function hasImageryDate(id: BasemapId): boolean {
  return id === 'satellite';
}

/** Date the Satellite basemap will request: `date` clamped to [minDate, today - lagDays]; default newest allowed. */
export function satelliteDate(date?: string | null, now?: Date): string {
  return clampGibsDate(date, { now, minDate: GIBS_CONFIG.layers.trueColor.minDate });
}

const FIRMS_ATTRIBUTION = 'Fire data: NASA FIRMS';

export const BASEMAP_OPTIONS: ReadonlyArray<{ id: BasemapId; label: string; hint: string }> = [
  { id: 'satellite', label: 'Satellite', hint: 'VIIRS NOAA-20 true color, daily composite (choose the day)' },
  { id: 'bluemarble', label: 'Blue Marble', hint: 'NASA shaded relief, static' },
  { id: 'dark', label: 'Dark', hint: 'Esri dark gray' },
];

export function isGibsBasemap(id: BasemapId): boolean {
  return id !== 'dark';
}

/** Id of the first fire layer; the basemap is always inserted below it so fires stay on top. */
export const FIRST_FIRE_LAYER_ID = 'modis-heatmap';

export interface BasemapDef {
  id: BasemapId;
  sourceId: string;
  layerId: string;
  source: RasterSourceSpecification;
  layer: RasterLayerSpecification;
}

/**
 * Source + layer for a basemap. `now` is injectable for tests. `date` (YYYY-MM-DD, UTC) only applies to
 * Satellite; it is clamped, and the source id contains it, so a new date means a new raster source.
 */
export function buildBasemap(id: BasemapId, now?: Date, date?: string | null): BasemapDef {
  if (id === 'dark') {
    const source = buildFallbackRasterSource();
    return {
      id,
      sourceId: GIBS_FALLBACK_BASEMAP.sourceId,
      layerId: GIBS_FALLBACK_BASEMAP.layerId,
      source: { ...source, attribution: `${GIBS_FALLBACK_BASEMAP.attribution} · ${FIRMS_ATTRIBUTION}` },
      layer: buildFallbackRasterLayer(),
    };
  }
  // Satellite: date defaults to the newest allowed one (today UTC minus lagDays).
  const day = id === 'satellite' ? satelliteDate(date, now) : undefined;
  const built = buildGibsLayer(id === 'satellite' ? 'trueColor' : 'baseMap', { now, date: day });
  const credit = day ? satelliteCredit(day) : GIBS_ATTRIBUTION;
  return {
    id,
    sourceId: built.sourceId,
    layerId: built.layerId,
    source: { ...built.source, attribution: `${credit} · ${FIRMS_ATTRIBUTION}` },
    layer: built.layer,
  };
}

/** Consecutive-tile-error counter: any successful tile resets it. */
export function nextErrorCount(current: number, event: 'error' | 'ok'): number {
  return event === 'ok' ? 0 : current + 1;
}

/** True when the active basemap is a GIBS one and its consecutive errors reached the threshold. */
export function shouldFallBackToDark(active: BasemapId, consecutiveErrors: number): boolean {
  return isGibsBasemap(active) && shouldUseFallback(consecutiveErrors);
}

export const FALLBACK_NOTICE = 'NASA imagery is not loading right now. Showing the dark map instead.';

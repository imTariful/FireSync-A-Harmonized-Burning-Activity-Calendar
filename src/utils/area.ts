/**
 * One "Area" for the whole app. The Explorer's region chips, the place search, Overview, Calendar,
 * Comparison and Exports all read and write this single value, so they can never disagree.
 *
 * Pure (no React, no DOM): unit-tested in area.test.ts.
 *
 * `kind` is an extension point: 'custom' is reserved for a drawn area / typed lat-lon box (not built yet).
 */
import type { AoiPolygon, BoundingBox } from '../types/fire';
import { QUICK_REGIONS, type QuickRegion } from './fireRegions';
import { STUDY_REGIONS } from './spatial';
import type { PlaceResult } from './geocode';
import { encodePolygon } from './polygon';

export type AreaKind = 'preset' | 'place' | 'custom' | 'polygon';

export interface Area {
  id: string;
  name: string;
  bbox: BoundingBox;
  kind: AreaKind;
  /** Optional drawn AOI. The bbox remains the preliminary filter. */
  polygon?: AoiPolygon;
}

/** What the data requests need: the bbox as `west,south,east,north` (same format the server parses). */
export interface AreaScope {
  bbox?: string;
  /** Compact drawn AOI, when the area has one. */
  aoi?: string;
  sensors?: string;
}

/** Half-size (degrees) of the box drawn around a place that came back without a bounding box (~55 km). */
export const PLACE_FALLBACK_HALF_SPAN_DEG = 0.25;

export function areaFromQuickRegion(r: Pick<QuickRegion, 'id' | 'name' | 'bbox'>): Area {
  return { id: r.id, name: r.name, bbox: { ...r.bbox }, kind: 'preset' };
}

const clampLat = (v: number) => Math.min(90, Math.max(-90, v));
const clampLng = (v: number) => Math.min(180, Math.max(-180, v));
const round3 = (v: number) => Number(v.toFixed(3));

/** A place search result as an Area. Without a bbox, a small box around the point is used. */
export function areaFromPlace(p: Pick<PlaceResult, 'name' | 'lat' | 'lng' | 'bbox'>): Area {
  const h = PLACE_FALLBACK_HALF_SPAN_DEG;
  const bbox: BoundingBox = p.bbox
    ? { ...p.bbox }
    : {
        west: clampLng(p.lng - h),
        south: clampLat(p.lat - h),
        east: clampLng(p.lng + h),
        north: clampLat(p.lat + h),
      };
  return { id: `place:${round3(p.lat)},${round3(p.lng)}`, name: p.name, bbox, kind: 'place' };
}

/** `west,south,east,north` for the API. */
export function bboxToString(b: BoundingBox): string {
  return `${b.west},${b.south},${b.east},${b.north}`;
}

/** Request scope for an area; `sensors` is passed through when given (MODIS or VIIRS, never merged). */
export function areaToScope(area: Area, sensors?: string): AreaScope {
  const scope: AreaScope = { bbox: bboxToString(area.bbox) };
  if (area.polygon && area.polygon.length >= 3) scope.aoi = encodePolygon(area.polygon);
  if (sensors) scope.sensors = sensors;
  return scope;
}

/** The whole globe: the scope the pages use until the user picks a region on the map. */
export const WORLD_AREA: Area = Object.freeze({
  id: 'world',
  name: 'World',
  bbox: { west: -180, south: -90, east: 180, north: 90 },
  kind: 'preset',
}) as Area;

const BANGLADESH = STUDY_REGIONS.find((r) => r.id === 'bangladesh') ?? {
  id: 'bangladesh',
  name: 'Bangladesh (Demonstration Region)',
  bbox: { west: 88.0, south: 20.5, east: 92.8, north: 26.7 },
};

/** Fallback area used for requests that still need one before the user picks a region. */
export const DEFAULT_AREA: Area = Object.freeze(areaFromQuickRegion(BANGLADESH)) as Area;

/** Whether an area has any detections at all (independent of date and sensor filters). */
export type ArchiveCoverage = 'unknown' | 'covered' | 'none';

/** `total` is the archive row count for the area with NO other filters; null = not known yet / request failed. */
export function archiveCoverageFromTotal(total: number | null | undefined): ArchiveCoverage {
  if (typeof total !== 'number' || !Number.isFinite(total)) return 'unknown';
  return total > 0 ? 'covered' : 'none';
}

export const NO_ARCHIVE_FOR_AREA_MESSAGE =
  'No live NASA FIRMS detections for this area. Live NRT only covers the rolling last 5 days; older dates would need an ingested archive.';

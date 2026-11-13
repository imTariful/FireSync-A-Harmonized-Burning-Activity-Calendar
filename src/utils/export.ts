/**
 * Export of currently visible detections to CSV and GeoJSON.
 *
 * Science rules enforced here:
 *  - MODIS and VIIRS are never merged or summed; every row/feature carries its
 *    own `sensor`, and metadata reports per-sensor counts only.
 *  - GeoJSON metadata carries the mandatory disclaimer sentence.
 *  - Records without a valid sensor or coordinates are skipped, never repaired
 *    or invented; the GeoJSON metadata reports how many were skipped.
 */

import type { CanonicalObservation } from '../types/fire';
import { sanitizeCsvCell } from './csv_export';

export const EXPORT_DISCLAIMER = 'Satellite thermal anomalies, not confirmed wildfires or burned area.';

/** Minimal fields needed to export; a CanonicalObservation satisfies this. */
export type ExportDetection = Pick<
  CanonicalObservation,
  'latitude' | 'longitude' | 'sensor' | 'satellite' | 'frp_mw' | 'datetime_utc' | 'confidence'
>;

export const CSV_HEADERS = [
  'sensor',
  'satellite',
  'latitude',
  'longitude',
  'datetime_utc',
  'frp_mw',
  'confidence',
] as const;

export interface DetectionProperties {
  sensor: 'MODIS' | 'VIIRS';
  satellite: string | null;
  frp_mw: number | null;
  time: string | null;
  confidence: number | string | null;
}

export interface DetectionFeature {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: DetectionProperties;
}

export interface DetectionFeatureCollection {
  type: 'FeatureCollection';
  metadata: {
    disclaimer: string;
    generated_at: string;
    sensors_kept_separate: true;
    counts_by_sensor: { MODIS: number; VIIRS: number };
    skipped_invalid_records: number;
  };
  features: DetectionFeature[];
}

function isExportable(d: ExportDetection): boolean {
  return (
    !!d &&
    (d.sensor === 'MODIS' || d.sensor === 'VIIRS') &&
    typeof d.latitude === 'number' &&
    typeof d.longitude === 'number' &&
    Number.isFinite(d.latitude) &&
    Number.isFinite(d.longitude) &&
    d.latitude >= -90 &&
    d.latitude <= 90 &&
    d.longitude >= -180 &&
    d.longitude <= 180
  );
}

function finiteOrNull(n: unknown): number | null {
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function strOrNull(s: unknown): string | null {
  return typeof s === 'string' && s !== '' ? s : null;
}

function confidenceOrNull(c: unknown): number | string | null {
  if (typeof c === 'number') return Number.isFinite(c) ? c : null;
  return strOrNull(c);
}

/** CSV (RFC 4180, CRLF) with a `sensor` column; every cell goes through sanitizeCsvCell. */
export function detectionsToCsv(detections: readonly ExportDetection[]): string {
  const rows = detections.filter(isExportable).map((d) =>
    [
      sanitizeCsvCell(d.sensor),
      sanitizeCsvCell(d.satellite),
      sanitizeCsvCell(d.latitude),
      sanitizeCsvCell(d.longitude),
      sanitizeCsvCell(d.datetime_utc),
      sanitizeCsvCell(finiteOrNull(d.frp_mw)),
      sanitizeCsvCell(confidenceOrNull(d.confidence)),
    ].join(','),
  );
  return [CSV_HEADERS.join(','), ...rows].join('\r\n');
}

/** GeoJSON FeatureCollection of Points; coordinates are [lng, lat]. */
export function detectionsToGeoJson(
  detections: readonly ExportDetection[],
  now: Date = new Date(),
): DetectionFeatureCollection {
  const valid = detections.filter(isExportable);
  const counts = { MODIS: 0, VIIRS: 0 };
  const features: DetectionFeature[] = valid.map((d) => {
    counts[d.sensor] += 1;
    return {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [d.longitude, d.latitude] },
      properties: {
        sensor: d.sensor,
        satellite: strOrNull(d.satellite),
        frp_mw: finiteOrNull(d.frp_mw),
        time: strOrNull(d.datetime_utc),
        confidence: confidenceOrNull(d.confidence),
      },
    };
  });
  return {
    type: 'FeatureCollection',
    metadata: {
      disclaimer: EXPORT_DISCLAIMER,
      generated_at: now.toISOString(),
      sensors_kept_separate: true,
      counts_by_sensor: counts,
      skipped_invalid_records: detections.length - valid.length,
    },
    features,
  };
}

export function detectionsToGeoJsonString(
  detections: readonly ExportDetection[],
  now: Date = new Date(),
): string {
  return JSON.stringify(detectionsToGeoJson(detections, now), null, 2);
}

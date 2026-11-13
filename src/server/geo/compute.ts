/**
 * Geographic computations over real detection records.
 *
 * Pure functions over observations that were already fetched from NASA FIRMS (or the local store).
 * Distances are geodesic (haversine). Density always reports the area it divided by, and any
 * capability whose dataset is missing returns `available: false` with a reason instead of zeros.
 */

import type { CanonicalObservation } from '../../types/fire';
import { aggregateToSpatialTemporalGrid } from '../../utils/harmonization';
import { haversineDistanceKm } from '../../utils/spatial';
import { dataset } from './datasets';

export interface Bbox {
  west: number;
  south: number;
  east: number;
  north: number;
}

export function parseBboxString(raw: string): Bbox | null {
  const parts = raw.split(',').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [west, south, east, north] = parts;
  if (west < -180 || east > 180 || south < -90 || north > 90 || west >= east || south >= north) return null;
  return { west, south, east, north };
}

/** Spherical rectangle area in km².
 *
 * F52 fix: the previous formula multiplied two haversine distances, which caused west=−180 and
 * east=+180 (same meridian) to collapse to width≈0, giving a world area of ~3×10⁻⁸ km².
 *
 * The correct spherical‐zone formula for a geographic bounding box is:
 *   area = R² × |sin(north) − sin(south)| × |lonSpan_rad|
 * where R = 6371 km (mean Earth radius) and lonSpan is the absolute difference in longitude
 * in radians (capped at 2π), handled explicitly for wide/antimeridian boxes.
 */
export function bboxAreaKm2(bbox: Bbox): number {
  const R = 6371; // km
  const toRad = (d: number) => (d * Math.PI) / 180;
  // Compute the longitude span in degrees, treating −180/+180 as the full circle.
  let lonSpanDeg = bbox.east - bbox.west;
  if (lonSpanDeg <= 0) lonSpanDeg += 360; // antimeridian or same-meridian (world)
  const lonSpanRad = toRad(Math.min(lonSpanDeg, 360));
  const latFactor = Math.abs(Math.sin(toRad(bbox.north)) - Math.sin(toRad(bbox.south)));
  return R * R * latFactor * lonSpanRad;
}

export interface DensestCell {
  cell_id: string;
  center_lat: number;
  center_lon: number;
  modis: number;
  viirs: number;
  total_cells_detected: number;
}

export interface DensityResult {
  area_km2: number;
  cell_size_km: number;
  total_detections: number;
  by_sensor: { MODIS: number; VIIRS: number };
  densities_per_1000_km2: { MODIS: number; VIIRS: number };
  active_cells: number;
  top_cells: DensestCell[];
  cells_omitted: number;
  notes: string[];
}

export function densityFor(
  observations: readonly CanonicalObservation[],
  bbox: Bbox,
  options: { cellKm?: number; topN?: number } = {}
): DensityResult {
  const cellKm = options.cellKm && options.cellKm > 0 ? options.cellKm : 1.0;
  const topN = Math.min(Math.max(options.topN ?? 25, 1), 200);
  const cells = Array.from(aggregateToSpatialTemporalGrid([...observations], cellKm).values());
  const areaKm2 = bboxAreaKm2(bbox);
  const modis = observations.filter((o) => o.sensor === 'MODIS').length;
  const viirs = observations.filter((o) => o.sensor === 'VIIRS').length;

  const perCell = new Map<string, DensestCell>();
  for (const cell of cells) {
    const key = `${cell.grid_x}:${cell.grid_y}`;
    const existing = perCell.get(key);
    if (existing) {
      existing.modis += cell.modis_count;
      existing.viirs += cell.viirs_count;
      existing.total_cells_detected += 1;
    } else {
      perCell.set(key, {
        cell_id: key,
        center_lat: Number(cell.center_lat.toFixed(4)),
        center_lon: Number(cell.center_lon.toFixed(4)),
        modis: cell.modis_count,
        viirs: cell.viirs_count,
        total_cells_detected: 1,
      });
    }
  }
  const ranked = [...perCell.values()].sort(
    (a, b) => b.modis + b.viirs - (a.modis + a.viirs)
  );

  return {
    area_km2: Number(areaKm2.toFixed(1)),
    cell_size_km: cellKm,
    total_detections: observations.length,
    by_sensor: { MODIS: modis, VIIRS: viirs },
    densities_per_1000_km2: {
      MODIS: areaKm2 > 0 ? Number(((modis / areaKm2) * 1000).toFixed(4)) : 0,
      VIIRS: areaKm2 > 0 ? Number(((viirs / areaKm2) * 1000).toFixed(4)) : 0,
    },
    active_cells: perCell.size,
    top_cells: ranked.slice(0, topN),
    cells_omitted: Math.max(0, ranked.length - topN),
    notes: [
      `Density is detections per 1000 km² over the stated box area (${Number(areaKm2.toFixed(1))} km²) for the selected window.`,
      'MODIS and VIIRS densities are reported separately; they are never summed.',
      'Density is a detection rate, not a fire frequency or burned area.',
    ],
  };
}

export interface ProximityFeature {
  id: string;
  name: string;
  type: string;
  latitude: number;
  longitude: number;
}

export interface ProximityResult {
  available: boolean;
  reason: string | null;
  buffer_km: number;
  features: Array<{
    id: string;
    name: string;
    type: string;
    nearest: {
      MODIS: { distance_km: number; observation_id: string; datetime_utc: string } | null;
      VIIRS: { distance_km: number; observation_id: string; datetime_utc: string } | null;
    };
    within_buffer: { MODIS: number; VIIRS: number };
  }>;
  dataset: ReturnType<typeof dataset>;
  notes: string[];
}

/**
 * Distance from explicitly supplied features to the nearest detection of each sensor.
 * No bundled infrastructure dataset exists, so an empty feature list is "not available",
 * never "0 m / no exposure".
 */
export function proximityFor(
  observations: readonly CanonicalObservation[],
  features: readonly ProximityFeature[],
  options: { bufferKm?: number } = {}
): ProximityResult {
  const bufferKm = options.bufferKm && options.bufferKm > 0 ? Math.min(options.bufferKm, 500) : 25;
  const infra = dataset('settlements');
  if (features.length === 0) {
    return {
      available: false,
      reason: 'No settlement/infrastructure dataset is configured in this deployment. ' + infra.note,
      buffer_km: bufferKm,
      features: [],
      dataset: infra,
      notes: [
        'No settlement/hospital/school/road dataset is configured, so no proximity result is produced.',
        'Proximity results are exposure screening only: they do not mean people were affected or need evacuation.',
      ],
    };
  }

  const evaluated = features.slice(0, 50).map((feature) => {
    const nearestFor = (sensor: 'MODIS' | 'VIIRS') => {
      let best: { distance_km: number; observation_id: string; datetime_utc: string } | null = null;
      for (const o of observations) {
        if (o.sensor !== sensor) continue;
        const d = haversineDistanceKm(feature.latitude, feature.longitude, o.latitude, o.longitude);
        if (!best || d < best.distance_km) {
          best = { distance_km: Number(d.toFixed(3)), observation_id: o.id, datetime_utc: o.datetime_utc };
        }
      }
      return best;
    };
    const within = (sensor: 'MODIS' | 'VIIRS') =>
      observations.filter(
        (o) =>
          o.sensor === sensor &&
          haversineDistanceKm(feature.latitude, feature.longitude, o.latitude, o.longitude) <= bufferKm
      ).length;

    return {
      id: feature.id,
      name: feature.name,
      type: feature.type,
      nearest: { MODIS: nearestFor('MODIS'), VIIRS: nearestFor('VIIRS') },
      within_buffer: { MODIS: within('MODIS'), VIIRS: within('VIIRS') },
    };
  });

  return {
    available: true,
    reason: null,
    buffer_km: bufferKm,
    features: evaluated,
    dataset: infra,
    notes: [
      `Distances are geodesic (haversine) from the supplied feature coordinates; buffer ${bufferKm} km.`,
      'Exposure screening only. Nearby detections do not establish injury, damage or an evacuation need.',
      'Supplied feature coordinates are used as given and are not validated against an official dataset.',
    ],
  };
}

export interface RegionDensity {
  region_id: string;
  name: string;
  bbox: string;
  area_km2: number;
  total_detections: number;
  by_sensor: { MODIS: number; VIIRS: number };
  densities_per_1000_km2: { MODIS: number; VIIRS: number };
  active_cells: number;
}

export function regionDensities(
  regions: Array<{ id: string; name: string; bbox: string; observations: readonly CanonicalObservation[] }>
): RegionDensity[] {
  return regions.map((region) => {
    const parsed = parseBboxString(region.bbox);
    const density = parsed ? densityFor(region.observations, parsed, { topN: 1 }) : null;
    return {
      region_id: region.id,
      name: region.name,
      bbox: region.bbox,
      area_km2: density?.area_km2 ?? 0,
      total_detections: region.observations.length,
      by_sensor: density?.by_sensor ?? { MODIS: 0, VIIRS: 0 },
      densities_per_1000_km2: density?.densities_per_1000_km2 ?? { MODIS: 0, VIIRS: 0 },
      active_cells: density?.active_cells ?? 0,
    };
  });
}

export interface CoverageDay {
  date: string;
  MODIS: number;
  VIIRS: number;
  record_count: number;
  status: 'observed' | 'no_observation_record';
  /** True when exactly one sensor reported that day: a possible overpass gap, not proof of absence. */
  single_sensor: boolean;
}

export interface CoverageResult {
  start_date: string;
  end_date: string;
  days: CoverageDay[];
  observed_days: number;
  no_record_days: number;
  /** Observed days where only one of MODIS/VIIRS returned records. */
  single_sensor_days: number;
  source_errors: string[];
  notes: string[];
}

/** Per-day record counts. A day with no record is "no observation record", never zero fire. */
export function coverageFor(
  observations: readonly CanonicalObservation[],
  startDate: string,
  endDate: string,
  sourceErrors: readonly string[]
): CoverageResult {
  const days: CoverageDay[] = [];
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  for (let t = start; t <= end; t += 86_400_000) {
    const date = new Date(t).toISOString().slice(0, 10);
    const inDay = observations.filter((o) => o.acq_date === date);
    const modis = inDay.filter((o) => o.sensor === 'MODIS').length;
    const viirs = inDay.filter((o) => o.sensor === 'VIIRS').length;
    days.push({
      date,
      MODIS: modis,
      VIIRS: viirs,
      record_count: inDay.length,
      status: inDay.length > 0 ? 'observed' : 'no_observation_record',
      single_sensor: inDay.length > 0 && (modis === 0 || viirs === 0),
    });
  }
  return {
    start_date: startDate,
    end_date: endDate,
    days,
    observed_days: days.filter((d) => d.status === 'observed').length,
    no_record_days: days.filter((d) => d.status === 'no_observation_record').length,
    single_sensor_days: days.filter((d) => d.single_sensor).length,
    source_errors: [...sourceErrors],
    notes: [
      'A day without a record is missing observation data, NOT zero fire activity.',
      'Only the last 1-5 days are available from live NRT; longer windows are not ingested.',
      'Source errors are listed verbatim; a failed source is never replaced with an empty success.',
      'A day reported by only one sensor may be an overpass or coverage gap; it cannot be distinguished from genuinely absent detections.',
    ],
  };
}

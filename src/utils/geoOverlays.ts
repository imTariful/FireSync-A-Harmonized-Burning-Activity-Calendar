/**
 * GeoJSON and CSV builders for geographic analysis overlays.
 *
 * Pure functions only: no DOM, no MapLibre and no network. The map draws exactly the cells and
 * bounding boxes returned by the server; this module never invents missing geometry. Rectangles
 * are split at ±180° instead of being wrapped across the whole world, and MODIS / VIIRS values
 * stay in separate properties (there is no combined count).
 */

import { FIRE_LEGEND } from '../types/ai';
import type { BoundingBox } from '../types/fire';
import { splitBboxAtAntimeridian } from './geo';
import { sanitizeCsvCell } from './csv_export';

const KM_PER_DEG = 111.32;
/** Near the poles a 1 km cell would be wider than the world; such cells are skipped, not distorted. */
const MAX_ABS_LAT = 89.5;

export const ANALYSIS_SOURCE_ID = 'analysis-overlay-src';
export const ANALYSIS_FILL_LAYER_ID = 'analysis-overlay-fill';
export const ANALYSIS_LINE_LAYER_ID = 'analysis-overlay-line';

export interface OverlayWindow {
  start_date: string;
  end_date: string;
  days: number;
}

export interface OverlaySourceMeta {
  data_source: string;
  provenance_status: string;
  retrieved_at: string | null;
  source_errors: string[];
  truncated: boolean;
}

export interface DensityCell {
  cell_id: string;
  center_lat: number;
  center_lon: number;
  modis: number;
  viirs: number;
}

export interface ClusterBoxInput {
  id: string;
  label: string;
  bbox: { west: number; south: number; east: number; north: number };
  centroid: { latitude: number; longitude: number };
  by_sensor: { MODIS: number; VIIRS: number };
  first_detection_utc: string;
  last_detection_utc: string;
  duration_hours: number;
  active_days: number;
}

export type OverlayProperty = string | number | boolean | null;
export type OverlayProperties = Record<string, OverlayProperty>;

export interface OverlayPolygon {
  type: 'Polygon';
  coordinates: number[][][];
}

export interface OverlayMultiPolygon {
  type: 'MultiPolygon';
  coordinates: number[][][][];
}

export type OverlayGeometry = OverlayPolygon | OverlayMultiPolygon;

export interface OverlayFeature {
  type: 'Feature';
  geometry: OverlayGeometry;
  properties: OverlayProperties;
}

export interface OverlayMetadata {
  kind: 'density' | 'clusters' | 'agnicells';
  title: string;
  legend: string;
  sensors_kept_separate: true;
  feature_count: number;
  skipped_geometry: number;
  antimeridian_interpreted?: number;
  cells_omitted?: number;
  note: string;
}

export interface OverlayFeatureCollection {
  type: 'FeatureCollection';
  features: OverlayFeature[];
  metadata: OverlayMetadata;
}

export interface AnalysisOverlay {
  kind: 'density' | 'clusters' | 'agnicells';
  title: string;
  description: string;
  geojson: OverlayFeatureCollection;
  csv: string;
  bounds: [[number, number], [number, number]] | null;
  notes: string[];
}

export interface DensityOverlayInput {
  cells: readonly DensityCell[];
  cellSizeKm: number;
  cellsOmitted: number;
  bbox: string;
  window: OverlayWindow;
  sensors: string;
  source: OverlaySourceMeta;
}

export interface ClusterOverlayInput {
  clusters: readonly ClusterBoxInput[];
  bbox: string;
  window: OverlayWindow;
  sensors: string;
  source: OverlaySourceMeta;
}

function ring(box: BoundingBox): number[][] {
  return [
    [box.west, box.south],
    [box.east, box.south],
    [box.east, box.north],
    [box.west, box.north],
    [box.west, box.south],
  ];
}

function geometryFromBoxes(boxes: BoundingBox[]): OverlayGeometry | null {
  if (boxes.length === 0) return null;
  if (boxes.length === 1) return { type: 'Polygon', coordinates: [ring(boxes[0])] };
  return { type: 'MultiPolygon', coordinates: boxes.map((box) => [ring(box)]) };
}

function cellGeometry(cell: DensityCell, cellKm: number): { geometry: OverlayGeometry; seam: boolean } | null {
  if (
    !Number.isFinite(cell.center_lat) ||
    !Number.isFinite(cell.center_lon) ||
    cell.center_lat < -90 ||
    cell.center_lat > 90 ||
    cell.center_lon < -180 ||
    cell.center_lon > 180 ||
    Math.abs(cell.center_lat) > MAX_ABS_LAT
  ) {
    return null;
  }

  const halfLat = cellKm / 2 / KM_PER_DEG;
  const cosLat = Math.cos((cell.center_lat * Math.PI) / 180);
  if (!Number.isFinite(cosLat) || cosLat <= 0.001) return null;
  const halfLon = cellKm / 2 / (KM_PER_DEG * cosLat);
  if (!Number.isFinite(halfLon) || halfLon > 180) return null;

  const south = cell.center_lat - halfLat;
  const north = cell.center_lat + halfLat;
  if (south < -90 || north > 90) return null;

  const west = cell.center_lon - halfLon;
  const east = cell.center_lon + halfLon;
  const boxes = splitBboxAtAntimeridian(west, south, east, north);
  const geometry = geometryFromBoxes(boxes);
  if (!geometry) return null;
  return { geometry, seam: boxes.length > 1 };
}

function clusterGeometry(bbox: ClusterBoxInput['bbox']): { geometry: OverlayGeometry; seam: boolean } | null {
  const { west, south, east, north } = bbox;
  if (
    ![west, south, east, north].every(Number.isFinite) ||
    west < -180 ||
    west > 180 ||
    east < -180 ||
    east > 180 ||
    south < -90 ||
    north > 90 ||
    south >= north
  ) {
    return null;
  }

  // A zero-width or full-world box has no drawable extent. Skip it and let the caller count it;
  // never expand it into invented geometry.
  const width = west <= east ? east - west : 360 - (west - east);
  if (width <= 0 || width >= 360) return null;

  // A server bbox wider than 180° is drawn as the short arc across the antimeridian. This is the
  // only honest interpretation available from min/max longitudes alone; the metadata records it.
  let boxes: BoundingBox[];
  let seam = false;
  if (west > east) {
    boxes = splitBboxAtAntimeridian(west, south, east, north);
    seam = true;
  } else if (east - west > 180) {
    boxes = splitBboxAtAntimeridian(east, south, west, north);
    seam = true;
  } else {
    boxes = splitBboxAtAntimeridian(west, south, east, north);
  }

  const geometry = geometryFromBoxes(boxes);
  if (!geometry) return null;
  return { geometry, seam };
}

/** Rectangles for the density cells returned by the API; omitted cells are counted, never drawn. */
export function densityCellsToGeoJSON(
  cells: readonly DensityCell[],
  cellSizeKm: number,
  options: { cellsOmitted?: number } = {}
): OverlayFeatureCollection {
  const size = Number.isFinite(cellSizeKm) && cellSizeKm > 0 ? cellSizeKm : 1;
  const features: OverlayFeature[] = [];
  let skipped = 0;
  let seamCount = 0;

  for (const cell of cells) {
    const built = cellGeometry(cell, size);
    if (!built) {
      skipped += 1;
      continue;
    }
    if (built.seam) seamCount += 1;
    features.push({
      type: 'Feature',
      geometry: built.geometry,
      properties: {
        overlay_kind: 'density',
        cell_id: cell.cell_id,
        center_lat: cell.center_lat,
        center_lon: cell.center_lon,
        modis_detections: cell.modis,
        viirs_detections: cell.viirs,
        cell_size_km: size,
      },
    });
  }

  return {
    type: 'FeatureCollection',
    features,
    metadata: {
      kind: 'density',
      title: 'Density cells',
      legend: FIRE_LEGEND,
      sensors_kept_separate: true,
      feature_count: features.length,
      skipped_geometry: skipped,
      antimeridian_interpreted: seamCount,
      cells_omitted: Math.max(0, Math.floor(options.cellsOmitted ?? 0)),
      note: 'Only cells returned by the density API are drawn; omitted cells are not represented. Cell rectangles approximate the analysis grid, not burned area.',
    },
  };
}

/** Bounding boxes for candidate hotspot groups. The boxes are not fire perimeters. */
export function clustersToGeoJSON(clusters: readonly ClusterBoxInput[]): OverlayFeatureCollection {
  const features: OverlayFeature[] = [];
  let skipped = 0;
  let seamCount = 0;

  for (const cluster of clusters) {
    const built = clusterGeometry(cluster.bbox);
    if (!built) {
      skipped += 1;
      continue;
    }
    if (built.seam) seamCount += 1;
    features.push({
      type: 'Feature',
      geometry: built.geometry,
      properties: {
        overlay_kind: 'clusters',
        cluster_id: cluster.id,
        label: cluster.label,
        modis_detections: cluster.by_sensor.MODIS,
        viirs_detections: cluster.by_sensor.VIIRS,
        first_detection_utc: cluster.first_detection_utc,
        last_detection_utc: cluster.last_detection_utc,
        duration_hours: cluster.duration_hours,
        active_days: cluster.active_days,
        centroid_lat: cluster.centroid.latitude,
        centroid_lon: cluster.centroid.longitude,
        bbox_west: cluster.bbox.west,
        bbox_south: cluster.bbox.south,
        bbox_east: cluster.bbox.east,
        bbox_north: cluster.bbox.north,
      },
    });
  }

  return {
    type: 'FeatureCollection',
    features,
    metadata: {
      kind: 'clusters',
      title: 'Candidate hotspot boxes',
      legend: FIRE_LEGEND,
      sensors_kept_separate: true,
      feature_count: features.length,
      skipped_geometry: skipped,
      antimeridian_interpreted: seamCount,
      note: 'Bounding boxes of candidate hotspot groups, not confirmed wildfires or fire perimeters. MODIS and VIIRS values stay separate.',
    },
  };
}

function positionsOf(geometry: OverlayGeometry): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const walk = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && typeof value[0] === 'number' && typeof value[1] === 'number') {
      out.push([value[0], value[1]]);
      return;
    }
    for (const child of value) walk(child);
  };
  walk(geometry.coordinates);
  return out;
}

/** Bounds of the drawn geometry; null when no finite geometry exists. */
export function overlayBounds(
  geojson: OverlayFeatureCollection
): [[number, number], [number, number]] | null {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const feature of geojson.features) {
    for (const [lon, lat] of positionsOf(feature.geometry)) {
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      west = Math.min(west, lon);
      south = Math.min(south, lat);
      east = Math.max(east, lon);
      north = Math.max(north, lat);
    }
  }
  if (![west, south, east, north].every(Number.isFinite) || west >= east || south >= north) return null;
  return [
    [west, south],
    [east, north],
  ];
}

function metadataRows(metadata: Record<string, unknown>): string[] {
  return [
    '# FireSync geographic overlay metadata',
    ...Object.entries(metadata).map(([key, value]) => {
      const text = typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value) ?? '';
      return `# ${sanitizeCsvCell(key)},${sanitizeCsvCell(text)}`;
    }),
  ];
}

function csvLine(values: readonly unknown[]): string {
  return values.map((value) => sanitizeCsvCell(value)).join(',');
}

function densityCsv(input: DensityOverlayInput, geojson: OverlayFeatureCollection): string {
  const metadata = {
    overlay_kind: 'density',
    bbox: input.bbox,
    window_start: input.window.start_date,
    window_end: input.window.end_date,
    window_days: input.window.days,
    sensors: input.sensors,
    cell_size_km: input.cellSizeKm,
    cells_rendered: geojson.features.length,
    cells_omitted: geojson.metadata.cells_omitted ?? 0,
    skipped_geometry: geojson.metadata.skipped_geometry,
    antimeridian_interpreted: geojson.metadata.antimeridian_interpreted ?? 0,
    data_source: input.source.data_source,
    provenance_status: input.source.provenance_status,
    retrieved_at: input.source.retrieved_at,
    source_errors: input.source.source_errors.join(' | '),
    truncated: input.source.truncated,
    sensors_kept_separate: true,
    legend: FIRE_LEGEND,
    note: geojson.metadata.note,
  };
  const headers = [
    'cell_id',
    'center_lat',
    'center_lon',
    'modis_detections',
    'viirs_detections',
    'cell_size_km',
  ];
  const rows = geojson.features.map((feature) =>
    csvLine([
      feature.properties.cell_id,
      feature.properties.center_lat,
      feature.properties.center_lon,
      feature.properties.modis_detections,
      feature.properties.viirs_detections,
      feature.properties.cell_size_km,
    ])
  );
  return [...metadataRows(metadata), headers.join(','), ...rows].join('\r\n');
}

function clusterCsv(input: ClusterOverlayInput, geojson: OverlayFeatureCollection): string {
  const metadata = {
    overlay_kind: 'clusters',
    bbox: input.bbox,
    window_start: input.window.start_date,
    window_end: input.window.end_date,
    window_days: input.window.days,
    sensors: input.sensors,
    clusters_rendered: geojson.features.length,
    skipped_geometry: geojson.metadata.skipped_geometry,
    antimeridian_interpreted: geojson.metadata.antimeridian_interpreted ?? 0,
    data_source: input.source.data_source,
    provenance_status: input.source.provenance_status,
    retrieved_at: input.source.retrieved_at,
    source_errors: input.source.source_errors.join(' | '),
    truncated: input.source.truncated,
    sensors_kept_separate: true,
    legend: FIRE_LEGEND,
    note: geojson.metadata.note,
  };
  const headers = [
    'cluster_id',
    'label',
    'modis_detections',
    'viirs_detections',
    'first_detection_utc',
    'last_detection_utc',
    'duration_hours',
    'active_days',
    'centroid_lat',
    'centroid_lon',
    'bbox_west',
    'bbox_south',
    'bbox_east',
    'bbox_north',
  ];
  const rows = geojson.features.map((feature) =>
    csvLine([
      feature.properties.cluster_id,
      feature.properties.label,
      feature.properties.modis_detections,
      feature.properties.viirs_detections,
      feature.properties.first_detection_utc,
      feature.properties.last_detection_utc,
      feature.properties.duration_hours,
      feature.properties.active_days,
      feature.properties.centroid_lat,
      feature.properties.centroid_lon,
      feature.properties.bbox_west,
      feature.properties.bbox_south,
      feature.properties.bbox_east,
      feature.properties.bbox_north,
    ])
  );
  return [...metadataRows(metadata), headers.join(','), ...rows].join('\r\n');
}

export function buildDensityOverlay(input: DensityOverlayInput): AnalysisOverlay {
  const omitted = Math.max(0, Math.floor(input.cellsOmitted));
  const geojson = densityCellsToGeoJSON(input.cells, input.cellSizeKm, { cellsOmitted: omitted });
  const size = Number.isFinite(input.cellSizeKm) && input.cellSizeKm > 0 ? input.cellSizeKm : 1;
  const notes = [
    FIRE_LEGEND,
    'MODIS and VIIRS cell values stay separate; no combined cell total is drawn.',
    'Cell rectangles approximate the analysis grid, not burned area.',
  ];
  if (omitted > 0) notes.push(`${omitted} further cell(s) are not drawn because the API did not return them.`);
  if ((geojson.metadata.antimeridian_interpreted ?? 0) > 0) {
    notes.push('Cells crossing the antimeridian are split into two polygons at ±180°.');
  }
  if (input.source.truncated) notes.push('The source response was capped; counts are lower bounds.');
  const title = `Density cells (${geojson.features.length})`;
  const description =
    geojson.features.length === 0
      ? 'No density cell geometry could be drawn from this response.'
      : `${geojson.features.length} densest ${size} km cell(s) returned by the density API; ${omitted} omitted cell(s) are not drawn.`;
  return {
    kind: 'density',
    title,
    description,
    geojson,
    csv: densityCsv({ ...input, cellsOmitted: omitted, cellSizeKm: size }, geojson),
    bounds: overlayBounds(geojson),
    notes,
  };
}

export function buildClusterOverlay(input: ClusterOverlayInput): AnalysisOverlay {
  const geojson = clustersToGeoJSON(input.clusters);
  const notes = [
    FIRE_LEGEND,
    'Bounding boxes are candidate hotspot groups, not confirmed wildfires or fire perimeters.',
    'MODIS and VIIRS values stay separate; no combined detection total is drawn.',
  ];
  if ((geojson.metadata.antimeridian_interpreted ?? 0) > 0) {
    notes.push('A group box wider than 180° is drawn as the short arc across the antimeridian.');
  }
  if (input.source.truncated) notes.push('The source response was capped; counts are lower bounds.');
  const title = `Candidate hotspot boxes (${geojson.features.length})`;
  const description = `${geojson.features.length} candidate hotspot group bounding box(es); a group is not a confirmed wildfire or fire perimeter.`;
  return {
    kind: 'clusters',
    title,
    description,
    geojson,
    csv: clusterCsv(input, geojson),
    bounds: overlayBounds(geojson),
    notes,
  };
}

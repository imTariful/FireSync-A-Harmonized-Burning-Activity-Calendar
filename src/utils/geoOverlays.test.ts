/**
 * Tests for the geographic overlay builders.
 *
 * Pure functions only: no map, no network. The tests pin the two science rules that matter here:
 * only server-returned geometry is drawn, and MODIS / VIIRS values are never combined.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { FIRE_LEGEND } from '../types/ai';
import {
  buildClusterOverlay,
  buildDensityOverlay,
  clustersToGeoJSON,
  densityCellsToGeoJSON,
  overlayBounds,
  type ClusterBoxInput,
  type DensityCell,
  type OverlayGeometry,
  type OverlaySourceMeta,
} from './geoOverlays';

const SOURCE: OverlaySourceMeta = {
  data_source: 'store',
  provenance_status: 'UNVERIFIED',
  retrieved_at: null,
  source_errors: [],
  truncated: false,
};

const WINDOW = { start_date: '2026-11-05', end_date: '2026-11-11', days: 7 };

function positions(geometry: OverlayGeometry): Array<[number, number]> {
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

function cluster(partial: Partial<ClusterBoxInput> & Pick<ClusterBoxInput, 'id' | 'bbox'>): ClusterBoxInput {
  return {
    id: partial.id,
    label: 'candidate_hotspot_group',
    bbox: partial.bbox,
    centroid: partial.centroid ?? { latitude: 22.05, longitude: 90.05 },
    by_sensor: partial.by_sensor ?? { MODIS: 4, VIIRS: 2 },
    first_detection_utc: partial.first_detection_utc ?? '2026-11-09T06:00:00Z',
    last_detection_utc: partial.last_detection_utc ?? '2026-11-09T18:00:00Z',
    duration_hours: partial.duration_hours ?? 12,
    active_days: partial.active_days ?? 1,
  };
}

test('density overlay draws only returned cells, keeps sensors separate and counts omissions', () => {
  const cells: DensityCell[] = [
    { cell_id: '10:20', center_lat: 22.1, center_lon: 90.1, modis: 3, viirs: 5 },
    { cell_id: '179:0', center_lat: 0, center_lon: 179.99, modis: 1, viirs: 0 },
    { cell_id: 'bad-latitude', center_lat: 95, center_lon: 0, modis: 1, viirs: 1 },
  ];
  const fc = densityCellsToGeoJSON(cells, 10, { cellsOmitted: 7 });

  assert.equal(fc.features.length, 2);
  assert.equal(fc.metadata.feature_count, 2);
  assert.equal(fc.metadata.skipped_geometry, 1);
  assert.equal(fc.metadata.cells_omitted, 7);
  assert.equal(fc.metadata.antimeridian_interpreted, 1);

  const first = fc.features[0];
  assert.equal(first.properties.cell_id, '10:20');
  assert.equal(first.properties.modis_detections, 3);
  assert.equal(first.properties.viirs_detections, 5);
  assert.equal(first.properties.cell_size_km, 10);
  assert.ok(!('detection_count' in first.properties));
  assert.ok(!('total_detections' in first.properties));

  const seam = fc.features[1];
  assert.equal(seam.geometry.type, 'MultiPolygon');
  for (const [lon, lat] of positions(seam.geometry)) {
    assert.ok(lon >= -180 && lon <= 180, `longitude ${lon} is outside the GeoJSON range`);
    assert.ok(lat >= -90 && lat <= 90, `latitude ${lat} is outside the GeoJSON range`);
  }
});

test('cluster overlay uses candidate-group boxes, per-sensor counts and antimeridian splits', () => {
  const fc = clustersToGeoJSON([
    cluster({ id: 'c-normal', bbox: { west: 90, south: 22, east: 90.1, north: 22.1 } }),
    cluster({ id: 'c-wrapped', bbox: { west: 179, south: -1, east: -179, north: 1 } }),
    cluster({ id: 'c-wide', bbox: { west: -170, south: -1, east: 170, north: 1 } }),
    cluster({ id: 'c-invalid', bbox: { west: 90, south: 23, east: 91, north: 22 } }),
    cluster({ id: 'c-zero-width', bbox: { west: 90, south: 22, east: 90, north: 22.1 } }),
  ]);

  assert.equal(fc.features.length, 3);
  assert.equal(fc.metadata.skipped_geometry, 2);
  assert.equal(fc.metadata.antimeridian_interpreted, 2);

  const normal = fc.features[0];
  assert.equal(normal.geometry.type, 'Polygon');
  assert.equal(normal.properties.cluster_id, 'c-normal');
  assert.equal(normal.properties.label, 'candidate_hotspot_group');
  assert.equal(normal.properties.modis_detections, 4);
  assert.equal(normal.properties.viirs_detections, 2);
  assert.ok(!('detection_count' in normal.properties));

  for (const feature of fc.features.slice(1)) {
    assert.equal(feature.geometry.type, 'MultiPolygon');
    for (const [lon, lat] of positions(feature.geometry)) {
      assert.ok(lon >= -180 && lon <= 180);
      assert.ok(lat >= -90 && lat <= 90);
    }
  }
  assert.match(fc.metadata.note, /not confirmed wildfires or fire perimeters/i);
  assert.match(fc.metadata.note, /MODIS and VIIRS values stay separate/i);
});

test('overlayBounds is null without geometry and covers a drawn box', () => {
  assert.equal(overlayBounds(densityCellsToGeoJSON([], 10)), null);

  const fc = densityCellsToGeoJSON(
    [{ cell_id: '1:2', center_lat: 22, center_lon: 90, modis: 1, viirs: 0 }],
    1
  );
  const bounds = overlayBounds(fc);
  assert.ok(bounds);
  assert.ok(bounds[0][0] < 90 && bounds[0][0] >= -180);
  assert.ok(bounds[1][0] > 90 && bounds[1][0] <= 180);
  assert.ok(bounds[0][1] < 22 && bounds[1][1] > 22);
});

test('density CSV carries window, source and legend metadata and sanitizes ids', () => {
  const overlay = buildDensityOverlay({
    cells: [{ cell_id: '=EVIL()', center_lat: 22, center_lon: 90, modis: 1, viirs: 2 }],
    cellSizeKm: 10,
    cellsOmitted: 3,
    bbox: '89,21,91,23',
    window: WINDOW,
    sensors: 'ALL',
    source: SOURCE,
  });

  assert.equal(overlay.kind, 'density');
  assert.match(overlay.title, /Density cells \(1\)/);
  assert.equal(overlay.bounds === null, false);
  assert.ok(overlay.notes.includes(FIRE_LEGEND));
  assert.ok(overlay.notes.some((note) => /3 further cell\(s\) are not drawn/.test(note)));

  assert.match(overlay.csv, /^# FireSync geographic overlay metadata/);
  assert.match(overlay.csv, /# overlay_kind,density/);
  assert.match(overlay.csv, /# bbox,"89,21,91,23"/);
  assert.match(overlay.csv, /# window_start,2026-11-05/);
  assert.match(overlay.csv, /# window_end,2026-11-11/);
  assert.match(overlay.csv, /# sensors,ALL/);
  assert.match(overlay.csv, /# cells_omitted,3/);
  assert.match(overlay.csv, /# sensors_kept_separate,true/);
  assert.ok(overlay.csv.includes(FIRE_LEGEND));
  assert.ok(overlay.csv.includes('cell_id,center_lat,center_lon,modis_detections,viirs_detections,cell_size_km'));
  assert.ok(overlay.csv.includes("'=EVIL()"));
  assert.ok(!overlay.csv.includes('detection_count'));
  assert.ok(!overlay.csv.includes('total_detections'));
});

test('cluster CSV carries the antimeridian interpretation and never a combined count', () => {
  const overlay = buildClusterOverlay({
    clusters: [
      cluster({
        id: 'c-wrapped',
        bbox: { west: 179, south: -1, east: -179, north: 1 },
        by_sensor: { MODIS: 0, VIIRS: 7 },
      }),
    ],
    bbox: '178,-2,180,2',
    window: WINDOW,
    sensors: 'VIIRS',
    source: { ...SOURCE, truncated: true, source_errors: ['VIIRS_NOAA20_NRT: timeout'] },
  });

  assert.equal(overlay.kind, 'clusters');
  assert.match(overlay.title, /Candidate hotspot boxes \(1\)/);
  assert.ok(overlay.notes.some((note) => /short arc across the antimeridian/.test(note)));
  assert.ok(overlay.notes.some((note) => /counts are lower bounds/.test(note)));

  assert.match(overlay.csv, /# overlay_kind,clusters/);
  assert.match(overlay.csv, /# sensors,VIIRS/);
  assert.match(overlay.csv, /# antimeridian_interpreted,1/);
  assert.match(overlay.csv, /# truncated,true/);
  assert.match(overlay.csv, /# source_errors,VIIRS_NOAA20_NRT: timeout/);
  assert.ok(overlay.csv.includes('cluster_id,label,modis_detections,viirs_detections'));
  assert.ok(overlay.csv.includes('c-wrapped,candidate_hotspot_group,0,7'));
  assert.ok(!overlay.csv.includes('detection_count'));
});

/**
 * Tests for the geographic compute layer: density, geodesic proximity, region normalisation and
 * coverage semantics. No network: observations are fixtures and every dataset that is not bundled
 * must return `available: false` instead of a zero result.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import type { CanonicalObservation } from '../../types/fire';
import { bboxAreaKm2, coverageFor, densityFor, parseBboxString, proximityFor, regionDensities } from './compute';
import { geoDatasetStatus, unavailableDatasetResult } from './datasets';

function obs(partial: Partial<CanonicalObservation> & Pick<CanonicalObservation, 'id' | 'sensor'>): CanonicalObservation {
  const { id, sensor, ...rest } = partial;
  return {
    id,
    sensor,
    source_record_id: id,
    latitude: 22.1,
    longitude: 90.1,
    acq_date: '2026-11-09',
    acq_time: '0610',
    datetime_utc: '2026-11-09T06:10:00Z',
    satellite: sensor === 'MODIS' ? 'Terra' : 'NOAA-20',
    product: sensor === 'MODIS' ? 'MODIS_NRT' : 'VIIRS_NOAA20_NRT',
    processing_version: '6.1NRT',
    confidence: 80,
    confidence_category: 'nominal',
    frp_mw: 10,
    scan: 1,
    track: 1,
    daynight: 'D',
    source_file: 'fixture.csv',
    retrieved_at: '2026-11-10T00:00:00Z',
    quality_flags: 'fixture',
    record_hash: `hash-${id}`,
    provenance_status: 'VERIFIED',
    ...rest,
  };
}

const FIXTURES: CanonicalObservation[] = [
  obs({ id: 'm1', sensor: 'MODIS', latitude: 22.1, longitude: 90.1 }),
  obs({ id: 'm2', sensor: 'MODIS', latitude: 22.11, longitude: 90.11 }),
  obs({ id: 'v1', sensor: 'VIIRS', latitude: 22.1005, longitude: 90.1005 }),
];

test('bbox strings are validated and inverted boxes rejected', () => {
  assert.deepEqual(parseBboxString('90,22,91,23'), { west: 90, south: 22, east: 91, north: 23 });
  assert.equal(parseBboxString('91,22,90,23'), null);
  assert.equal(parseBboxString('90,22,91'), null);
  assert.equal(parseBboxString('nope'), null);
});

test('box area is positive and roughly correct for a one-degree box', () => {
  const area = bboxAreaKm2(parseBboxString('90,22,91,23')!);
  // A degree of latitude is ~111 km; a degree of longitude at 22.5N is ~103 km.
  assert.ok(area > 10_000 && area < 13_000, `unexpected area ${area}`);
});

test('density reports per-sensor counts against the stated area', () => {
  const result = densityFor(FIXTURES, parseBboxString('90,22,91,23')!, { topN: 5 });
  assert.equal(result.total_detections, 3);
  assert.deepEqual(result.by_sensor, { MODIS: 2, VIIRS: 1 });
  assert.ok(result.area_km2 > 10_000);
  assert.ok(result.densities_per_1000_km2.MODIS > 0);
  assert.ok(result.densities_per_1000_km2.VIIRS > 0);
  assert.ok(result.top_cells.length >= 1);
  assert.ok(result.top_cells[0].modis + result.top_cells[0].viirs >= 1);
  assert.ok(result.notes.some((n) => /never summed/i.test(n)));
  assert.equal((result as unknown as Record<string, unknown>).combined_density, undefined);
});

test('density omits cells beyond the cap and says how many', () => {
  const many = Array.from({ length: 40 }, (_, i) => obs({ id: `o${i}`, sensor: 'MODIS', latitude: 22 + i * 0.02 }));
  const result = densityFor(many, parseBboxString('90,20,92,26')!, { topN: 3 });
  assert.equal(result.top_cells.length, 3);
  assert.ok(result.cells_omitted > 0);
});

test('proximity is unavailable without a feature dataset, never a zero result', () => {
  const result = proximityFor(FIXTURES, [], { bufferKm: 10 });
  assert.equal(result.available, false);
  assert.match(String(result.reason), /dataset|No settlement/i);
  assert.equal(result.features.length, 0);
  assert.ok(result.notes.some((n) => /not mean people were affected/i.test(n)));
});

test('proximity computes geodesic distance to the nearest detection per sensor', () => {
  const result = proximityFor(
    FIXTURES,
    [{ id: 'h1', name: 'Clinic', type: 'hospital', latitude: 22.1, longitude: 90.1 }],
    { bufferKm: 1 }
  );
  assert.equal(result.available, true);
  const feature = result.features[0];
  assert.equal(feature.nearest.MODIS?.observation_id, 'm1');
  assert.ok((feature.nearest.MODIS?.distance_km ?? 99) < 0.001);
  // m2 sits ~1.5 km away, so only m1 is inside the 1 km buffer.
  assert.equal(feature.within_buffer.MODIS, 1);
  assert.equal(feature.within_buffer.VIIRS, 1);
  assert.ok(feature.nearest.VIIRS);
});

test('region densities normalise counts by each region box area', () => {
  const rows = regionDensities([
    { id: 'a', name: 'Small', bbox: '90,22,90.1,22.1', observations: FIXTURES },
    { id: 'b', name: 'Large', bbox: '88,20,92,26', observations: FIXTURES },
  ]);
  assert.equal(rows[0].total_detections, 3);
  assert.ok(rows[0].area_km2 < rows[1].area_km2);
  assert.ok(rows[0].densities_per_1000_km2.MODIS > rows[1].densities_per_1000_km2.MODIS);
});

test('coverage marks days without a record as no_observation_record, not zero', () => {
  const result = coverageFor(FIXTURES, '2026-11-08', '2026-11-10', ['VIIRS_NOAA21_NRT: timeout']);
  assert.equal(result.days.length, 3);
  const day9 = result.days.find((d) => d.date === '2026-11-09')!;
  assert.equal(day9.status, 'observed');
  assert.equal(day9.MODIS, 2);
  const day10 = result.days.find((d) => d.date === '2026-11-10')!;
  assert.equal(day10.status, 'no_observation_record');
  assert.equal(day10.record_count, 0);
  assert.equal(result.observed_days, 1);
  assert.equal(result.no_record_days, 2);
  assert.deepEqual(result.source_errors, ['VIIRS_NOAA21_NRT: timeout']);
  assert.ok(result.notes.some((n) => /NOT zero fire/i.test(n)));
});

test('coverage flags single-sensor days as possible overpass gaps', () => {
  const mixed = [
    obs({ id: 'm1', sensor: 'MODIS', acq_date: '2026-11-09', datetime_utc: '2026-11-09T06:10:00Z' }),
    obs({ id: 'm2', sensor: 'MODIS', acq_date: '2026-11-10', datetime_utc: '2026-11-10T06:10:00Z' }),
    obs({ id: 'v1', sensor: 'VIIRS', acq_date: '2026-11-09', datetime_utc: '2026-11-09T07:10:00Z' }),
  ];
  const result = coverageFor(mixed, '2026-11-09', '2026-11-10', []);
  const day9 = result.days.find((d) => d.date === '2026-11-09')!;
  const day10 = result.days.find((d) => d.date === '2026-11-10')!;
  assert.equal(day9.single_sensor, false);
  assert.equal(day10.single_sensor, true);
  assert.equal(result.single_sensor_days, 1);
  assert.ok(result.notes.some((n) => /overpass or coverage gap/i.test(n)));
});

test('dataset status is honest about what is not bundled', () => {
  const status = geoDatasetStatus();
  assert.equal(status.datasets.find((d) => d.id === 'firms_nrt')?.configured, true);
  for (const id of ['landcover', 'terrain', 'population', 'admin_boundaries', 'settlements'] as const) {
    assert.equal(status.datasets.find((d) => d.id === id)?.configured, false, `${id} must not claim to be configured`);
  }
  assert.equal(status.available_count + status.unavailable_count, status.datasets.length);
});

test('unavailable dataset adapters return a reason, not an empty or zero result', () => {
  for (const id of ['landcover', 'terrain', 'population', 'admin_boundaries'] as const) {
    const result = unavailableDatasetResult(id);
    assert.equal(result.available, false, `${id} must be unavailable`);
    assert.equal(result.dataset.id, id);
    assert.equal(result.dataset.configured, false);
    assert.equal(result.expected_resolution, result.dataset.resolution);
    assert.equal(result.would_provide, result.dataset.used_for);
    assert.ok(result.reason.length > 0, `${id} needs a reason`);
    assert.match(result.note, /unavailable/i);
    assert.ok(!('features' in result));
    assert.ok(!('result' in result));
  }
});

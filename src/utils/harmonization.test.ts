import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateToSpatialTemporalGrid,
  evaluateCalibrationModel,
  buildDailySummariesFromCells,
} from './harmonization';
import { CanonicalObservation } from '../types/fire';

const mockObservations: CanonicalObservation[] = [
  {
    id: 'obs-1',
    source_record_id: 'firms-1',
    latitude: 23.501,
    longitude: 90.501,
    acq_date: '2024-03-15',
    acq_time: '0730',
    datetime_utc: '2024-03-15T07:30:00Z',
    sensor: 'MODIS',
    satellite: 'Terra',
    product: 'MODIS_C6_1',
    processing_version: '6.1',
    confidence: 85,
    confidence_category: 'high',
    frp_mw: 24.5,
    scan: 1.1,
    track: 1.0,
    daynight: 'D',
    source_file: 'MODIS_C6_1_SouthAsia.csv',
    retrieved_at: '2026-10-29T10:00:00Z',
    quality_flags: '0',
    record_hash: 'hash1',
  },
  {
    id: 'obs-2',
    source_record_id: 'firms-2',
    latitude: 23.502,
    longitude: 90.502,
    acq_date: '2024-03-15',
    acq_time: '0815',
    datetime_utc: '2024-03-15T08:15:00Z',
    sensor: 'VIIRS',
    satellite: 'Suomi-NPP',
    product: 'VIIRS_SNPP_NRT',
    processing_version: '2.0NRT',
    confidence: 'nominal',
    confidence_category: 'nominal',
    frp_mw: 8.2,
    scan: 0.38,
    track: 0.36,
    daynight: 'D',
    source_file: 'VIIRS_SNPP_SouthAsia.csv',
    retrieved_at: '2026-10-29T10:00:00Z',
    quality_flags: '0',
    record_hash: 'hash2',
  },
];

test('aggregateToSpatialTemporalGrid bins observations and computes harmonized index', () => {
  const cellMap = aggregateToSpatialTemporalGrid(mockObservations, 1.0);
  assert.equal(cellMap.size, 1); // both obs are in same 1-km cell on 2024-03-15

  const cell = Array.from(cellMap.values())[0];
  assert.equal(cell.modis_count, 1);
  assert.equal(cell.viirs_count, 1);
  assert.equal(cell.dominant_sensor, 'BOTH');
  assert.ok(cell.harmonized_activity_index > 0);
  assert.ok(Math.abs(cell.total_frp_sum - 32.7) < 0.01);
});

test('evaluateCalibrationModel calculates MAE, RMSE, and bias correctly', () => {
  const paired = [
    { modis: 1, viirs: 3 },
    { modis: 2, viirs: 7 },
    { modis: 4, viirs: 12 },
  ];
  const metrics = evaluateCalibrationModel(paired, 0.3, 0.0);
  assert.equal(typeof metrics.mae, 'number');
  assert.equal(typeof metrics.rmse, 'number');
  assert.equal(typeof metrics.mean_bias, 'number');
  assert.ok((metrics.mae ?? -1) >= 0);
  assert.ok((metrics.rmse ?? -1) >= 0);
  assert.equal(metrics.sample_size_paired_cells, 3);
  // A fixed coefficient evaluated in-sample can never be VALIDATED.
  assert.equal(metrics.status, 'INSUFFICIENT');
  assert.equal(metrics.independent_validation, false);
});

test('evaluateCalibrationModel returns null metrics when there is no paired evidence', () => {
  const metrics = evaluateCalibrationModel([]);
  assert.equal(metrics.mae, null);
  assert.equal(metrics.rmse, null);
  assert.equal(metrics.mean_bias, null);
  assert.equal(metrics.r_squared, null);
  assert.equal(metrics.status, 'INSUFFICIENT');
});

test('buildDailySummariesFromCells emits only observed days: a missing date is not zero fire', () => {
  const cellMap = aggregateToSpatialTemporalGrid(mockObservations, 1.0);
  const cells = Array.from(cellMap.values());
  const summaries = buildDailySummariesFromCells(cells, {
    start: '2024-03-14',
    end: '2024-03-16',
  });

  // Only 2024-03-15 has observations. The 14th and 16th are absent, NOT zero-filled.
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].date, '2024-03-15');
  assert.equal(summaries[0].total_raw_detections, 2);
  assert.equal(summaries[0].coverage_status, 'observed');
});

test('buildDailySummariesFromCells never emits days after today', () => {
  const cells = Array.from(aggregateToSpatialTemporalGrid(mockObservations, 1.0).values());
  const summaries = buildDailySummariesFromCells(
    cells,
    { start: '2024-03-14', end: '2024-03-30' },
    { today: '2024-03-15' }
  );
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].date, '2024-03-15');
});

test('daily coverage is unknown (null), never a fabricated 100%', () => {
  const cells = Array.from(aggregateToSpatialTemporalGrid(mockObservations, 1.0).values());
  const [first] = buildDailySummariesFromCells(cells, { start: '2024-03-15', end: '2024-03-15' });
  assert.equal(first.observation_coverage_pct, null);
  assert.equal(first.coverage_status, 'observed');
});

test('undefined R² is null, not 0, and zero-variance data is INSUFFICIENT', () => {
  const metrics = evaluateCalibrationModel(Array.from({ length: 9 }, () => ({ modis: 1, viirs: 2 })));
  assert.equal(metrics.status, 'INSUFFICIENT');
  assert.equal(metrics.r_squared, null);
  assert.ok(metrics.limitations.some((l) => l.includes('Reference variance is zero')));
  assert.ok(metrics.limitations.some((l) => l.includes('at least 50')));
  assert.ok(!metrics.training_period.includes('2023'));
  assert.ok(metrics.validation_period.includes('no temporal holdout'));
});

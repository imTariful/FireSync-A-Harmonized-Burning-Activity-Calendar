import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeCsvCell,
  observationsToCsv,
  calendarSummariesToCsv,
  validationResultsToCsv,
} from './csv_export';
import { CanonicalObservation, DailyActivitySummary, CalibrationModelMetrics } from '../types/fire';

test('sanitizeCsvCell protects against CSV formula injection (CWE-1236)', () => {
  // Dangerous prefixes must be prepended with a single quote
  assert.equal(sanitizeCsvCell('=SUM(A1:A10)'), "'=SUM(A1:A10)");
  assert.equal(sanitizeCsvCell('@cmd|calc'), "'@cmd|calc");
  assert.equal(sanitizeCsvCell('+cmd|calc'), "'+cmd|calc");
  assert.equal(sanitizeCsvCell('-cmd|calc'), "'-cmd|calc");
  assert.equal(sanitizeCsvCell('@cmd|"/c calc"!A0'), `"'@cmd|""/c calc""!A0"`);

  // Leading whitespace before formula triggers must also be sanitized
  assert.equal(sanitizeCsvCell('  =2+2'), "'  =2+2");
  assert.equal(sanitizeCsvCell('\t@calc'), "'\t@calc");

  // Pure numbers (including negative numbers and floats) should remain unquoted numbers
  assert.equal(sanitizeCsvCell(-23.5), '-23.5');
  assert.equal(sanitizeCsvCell(100), '100');
  assert.equal(sanitizeCsvCell('-15.2'), '-15.2');
  assert.equal(sanitizeCsvCell('+42'), '+42');

  // Null and undefined return empty string
  assert.equal(sanitizeCsvCell(null), '');
  assert.equal(sanitizeCsvCell(undefined), '');

  // Commas and newlines should be escaped in quotes
  assert.equal(sanitizeCsvCell('hello, world'), '"hello, world"');
  assert.equal(sanitizeCsvCell('quotes "inside"'), '"quotes ""inside"""');
});

test('observationsToCsv formats rows and headers correctly', () => {
  const sampleObs: CanonicalObservation[] = [
    {
      id: 'test-1',
      source_record_id: '=MALICIOUS',
      latitude: 23.5,
      longitude: 90.5,
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
      source_file: 'sample.csv',
      retrieved_at: '2026-10-29T10:00:00Z',
      quality_flags: '0',
      record_hash: 'abc123hash',
    },
  ];

  const csv = observationsToCsv(sampleObs);
  const lines = csv.split('\r\n');
  assert.equal(lines.length, 2);
  assert.ok(lines[0].startsWith('id,source_record_id,latitude,longitude'));
  // Verify formula sanitization on source_record_id
  assert.ok(lines[1].includes("'=MALICIOUS"));
});

test('validationResultsToCsv exports all metrics in standard format', () => {
  const metrics: CalibrationModelMetrics = {
    model_id: 'cal-modis-viirs-v1',
    model_version: '1.2.0',
    algorithm: 'Constrained Poisson-Weighted GLM',
    target_grid_km: 1.0,
    sample_size_paired_cells: 10,
    training_period: '2024',
    validation_period: '2025-2026',
    mae: 0.35,
    rmse: 0.42,
    mean_bias: -0.15,
    r_squared: 0.65,
    calibration_slope: 0.294,
    calibration_intercept: 0.05,
    status: 'EXPLORATORY',
    limitations: ['Test limit'],
  };

  const csv = validationResultsToCsv(metrics);
  assert.ok(csv.includes('mae,0.35,Mean Absolute Error'));
  assert.ok(csv.includes('calibration_slope,0.294,'));
  assert.ok(csv.includes('validation_status,EXPLORATORY,'));
});

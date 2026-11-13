/**
 * Historical query-service tests.
 *
 * The parquet store is absent in tests, so these exercise the honest
 * "unavailable / empty" paths and input validation — never a real archive.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.FIRESYNC_HISTORICAL_PARQUET = path.join(os.tmpdir(), 'firesync-no-such-store');

const {
  historicalStatus,
  historicalDaily,
  historicalObservations,
  historicalCoverage,
  historicalYearTotals,
  historicalFrpExtremes,
  historicalPersistence,
  historicalMonthAnomaly,
  historicalClimatology,
  historicalSeasonalStatus,
  historicalCountries,
} = await import('./historical');

test('historicalStatus reports unavailable when the parquet store is missing', async () => {
  const status = await historicalStatus();
  assert.equal(status.available, false);
  assert.deepEqual(status.sensors, {});
  assert.match(status.note, /import_historical\.py/);
});

test('historicalDaily returns empty rows when no store exists', async () => {
  const result = await historicalDaily({ year: 2019, sensor: 'MODIS' });
  assert.deepEqual(result.rows, []);
  assert.equal(result.truncated, false);
});

test('historicalCoverage returns empty when no store exists', async () => {
  assert.deepEqual(await historicalCoverage('VIIRS'), []);
});

test('historicalYearTotals returns null for missing sensor-year', async () => {
  assert.equal(await historicalYearTotals('MODIS', 1999), null);
});

test('historicalObservations rejects malformed dates', async () => {
  await assert.rejects(() => historicalObservations({ date: 'not-a-date' }), /YYYY-MM-DD/);
  await assert.rejects(() => historicalObservations({ date: '2019-13-40' }), /YYYY-MM-DD/);
});

test('historicalObservations returns empty for valid date with no store', async () => {
  const result = await historicalObservations({ date: '2019-06-01', sensor: 'VIIRS' });
  assert.deepEqual(result.rows, []);
});

test('historicalDaily accepts date ranges and returns empty with no store', async () => {
  const result = await historicalDaily({ startDate: '2019-03-01', endDate: '2019-10-31', sensor: 'MODIS' });
  assert.deepEqual(result.rows, []);
  assert.equal(result.truncated, false);
});

test('new analytics return empty when no store exists', async () => {
  assert.deepEqual(await historicalFrpExtremes({ sensor: 'MODIS' }), []);
  assert.deepEqual(await historicalPersistence({ sensor: 'VIIRS' }), []);
  assert.deepEqual(await historicalMonthAnomaly({ year: 2019, month: 8 }), []);
});

test('climatology functions degrade honestly when no store exists', async () => {
  const c = await historicalClimatology({ country: 'Australia' });
  assert.deepEqual(c.months, []);
  assert.equal(c.legend, 'Satellite thermal anomalies, not confirmed wildfires or burned area.');
  const b = await historicalClimatology({ bbox: { west: 130, south: -25, east: 140, north: -15 } });
  assert.deepEqual(b.months, []);
  assert.equal(await historicalSeasonalStatus({ country: 'Australia' }), null);
  assert.deepEqual(await historicalCountries(), []);
});

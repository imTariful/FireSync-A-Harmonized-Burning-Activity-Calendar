import test from 'node:test';
import assert from 'node:assert/strict';
import { compareAgniMonth, agniSeason } from './agniBaseline';
const rows = [2018, 2019, 2020, 2021, 2022, 2023].map((year, i) => ({ year, month: 3, detections: i + 1, partial_coverage: false }));
test('target year excluded, median/percentile calculated from five independent years', () => {
  const c = compareAgniMonth(rows, 2023, 3);
  assert.equal(c.baseline_median, 3);
  assert.deepEqual(c.baseline_years, [2018, 2019, 2020, 2021, 2022]);
  assert.equal(c.percentile, 100);
  assert.equal(c.status, 'unusually_high');
});
test('unknown, nonfinite, partial and fewer than five years never produce a comparison', () => {
  assert.equal(compareAgniMonth(rows.slice(1), 2023, 3).baseline_median, null);
  assert.equal(compareAgniMonth(rows, 2024, 3).status, 'unknown');
  assert.equal(compareAgniMonth([...rows, { year: 2024, month: 3, detections: null, partial_coverage: false }], 2024, 3).observed, null);
  assert.equal(compareAgniMonth(rows.map((r) => ({ ...r, partial_coverage: r.year === 2023 })), 2023, 3).status, 'partial_coverage');
  assert.equal(compareAgniMonth(rows.map((r) => ({ ...r, detections: r.year === 2018 ? null : r.detections })), 2023, 3).status, 'insufficient_history');
});
test('ties, zero baseline and duplicates are handled explicitly', () => {
  const zero = rows.map((r) => ({ ...r, detections: 0 }));
  const c = compareAgniMonth(zero, 2023, 3);
  assert.equal(c.percentile, 50);
  assert.equal(c.ratio, null);
  assert.equal(compareAgniMonth([...rows, rows[0]], 2023, 3).status, 'insufficient_history');
});
test('season excludes target and leaves absent months unknown', () => {
  const season = agniSeason(rows, 2023);
  assert.deepEqual(season.peak_months, [3]);
  assert.equal(season.months[2].median, 3);
  assert.equal(season.months[0].median, null);
});
test('different reported product populations are never mixed into a baseline', () => {
  const different = rows.map((r) => ({ ...r, population_key: r.year === 2023 ? 'new-version' : 'old-version' }));
  assert.equal(compareAgniMonth(different, 2023, 3).valid_years, 0);
  assert.equal(compareAgniMonth(different, 2023, 3).status, 'insufficient_history');
});

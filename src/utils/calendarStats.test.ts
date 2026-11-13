import test from 'node:test';
import assert from 'node:assert/strict';
import { DailyActivitySummary } from '../types/fire';
import { buildMonthYearMatrix, compareMonthToHistory, rampStep, textOnStep, monthKey } from './calendarStats';

function day(date: string, bau: number, modis = 0, viirs = 0): DailyActivitySummary {
  const [y, m, d] = date.split('-').map(Number);
  return {
    date, year: y, month: m, day: d, day_of_year: 1,
    modis_detections: modis, viirs_detections: viirs, total_raw_detections: modis + viirs,
    harmonized_activity_units: bau, modis_frp_mw: 0, viirs_frp_mw: 0, total_frp_mw: 0, mean_frp_mw: 0,
    active_1km_cells: 0, historical_baseline_median: 0, historical_baseline_mad: 0, anomaly_score: 0,
    anomaly_category: 'normal', observation_coverage_pct: null, data_quality: 'standard_science',
  };
}

test('matrix sums harmonized per month and keeps MODIS and VIIRS separate', () => {
  const m = buildMonthYearMatrix(
    [day('2024-03-01', 1.5, 1, 2), day('2024-03-02', 2.5, 0, 3), day('2025-04-01', 4, 2, 0)],
    '2026-01-01'
  );
  assert.deepEqual(m.years, [2024, 2025]);
  const mar = m.cells.get(monthKey(2024, 3))!;
  assert.equal(mar.harmonized, 4);
  assert.equal(mar.modis, 1);
  assert.equal(mar.viirs, 5);
  assert.equal(mar.activeDays, 2);
  assert.equal(m.max, 4);
});

test('matrix ignores days after today', () => {
  const m = buildMonthYearMatrix([day('2024-03-01', 1), day('2030-03-01', 9)], '2026-01-01');
  assert.deepEqual(m.years, [2024]);
});

test('month-to-date is compared with the same days of other years only', () => {
  const daily: DailyActivitySummary[] = [];
  // other years: first 8 days of November sum to 8 (1 per day), plus a big late-November day that must NOT count
  for (const y of [2022, 2023, 2024, 2025]) {
    for (let d = 1; d <= 8; d++) daily.push(day(`${y}-11-0${d}`, 1));
    daily.push(day(`${y}-11-25`, 50));
  }
  for (let d = 1; d <= 8; d++) daily.push(day(`2026-11-0${d}`, 2)); // current: 16
  const c = compareMonthToHistory(daily, '2026-11-08');
  assert.equal(c.status, 'ok');
  assert.equal(c.throughDay, 8);
  assert.equal(c.current, 16);
  assert.equal(c.historicalMedian, 8);
  assert.equal(c.yearsUsed, 4);
  assert.equal(c.pctVsMedian, 100);
});

test('fewer than 3 other years is insufficient_history, with no median claimed', () => {
  const daily = [day('2025-11-02', 3), day('2026-11-02', 5)];
  const c = compareMonthToHistory(daily, '2026-11-08');
  assert.equal(c.status, 'insufficient_history');
  assert.equal(c.historicalMedian, null);
  assert.equal(c.pctVsMedian, null);
});

test('ramp steps: zero is its own state, and text colour keeps contrast', () => {
  assert.equal(rampStep(0, 10), 0);
  assert.equal(rampStep(1, 10), 1);
  assert.equal(rampStep(3, 10), 2);
  assert.equal(rampStep(5, 10), 3);
  assert.equal(rampStep(7, 10), 4);
  assert.equal(rampStep(10, 10), 5);
  assert.equal(rampStep(5, 0), 0);
  assert.equal(textOnStep(1), 'light');
  assert.equal(textOnStep(3), 'dark');
});

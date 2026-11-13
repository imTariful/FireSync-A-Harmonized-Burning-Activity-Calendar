import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeMedian,
  computeMAD,
  computeRobustZScore,
  categorizeAnomaly,
  applyHistoricalBaselines,
  computeModifiedZScore,
} from './anomaly';
import { DailyActivitySummary } from '../types/fire';

test('computeMedian calculates correct median for odd and even lengths', () => {
  assert.equal(computeMedian([1, 3, 5]), 3);
  assert.equal(computeMedian([1, 2, 4, 8]), 3);
  assert.equal(computeMedian([10]), 10);
  assert.equal(computeMedian([]), 0);
});

test('computeMAD calculates median absolute deviation correctly', () => {
  // values: [1, 2, 3, 4, 5, 6, 7], median = 4
  // deviations from 4: [3, 2, 1, 0, 1, 2, 3] -> sorted: [0, 1, 1, 2, 2, 3, 3] -> median = 2
  const mad = computeMAD([1, 2, 3, 4, 5, 6, 7], 4);
  assert.equal(mad, 2);
});

test('computeRobustZScore computes standardized deviation', () => {
  const z = computeRobustZScore(10, 4, 2);
  // (10 - 4) / (1.4826 * 2) = 6 / 2.9652 = 2.02
  assert.equal(z, 2.02);
});

test('computeRobustZScore safely handles zero MAD without division by zero', () => {
  // When observed equals median and MAD is 0 -> deviation is 0
  assert.equal(computeRobustZScore(5, 5, 0), 0);
  // When observed differs from median and MAD is 0 -> regularized by pseudo-variance 1.0
  assert.equal(computeRobustZScore(7, 5, 0), 2.0);
  assert.equal(computeRobustZScore(3, 5, 0), -2.0);
});

test('categorizeAnomaly properly classifies activity thresholds', () => {
  assert.equal(categorizeAnomaly(0.8, true), 'normal');
  assert.equal(categorizeAnomaly(1.8, true), 'moderate_anomaly');
  assert.equal(categorizeAnomaly(2.8, true), 'high_anomaly');
  assert.equal(categorizeAnomaly(4.0, true), 'extreme_anomaly');
  assert.equal(categorizeAnomaly(4.0, false), 'insufficient_data');
});

function mkDay(date: string, bau: number): DailyActivitySummary {
  const [y, m, d] = date.split('-').map(Number);
  return {
    date, year: y, month: m, day: d, day_of_year: 1,
    modis_detections: 0, viirs_detections: 0, total_raw_detections: bau > 0 ? 1 : 0,
    harmonized_activity_units: bau, modis_frp_mw: 0, viirs_frp_mw: 0, total_frp_mw: 0, mean_frp_mw: 0,
    active_1km_cells: 0, historical_baseline_median: 0, historical_baseline_mad: 0, anomaly_score: 0,
    anomaly_category: 'normal', observation_coverage_pct: null, data_quality: 'standard_science',
  };
}

// Four past Marches with a little variation, then a 2026 day to score.
function marchHistory(): DailyActivitySummary[] {
  const out: DailyActivitySummary[] = [];
  for (const y of [2022, 2023, 2024, 2025]) {
    for (let d = 1; d <= 10; d++) out.push(mkDay(`${y}-03-${String(d).padStart(2, '0')}`, 3 + (d % 3)));
  }
  return out;
}

test('applyHistoricalBaselines scores a day far above its seasonal baseline', () => {
  const hist = marchHistory();
  const target = mkDay('2026-03-15', 25);
  const [out] = applyHistoricalBaselines([target], [...hist, target], { today: '2026-11-08' });
  assert.ok(out.historical_baseline_median > 0);
  assert.ok(out.anomaly_score >= 3.5, `score ${out.anomaly_score}`);
  assert.equal(out.anomaly_category, 'extreme_anomaly');
});

test('a day is never part of its own baseline (same-year days are excluded)', () => {
  const hist = marchHistory();
  // Many same-year high days must not raise the baseline for a 2026 day
  const same = Array.from({ length: 10 }, (_, i) => mkDay(`2026-03-${String(i + 1).padStart(2, '0')}`, 30));
  const [out] = applyHistoricalBaselines([same[0]], [...hist, ...same], { today: '2026-11-08' });
  assert.ok(out.historical_baseline_median < 10, `median ${out.historical_baseline_median}`);
  assert.equal(out.anomaly_category, 'extreme_anomaly');
});

test('fewer than 3 other years of history is insufficient_data, not normal', () => {
  const hist = marchHistory().filter((d) => d.year >= 2024); // only 2 other years
  const target = mkDay('2026-03-15', 25);
  const [out] = applyHistoricalBaselines([target], [...hist, target], { today: '2026-11-08' });
  assert.equal(out.anomaly_category, 'insufficient_data');
  assert.equal(out.anomaly_score, 0);
});

test('future days are never scored', () => {
  const hist = marchHistory();
  const target = mkDay('2026-12-15', 0);
  const decHist = [2022, 2023, 2024, 2025].flatMap((y) => [mkDay(`${y}-12-01`, 1), mkDay(`${y}-12-02`, 2)]);
  const [out] = applyHistoricalBaselines([target], [...hist, ...decHist, target], { today: '2026-11-08' });
  assert.equal(out.anomaly_category, 'insufficient_data');
});

test('sparse history with MAD = 0 uses mean-absolute-deviation fallback, not a raw difference', () => {
  // 97 zeros and 3 ones: median 0, MAD 0, mean AD 0.03
  const history = [...Array(97).fill(0), 1, 1, 1];
  const z = computeModifiedZScore(1, history);
  assert.ok(z !== null && z > 20, `z ${z}`); // 1 / (1.2533 * 0.03)
  assert.equal(computeModifiedZScore(0, history), 0);
});

test('history with no variability at all has no scale (null)', () => {
  assert.equal(computeModifiedZScore(5, [0, 0, 0, 0]), null);
  assert.equal(computeModifiedZScore(5, []), null);
});

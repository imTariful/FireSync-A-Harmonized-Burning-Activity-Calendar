import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activityThresholds,
  classifyActivity,
  classifyVsClimatology,
  doyInWindow,
  doyWindow,
  harmonizedEquivalent,
  quantile,
  seasonSummary,
  type MonthlyClimatology,
} from './seasonalClimatology';
import { HARMONIZATION_CONSTANTS } from './harmonization';

test('quantile uses linear interpolation', () => {
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(quantile([], 0.5), 0);
  assert.equal(quantile([10], 0.9), 10);
});

test('activityThresholds returns quartiles of monthly medians', () => {
  const t = activityThresholds([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110]);
  assert.ok(t.q1 < t.q2 && t.q2 < t.q3);
  assert.deepEqual(activityThresholds([]), { q1: 0, q2: 0, q3: 0 });
});

test('classifyActivity buckets by the scope seasonal range', () => {
  const t = { q1: 10, q2: 30, q3: 70 };
  assert.equal(classifyActivity(5, t), 'low');
  assert.equal(classifyActivity(20, t), 'typical');
  assert.equal(classifyActivity(50, t), 'elevated');
  assert.equal(classifyActivity(90, t), 'high');
  assert.equal(classifyActivity(0, t), 'low');
});

test('harmonizedEquivalent applies the fixed exploratory coefficient', () => {
  const v = harmonizedEquivalent(100, 100);
  assert.ok(Math.abs(v - (100 + HARMONIZATION_CONSTANTS.VIIRS_COUNT_SCALE_FACTOR * 100)) < 1e-9);
});

test('seasonSummary picks peak and low months without overlap', () => {
  const months: MonthlyClimatology[] = Array.from({ length: 12 }, (_, i) => ({
    month: i + 1,
    sensors: {},
    harmonized_equivalent_median: i === 0 ? 1000 : i === 6 ? 500 : 10,
    activity_class: 'typical',
  }));
  const s = seasonSummary(months);
  assert.deepEqual(s.peak_months.slice(0, 2), [1, 7]);
  assert.equal(s.peak_months.length, 3);
  assert.ok(!s.low_months.includes(1) && !s.low_months.includes(7));
  assert.equal(s.low_months.length, 3);
});

test('classifyVsClimatology respects baseline sufficiency and IQR fences', () => {
  assert.equal(classifyVsClimatology(500, 100, 50, 200, 2), 'insufficient_baseline');
  assert.equal(classifyVsClimatology(100, 100, 50, 200, 10), 'within_typical');
  assert.equal(classifyVsClimatology(40, 100, 50, 200, 10), 'below_typical');
  assert.equal(classifyVsClimatology(250, 100, 50, 200, 10), 'above_typical');
  // IQR = 150, upper fence = 200 + 225 = 425
  assert.equal(classifyVsClimatology(500, 100, 50, 200, 10), 'well_above_typical');
});

test('doyWindow wraps around the year boundary', () => {
  const w = doyWindow(3, 5);
  assert.equal(w.start, 363);
  assert.equal(w.end, 8);
  assert.ok(doyInWindow(365, w.start, w.end));
  assert.ok(doyInWindow(2, w.start, w.end));
  assert.ok(!doyInWindow(100, w.start, w.end));
});

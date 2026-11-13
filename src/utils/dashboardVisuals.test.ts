import test from 'node:test';
import assert from 'node:assert/strict';
import { availableValue, dailyVisualPoints, monthlyVisualPoints, chartMaximum, chartLine, rankedPeriods, sensorHeatOpacity } from './dashboardVisuals';
import type { AgniMonthRow } from '../api/agnicalendar';

const day = (date: string, modis: number | null = 2, viirs: number | null = 7) => ({ date, modis_detections: modis, viirs_detections: viirs, modis_frp_mw: 4, viirs_frp_mw: 8, harmonized_activity_units: 3 });

test('calendar stripes distinguish unknown and zero and use bounded per-sensor intensity', () => {
  assert.equal(sensorHeatOpacity(null, 10), 0);
  assert.equal(sensorHeatOpacity(0, 10), 0.08);
  assert.equal(sensorHeatOpacity(10, 10), 0.95);
  assert.ok(sensorHeatOpacity(5, 10) < sensorHeatOpacity(10, 10));
  assert.equal(sensorHeatOpacity(100, 10), 0.95);
});

test('daily explorer sorts dates and inserts missing records as null without changing measured zeros', () => {
  const rows = dailyVisualPoints([day('2025-01-03'), day('2025-01-01', 0, null)]);
  assert.deepEqual(rows.map((p) => p.key), ['2025-01-01', '2025-01-02', '2025-01-03']);
  assert.equal(rows[0].values.modis, 0);
  assert.equal(rows[0].values.viirs, null);
  assert.ok(Object.values(rows[1].values).every((v) => v === null));
  assert.equal(rows[2].values.modis, 2);
  assert.equal(rows[2].values.viirs, 7);
  assert.match(rows[1].note!, /not a zero-fire day/);
});

test('invalid and impossible dates are excluded without throwing or rolling into another month', () => {
  assert.deepEqual(dailyVisualPoints([day('invalid'), day('2025-02-30'), day('2025-13-01')]), []);
  assert.equal(dailyVisualPoints([day('2024-02-29')]).length, 1);
  assert.equal(dailyVisualPoints([]).length, 0);
});

test('monthly chart remains twelve months and preserves unavailable, measured zero and partial coverage', () => {
  const row: AgniMonthRow = { year: 2025, month: 4, detections: 0, frp_sum_mw: null, cells_with_data: 2, partial_coverage: true };
  const points = monthlyVisualPoints([row, { ...row, year: 2024, detections: 99 }], 2025);
  assert.equal(points.length, 12);
  assert.equal(points[0].key, '2025-01');
  assert.equal(points[0].values.activity, null);
  assert.equal(points[3].values.activity, 0);
  assert.equal(points[3].values.frp, null);
  assert.match(points[3].note!, /Partial source coverage/);
  assert.ok(points.every((p) => /^\d{4}-\d{2}$/.test(p.key)));
});

test('chart axes use the visible sensor only rather than a cross-sensor sum', () => {
  const points = dailyVisualPoints([day('2025-01-01', 3, 28)]);
  assert.equal(chartMaximum(points, ['modis']), 3);
  assert.equal(chartMaximum(points, ['modis', 'viirs']), 30);
  assert.equal(chartMaximum([], ['modis']), 1);
});

test('null values break SVG lines; measured zeros remain at their actual positions', () => {
  assert.equal(chartLine([2, null, 0, 4], 4, 300, 100), 'M0.00,50.00 M200.00,100.00 L300.00,0.00');
  assert.equal(chartLine([2], 4, 300, 100), 'M150.00,50.00');
  assert.equal(chartLine([null, null], 4, 300, 100), '');
});

test('ranked periods are sensor-specific, deterministic and do not mutate temporal input', () => {
  const points = dailyVisualPoints([day('2025-01-01', 2, 100), day('2025-01-02', 4, 1), day('2025-01-03', 4, 2)]);
  assert.deepEqual(rankedPeriods(points, 'modis').map((p) => p.key), ['2025-01-02', '2025-01-03', '2025-01-01']);
  assert.equal(rankedPeriods(points, 'viirs')[0].key, '2025-01-01');
  assert.equal(points[0].key, '2025-01-01');
  for (const value of [undefined, null, NaN, Infinity, -1, '2']) assert.equal(availableValue(value), null);
  assert.equal(availableValue(0), 0);
});

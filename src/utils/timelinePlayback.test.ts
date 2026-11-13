import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CanonicalObservation, SensorType } from '../types/fire';
import {
  MAX_TIMELINE_STEPS,
  buildTimelineAxis,
  chooseBucketHours,
  indexTimeline,
  observationTimeSpan,
  observationsAtOrBefore,
  observationsAtStep,
  stepCutoffMs,
} from './timeline';

const H = 3_600_000;
const D = 24 * H;
const T0 = Date.parse('2026-11-04T00:00:00Z');
const NOW = Date.parse('2026-11-06T12:00:00Z');

function obs(id: string, sensor: SensorType, datetime_utc: string, frp_mw = 1): CanonicalObservation {
  return {
    id,
    source_record_id: id,
    latitude: 0,
    longitude: 0,
    acq_date: datetime_utc.slice(0, 10),
    acq_time: '0000',
    datetime_utc,
    sensor,
    satellite: sensor === 'MODIS' ? 'Aqua' : 'NOAA-20',
    product: 'test',
    processing_version: 'x',
    confidence: 50,
    confidence_category: 'nominal',
    frp_mw,
    scan: 1,
    track: 1,
    daynight: 'D',
    source_file: 'x',
    retrieved_at: '2026-11-06T12:00:00Z',
    quality_flags: '',
    record_hash: id,
  };
}

test('chooseBucketHours: 1 h up to 2 days, 6 h beyond, never more than the step cap', () => {
  assert.equal(chooseBucketHours(T0, T0), 1);
  assert.equal(chooseBucketHours(T0, T0 + 2 * D), 1);
  assert.equal(chooseBucketHours(T0, T0 + 2 * D + 1), 6);
  assert.equal(chooseBucketHours(T0, T0 + 5 * D), 6);
  // 30 days at 6 h would be 120 steps: widened.
  const wide = chooseBucketHours(T0, T0 + 30 * D);
  assert.ok(wide > 6);
  const steps = Math.floor((T0 + 30 * D) / (wide * H)) - Math.floor(T0 / (wide * H)) + 1;
  assert.ok(steps <= MAX_TIMELINE_STEPS);
  // garbage input falls back safely
  assert.equal(chooseBucketHours(NaN, T0), 1);
  assert.equal(chooseBucketHours(T0 + D, T0), 1);
});

test('observationTimeSpan ignores invalid dates; null when nothing parses', () => {
  assert.equal(observationTimeSpan([]), null);
  assert.equal(observationTimeSpan([obs('a', 'MODIS', 'garbage')]), null);
  const s = observationTimeSpan([
    obs('a', 'MODIS', '2026-11-04T10:00:00Z'),
    obs('b', 'VIIRS', '2026-11-05T03:00:00Z'),
    obs('c', 'VIIRS', ''),
  ]);
  assert.deepEqual(s, { firstMs: Date.parse('2026-11-04T10:00:00Z'), lastMs: Date.parse('2026-11-05T03:00:00Z') });
});

test('empty input: no steps, null range, empty index', () => {
  const axis = buildTimelineAxis([], NOW);
  assert.deepEqual(axis.steps, []);
  assert.equal(axis.startMs, null);
  assert.equal(axis.endMs, null);
  const idx = indexTimeline([], axis);
  assert.deepEqual(idx.byStep, []);
  assert.deepEqual(idx.cumulative, { MODIS: [], VIIRS: [] });
  assert.equal(stepCutoffMs(axis, 0), null);
  assert.deepEqual(observationsAtStep(idx, 0), []);
});

test('single step: one bucket, one step, cutoff is the last ms of the step', () => {
  const o = [obs('a', 'MODIS', '2026-11-04T10:15:00Z')];
  const axis = buildTimelineAxis(o, NOW);
  assert.equal(axis.bucketHours, 1);
  assert.equal(axis.steps.length, 1);
  const s = axis.steps[0];
  assert.equal(s.hasData, true);
  assert.equal(s.startMs, Date.parse('2026-11-04T10:00:00Z'));
  assert.equal(s.endMs, Date.parse('2026-11-04T11:00:00Z'));
  assert.equal(stepCutoffMs(axis, 0), s.endMs - 1);
  assert.equal(axis.startMs, s.startMs);
  assert.equal(axis.endMs, s.endMs);
});

test('gaps become explicit "no data" steps (hasData false), never activity 0 of real data', () => {
  const o = [obs('a', 'MODIS', '2026-11-04T01:10:00Z'), obs('b', 'VIIRS', '2026-11-04T05:50:00Z')];
  const axis = buildTimelineAxis(o, NOW);
  // 01:00 .. 06:00 -> 5 contiguous 1 h steps
  assert.equal(axis.steps.length, 5);
  assert.deepEqual(
    axis.steps.map((s) => s.hasData),
    [true, false, false, false, true],
  );
  for (let i = 1; i < axis.steps.length; i++) assert.equal(axis.steps[i].startMs, axis.steps[i - 1].endMs);
  assert.deepEqual(axis.steps.map((s) => s.index), [0, 1, 2, 3, 4]);
  const gap = axis.steps[2];
  assert.equal(gap.MODIS.count, 0);
  assert.equal(gap.VIIRS.count, 0);
  assert.equal(gap.hasData, false);
});

test('partial flag: last step reaching past now is partial, earlier ones are not; gap steps follow the same rule', () => {
  const now = Date.parse('2026-11-04T05:30:00Z');
  const o = [obs('a', 'MODIS', '2026-11-04T01:10:00Z'), obs('b', 'VIIRS', '2026-11-04T05:20:00Z')];
  const axis = buildTimelineAxis(o, now);
  assert.deepEqual(
    axis.steps.map((s) => s.partial),
    [false, false, false, false, true],
  );
  // a window ending exactly at now is complete
  const exact = buildTimelineAxis([obs('c', 'MODIS', '2026-11-04T04:10:00Z')], Date.parse('2026-11-04T05:00:00Z'));
  assert.equal(exact.steps[0].partial, false);
});

test('boundary: an observation exactly on a step edge belongs to the later step; cutoff = endMs - 1 is inclusive of the earlier one', () => {
  const o = [
    obs('a', 'MODIS', '2026-11-04T10:59:59.999Z'),
    obs('b', 'MODIS', '2026-11-04T11:00:00Z'),
  ];
  const axis = buildTimelineAxis(o, NOW);
  assert.equal(axis.steps.length, 2);
  const idx = indexTimeline(o, axis);
  assert.deepEqual(idx.byStep.map((a) => a.map((x) => x.id)), [['a'], ['b']]);
  const c0 = stepCutoffMs(axis, 0)!;
  assert.deepEqual(observationsAtOrBefore(o, c0).map((x) => x.id), ['a']);
  assert.deepEqual(observationsAtOrBefore(o, c0 + 1).map((x) => x.id), ['a', 'b']);
  // cutoff exactly at the observation time includes it
  assert.deepEqual(observationsAtOrBefore(o, Date.parse('2026-11-04T11:00:00Z')).map((x) => x.id), ['a', 'b']);
});

test('cumulative counts are per sensor and are never summed together', () => {
  const o = [
    obs('m1', 'MODIS', '2026-11-04T01:00:00Z'),
    obs('m2', 'MODIS', '2026-11-04T01:30:00Z'),
    obs('v1', 'VIIRS', '2026-11-04T03:10:00Z'),
    obs('m3', 'MODIS', '2026-11-04T03:40:00Z'),
    obs('v2', 'VIIRS', '2026-11-04T03:50:00Z'),
  ];
  const axis = buildTimelineAxis(o, NOW);
  const idx = indexTimeline(o, axis);
  assert.equal(axis.steps.length, 3); // 01, 02 (gap), 03
  assert.deepEqual(idx.cumulative.MODIS, [2, 2, 3]);
  assert.deepEqual(idx.cumulative.VIIRS, [0, 0, 2]);
  // final cumulative equals total per sensor
  assert.equal(idx.cumulative.MODIS.at(-1), o.filter((x) => x.sensor === 'MODIS').length);
  assert.equal(idx.cumulative.VIIRS.at(-1), o.filter((x) => x.sensor === 'VIIRS').length);
  // per-step stats stay separate
  assert.equal(axis.steps[2].MODIS.count, 1);
  assert.equal(axis.steps[2].VIIRS.count, 2);
  // observationsAtStep: cumulative (default) vs step-only
  assert.deepEqual(observationsAtStep(idx, 1).map((x) => x.id), ['m1', 'm2']);
  assert.deepEqual(observationsAtStep(idx, 2).map((x) => x.id), ['m1', 'm2', 'v1', 'm3', 'v2']);
  assert.deepEqual(observationsAtStep(idx, 2, 'step').map((x) => x.id), ['v1', 'm3', 'v2']);
  assert.deepEqual(observationsAtStep(idx, 3), []);
  assert.deepEqual(observationsAtStep(idx, -1), []);
});

test('invalid dates and non-MODIS/VIIRS sensors never enter the axis or the index', () => {
  const bad = { ...obs('x', 'MODIS', '2026-11-04T01:00:00Z'), sensor: 'OTHER' as unknown as SensorType };
  const o = [obs('a', 'MODIS', '2026-11-04T01:10:00Z'), obs('n', 'VIIRS', 'not-a-date'), bad];
  const axis = buildTimelineAxis(o, NOW);
  assert.equal(axis.skipped, 1);
  assert.equal(axis.skippedSensor, 1);
  const idx = indexTimeline(o, axis);
  assert.deepEqual(idx.byStep.flat().map((x) => x.id), ['a']);
  assert.deepEqual(observationsAtOrBefore(o, NOW).map((x) => x.id), ['a', 'x']); // cutoff helper is sensor-agnostic
});

test('stepCutoffMs: out-of-range and non-integer indices give null', () => {
  const axis = buildTimelineAxis([obs('a', 'MODIS', '2026-11-04T01:10:00Z')], NOW);
  assert.equal(stepCutoffMs(axis, -1), null);
  assert.equal(stepCutoffMs(axis, 1), null);
  assert.equal(stepCutoffMs(axis, 0.5), null);
  assert.equal(observationsAtOrBefore([], NaN).length, 0);
});

test('a 2-day load uses 1 h steps, a 5-day load 6 h steps; both stay within the cap', () => {
  const mk = (days: number) => [
    obs('a', 'MODIS', new Date(T0 + 3 * H).toISOString()),
    obs('b', 'VIIRS', new Date(T0 + days * D - H).toISOString()),
  ];
  const a2 = buildTimelineAxis(mk(2), NOW);
  assert.equal(a2.bucketHours, 1);
  assert.ok(a2.steps.length <= MAX_TIMELINE_STEPS);
  const a5 = buildTimelineAxis(mk(5), NOW);
  assert.equal(a5.bucketHours, 6);
  assert.ok(a5.steps.length <= MAX_TIMELINE_STEPS);
});

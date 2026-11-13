/**
 * Tests for the "What changed?" comparison adapter.
 *
 * No network: the loader is mocked and every observation is a fixture. The tests assert the
 * honesty rules: per-sensor separation, null percent on a zero baseline, and missing coverage
 * described as missing, not as zero fire.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { AiObservationLoader } from '../../types/ai';
import type { CanonicalObservation } from '../../types/fire';
import { createApp } from '../app';
import { MemoryObservationStore } from '../store';
import {
  buildComparisonWindows,
  makeComparisonWindow,
  parseCompareRequest,
  runComparison,
  type CompareRequest,
} from './compare';

const TODAY = '2026-11-10';

function obs(
  partial: Partial<CanonicalObservation> & Pick<CanonicalObservation, 'id' | 'sensor' | 'acq_date'>
): CanonicalObservation {
  const { id, sensor, acq_date, ...rest } = partial;
  return {
    id,
    sensor,
    acq_date,
    source_record_id: id,
    latitude: 22.1,
    longitude: 90.1,
    acq_time: '0610',
    datetime_utc: `${acq_date}T06:10:00Z`,
    satellite: sensor === 'MODIS' ? 'Terra' : 'NOAA-20',
    product: sensor === 'MODIS' ? 'MODIS_NRT' : 'VIIRS_NOAA20_NRT',
    processing_version: '6.1NRT',
    confidence: sensor === 'MODIS' ? 80 : 'nominal',
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

function request(body: Record<string, unknown>): CompareRequest {
  const parsed = parseCompareRequest(body, TODAY);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

function mockLoader(
  observations: CanonicalObservation[],
  source: 'live' | 'store' = 'live'
): { load: AiObservationLoader; calls: Array<{ days: number; bbox: string | null }> } {
  const calls: Array<{ days: number; bbox: string | null }> = [];
  return {
    calls,
    load: async (query) => {
      calls.push(query);
      return {
        observations,
        source,
        provenance: 'VERIFIED',
        retrieved_at: '2026-11-10T12:00:00Z',
        errors: [],
        truncated: false,
      };
    },
  };
}

test('comparison parser rejects 0 days, 6 days and a combined window over the live limit', () => {
  assert.equal(parseCompareRequest({ days_a: 0, days_b: 1 }, TODAY).ok, false);
  assert.equal(parseCompareRequest({ days_a: 6, days_b: 1 }, TODAY).ok, false);
  assert.equal(parseCompareRequest({ days_a: 1, days_b: 6 }, TODAY).ok, false);

  const combined = parseCompareRequest({ days_a: 3, days_b: 3 }, TODAY);
  assert.equal(combined.ok, false);
  if (!combined.ok) {
    assert.equal(combined.code, 'LIVE_WINDOW');
    assert.match(combined.error, /together may not exceed 5 days/i);
  }
});

test('comparison parser rejects invalid bbox and accepts valid sensor filters', () => {
  assert.equal(parseCompareRequest({ bbox: '91,22,90,23' }, TODAY).ok, false);
  const parsed = parseCompareRequest({ bbox: '90,22,91,23', days_a: 1, days_b: 1, sensors: 'VIIRS' }, TODAY);
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.value.sensors, 'VIIRS');
});

test('a reversed window is rejected instead of producing a negative range', () => {
  assert.equal(makeComparisonWindow('window_a', '2026-11-10', '2026-11-09'), null);
  assert.equal(makeComparisonWindow('window_a', 'not-a-date', '2026-11-09'), null);
});

test('consecutive windows are built backwards from today', () => {
  const windows = buildComparisonWindows(TODAY, 2, 2);
  assert.ok(windows);
  assert.deepEqual(windows.window_a, {
    label: 'window_a',
    start_date: '2026-11-09',
    end_date: '2026-11-10',
    days: 2,
  });
  assert.deepEqual(windows.window_b, {
    label: 'window_b',
    start_date: '2026-11-07',
    end_date: '2026-11-08',
    days: 2,
  });
});

test('zero baseline yields a null percent, never Infinity or a fake 0%', async () => {
  const loader = mockLoader([obs({ id: 'a1', sensor: 'MODIS', acq_date: '2026-11-10' })]);
  const result = await runComparison(loader.load, request({ days_a: 1, days_b: 1 }));

  assert.equal(result.a.by_sensor.MODIS, 1);
  assert.equal(result.b.by_sensor.MODIS, 0);
  assert.equal(result.change.MODIS.absolute, 1);
  assert.equal(result.change.MODIS.percent, null);
  assert.equal(result.change.MODIS.direction, 'increase');
});

test('equal-length windows are compared and normalised per day', async () => {
  const observations = [
    obs({ id: 'a1', sensor: 'MODIS', acq_date: '2026-11-09' }),
    obs({ id: 'a2', sensor: 'MODIS', acq_date: '2026-11-10' }),
    obs({ id: 'b1', sensor: 'MODIS', acq_date: '2026-11-07' }),
    obs({ id: 'b2', sensor: 'MODIS', acq_date: '2026-11-07' }),
    obs({ id: 'b3', sensor: 'MODIS', acq_date: '2026-11-08' }),
    obs({ id: 'b4', sensor: 'MODIS', acq_date: '2026-11-08' }),
  ];
  const loader = mockLoader(observations);
  const result = await runComparison(loader.load, request({ days_a: 2, days_b: 2 }));

  assert.deepEqual(loader.calls, [{ days: 4, bbox: null }]);
  assert.deepEqual(result.normalized.a_per_day, { MODIS: 1, VIIRS: 0 });
  assert.deepEqual(result.normalized.b_per_day, { MODIS: 2, VIIRS: 0 });
  assert.equal(result.change.MODIS.absolute, -2);
  assert.equal(result.change.MODIS.percent, -50);
  assert.equal(result.change.MODIS.direction, 'decrease');
  assert.deepEqual(Object.keys(result.change), ['MODIS', 'VIIRS', 'active_1km_cells']);
  assert.equal((result as unknown as Record<string, unknown>).total, undefined);
});

test('a window with no detections is reported as missing coverage, not zero fire', async () => {
  const loader = mockLoader([obs({ id: 'b1', sensor: 'VIIRS', acq_date: '2026-11-09' })]);
  const result = await runComparison(loader.load, request({ days_a: 1, days_b: 1 }));

  assert.equal(result.a.by_sensor.MODIS, 0);
  assert.equal(result.a.by_sensor.VIIRS, 0);
  assert.match(result.coverage_note, /No observation record in window A/i);
  assert.match(result.coverage_note, /not zero fire/i);
});

test('the sensor filter is applied before comparison and the loader receives the bbox', async () => {
  const observations = [
    obs({ id: 'm1', sensor: 'MODIS', acq_date: '2026-11-10' }),
    obs({ id: 'v1', sensor: 'VIIRS', acq_date: '2026-11-10' }),
  ];
  const loader = mockLoader(observations, 'store');
  const result = await runComparison(
    loader.load,
    request({ bbox: '90,22,91,23', days_a: 1, days_b: 1, sensors: 'MODIS' })
  );

  assert.deepEqual(loader.calls, [{ days: 2, bbox: '90,22,91,23' }]);
  assert.equal(result.a.by_sensor.MODIS, 1);
  assert.equal(result.a.by_sensor.VIIRS, 0);
  assert.equal(result.source.data_source, 'store');
  assert.match(result.coverage_note, /local store, not live NRT/i);
});

test('the compare route serves per-sensor changes from a seeded store and rejects an oversized window', async (t) => {
  const seeded = [
    obs({ id: 'a-m1', sensor: 'MODIS', acq_date: '2026-11-10' }),
    obs({ id: 'a-m2', sensor: 'MODIS', acq_date: '2026-11-10' }),
    obs({ id: 'b-m1', sensor: 'MODIS', acq_date: '2026-11-09' }),
    obs({ id: 'b-v1', sensor: 'VIIRS', acq_date: '2026-11-09' }),
  ];
  const { app } = createApp({
    store: new MemoryObservationStore(seeded),
    env: {},
    now: () => new Date('2026-11-10T12:00:00Z'),
    enableLiveFires: false,
  });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const res = await fetch(`${base}/api/v1/geo/compare`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bbox: '90,22,91,23', days_a: 1, days_b: 1 }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.deepEqual(Object.keys(body.change), ['MODIS', 'VIIRS', 'active_1km_cells']);
  assert.equal(body.a.by_sensor.MODIS, 2);
  assert.equal(body.a.by_sensor.VIIRS, 0);
  assert.equal(body.b.by_sensor.MODIS, 1);
  assert.equal(body.b.by_sensor.VIIRS, 1);
  assert.equal(body.change.MODIS.absolute, 1);
  assert.equal(body.change.MODIS.percent, 100);
  assert.equal(body.change.VIIRS.absolute, -1);
  assert.equal(body.change.VIIRS.percent, -100);
  assert.equal(body.source.data_source, 'store');
  assert.match(body.coverage_note, /local store, not live NRT/i);
  assert.equal('total' in body, false);

  const over = await fetch(`${base}/api/v1/geo/compare`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ days_a: 3, days_b: 3 }),
  });
  assert.equal(over.status, 400);
  const overBody = await over.json();
  assert.equal(overBody.code, 'LIVE_WINDOW');
  assert.match(overBody.error, /together may not exceed 5 days/i);
});

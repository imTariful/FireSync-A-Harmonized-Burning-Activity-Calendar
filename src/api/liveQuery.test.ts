import test from 'node:test';
import assert from 'node:assert/strict';
import { api, liveObservationQuery } from './client';
import { defaultFilters } from '../utils/filterValidation';

const today = '2026-11-13';
const scope = { bbox: '90,22,91,23', aoi: '90,22;91,22;90,23', sensors: 'MODIS' };

test('shared live query keeps AOI, satellite, FRP and confidence while clamping the same dates', () => {
  const filters = Object.freeze({ ...defaultFilters(today), startDate: '2020-01-01', endDate: '2030-01-01', satellite: 'Terra' as const, minFRP: 50, minConfidence: 80 });
  const query = liveObservationQuery(filters, scope, today);
  assert.deepEqual(query, { source: 'live', start_date: '2026-11-09', end_date: today, ...scope, satellites: 'Terra', min_frp: 50, min_confidence: 80 });
  assert.equal(filters.startDate, '2020-01-01');
});

test('reset and legacy date-only callers retain defaults rather than stale filter values', () => {
  const reset = liveObservationQuery(defaultFilters(today), {}, today);
  assert.equal(reset.satellites, undefined);
  assert.equal(reset.min_frp, undefined);
  assert.equal(reset.min_confidence, undefined);
  assert.equal(reset.aoi, undefined);
  assert.equal(reset.start_date, today);
  assert.equal(reset.end_date, today);
  assert.deepEqual(liveObservationQuery({ startDate: today, endDate: today }, {}, today), reset);
});

test('calendar, sensor, summary, calibration and exports serialize the identical scoped filters', async (t) => {
  const requests: URL[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL) => {
    requests.push(new URL(String(input), 'http://fixture.invalid'));
    return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
  });
  const actualToday = new Date().toISOString().slice(0, 10);
  const query = liveObservationQuery({ ...defaultFilters(actualToday), satellite: 'Terra', minFRP: 50, minConfidence: 80 }, scope);
  await api.getHotspots(query);
  await api.getAnalyticsSummary(query);
  await api.getCalendar(query);
  await api.getSensorComparison(query);
  await api.getCalibrationMetrics(query);
  for (const url of [api.getExportCsvUrl(query), api.getExportCalendarCsvUrl(query), api.getExportValidationCsvUrl(query)]) requests.push(new URL(url, 'http://fixture.invalid'));
  assert.equal(requests.length, 8);
  for (const url of requests) {
    for (const [key, value] of Object.entries(query)) if (value !== undefined) assert.equal(url.searchParams.get(key), String(value), `${url.pathname}: ${key}`);
  }
});

test('a failed calendar request is not an empty success, and the same selection can be retried', async (t) => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests += 1;
    return requests === 1
      ? new Response(JSON.stringify({ error: 'Source temporarily unavailable' }), { status: 503 })
      : new Response(JSON.stringify({ daily_summaries: [] }));
  });
  const query = liveObservationQuery(defaultFilters());
  await assert.rejects(api.getCalendar(query), /Source temporarily unavailable/);
  assert.deepEqual((await api.getCalendar(query)).daily_summaries, []);
  assert.equal(requests, 2);
});

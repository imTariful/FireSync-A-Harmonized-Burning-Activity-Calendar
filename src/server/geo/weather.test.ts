/**
 * Tests for the Open-Meteo weather adapter and the deterministic fire–weather correlations.
 * `fetch` is always mocked: no test may call a real provider.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import type { CanonicalObservation } from '../../types/fire';
import {
  buildWeatherFireAnalysis,
  fetchWeatherDays,
  fireWeatherCorrelations,
  parseOpenMeteoDaily,
  pearson,
  weatherPointForBbox,
} from './weather';
import { parseBboxString } from './compute';

function obs(partial: Partial<CanonicalObservation> & Pick<CanonicalObservation, 'id' | 'sensor'>): CanonicalObservation {
  const { id, sensor, ...rest } = partial;
  return {
    id,
    sensor,
    source_record_id: id,
    latitude: 22.1,
    longitude: 90.1,
    acq_date: '2026-11-09',
    acq_time: '0610',
    datetime_utc: '2026-11-09T06:10:00Z',
    satellite: sensor === 'MODIS' ? 'Terra' : 'NOAA-20',
    product: sensor === 'MODIS' ? 'MODIS_NRT' : 'VIIRS_NOAA20_NRT',
    processing_version: '6.1NRT',
    confidence: 80,
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

const OPEN_METEO_BODY = {
  daily: {
    time: ['2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11'],
    temperature_2m_max: [30, 31, 'x', 29],
    temperature_2m_min: [20, 21, 22, 19],
    precipitation_sum: [0, 1.5, 0, null],
    wind_speed_10m_max: [12, 15, 9, 11],
    relative_humidity_2m_mean: [60, 55, 70, 65],
  },
};

test('weather point is the bbox centre only for small areas', () => {
  const small = weatherPointForBbox(parseBboxString('90,22,91,23')!);
  assert.equal(small.ok, true);
  if (small.ok) {
    assert.equal(small.latitude, 22.5);
    assert.equal(small.longitude, 90.5);
  }
  const world = weatherPointForBbox(parseBboxString('-180,-90,180,90')!);
  assert.equal(world.ok, false);
  if (!world.ok) assert.match(world.reason, /single-point|representative/i);
});

test('Open-Meteo payload parsing keeps malformed values null, never guessed', () => {
  const days = parseOpenMeteoDaily(OPEN_METEO_BODY);
  assert.equal(days.length, 4);
  assert.equal(days[0].temperature_2m_max_c, 30);
  assert.equal(days[2].temperature_2m_max_c, null);
  assert.equal(days[3].precipitation_mm, null);
  assert.deepEqual(parseOpenMeteoDaily({}), []);
  assert.deepEqual(parseOpenMeteoDaily(null), []);
  assert.deepEqual(parseOpenMeteoDaily('nope'), []);
});

test('fetchWeatherDays filters rows to the requested window and reports provider metadata', async () => {
  const calls: string[] = [];
  const fakeFetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response(JSON.stringify(OPEN_METEO_BODY), { status: 200 });
  }) as typeof fetch;

  const result = await fetchWeatherDays({
    latitude: 22.5,
    longitude: 90.5,
    startDate: '2026-11-09',
    endDate: '2026-11-10',
    fetchImpl: fakeFetch,
    now: () => new Date('2026-11-10T12:00:00Z'),
  });

  assert.equal(result.available, true);
  assert.deepEqual(
    result.days.map((d) => d.date),
    ['2026-11-09', '2026-11-10']
  );
  assert.equal(result.provider, 'Open-Meteo');
  assert.equal(result.retrieved_at, '2026-11-10T12:00:00.000Z');
  assert.match(calls[0], /past_days=2/);
  assert.match(calls[0], /timezone=UTC/);
});

test('fetchWeatherDays reports HTTP and network failures instead of empty success', async () => {
  const httpFail = (async () => new Response('boom', { status: 503 })) as typeof fetch;
  const failed = await fetchWeatherDays({
    latitude: 1,
    longitude: 1,
    startDate: '2026-11-09',
    endDate: '2026-11-10',
    fetchImpl: httpFail,
  });
  assert.equal(failed.available, false);
  assert.match(String(failed.reason), /HTTP 503/);

  const netFail = (async () => {
    throw new Error('socket hangup');
  }) as typeof fetch;
  const failedNet = await fetchWeatherDays({
    latitude: 1,
    longitude: 1,
    startDate: '2026-11-09',
    endDate: '2026-11-10',
    fetchImpl: netFail,
  });
  assert.equal(failedNet.available, false);
  assert.match(String(failedNet.reason), /socket hangup/);
});

test('pearson needs at least three finite pairs and non-zero variance', () => {
  assert.deepEqual(pearson([1, 2], [1, 2]), { r: null, pairs: 2 });
  assert.deepEqual(pearson([1, 1, 1], [1, 2, 3]), { r: null, pairs: 3 });
  const perfect = pearson([1, 2, 3, 4], [2, 4, 6, 8]);
  assert.equal(perfect.r, 1);
  assert.equal(perfect.pairs, 4);
  const inverse = pearson([1, 2, 3, 4], [8, 6, 4, 2]);
  assert.equal(inverse.r, -1);
});

test('fire–weather correlations pair only days with observation records', () => {
  const fireDays = [
    { date: '2026-11-08', MODIS: 1, VIIRS: 2, status: 'observed' },
    { date: '2026-11-09', MODIS: 2, VIIRS: 3, status: 'observed' },
    { date: '2026-11-10', MODIS: 0, VIIRS: 0, status: 'no_observation_record' },
    { date: '2026-11-11', MODIS: 4, VIIRS: 5, status: 'observed' },
  ];
  const weatherDays = parseOpenMeteoDaily(OPEN_METEO_BODY);
  const correlations = fireWeatherCorrelations(fireDays, weatherDays);
  assert.equal(correlations.length, 5);
  const tempMax = correlations.find((c) => c.variable === 'temperature_2m_max_c')!;
  // The no-record day is excluded: only 3 pairs remain (11-08, 11-09, 11-11).
  assert.equal(tempMax.MODIS.pairs, 3);
  assert.equal(tempMax.VIIRS.pairs, 3);
});

test('analysis stays honest when weather is unavailable or the box is too large', async () => {
  const observations = [obs({ id: 'm1', sensor: 'MODIS' })];
  const unavailable = await fetchWeatherDays({
    latitude: 1,
    longitude: 1,
    startDate: '2026-11-09',
    endDate: '2026-11-09',
    fetchImpl: (async () => new Response('no', { status: 500 })) as typeof fetch,
  });
  const analysis = buildWeatherFireAnalysis({
    observations,
    bboxString: '90,22,91,23',
    startDate: '2026-11-09',
    endDate: '2026-11-09',
    sourceErrors: [],
    weather: unavailable,
  });
  assert.equal(analysis.weather.available, false);
  assert.equal(analysis.correlations.length, 0);
  assert.equal(analysis.paired_days, 0);
  assert.ok(analysis.notes.some((n) => /single-point/i.test(n)));
  assert.ok(analysis.notes.some((n) => /not zero fire/i.test(n)));
});

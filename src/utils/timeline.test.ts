import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CanonicalObservation, SensorType } from '../types/fire';
import { bucketObservations, bucketRange, observationsInBucket } from './timeline';

const H = 3_600_000;
const NOW = Date.parse('2026-11-06T12:00:00Z');

function obs(
  id: string,
  sensor: SensorType,
  datetime_utc: string,
  frp_mw: number = 1,
): CanonicalObservation {
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
    source_file: 'test',
    retrieved_at: '2026-11-06T00:00:00Z',
    quality_flags: '',
    record_hash: id,
  };
}

test('empty input returns an empty bucket list and zero skipped', () => {
  const r = bucketObservations([], 6, NOW);
  assert.deepEqual(r.buckets, []);
  assert.equal(r.skipped, 0);
  assert.equal(r.skippedSensor, 0);
  assert.equal(bucketRange(r.buckets), null);
});

test('two sensors in one bucket stay separate (counts and FRP, no combined total)', () => {
  const r = bucketObservations(
    [
      obs('m1', 'MODIS', '2026-11-05T01:00:00Z', 10),
      obs('m2', 'MODIS', '2026-11-05T02:00:00Z', 5),
      obs('v1', 'VIIRS', '2026-11-05T03:00:00Z', 2.5),
    ],
    6,
    NOW,
  );
  assert.equal(r.buckets.length, 1);
  const b = r.buckets[0];
  assert.deepEqual(b.MODIS, { count: 2, frpSumMw: 15 });
  assert.deepEqual(b.VIIRS, { count: 1, frpSumMw: 2.5 });
  assert.equal(b.startMs, Date.parse('2026-11-05T00:00:00Z'));
  assert.equal(b.endMs, Date.parse('2026-11-05T06:00:00Z'));
  assert.ok(!('count' in b) && !('frpSumMw' in b), 'no cross-sensor total on the bucket');
});

test('bucket boundary: start inclusive, end exclusive', () => {
  const r = bucketObservations(
    [
      obs('a', 'MODIS', '2026-11-05T05:59:59Z'),
      obs('b', 'MODIS', '2026-11-05T06:00:00Z'), // exactly on boundary -> next bucket
      obs('c', 'MODIS', '2026-11-05T00:00:00Z'), // exactly on start -> first bucket
    ],
    6,
    NOW,
  );
  assert.equal(r.buckets.length, 2);
  assert.equal(r.buckets[0].startMs, Date.parse('2026-11-05T00:00:00Z'));
  assert.equal(r.buckets[0].MODIS.count, 2);
  assert.equal(r.buckets[1].startMs, Date.parse('2026-11-05T06:00:00Z'));
  assert.equal(r.buckets[1].MODIS.count, 1);

  const all = [
    obs('a', 'MODIS', '2026-11-05T05:59:59Z'),
    obs('b', 'MODIS', '2026-11-05T06:00:00Z'),
    obs('c', 'MODIS', '2026-11-05T00:00:00Z'),
  ];
  assert.deepEqual(observationsInBucket(all, r.buckets, 0).map((o) => o.id), ['a', 'c']);
  assert.deepEqual(observationsInBucket(all, r.buckets, 1).map((o) => o.id), ['b']);
});

test('partial flag: true only when the bucket ends after now (end == now is complete)', () => {
  const now = Date.parse('2026-11-06T12:00:00Z');
  const r = bucketObservations(
    [
      obs('past', 'VIIRS', '2026-11-06T05:00:00Z'), // bucket 00:00-06:00, complete
      obs('edge', 'VIIRS', '2026-11-06T06:00:00Z'), // bucket 06:00-12:00 ends exactly at now
      obs('cur', 'VIIRS', '2026-11-06T11:59:00Z'), // same 06-12 bucket
      obs('now', 'VIIRS', '2026-11-06T12:00:00Z'), // 12-18 bucket, ends after now
    ],
    6,
    now,
  );
  assert.deepEqual(
    r.buckets.map((b) => [b.startMs, b.partial]),
    [
      [Date.parse('2026-11-06T00:00:00Z'), false],
      [Date.parse('2026-11-06T06:00:00Z'), false],
      [Date.parse('2026-11-06T12:00:00Z'), true],
    ],
  );
  // A bucket straddling now is partial.
  const r2 = bucketObservations([obs('x', 'MODIS', '2026-11-06T10:00:00Z')], 24, now);
  assert.equal(r2.buckets[0].partial, true);
});

test('invalid datetime_utc is skipped and counted; missing/NaN frp counts as 0 for FRP only', () => {
  const bad = [
    obs('empty', 'MODIS', ''),
    obs('junk', 'MODIS', 'not-a-date'),
    { ...obs('undef', 'VIIRS', '2026-11-05T00:00:00Z'), datetime_utc: undefined as unknown as string },
  ];
  const nanFrp = obs('nan', 'MODIS', '2026-11-05T01:00:00Z', NaN);
  const noFrp = { ...obs('nofrp', 'MODIS', '2026-11-05T02:00:00Z'), frp_mw: undefined as unknown as number };
  const ok = obs('ok', 'MODIS', '2026-11-05T03:00:00Z', 4);
  const r = bucketObservations([...bad, nanFrp, noFrp, ok], 6, NOW);
  assert.equal(r.skipped, 3);
  assert.equal(r.buckets.length, 1);
  assert.deepEqual(r.buckets[0].MODIS, { count: 3, frpSumMw: 4 }); // NaN/undefined still counted, FRP 0
  assert.deepEqual(r.buckets[0].VIIRS, { count: 0, frpSumMw: 0 });
  assert.deepEqual(observationsInBucket([...bad, ok], r.buckets, 0).map((o) => o.id), ['ok']);
});

test('unsorted input yields buckets sorted by start; bucketRange spans first start to last end', () => {
  const r = bucketObservations(
    [
      obs('c', 'MODIS', '2026-11-05T13:00:00Z'),
      obs('a', 'VIIRS', '2026-11-04T01:00:00Z'),
      obs('b', 'MODIS', '2026-11-04T07:00:00Z'),
      obs('a2', 'MODIS', '2026-11-04T02:00:00Z'),
    ],
    6,
    NOW,
  );
  const starts = r.buckets.map((b) => b.startMs);
  assert.deepEqual(starts, [...starts].sort((x, y) => x - y));
  assert.equal(r.buckets.length, 3); // sparse: empty buckets are not invented
  assert.deepEqual(bucketRange(r.buckets), {
    startMs: Date.parse('2026-11-04T00:00:00Z'),
    endMs: Date.parse('2026-11-05T18:00:00Z'),
  });
});

test('observationsInBucket: out-of-range index returns []; input order preserved', () => {
  const all = [obs('2', 'MODIS', '2026-11-05T02:00:00Z'), obs('1', 'VIIRS', '2026-11-05T01:00:00Z')];
  const { buckets } = bucketObservations(all, 6, NOW);
  assert.deepEqual(observationsInBucket(all, buckets, 0).map((o) => o.id), ['2', '1']);
  assert.deepEqual(observationsInBucket(all, buckets, -1), []);
  assert.deepEqual(observationsInBucket(all, buckets, 1), []);
  assert.deepEqual(observationsInBucket(all, buckets, 0.5), []);
});

test('unknown sensor is not merged into either sensor (counted in skippedSensor)', () => {
  const weird = { ...obs('w', 'MODIS', '2026-11-05T01:00:00Z'), sensor: 'OTHER' as unknown as SensorType };
  const r = bucketObservations([weird, obs('m', 'MODIS', '2026-11-05T01:00:00Z')], 6, NOW);
  assert.equal(r.skippedSensor, 1);
  assert.equal(r.buckets[0].MODIS.count, 1);
  assert.equal(r.buckets[0].VIIRS.count, 0);
});

test('invalid bucketHours / now throw RangeError; the clock is never read', () => {
  assert.throws(() => bucketObservations([], 0, NOW), RangeError);
  assert.throws(() => bucketObservations([], -1, NOW), RangeError);
  assert.throws(() => bucketObservations([], NaN, NOW), RangeError);
  assert.throws(() => bucketObservations([], 6, NaN), RangeError);
  // Same input + same injected now => same output regardless of real time.
  const o = [obs('a', 'MODIS', '2026-11-05T01:00:00Z')];
  assert.deepEqual(bucketObservations(o, 24, 5 * H), bucketObservations(o, 24, 5 * H));
});

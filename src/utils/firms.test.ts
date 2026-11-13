import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FIRMS_SOURCES,
  FirmsFormatError,
  FirmsRequestError,
  RateBudget,
  TtlCache,
  capByFrp,
  classifyFailures,
  describeError,
  fetchTextWithRetry,
  firmsCsvToObservations,
  mapSettledWithConcurrency,
  maskSecret,
  splitCsvLine,
  validateArea,
} from './firms';

const VIIRS = FIRMS_SOURCES.find((s) => s.source === 'VIIRS_NOAA20_NRT')!;
const MODIS = FIRMS_SOURCES.find((s) => s.source === 'MODIS_NRT')!;

const VIIRS_CSV = [
  'latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight',
  '23.5,90.1,340.2,0.4,0.37,2026-11-03,142,N20,VIIRS,n,2.0NRT,300.1,4.5,D',
  '23.6,90.2,360.0,0.4,0.37,2026-11-03,1305,N20,VIIRS,h,2.0NRT,301.0,12.25,N',
  '23.7,90.3,310.0,0.4,0.37,2026-11-03,1305,N20,VIIRS,l,2.0NRT,299.0,0.8,N',
].join('\n');

const MODIS_CSV = [
  'latitude,longitude,brightness,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_t31,frp,daynight',
  '10.1,20.2,330.5,1.1,1.0,2026-11-03,0955,Aqua,MODIS,85,6.1NRT,300.0,20.5,D',
  '10.2,20.3,320.5,1.1,1.0,2026-11-03,0955,Terra,MODIS,45,6.1NRT,300.0,8,D',
  '10.3,20.4,310.5,1.1,1.0,2026-11-03,0955,Terra,MODIS,10,6.1NRT,300.0,2,N',
].join('\n');

test('VIIRS CSV -> observations (confidence letters, padded time, sensor/satellite/product)', () => {
  const obs = firmsCsvToObservations(VIIRS_CSV, VIIRS, '2026-11-04T00:00:00Z');
  assert.equal(obs.length, 3);
  assert.deepEqual(obs.map((o) => o.confidence_category), ['nominal', 'high', 'low']);
  assert.equal(obs[0].acq_time, '0142');
  assert.equal(obs[0].datetime_utc, '2026-11-03T01:42:00Z');
  assert.equal(obs[0].sensor, 'VIIRS');
  assert.equal(obs[0].satellite, 'NOAA-20');
  assert.equal(obs[0].product, 'VIIRS_NOAA20_NRT');
  assert.equal(obs[0].bright_ti4, 340.2);
  assert.equal(obs[0].brightness, undefined);
  assert.equal(obs[1].daynight, 'N');
  assert.equal(obs[1].frp_mw, 12.25);
  assert.equal(obs[0].retrieved_at, '2026-11-04T00:00:00Z');
});

test('MODIS CSV -> observations (numeric confidence buckets, Aqua/Terra from satellite column)', () => {
  const obs = firmsCsvToObservations(MODIS_CSV, MODIS, 'now');
  assert.deepEqual(obs.map((o) => o.confidence_category), ['high', 'nominal', 'low']);
  assert.deepEqual(obs.map((o) => o.satellite), ['Aqua', 'Terra', 'Terra']);
  assert.equal(obs[0].confidence, 85);
  assert.equal(obs[0].brightness, 330.5);
  assert.equal(obs[0].bright_ti4, undefined);
  assert.equal(obs[0].sensor, 'MODIS');
});

test('ids are deterministic, unique per record and sensors never share ids', () => {
  const a = firmsCsvToObservations(VIIRS_CSV, VIIRS, 'x');
  const b = firmsCsvToObservations(VIIRS_CSV, VIIRS, 'y');
  assert.deepEqual(a.map((o) => o.id), b.map((o) => o.id));
  assert.equal(new Set(a.map((o) => o.id)).size, a.length);
  assert.match(a[0].id, /^live-[0-9a-f]{16}$/);
});

test('header-only CSV is an empty list; plain-text FIRMS errors and empty bodies throw', () => {
  assert.deepEqual(firmsCsvToObservations('latitude,longitude,acq_date,acq_time\n', MODIS, 'x'), []);
  assert.throws(
    () => firmsCsvToObservations('Invalid MAP_KEY.', MODIS, 'x'),
    (e: unknown) => e instanceof FirmsFormatError && /MODIS_NRT: Invalid MAP_KEY/.test(e.message)
  );
  assert.throws(() => firmsCsvToObservations('   \n', MODIS, 'x'), FirmsFormatError);
});

test('rows with broken coordinates are skipped, CRLF is handled', () => {
  const csv = 'latitude,longitude,acq_date,acq_time,confidence,frp,scan,track,daynight,satellite\r\nabc,10,2026-11-03,100,50,1,1,1,D,Terra\r\n5,6,2026-11-03,100,50,1,1,1,D,Terra\r\n';
  const obs = firmsCsvToObservations(csv, MODIS, 'x');
  assert.equal(obs.length, 1);
  assert.equal(obs[0].latitude, 5);
});

test('missing required measurement fields fail explicitly rather than becoming zero/day/nominal', () => {
  const header = 'latitude,longitude,acq_date,acq_time,confidence,frp,scan,track,daynight,satellite';
  const values = ['5', '6', '2026-11-03', '0100', '50', '1', '1', '1', 'D', 'Terra'];
  for (const index of [4, 5, 6, 7, 8]) {
    const missing = [...values]; missing[index] = '';
    assert.throws(() => firmsCsvToObservations(`${header}\n${missing.join(',')}`, MODIS, 'now'), FirmsFormatError);
  }
  const zero = [...values]; zero[5] = '0';
  assert.equal(firmsCsvToObservations(`${header}\n${zero.join(',')}`, MODIS, 'now')[0].frp_mw, 0);
});
test('coordinate omissions are not located at zero, and platform identity participates in fingerprints', () => {
  const header = 'latitude,longitude,acq_date,acq_time,confidence,frp,scan,track,daynight,satellite';
  assert.equal(firmsCsvToObservations(`${header}\n,6,2026-11-03,0100,50,1,1,1,D,Terra`, MODIS, 'now').length, 0);
  const obs = firmsCsvToObservations(`${header}\n5,6,2026-11-03,0100,50,1,1,1,D,Terra\n5,6,2026-11-03,0100,50,1,1,1,D,Aqua`, MODIS, 'now');
  assert.notEqual(obs[0].record_hash, obs[1].record_hash);
});

test('splitCsvLine handles quoted fields', () => {
  assert.deepEqual(splitCsvLine('a,"b,c",d'), ['a', 'b,c', 'd']);
  assert.deepEqual(splitCsvLine('a,"say ""hi""",c'), ['a', 'say "hi"', 'c']);
  assert.deepEqual(splitCsvLine('a,b'), ['a', 'b']);
});

test('capByFrp keeps the strongest detections and reports truncation', () => {
  const items = [{ frp_mw: 1 }, { frp_mw: 9 }, { frp_mw: 5 }, { frp_mw: 7 }];
  assert.deepEqual(capByFrp(items, 10), { items, truncated: false });
  const capped = capByFrp(items, 2);
  assert.equal(capped.truncated, true);
  assert.deepEqual(capped.items.map((i) => i.frp_mw), [9, 7]);
});

test('validateArea: world, valid boxes, bad format, bad ranges', () => {
  assert.deepEqual(validateArea('world'), { ok: true, area: 'world' });
  assert.deepEqual(validateArea('88,20,93,27'), { ok: true, area: '88,20,93,27' });
  assert.deepEqual(validateArea('-124.5,32.5,-114.1,42'), { ok: true, area: '-124.5,32.5,-114.1,42' });
  assert.equal(validateArea('88,20,93').ok, false);
  assert.equal(validateArea('a,b,c,d').ok, false);
  assert.equal(validateArea('1e2,0,5,5').ok, false);
  assert.equal(validateArea('../../etc,1,2,3').ok, false);
  assert.equal(validateArea('-181,0,5,5').ok, false);
  assert.equal(validateArea('0,0,181,5').ok, false);
  assert.equal(validateArea('0,-91,5,5').ok, false);
  assert.equal(validateArea('0,0,5,91').ok, false);
  assert.equal(validateArea('10,0,5,5').ok, false);
  assert.equal(validateArea('0,10,5,5').ok, false);
});

test('maskSecret removes the key everywhere, including URL path segments', () => {
  const key = 'abc123SECRET';
  assert.equal(maskSecret(`GET https://x/api/area/csv/${key}/MODIS_NRT/world/1 failed`, key).includes(key), false);
  assert.equal(maskSecret('key abc123SECRET twice abc123SECRET', key), 'key *** twice ***');
  assert.equal(maskSecret('https://x/api/area/csv/OTHERKEY/MODIS_NRT/1,2,3,4/1'), 'https://x/api/area/csv/***/MODIS_NRT/1,2,3,4/1');
  assert.equal(maskSecret('nothing here', undefined), 'nothing here');
});

test('describeError follows the cause chain (fetch failed -> ECONNREFUSED) and masks the key', () => {
  const cause = Object.assign(new Error('connect ECONNREFUSED 1.2.3.4:443 for /area/csv/SECRETKEY/x'), {
    code: 'ECONNREFUSED',
  });
  const err = new TypeError('fetch failed', { cause });
  const text = describeError(err, 'SECRETKEY');
  assert.match(text, /fetch failed/);
  assert.match(text, /ECONNREFUSED/);
  assert.equal(text.includes('SECRETKEY'), false);
});

test('TtlCache: hit, expiry, overwrite and size bound', () => {
  let t = 1000;
  const cache = new TtlCache<string>(100, 3, () => t);
  cache.set('a', '1');
  assert.equal(cache.get('a'), '1');
  t += 99;
  assert.equal(cache.get('a'), '1');
  t += 1; // exactly ttl -> expired
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.size, 0);

  cache.set('a', '1');
  cache.set('a', '2');
  assert.equal(cache.get('a'), '2');
  assert.equal(cache.size, 1);

  cache.set('b', 'b');
  cache.set('c', 'c');
  cache.set('d', 'd'); // evicts oldest ('a')
  assert.equal(cache.size, 3);
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.get('d'), 'd');
});

test('TtlCache evicts expired entries before live ones when full', () => {
  let t = 0;
  const cache = new TtlCache<number>(100, 2, () => t);
  cache.set('old', 1);
  t = 90;
  cache.set('new', 2);
  t = 120; // 'old' expired, 'new' alive
  cache.set('x', 3);
  assert.equal(cache.get('new'), 2);
  assert.equal(cache.get('x'), 3);
  assert.equal(cache.get('old'), undefined);
});

test('RateBudget: sliding window, refusal does not consume, secondsUntilAvailable', () => {
  let t = 0;
  const budget = new RateBudget(10, 1000, () => t);
  assert.equal(budget.tryConsume(6), true);
  assert.equal(budget.tryConsume(5), false);
  assert.equal(budget.remaining(), 4);
  assert.equal(budget.secondsUntilAvailable(5), 1);
  t = 1001;
  assert.equal(budget.remaining(), 10);
  assert.equal(budget.tryConsume(5), true);
});

function makeRetryOpts(fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) {
  const sleeps: number[] = [];
  return {
    sleeps,
    opts: {
      attempts: 3,
      baseDelayMs: 100,
      timeoutMs: 1000,
      fetchImpl,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      random: () => 0,
      ...extra,
    },
  };
}

test('fetchTextWithRetry retries "fetch failed" with exponential backoff, then succeeds', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    if (calls < 3) throw new TypeError('fetch failed', { cause: new Error('ECONNRESET') });
    return new Response('ok-body', { status: 200 });
  }) as typeof fetch;
  const { opts, sleeps } = makeRetryOpts(fetchImpl);
  assert.equal(await fetchTextWithRetry('http://x', opts), 'ok-body');
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [100, 200]);
});

test('fetchTextWithRetry retries 5xx/429 but not 4xx; keeps the failure reason', async () => {
  let calls = 0;
  const f500 = (async () => {
    calls++;
    return new Response('boom', { status: 503 });
  }) as typeof fetch;
  await assert.rejects(
    fetchTextWithRetry('http://x', makeRetryOpts(f500).opts),
    (e: unknown) => e instanceof FirmsRequestError && e.status === 503 && e.kind === 'http'
  );
  assert.equal(calls, 3);

  calls = 0;
  const f403 = (async () => {
    calls++;
    return new Response('nope', { status: 403 });
  }) as typeof fetch;
  await assert.rejects(
    fetchTextWithRetry('http://x', makeRetryOpts(f403).opts),
    (e: unknown) => e instanceof FirmsRequestError && e.status === 403 && !e.retryable
  );
  assert.equal(calls, 1);
});

test('fetchTextWithRetry: timeout -> kind "timeout"; network failure keeps the cause', async () => {
  const fTimeout = (async () => {
    throw new DOMException('timed out', 'TimeoutError');
  }) as typeof fetch;
  await assert.rejects(
    fetchTextWithRetry('http://x', makeRetryOpts(fTimeout, { attempts: 2 }).opts),
    (e: unknown) => e instanceof FirmsRequestError && e.kind === 'timeout'
  );

  const cause = new Error('ENOTFOUND');
  const fNet = (async () => {
    throw new TypeError('fetch failed', { cause });
  }) as typeof fetch;
  await assert.rejects(
    fetchTextWithRetry('http://x', makeRetryOpts(fNet, { attempts: 1 }).opts),
    (e: unknown) => e instanceof FirmsRequestError && e.kind === 'network' && (e.cause as { cause?: unknown }).cause === cause
  );
});

test('fetchTextWithRetry stops when beforeAttempt refuses (budget)', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    throw new TypeError('fetch failed');
  }) as typeof fetch;
  const { opts } = makeRetryOpts(fetchImpl, { beforeAttempt: (n: number) => n < 2 });
  await assert.rejects(
    fetchTextWithRetry('http://x', opts),
    (e: unknown) => e instanceof FirmsRequestError && e.kind === 'budget'
  );
  assert.equal(calls, 1);
});

test('mapSettledWithConcurrency respects the limit, keeps order and settles failures', async () => {
  let active = 0;
  let maxActive = 0;
  const results = await mapSettledWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    if (n === 3) throw new Error('three');
    return n * 10;
  });
  assert.equal(maxActive, 2);
  assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'fulfilled', 'rejected', 'fulfilled', 'fulfilled']);
  assert.equal((results[4] as PromiseFulfilledResult<number>).value, 50);

  const sequential = await mapSettledWithConcurrency([1, 2, 3], 1, async (n) => n);
  assert.equal(sequential.length, 3);
});

test('classifyFailures gives user-safe messages and the right status', () => {
  assert.equal(classifyFailures([new FirmsRequestError('HTTP 429', 'http', true, 429)]).status, 429);
  assert.equal(classifyFailures([new FirmsFormatError('MODIS_NRT: Exceeded transaction limit')]).status, 429);
  assert.match(classifyFailures([new FirmsFormatError('MODIS_NRT: Invalid MAP_KEY')]).message, /FIRMS_MAP_KEY/);
  assert.equal(classifyFailures([new FirmsRequestError('t', 'timeout', true), new FirmsRequestError('t', 'timeout', true)]).status, 504);
  const net = classifyFailures([new FirmsRequestError('fetch failed', 'network', true)]);
  assert.equal(net.status, 502);
  assert.match(net.message, /network/i);
  assert.equal(classifyFailures([new FirmsRequestError('HTTP 500', 'http', true, 500)]).status, 502);

  const bad400 = new FirmsRequestError('HTTP 400', 'http', false, 400, { responseText: 'Invalid MAP_KEY.' });
  const badKeySummary = classifyFailures([bad400]);
  assert.equal(badKeySummary.status, 502);
  assert.match(badKeySummary.message, /rejected the server key/i);
  assert.match(badKeySummary.message, /FIRMS_MAP_KEY/);

  // A 400 with an unrelated body must not be misreported as an auth failure.
  const other400 = new FirmsRequestError('HTTP 400', 'http', false, 400, { responseText: 'bad coordinates' });
  assert.match(classifyFailures([other400]).message, /temporarily unavailable/i);
});

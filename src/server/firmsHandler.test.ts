/**
 * Handler tests: a real Express app + the real handler, with a MOCKED fetch (NASA is never called).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { createFiresHandler, type FiresHandlerDeps } from './firmsHandler';
import { RateBudget } from '../utils/firms';

const KEY = 'TESTKEY_abc123';

function viirsCsv(n: number, frpStart = 1): string {
  const rows = ['latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,confidence,version,bright_ti5,frp,daynight'];
  for (let i = 0; i < n; i++) {
    // Generate valid HHMM times: MM=i%60 (0-59), HH cycles through 00-23 then repeats.
    const hh = String(Math.floor(i / 60) % 24).padStart(2, '0');
    const mm = String(i % 60).padStart(2, '0');
    rows.push(`${10 + i * 0.01},${20 + i * 0.01},340,0.4,0.4,2026-11-03,${hh}${mm},N20,n,2.0NRT,300,${frpStart + i},D`);
  }
  return rows.join('\n');
}
function modisCsv(n: number): string {
  const rows = ['latitude,longitude,brightness,scan,track,acq_date,acq_time,satellite,confidence,version,bright_t31,frp,daynight'];
  for (let i = 0; i < n; i++) {
    rows.push(`${30 + i * 0.01},${40 + i * 0.01},330,1,1,2026-11-03,${String(900 + i).padStart(4, '0')},Terra,80,6.1NRT,300,${5 + i},D`);
  }
  return rows.join('\n');
}

interface Harness {
  url: string;
  calls: string[];
  logs: string[];
  close: () => Promise<void>;
}

async function start(
  fetchImpl: typeof fetch,
  overrides: Partial<FiresHandlerDeps> = {}
): Promise<Harness> {
  const calls: string[] = [];
  const logs: string[] = [];
  const logger = {
    info: (m: string) => logs.push(m),
    warn: (m: string) => logs.push(m),
    error: (m: string) => logs.push(m),
  };
  const wrapped = (async (input: unknown, init?: RequestInit) => {
    calls.push(String(input));
    return fetchImpl(input as string, init);
  }) as typeof fetch;

  const app = express();
  app.get(
    '/api/v1/fires',
    createFiresHandler({
      getKey: () => KEY,
      getBaseUrl: () => 'https://mock.firms.test',
      fetchImpl: wrapped,
      sleep: async () => {},
      baseDelayMs: 1,
      logger,
      ...overrides,
    })
  );
  const server = await new Promise<import('node:http').Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/api/v1/fires`,
    calls,
    logs,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

const okFetch: typeof fetch = (async (input: unknown) => {
  const url = String(input);
  if (url.includes('MODIS_NRT')) return new Response(modisCsv(3), { status: 200 });
  if (url.includes('NOAA20')) return new Response(viirsCsv(2), { status: 200 });
  return new Response(viirsCsv(4, 50), { status: 200 });
}) as typeof fetch;

test('success: aggregates three sources, keeps sensors separate, builds the NASA URL with the key', async () => {
  const h = await start(okFetch);
  try {
    const r = await fetch(`${h.url}?area=88,20,93,27&days=2`);
    const body = await r.json();
    assert.equal(r.status, 200);
    assert.equal(body.total, 9);
    assert.deepEqual(body.counts, { MODIS: 3, VIIRS: 6 });
    assert.equal(body.cached, false);
    assert.equal(body.errors.length, 0);
    assert.equal(body.days, 2);
    assert.ok(Date.parse(body.retrieved_at) > 0);
    assert.equal(h.calls.length, 3);
    assert.ok(h.calls.every((u) => u.startsWith(`https://mock.firms.test/api/area/csv/${KEY}/`)));
    assert.ok(h.calls.every((u) => u.endsWith('/88,20,93,27/2')));
    assert.deepEqual(
      h.calls.map((u) => u.split('/')[7]).sort(),
      ['MODIS_NRT', 'VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT']
    );
    for (const o of body.observations) assert.ok(o.sensor === 'MODIS' || o.sensor === 'VIIRS');
  } finally {
    await h.close();
  }
});

test('cache: identical request is served from cache (no new upstream calls), flagged cached:true', async () => {
  const h = await start(okFetch);
  try {
    await (await fetch(`${h.url}?area=1,2,3,4&days=1`)).json();
    assert.equal(h.calls.length, 3);
    const second = await (await fetch(`${h.url}?area=1,2,3,4&days=1`)).json();
    assert.equal(h.calls.length, 3);
    assert.equal(second.cached, true);
    assert.equal(second.total, 9);
    // different days => different cache entry
    await (await fetch(`${h.url}?area=1,2,3,4&days=3`)).json();
    assert.equal(h.calls.length, 6);
  } finally {
    await h.close();
  }
});

test('cache entries expire after 30 minutes', async () => {
  let t = 1_000_000;
  const h = await start(okFetch, { now: () => t });
  try {
    await (await fetch(`${h.url}?area=1,2,3,4&days=1`)).json();
    t += 29 * 60_000;
    assert.equal((await (await fetch(`${h.url}?area=1,2,3,4&days=1`)).json()).cached, true);
    t += 2 * 60_000;
    const fresh = await (await fetch(`${h.url}?area=1,2,3,4&days=1`)).json();
    assert.equal(fresh.cached, false);
    assert.equal(h.calls.length, 6);
  } finally {
    await h.close();
  }
});

test('concurrent identical requests share one upstream round-trip', async () => {
  const h = await start((async (input: unknown) => {
    await new Promise((r) => setTimeout(r, 30));
    return okFetch(input as string);
  }) as typeof fetch);
  try {
    const [a, b] = await Promise.all([fetch(`${h.url}?area=5,5,9,9`), fetch(`${h.url}?area=5,5,9,9`)]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(h.calls.length, 3);
  } finally {
    await h.close();
  }
});

test('per-source cap keeps the highest-FRP detections and sets truncated', async () => {
  const h = await start((async (input: unknown) => {
    if (String(input).includes('MODIS_NRT')) return new Response(modisCsv(2), { status: 200 });
    return new Response(viirsCsv(1500), { status: 200 });
  }) as typeof fetch);
  try {
    const body = await (await fetch(`${h.url}?area=1,2,3,4&cap=1000`)).json();
    assert.equal(body.truncated, true);
    assert.equal(body.counts.VIIRS, 2000); // 2 VIIRS sources x cap 1000
    assert.equal(body.counts.MODIS, 2);
    const minViirsFrp = Math.min(...body.observations.filter((o: { sensor: string }) => o.sensor === 'VIIRS').map((o: { frp_mw: number }) => o.frp_mw));
    assert.ok(minViirsFrp >= 500, `weakest 500 should have been dropped, min=${minViirsFrp}`);
  } finally {
    await h.close();
  }
});

test('retry: transient "fetch failed" on one source is retried and the request still succeeds', async () => {
  let modisAttempts = 0;
  const h = await start((async (input: unknown) => {
    if (String(input).includes('MODIS_NRT')) {
      modisAttempts++;
      if (modisAttempts < 3) throw new TypeError('fetch failed', { cause: new Error('read ECONNRESET') });
    }
    return okFetch(input as string);
  }) as typeof fetch);
  try {
    const body = await (await fetch(`${h.url}?area=1,2,3,4`)).json();
    assert.equal(modisAttempts, 3);
    assert.equal(body.errors.length, 0);
    assert.equal(body.counts.MODIS, 3);
  } finally {
    await h.close();
  }
});

test('all sources down: 502, friendly message, err.cause logged server-side, key never leaks', async () => {
  const h = await start((async (input: unknown) => {
    throw new TypeError('fetch failed', {
      cause: Object.assign(new Error(`connect ECONNREFUSED while requesting ${String(input)}`), { code: 'ECONNREFUSED' }),
    });
  }) as typeof fetch);
  try {
    const r = await fetch(`${h.url}?area=1,2,3,4`);
    const text = await r.text();
    assert.equal(r.status, 502);
    const body = JSON.parse(text);
    assert.match(body.error, /Could not reach NASA FIRMS/);
    assert.equal(body.errors.length, 3);
    assert.equal(text.includes(KEY), false, 'key must not appear in the response');
    const logText = h.logs.join('\n');
    assert.match(logText, /ECONNREFUSED/, 'cause must be logged');
    assert.equal(logText.includes(KEY), false, 'key must not appear in logs');
  } finally {
    await h.close();
  }
});

test('failed result is not cached (next request retries upstream)', async () => {
  let fail = true;
  const h = await start((async (input: unknown) => {
    if (fail) return new Response('down', { status: 503 });
    return okFetch(input as string);
  }) as typeof fetch);
  try {
    assert.equal((await fetch(`${h.url}?area=1,2,3,4`)).status, 502);
    fail = false;
    const r = await fetch(`${h.url}?area=1,2,3,4`);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).cached, false);
  } finally {
    await h.close();
  }
});

test('partial failure: 200 with the good sources, error listed (masked), and NOT cached', async () => {
  let breakModis = true;
  const h = await start((async (input: unknown) => {
    if (breakModis && String(input).includes('MODIS_NRT')) return new Response('oops', { status: 500 });
    return okFetch(input as string);
  }) as typeof fetch);
  try {
    const first = await (await fetch(`${h.url}?area=1,2,3,4`)).json();
    assert.equal(first.counts.MODIS, 0);
    assert.equal(first.counts.VIIRS, 6);
    assert.deepEqual(first.errors, ['MODIS_NRT: HTTP 500']);
    breakModis = false;
    const second = await (await fetch(`${h.url}?area=1,2,3,4`)).json();
    assert.equal(second.counts.MODIS, 3);
    assert.equal(second.cached, false);
  } finally {
    await h.close();
  }
});

test('HTTP 400 Invalid MAP_KEY is reported as a rejected key, not a transient outage', async () => {
  const h = await start((async () => new Response('Invalid MAP_KEY.', { status: 400 })) as typeof fetch);
  try {
    const r = await fetch(`${h.url}?area=1,2,3,4`);
    assert.equal(r.status, 502);
    const body = await r.json();
    assert.match(body.error, /rejected the server key/i);
    assert.match(body.error, /FIRMS_MAP_KEY/);
    assert.equal(body.errors.length, 3);
    assert.ok(body.errors.every((e: string) => e.endsWith('HTTP 400')), JSON.stringify(body.errors));
  } finally {
    await h.close();
  }
});

test('FIRMS plain-text error (HTTP 200) is surfaced as a friendly rate-limit message', async () => {
  const h = await start((async () => new Response('Exceeded transaction limit for this MAP_KEY', { status: 200 })) as typeof fetch);
  try {
    const r = await fetch(`${h.url}?area=1,2,3,4`);
    assert.equal(r.status, 429);
    assert.match((await r.json()).error, /rate limit/i);
  } finally {
    await h.close();
  }
});

test('local rate budget: refuses without calling NASA once exhausted, with Retry-After', async () => {
  const budget = new RateBudget(6, 600_000);
  const h = await start(okFetch, { budget });
  try {
    assert.equal((await fetch(`${h.url}?area=1,2,3,4&days=2`)).status, 200); // uses 6
    assert.equal(h.calls.length, 3);
    const r = await fetch(`${h.url}?area=5,6,7,8&days=1`);
    assert.equal(r.status, 429);
    assert.ok(Number(r.headers.get('retry-after')) >= 1);
    assert.equal(h.calls.length, 3);
  } finally {
    await h.close();
  }
});

test('validation: bad format, bad ranges -> 400 (no upstream call); missing key -> 503', async () => {
  const h = await start(okFetch);
  try {
    for (const area of ['abc', '1,2,3', '-181,0,5,5', '10,0,5,5', '1,2,3,4,5', '../x']) {
      const r = await fetch(`${h.url}?area=${encodeURIComponent(area)}`);
      assert.equal(r.status, 400, area);
    }
    assert.equal(h.calls.length, 0);
  } finally {
    await h.close();
  }

  const h2 = await start(okFetch, { getKey: () => undefined });
  try {
    const r = await fetch(`${h2.url}?area=1,2,3,4`);
    assert.equal(r.status, 503);
    const body = await r.json();
    assert.equal(body.code, 'FIRMS_KEY_NOT_CONFIGURED');
    assert.match(body.error, /FIRMS_MAP_KEY/);
    assert.equal(h2.calls.length, 0);
  } finally {
    await h2.close();
  }
});

test('days is clamped to 1..5', async () => {
  const h = await start(okFetch);
  try {
    await (await fetch(`${h.url}?area=1,2,3,4&days=99`)).json();
    assert.ok(h.calls.every((u) => u.endsWith('/5')));
    await (await fetch(`${h.url}?area=2,3,4,5&days=0`)).json();
    assert.ok(h.calls.slice(3).every((u) => u.endsWith('/1')));
  } finally {
    await h.close();
  }
});

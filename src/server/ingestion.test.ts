/**
 * Ingestion tests: real request validation, real download state machine, retries, checksums,
 * raw-file preservation and honest failure. NASA is never called; fetch is stubbed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { IngestionService, validateIngestionRequest } from './ingestion';
import { MemoryObservationStore } from './store';
import type { IngestionJob } from '../types/fire';

const KEY = 'SECRET_MAP_KEY_123';

function modisCsv(rows = 2): string {
  const header =
    'latitude,longitude,brightness,scan,track,acq_date,acq_time,satellite,confidence,version,bright_t31,frp,daynight';
  const lines = [header];
  for (let i = 0; i < rows; i++) {
    lines.push(
      `22.${100 + i},90.${100 + i},330,1,1,2026-11-03,${String(1000 + i).padStart(4, '0')},Terra,80,6.1NRT,300,${5 + i},D`
    );
  }
  return lines.join('\n');
}

function viirsCsv(rows = 1): string {
  const header =
    'latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,confidence,version,bright_ti5,frp,daynight';
  const lines = [header];
  for (let i = 0; i < rows; i++) {
    lines.push(
      `22.${200 + i},90.${200 + i},340,0.4,0.4,2026-11-03,${String(1100 + i).padStart(4, '0')},N20,n,2.0NRT,300,${8 + i},D`
    );
  }
  return lines.join('\n');
}

interface Harness {
  service: IngestionService;
  store: MemoryObservationStore;
  files: Map<string, string>;
  dirs: string[];
  fetchCalls: string[];
}

function harness(fetchImpl: typeof fetch, key: string | undefined = KEY): Harness {
  const store = new MemoryObservationStore();
  const files = new Map<string, string>();
  const dirs: string[] = [];
  const fetchCalls: string[] = [];
  const wrapped = (async (input: unknown, init?: RequestInit) => {
    fetchCalls.push(String(input));
    return fetchImpl(input as string, init);
  }) as typeof fetch;

  const service = new IngestionService({
    store,
    getKey: () => key,
    getBaseUrl: () => 'https://mock.firms.test',
    fetchImpl: wrapped,
    now: () => new Date('2026-11-03T12:00:00Z'),
    dataDir: 'test-data',
    mkdir: (path) => dirs.push(path),
    writeFile: (path, data) => files.set(path, data),
  });
  return { service, store, files, dirs, fetchCalls };
}

async function waitForTerminal(store: MemoryObservationStore, id: string, timeoutMs = 5000): Promise<IngestionJob> {
  const started = Date.now();
  for (;;) {
    const job = store.getJob(id);
    if (job && ['completed', 'failed', 'cancelled'].includes(job.status)) return job;
    if (Date.now() - started > timeoutMs) throw new Error(`Job ${id} did not finish in time.`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const okFetch: typeof fetch = (async (input: unknown) => {
  const url = String(input);
  if (url.includes('/MODIS_NRT/')) return new Response(modisCsv(2), { status: 200 });
  if (url.includes('/VIIRS_NOAA20_NRT/')) return new Response(viirsCsv(1), { status: 200 });
  if (url.includes('/VIIRS_NOAA21_NRT/')) return new Response(viirsCsv(1), { status: 200 });
  return new Response('unexpected product', { status: 500 });
}) as typeof fetch;

test('validateIngestionRequest enforces the documented Area API limits', () => {
  assert.equal(validateIngestionRequest({ bbox: '90,22,91,23', day_range: 3 }).ok, true);
  assert.equal(validateIngestionRequest({ bbox: '90,22,91,23', day_range: 1, date: '2026-11-01' }).ok, true);
  assert.equal(validateIngestionRequest({ bbox: '90,22,91,23', day_range: 6 }).ok, false);
  assert.equal(validateIngestionRequest({ bbox: '90,22,91,23', day_range: 0 }).ok, false);
  assert.equal(validateIngestionRequest({ bbox: '91,22,90,23', day_range: 3 }).ok, false);
  assert.equal(validateIngestionRequest({ bbox: '90,22,91,23', day_range: 3, date: '2026-02-30' }).ok, false);
  assert.equal(
    validateIngestionRequest({ bbox: '90,22,91,23', day_range: 3, products: ['VIIRS_SNPP_NRT'] }).ok,
    false
  );
  assert.equal(validateIngestionRequest({ bbox: '90,22,91,23', day_range: 3, products: ['MODIS_NRT'] }).ok, true);
});

test('a successful job imports real records, writes raw files and a manifest with SHA-256', async (t) => {
  const h = harness(okFetch);
  const job = h.service.start({ bbox: '90,22,91,23', day_range: 3, products: ['MODIS_NRT', 'VIIRS_NOAA20_NRT'] });
  const done = await waitForTerminal(h.store, job.id);

  assert.equal(done.status, 'completed');
  assert.equal(done.records_imported, 3);
  assert.match(done.checksum ?? '', /^[0-9a-f]{64}$/);
  assert.equal(done.provenance_status, 'VERIFIED');
  assert.equal(h.store.getObservations().length, 3);

  const rawFiles = [...h.files.keys()].filter((p) => p.includes('raw'));
  assert.equal(rawFiles.length, 2, 'one preserved raw CSV per product');
  assert.ok(rawFiles.some((p) => p.includes('MODIS_NRT')));
  assert.ok(rawFiles.some((p) => p.includes('VIIRS_NOAA20_NRT')));

  const manifestPath = [...h.files.keys()].find((p) => p.endsWith('source_manifest.json'));
  assert.ok(manifestPath, 'source manifest written');
  const manifest = JSON.parse(h.files.get(manifestPath!)!);
  assert.equal(manifest.records_added, 3);
  assert.equal(manifest.duplicate_records, 0);
  assert.match(manifest.note, /integrity, not NASA authenticity/i);
  assert.ok(!JSON.stringify(manifest).includes('latitude,longitude'), 'raw CSV text is not embedded in the manifest');

  const checksumsPath = [...h.files.keys()].find((p) => p.endsWith('checksums.json'));
  assert.ok(checksumsPath);
  const checksums = JSON.parse(h.files.get(checksumsPath!)!);
  assert.equal(checksums.files.length, 2);
  for (const file of checksums.files) assert.match(file.sha256, /^[0-9a-f]{64}$/);

  // The durable log must describe the terminal job, not the earlier `running` snapshot.
  const logPath = [...h.files.keys()].find((p) => p.endsWith('ingestion_log.json'));
  assert.ok(logPath, 'ingestion log written');
  const log = JSON.parse(h.files.get(logPath!)!);
  assert.equal(log.job.status, 'completed');
  assert.equal(log.job.records_imported, 3);
  assert.equal(log.job.checksum, done.checksum);
  assert.equal(log.job.provenance_status, 'VERIFIED');
});

test('running the same download twice adds zero duplicate records but still reports the real execution', async (t) => {
  const h = harness(okFetch);
  const request = { bbox: '90,22,91,23', day_range: 3, products: ['MODIS_NRT'] };

  const first = await waitForTerminal(h.store, h.service.start(request).id);
  assert.equal(first.records_imported, 2);

  const second = await waitForTerminal(h.store, h.service.start(request).id);
  assert.equal(second.status, 'completed');
  assert.equal(second.records_imported, 0, 'nothing new was added');
  assert.equal(h.store.getObservations().length, 2);

  const manifestPath = [...h.files.keys()].find((p) => p.endsWith('source_manifest.json'));
  const manifest = JSON.parse(h.files.get(manifestPath!)!);
  assert.equal(manifest.duplicate_records, 2);
});

test('a missing key fails the job; no record count or checksum is invented', async (t) => {
  // Empty string, not undefined: an explicit `undefined` argument would trigger the default KEY.
  const h = harness(okFetch, '');
  const job = h.service.start({ bbox: '90,22,91,23', day_range: 3 });
  const done = await waitForTerminal(h.store, job.id);

  assert.equal(done.status, 'failed');
  assert.equal(done.records_imported, 0);
  assert.equal(done.checksum, null);
  assert.match(done.error_message ?? '', /FIRMS_MAP_KEY is not configured/);
  assert.equal(h.store.getObservations().length, 0);
});

test('all downloads failing marks the job failed and masks the key in the error', async (t) => {
  const failing: typeof fetch = (async () =>
    new Response(`bad MAP_KEY ${KEY}`, { status: 401 })) as typeof fetch;
  const h = harness(failing);
  const job = h.service.start({ bbox: '90,22,91,23', day_range: 1, products: ['MODIS_NRT'] });
  const done = await waitForTerminal(h.store, job.id);

  assert.equal(done.status, 'failed');
  assert.equal(done.records_imported, 0);
  assert.equal(done.checksum, null);
  assert.ok(done.error_message?.includes('401'));
  assert.ok(!done.error_message?.includes(KEY), 'the MAP_KEY never appears in an error');
  assert.ok(done.error_message?.includes('***'));
  assert.equal(h.store.getObservations().length, 0);
});

test('partial success is completed with the real count and an explicit partial-success error', async (t) => {
  const partial: typeof fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.includes('/MODIS_NRT/')) return new Response(modisCsv(1), { status: 200 });
    return new Response('service unavailable', { status: 503 });
  }) as typeof fetch;
  const h = harness(partial);
  const job = h.service.start({ bbox: '90,22,91,23', day_range: 2, products: ['MODIS_NRT', 'VIIRS_NOAA20_NRT'] });
  const done = await waitForTerminal(h.store, job.id);

  assert.equal(done.status, 'completed');
  assert.equal(done.records_imported, 1);
  assert.match(done.error_message ?? '', /Partial success/i);
  assert.match(done.error_message ?? '', /VIIRS_NOAA20_NRT/);
  assert.match(done.checksum ?? '', /^[0-9a-f]{64}$/);
});

test('a non-CSV response is a failure, not an empty success', async (t) => {
  const html: typeof fetch = (async () => new Response('<html>rate limited</html>', { status: 200 })) as typeof fetch;
  const h = harness(html);
  const job = h.service.start({ bbox: '90,22,91,23', day_range: 1, products: ['MODIS_NRT'] });
  const done = await waitForTerminal(h.store, job.id);

  assert.equal(done.status, 'failed');
  assert.equal(done.records_imported, 0);
  assert.match(done.error_message ?? '', /no CSV header/i);
});

test('the ingestion request URL contains the key but the job record and errors do not', async (t) => {
  const h = harness(okFetch);
  const job = h.service.start({ bbox: '90,22,91,23', day_range: 1, products: ['MODIS_NRT'] });
  const done = await waitForTerminal(h.store, job.id);

  assert.ok(h.fetchCalls.some((u) => u.includes(KEY)));
  assert.ok(!JSON.stringify(done).includes(KEY), 'the job record never stores the key');
});

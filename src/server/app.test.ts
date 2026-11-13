/**
 * Express application integration tests.
 *
 * A real app is started on an ephemeral port and queried over HTTP. The store is a controlled
 * in-memory fixture, so no NASA endpoint is called and no external data is needed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from './app';
import { MemoryObservationStore } from './store';
import type { CanonicalObservation } from '../types/fire';
import { liveObservationQuery } from '../api/client';

const AOI = '90,22;91,22;90,23';
const BBOX = '90,22,91,23';

function observation(
  partial: Partial<CanonicalObservation> & Pick<CanonicalObservation, 'id' | 'sensor'>
): CanonicalObservation {
  const { id, sensor, ...rest } = partial;
  return {
    id,
    sensor,
    source_record_id: id,
    latitude: 22.1,
    longitude: 90.1,
    acq_date: '2024-03-15',
    acq_time: '1010',
    datetime_utc: '2024-03-15T10:10:00Z',
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
    retrieved_at: '2024-03-20T00:00:00Z',
    quality_flags: 'fixture',
    record_hash: 'fixture-hash',
    provenance_status: 'UNVERIFIED',
    ...rest,
  };
}

const FIXTURES: CanonicalObservation[] = [
  // Same 1-km cell: the only paired cell (MODIS 1, VIIRS 1).
  observation({ id: 'modis-in', sensor: 'MODIS', source_record_id: '=EVIL()', latitude: 22.1, longitude: 90.1 }),
  observation({ id: 'viirs-in', sensor: 'VIIRS', latitude: 22.1, longitude: 90.1, acq_time: '1015' }),
  // Inside the bbox but OUTSIDE the triangular AOI (x + y > 113).
  observation({ id: 'modis-bbox-only', sensor: 'MODIS', latitude: 22.9, longitude: 90.9 }),
  // Outside both bbox and AOI.
  observation({
    id: 'viirs-outside',
    sensor: 'VIIRS',
    latitude: 23.5,
    longitude: 91.5,
    acq_date: '2024-03-16',
    datetime_utc: '2024-03-16T10:10:00Z',
  }),
];

interface Harness {
  base: string;
  close: () => Promise<void>;
}

async function start(env: NodeJS.ProcessEnv = {}): Promise<Harness> {
  const { app } = createApp({
    store: new MemoryObservationStore(FIXTURES),
    env,
    now: () => new Date('2024-03-20T00:00:00Z'),
    enableLiveFires: false,
  });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function url(base: string, path: string, params: Record<string, string> = {}): string {
  const q = new URLSearchParams(params).toString();
  return `${base}${path}${q ? `?${q}` : ''}`;
}

test('health is truthful about storage, provenance, FIRMS and calibration', async (t) => {
  const h = await start();
  t.after(h.close);

  const res = await fetch(url(h.base, '/api/v1/health'));
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.database.storage_type, 'memory');
  assert.equal(body.database.durable, false);
  assert.equal(body.database.postgis_active, false);
  assert.equal(body.firms_integration.api_configured, false);
  assert.equal(body.provenance.local_store_status, 'UNVERIFIED');
  assert.equal(body.provenance.raw_source_files_present, false);
  assert.match(body.provenance.reason, /UNVERIFIED|verified/i);
  assert.match(body.provenance.checksum_note, /integrity/i);
  assert.equal(body.calibration.status, 'INSUFFICIENT');
  assert.equal(body.calibration.harmonization_status, 'EXPLORATORY');
  assert.match(body.calibration.note, /not a validated/i);
});

test('data availability separates MODIS and VIIRS and reports the local store honestly', async (t) => {
  const h = await start();
  t.after(h.close);

  const body = await (await fetch(url(h.base, '/api/v1/data-availability'))).json();
  assert.equal(body.local_store.total_records, 4);
  assert.equal(body.local_store.modis_count, 2);
  assert.equal(body.local_store.viirs_count, 2);
  assert.equal(body.local_store.provenance_status, 'UNVERIFIED');
  assert.equal(body.local_store.data_status, 'locally_ingested_records');
  assert.equal(body.live_nrt.available, false);
  assert.equal(body.live_nrt.max_days, 5);
  assert.equal(body.storage.kind, 'memory');
  assert.equal(body.calibration_status, 'INSUFFICIENT');
  assert.match(body.calibration_note, /not fitted/i);
  assert.ok(body.official_nasa_firms.products.some((p: { product: string }) => p.product === 'MODIS_NRT'));
});

test('bbox is only a prefilter: the AOI polygon removes points inside the box but outside the triangle', async (t) => {
  const h = await start();
  t.after(h.close);

  const bboxOnly = await (await fetch(url(h.base, '/api/v1/hotspots', { bbox: BBOX, limit: '50' }))).json();
  assert.equal(bboxOnly.total, 3, 'three fixture points fall inside the bbox');

  const withAoi = await (
    await fetch(url(h.base, '/api/v1/hotspots', { bbox: BBOX, aoi: AOI, limit: '50' }))
  ).json();
  assert.equal(withAoi.total, 2, 'the AOI point-in-polygon test removes the bbox-only point');
  assert.deepEqual(
    withAoi.observations.map((o: { id: string }) => o.id).sort(),
    ['modis-in', 'viirs-in']
  );
  assert.equal(withAoi.filters_applied.aoi_vertices, 3);
  assert.equal(withAoi.filters_applied.bbox.west, 90);
});

test('an invalid AOI is rejected instead of silently ignored', async (t) => {
  const h = await start();
  t.after(h.close);

  const res = await fetch(url(h.base, '/api/v1/hotspots', { aoi: '90,22;91,22' }));
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /Invalid AOI/i);
});

test('calendar returns observed days only and never zero-fills a missing date', async (t) => {
  const h = await start();
  t.after(h.close);

  const body = await (
    await fetch(
      url(h.base, '/api/v1/calendar', {
        start_date: '2024-03-14',
        end_date: '2024-03-17',
        bbox: BBOX,
        aoi: AOI,
      })
    )
  ).json();

  assert.equal(body.coverage_status, 'observed_days_only');
  assert.equal(body.observed_days, 1);
  assert.equal(body.missing_days, null);
  assert.equal(body.daily_summaries.length, 1);
  assert.equal(body.daily_summaries[0].date, '2024-03-15');
  assert.equal(body.daily_summaries[0].coverage_status, 'observed');
  assert.match(body.coverage_note, /NOT zero-fire/i);
});

test('calibration stays INSUFFICIENT with null R² when the only paired cell has no reference variance', async (t) => {
  const h = await start();
  t.after(h.close);

  const body = await (
    await fetch(url(h.base, '/api/v1/analytics/calibration', { bbox: BBOX, aoi: AOI }))
  ).json();

  assert.equal(body.sample_size_paired_cells, 1);
  assert.equal(body.status, 'INSUFFICIENT');
  assert.equal(body.r_squared, null);
  assert.equal(body.independent_validation, false);
  assert.equal(body.fixed_exploratory_factor, 0.294);
  assert.ok(body.limitations.some((l: string) => /zero/i.test(l)));
});

test('sensor comparison exposes real paired cells and no invented metrics', async (t) => {
  const h = await start();
  t.after(h.close);

  const body = await (
    await fetch(url(h.base, '/api/v1/analytics/sensors', { bbox: BBOX, aoi: AOI }))
  ).json();

  assert.equal(body.comparison.modis_total_detections, 1);
  assert.equal(body.comparison.viirs_total_detections, 1);
  assert.equal(body.comparison.paired_1km_cells_count, 1);
  assert.equal(body.comparison.paired_cells.length, 1);
  assert.equal(body.comparison.paired_cells[0].modis_count, 1);
  assert.equal(body.comparison.paired_cells[0].viirs_count, 1);
  assert.equal(body.comparison.calibration_status, 'INSUFFICIENT');
  assert.equal(body.comparison.calibration_metrics.r_squared, null);
});

test('shared UI filters preserve count parity, inclusive dates and empty CSV results across endpoints', async (t) => {
  const h = await start();
  t.after(h.close);
  const query = { ...liveObservationQuery({ startDate: '2024-03-15', endDate: '2024-03-16', satellite: 'Terra', minFRP: 10, minConfidence: 80 }, { bbox: BBOX, aoi: AOI }, '2024-03-16'), source: 'store' };
  const requestUrl = (route: string, params: Record<string, string | number | undefined> = query) => url(h.base, route,
    Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)])));
  const get = async (route: string, params: Record<string, string | number | undefined> = query) => {
    const response = await fetch(requestUrl(route, params));
    assert.equal(response.status, 200, route);
    return response.json();
  };
  const summary = await get('/api/v1/analytics/summary');
  const calendar = await get('/api/v1/calendar');
  const sensors = await get('/api/v1/analytics/sensors');
  assert.equal(summary.kpis.total_modis_detections, 1);
  assert.equal(summary.kpis.total_viirs_detections, 0);
  assert.equal(calendar.daily_summaries[0].modis_detections, 1);
  assert.equal(calendar.daily_summaries[0].viirs_detections, 0);
  assert.equal(sensors.comparison.modis_total_detections, 1);
  assert.equal(sensors.comparison.viirs_total_detections, 0);
  const none = { ...query, min_frp: 11 };
  assert.equal((await get('/api/v1/analytics/summary', none)).kpis.total_modis_detections, 0);
  assert.deepEqual((await get('/api/v1/calendar', none)).daily_summaries, []);
  const csv = await (await fetch(requestUrl('/api/v1/export/calendar.csv', none))).text();
  assert.equal(csv.split(/\r?\n/).filter((line) => line && !line.startsWith('#')).length, 1, 'successful empty export has its header, not an unfiltered day');
  const inclusive = await get('/api/v1/calendar', { ...query, bbox: '90,22,92,24', aoi: undefined, satellites: undefined, min_confidence: undefined });
  assert.ok(inclusive.daily_summaries.some((day: { date: string }) => day.date === '2024-03-16'), 'the end date remains inclusive');
});

test('per-sensor CSV export contains metadata, only that sensor, and formula sanitization', async (t) => {
  const h = await start();
  t.after(h.close);

  const res = await fetch(
    url(h.base, '/api/v1/export/csv', { dataset: 'modis', bbox: BBOX, aoi: AOI, start_date: '2024-03-15' })
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/csv/);
  const csv = await res.text();

  assert.ok(csv.startsWith('# FireSync export metadata'));
  assert.ok(csv.includes('# data_source,store'));
  assert.ok(csv.includes('# provenance_status,UNVERIFIED'));
  assert.ok(!csv.includes('archive_provenance'));
  assert.ok(csv.includes('# harmonization_status,EXPLORATORY'));
  assert.ok(csv.includes('# calibration_status,INSUFFICIENT'));
  assert.ok(csv.includes('# aoi_geometry,'));
  assert.ok(csv.includes("'=EVIL()"), 'CSV formula injection is neutralised');
  assert.ok(csv.includes(',MODIS,'), 'the MODIS row is present');
  assert.ok(!csv.includes(',VIIRS,'), 'the VIIRS row is never mixed into a MODIS export');

  const dataLines = csv.split('\r\n').filter((line) => line && !line.startsWith('#'));
  assert.equal(dataLines.length, 2, 'header + one MODIS observation');
});

test('provenance export states that checksums prove integrity, not NASA authenticity', async (t) => {
  const h = await start();
  t.after(h.close);

  const csv = await (await fetch(url(h.base, '/api/v1/export/provenance.csv'))).text();
  assert.ok(csv.includes('checksum_note'));
  assert.ok(csv.includes('integrity'));
  assert.ok(csv.includes('not NASA authenticity'));
});

test('ingestion is disabled honestly when FIRMS_MAP_KEY is absent', async (t) => {
  const h = await start();
  t.after(h.close);

  const trigger = await fetch(url(h.base, '/api/v1/ingestion/trigger'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bbox: BBOX, day_range: 3, products: ['MODIS_NRT'] }),
  });
  assert.equal(trigger.status, 503);
  const body = await trigger.json();
  assert.equal(body.code, 'FIRMS_KEY_NOT_CONFIGURED');

  const keyTest = await fetch(url(h.base, '/api/v1/ingestion/test-key'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(keyTest.status, 400);
  assert.equal((await keyTest.json()).valid, false);

  const jobs = await (await fetch(url(h.base, '/api/v1/ingestion/jobs'))).json();
  assert.equal(jobs.total_jobs, 0);
  assert.match(jobs.note, /No seed or placeholder jobs/i);
});

test('invalid ingestion requests are rejected before any job exists', async (t) => {
  const h = await start({ FIRMS_MAP_KEY: 'SERVER_ONLY_KEY' });
  t.after(h.close);

  for (const payload of [
    { bbox: '90,22,91', day_range: 3 },
    { bbox: '90,22,91,23', day_range: 30 },
    { bbox: '90,22,91,23', day_range: 3, products: ['VIIRS_SNPP_NRT'] },
    { bbox: '90,22,91,23', day_range: 3, date: '2024-02-31' },
  ]) {
    const res = await fetch(url(h.base, '/api/v1/ingestion/trigger'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    assert.equal(res.status, 400, JSON.stringify(payload));
  }

  const jobs = await (await fetch(url(h.base, '/api/v1/ingestion/jobs'))).json();
  assert.equal(jobs.total_jobs, 0);
});

test('unknown endpoints and unknown jobs return real 404s', async (t) => {
  const h = await start();
  t.after(h.close);

  const unknownJob = await fetch(url(h.base, '/api/v1/ingestion/jobs/job-does-not-exist'));
  assert.equal(unknownJob.status, 404);
  assert.match((await unknownJob.json()).error, /not found/i);

  const unknownApi = await fetch(url(h.base, '/api/v1/does-not-exist'));
  assert.equal(unknownApi.status, 404);
  assert.match((await unknownApi.json()).error, /not found/i);
});

test('unbundled geographic datasets return available:false with a reason', async (t) => {
  const h = await start();
  t.after(h.close);

  const cases: Array<[string, string]> = [
    ['/api/v1/geo/landcover', 'landcover'],
    ['/api/v1/geo/terrain', 'terrain'],
    ['/api/v1/geo/population', 'population'],
    ['/api/v1/geo/cross-border', 'admin_boundaries'],
  ];
  for (const [path, id] of cases) {
    const res = await fetch(url(h.base, path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bbox: BBOX, days: 1 }),
    });
    assert.equal(res.status, 200, path);
    const body = await res.json();
    assert.equal(body.available, false, path);
    assert.equal(body.dataset.id, id, path);
    assert.equal(body.dataset.configured, false, path);
    assert.equal(body.expected_resolution, body.dataset.resolution, path);
    assert.ok(typeof body.reason === 'string' && body.reason.length > 0, path);
    assert.match(body.note, /unavailable/i, path);
    assert.equal(body.features, undefined, path);
  }
});

test('cluster route keeps the sensor filter and window metadata for overlays', async (t) => {
  const h = await start();
  t.after(h.close);

  const res = await fetch(url(h.base, '/api/v1/geo/clusters'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bbox: '90,22,92,24', days: 5, sensors: 'VIIRS' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.sensors, 'VIIRS');
  assert.equal(body.window.days, 5);
  assert.equal(body.bbox, '90,22,92,24');
  assert.ok(Array.isArray(body.clusters.clusters));
  for (const cluster of body.clusters.clusters) {
    assert.equal(cluster.by_sensor.MODIS, 0);
    assert.ok(cluster.by_sensor.VIIRS >= 1);
  }
  assert.equal(body.source.data_source, 'store');
});

test('density route returns window, sensor filter and per-sensor cells for overlays', async (t) => {
  const h = await start();
  t.after(h.close);

  const res = await fetch(url(h.base, '/api/v1/geo/density'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bbox: '90,22,92,24', days: 5, sensors: 'VIIRS' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.window.days, 5);
  assert.equal(body.sensors, 'VIIRS');
  assert.equal(body.density.cell_size_km, 1);
  assert.equal(body.density.by_sensor.MODIS, 0);
  assert.equal(body.density.by_sensor.VIIRS, 1);
  assert.ok(body.density.top_cells.length >= 1);
  for (const cell of body.density.top_cells) {
    assert.equal(cell.modis, 0);
    assert.ok(cell.viirs >= 1);
  }
});

test('geo coverage reports single-sensor days and durable ingestion records', async (t) => {
  const h = await start();
  t.after(h.close);

  const res = await fetch(url(h.base, '/api/v1/geo/coverage'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ days: 5 }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.coverage.days));
  assert.equal(typeof body.coverage.single_sensor_days, 'number');
  assert.ok(body.coverage.days.every((d: { single_sensor: boolean }) => typeof d.single_sensor === 'boolean'));
  assert.equal(body.ingestion.storage, 'memory');
  assert.equal(body.ingestion.durable, false);
  assert.ok(Array.isArray(body.ingestion.recent_jobs));
  assert.equal(body.ingestion.job_counts.completed + body.ingestion.job_counts.failed, 0);
  assert.match(body.ingestion.note, /does not prove a coverage gap/i);
});

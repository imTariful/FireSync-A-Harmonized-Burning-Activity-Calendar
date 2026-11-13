/**
 * Fire Event Detective tests.
 *
 * The render tests use server-side markup only, so no browser or network is needed. The client
 * test mocks `fetch` and asserts the bounded request body and the typed response.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { ClusterInvestigationContent } from './IntelligencePanels';
import {
  intelligenceApi,
  type ClusterInvestigationResponse,
  type ClusterSummary,
} from '../../api/intelligence';

const noop = () => undefined;

const CLUSTER: ClusterSummary = {
  id: 'C1',
  label: 'candidate_hotspot_group',
  detection_count: 3,
  by_sensor: { MODIS: 2, VIIRS: 1 },
  centroid: { latitude: 22.1, longitude: 90.1 },
  bbox: { west: 90.05, south: 22.05, east: 90.15, north: 22.15 },
  first_detection_utc: '2026-11-09T06:10:00Z',
  last_detection_utc: '2026-11-10T07:20:00Z',
  duration_hours: 25.2,
  active_days: 2,
  daily_counts: [
    { date: '2026-11-09', MODIS: 1, VIIRS: 0 },
    { date: '2026-11-10', MODIS: 1, VIIRS: 1 },
  ],
  evolution: {
    phase: 'steady',
    recent_24h_detections: 3,
    early_half_detections: 1,
    late_half_detections: 2,
  },
  frp_mw: { MODIS: 42.5, VIIRS: 8.1, mean: 16.9, max: 30 },
  satellites: ['Aqua', 'NOAA-20'],
  active_1km_cells: 3,
  mean_confidence: 65.3,
  notes: [
    'Candidate hotspot group from satellite thermal anomalies; not a confirmed wildfire.',
    'FRP sums stay separate per sensor and are never combined into one fire energy figure.',
  ],
};

const SECOND_CLUSTER: ClusterSummary = {
  ...CLUSTER,
  id: 'C2',
  detection_count: 4,
  by_sensor: { MODIS: 0, VIIRS: 4 },
  centroid: { latitude: 22.3, longitude: 90.3 },
  bbox: { west: 90.25, south: 22.25, east: 90.35, north: 22.35 },
  first_detection_utc: '2026-11-10T05:00:00Z',
  last_detection_utc: '2026-11-10T06:00:00Z',
  duration_hours: 1,
  active_days: 1,
  frp_mw: { MODIS: 0, VIIRS: 20.4, mean: 5.1, max: 9.2 },
  satellites: ['NOAA-21'],
  active_1km_cells: 4,
  mean_confidence: 50,
};

const FIXTURE: ClusterInvestigationResponse = {
  window: { start_date: '2026-11-09', end_date: '2026-11-10', days: 2 },
  area: { bbox: '90,22,91,23' },
  sensors: 'ALL',
  total_clusters: 2,
  analysed_detections: 7,
  cluster: CLUSTER,
  clusters: [CLUSTER, SECOND_CLUSTER],
  report: null,
  ai: { status: 'disabled', model: null, reason: 'AI is disabled on this server.' },
  guardrails: [
    'Satellite thermal anomalies, not confirmed wildfires or burned area.',
    'MODIS and VIIRS detections are reported separately and are never added into one fire count.',
  ],
  notes: [
    'Groups are candidate hotspot clusters of satellite thermal anomalies; they are not confirmed wildfires or fire perimeters.',
    'Link rule: detections within 5 km and 24 h of each other.',
  ],
  source: {
    data_source: 'live',
    provenance_status: 'VERIFIED',
    retrieved_at: '2026-11-10T12:00:00Z',
    source_errors: [],
    truncated: false,
  },
};

const render = (overrides: Partial<React.ComponentProps<typeof ClusterInvestigationContent>> = {}) =>
  renderToString(
    <ClusterInvestigationContent
      data={FIXTURE}
      error={null}
      loading={false}
      selectedId=""
      onSelect={noop}
      onRetry={noop}
      onFocusCluster={noop}
      {...overrides}
    />
  );

test('renders per-sensor counts and deterministic cluster details, never a combined total', () => {
  const html = render();

  assert.match(html, /Fire Event Detective/);
  assert.match(html, /Candidate hotspot group/);
  assert.match(html, /C1/);
  assert.match(html, /data-testid="cluster-modis-count"[^>]*>2</);
  assert.match(html, /data-testid="cluster-viirs-count"[^>]*>1</);
  assert.match(html, /data-testid="cluster-frp-modis"[^>]*>42\.5 MW</);
  assert.match(html, /data-testid="cluster-frp-viirs"[^>]*>8\.1 MW</);
  assert.match(html, /2026-11-09T06:10:00Z/);
  assert.match(html, /2026-11-10T07:20:00Z/);
  assert.match(html, /25\.2 h/);
  assert.match(html, /Active 1 km cells/);
  assert.match(html, /Confidence summary \(derived\)/);
  assert.match(html, /65\.3/);
  assert.match(html, /Focus candidate group C1 on the map/);
  assert.match(html, /not a confirmed fire/);
  assert.match(html, /Satellite thermal anomalies, not confirmed wildfires or burned area\./);

  assert.doesNotMatch(html, /MODIS\s*\+\s*VIIRS/i);
  assert.doesNotMatch(html, /combined (fire )?count/i);
  assert.doesNotMatch(html, /total detections/i);
  assert.doesNotMatch(html, /<td[^>]*>3<\/td>/); // 2 + 1 is never rendered as a total
});

test('an AI report renders when present, and its absence keeps every number', () => {
  const withReport = render({
    data: {
      ...FIXTURE,
      report: 'This candidate group persisted for about a day across two sensors.',
      ai: { status: 'enabled', model: 'openai/gpt-oss-120b', reason: null },
    },
  });
  assert.match(withReport, /AI investigation report/);
  assert.match(withReport, /This candidate group persisted for about a day/);
  assert.match(withReport, /data-testid="cluster-modis-count"[^>]*>2</);
  assert.doesNotMatch(withReport, /AI report unavailable/);

  const unavailable = render();
  assert.match(unavailable, /AI report unavailable: AI is disabled on this server\./);
  assert.match(unavailable, /data-testid="cluster-modis-count"[^>]*>2</);
  assert.match(unavailable, /data-testid="cluster-viirs-count"[^>]*>1</);
});

test('an empty window is stated as missing coverage, not zero fire', () => {
  const html = render({
    data: {
      ...FIXTURE,
      total_clusters: 0,
      analysed_detections: 0,
      cluster: null,
      clusters: [],
    },
  });

  assert.match(html, /No detections were available in this window/);
  assert.match(html, /empty result, not zero fire/);
  assert.doesNotMatch(html, /data-testid="cluster-card"/);
  assert.doesNotMatch(html, /AI report unavailable/);
});

test('loading and error states are explicit and the error can be retried', () => {
  const loading = render({ data: null, loading: true });
  assert.match(loading, /Clustering detections/);

  const error = render({ data: null, error: 'The cluster request failed.' });
  assert.match(error, /role="alert"/);
  assert.match(error, /The cluster request failed\./);
  assert.match(error, /Retry cluster investigation/);
});

test('the map focus action is optional and names the candidate group', () => {
  const withFocus = render();
  assert.match(withFocus, /Focus candidate group C1 on the map/);

  const withoutFocus = render({ onFocusCluster: undefined });
  assert.doesNotMatch(withoutFocus, /Focus candidate group/);
});

test('the client posts the bounded window and optional cluster id', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(FIXTURE), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const data = await intelligenceApi.clusterInvestigation('90,22,91,23', 2, { cluster_id: 'C1' });
    assert.equal(data.cluster?.id, 'C1');
    assert.equal(data.cluster?.by_sensor.MODIS, 2);
    assert.equal(data.cluster?.by_sensor.VIIRS, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/api/v1/ai/cluster-investigation');
    assert.equal(calls[0].init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
      bbox: '90,22,91,23',
      days: 2,
      cluster_id: 'C1',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('the client surfaces the server error message', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: 'No candidate cluster with that id in this window.' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;

  try {
    await assert.rejects(
      () => intelligenceApi.clusterInvestigation('90,22,91,23', 2, { cluster_id: 'missing' }),
      /No candidate cluster with that id in this window\./
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

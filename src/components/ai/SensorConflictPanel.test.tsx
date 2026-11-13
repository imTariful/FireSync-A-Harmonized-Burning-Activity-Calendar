/**
 * Sensor Conflict Investigator tests.
 *
 * The render tests use server-side markup only, so no browser or network is needed. The client
 * test mocks `fetch` and asserts the bounded request body and the typed response.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { SensorConflictContent } from './SensorConflictPanel';
import { intelligenceApi, type SensorExplanationResponse } from '../../api/intelligence';

const noop = () => undefined;

const FIXTURE: SensorExplanationResponse = {
  comparison: {
    window: { start_date: '2026-11-09', end_date: '2026-11-10', days: 2 },
    bbox: '90,22,91,23',
    MODIS: {
      detections: 3,
      frp_total_mw: 45.5,
      frp_mean_mw: 15.17,
      mean_confidence: 72.5,
      peak_hours_utc: [
        { hour_utc: '06', count: 2 },
        { hour_utc: '07', count: 1 },
      ],
      satellites: ['Aqua', 'Terra'],
    },
    VIIRS: {
      detections: 7,
      frp_total_mw: 21,
      frp_mean_mw: 3,
      mean_confidence: null,
      peak_hours_utc: [{ hour_utc: '13', count: 4 }],
      satellites: ['NOAA-20'],
    },
    cells: { total: 8, paired: 2, modis_only: 1, viirs_only: 5 },
    sensor_only_note:
      'MODIS-only/VIIRS-only cells mean no counterpart was found on the shared 1 km grid; they are not non-detections.',
  },
  explanation: null,
  ai: { status: 'disabled', model: null, reason: 'AI is disabled on this server.' },
  guardrails: ['Never add MODIS and VIIRS together.'],
  source: {
    data_source: 'live',
    provenance_status: 'VERIFIED',
    retrieved_at: '2026-11-10T12:00:00Z',
    source_errors: [],
    truncated: false,
  },
  notes: [
    'Raw MODIS and VIIRS detections stay separate and are never added into a fire count.',
    'Pixel size differs (MODIS ~1 km, VIIRS ~375 m), so VIIRS usually detects more pixels for the same burning area.',
  ],
};

test('renders MODIS and VIIRS separately with the deterministic values', () => {
  const html = renderToString(
    <SensorConflictContent data={FIXTURE} error={null} loading={false} onRetry={noop} />
  );

  assert.match(html, /data-testid="sensor-modis"/);
  assert.match(html, /data-testid="sensor-viirs"/);
  assert.match(html, /data-testid="sensor-modis"[\s\S]*?45\.5/);
  assert.match(html, /data-testid="sensor-viirs"[\s\S]*?21/);
  assert.match(html, /Paired 1 km cells/);
  assert.match(html, /MODIS-only 1 km cells/);
  assert.match(html, /VIIRS-only 1 km cells/);
  assert.match(html, /06:00 UTC \(2\)/);
  assert.match(html, /13:00 UTC \(4\)/);
  assert.match(html, /AI explanation unavailable: AI is disabled on this server\./);
  assert.match(html, /Satellite thermal anomalies, not confirmed wildfires or burned area\./);
  assert.doesNotMatch(html, /MODIS \+ VIIRS/i);
  assert.doesNotMatch(html, /combined (fire )?count/i);
  assert.doesNotMatch(html, /total detections/i);
  assert.doesNotMatch(html, /data-testid="combined-total"/);
  assert.doesNotMatch(html, /<td[^>]*>10<\/td>/); // 3 + 7 is never rendered as a total
});

test('AI enabled renders the explanation and keeps every deterministic number', () => {
  const withAi: SensorExplanationResponse = {
    ...FIXTURE,
    explanation: 'MODIS and VIIRS sampled the area at different overpass times.',
    ai: { status: 'enabled', model: 'openai/gpt-oss-120b', reason: null },
  };
  const html = renderToString(
    <SensorConflictContent data={withAi} error={null} loading={false} onRetry={noop} />
  );

  assert.match(html, /MODIS and VIIRS sampled the area at different overpass times\./);
  assert.match(html, /data-testid="sensor-modis"[\s\S]*?45\.5/);
  assert.match(html, /data-testid="sensor-viirs"[\s\S]*?21/);
  assert.doesNotMatch(html, /AI explanation unavailable/);
});

test('an empty window is stated as missing coverage, not zero fire', () => {
  const empty: SensorExplanationResponse = {
    ...FIXTURE,
    comparison: {
      ...FIXTURE.comparison,
      MODIS: { ...FIXTURE.comparison.MODIS, detections: 0, frp_total_mw: 0, frp_mean_mw: null, mean_confidence: null, peak_hours_utc: [], satellites: [] },
      VIIRS: { ...FIXTURE.comparison.VIIRS, detections: 0, frp_total_mw: 0, frp_mean_mw: null, mean_confidence: null, peak_hours_utc: [], satellites: [] },
      cells: { total: 0, paired: 0, modis_only: 0, viirs_only: 0 },
    },
  };
  const html = renderToString(
    <SensorConflictContent data={empty} error={null} loading={false} onRetry={noop} />
  );

  assert.match(html, /No detections in this window\./);
  assert.match(html, /missing coverage, not zero fire/);
  assert.doesNotMatch(html, /<table/);
  assert.match(html, /AI explanation unavailable: AI is disabled on this server\./);
});

test('loading and error states are explicit and the error can be retried', () => {
  const loading = renderToString(
    <SensorConflictContent data={null} error={null} loading onRetry={noop} />
  );
  assert.match(loading, /Comparing MODIS and VIIRS/);

  const error = renderToString(
    <SensorConflictContent data={null} error="The sensor comparison failed." loading={false} onRetry={noop} />
  );
  assert.match(error, /role="alert"/);
  assert.match(error, /The sensor comparison failed\./);
  assert.match(error, /Retry sensor comparison/);
});

test('the client posts the bounded window and returns the typed response', async () => {
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
    const data = await intelligenceApi.sensorExplanation('90,22,91,23', 2);
    assert.equal(data.comparison.MODIS.detections, 3);
    assert.equal(data.comparison.VIIRS.detections, 7);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/api/v1/ai/sensor-explanation');
    assert.equal(calls[0].init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { bbox: '90,22,91,23', days: 2 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('the client surfaces the server error message', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: 'The AI provider failed.' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;

  try {
    await assert.rejects(
      () => intelligenceApi.sensorExplanation('90,22,91,23', 2),
      /The AI provider failed\./
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

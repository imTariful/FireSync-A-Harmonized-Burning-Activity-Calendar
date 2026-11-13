/**
 * AI Intelligence hub render tests.
 *
 * Server-side markup only: no browser, no network. The page container fetches in an effect,
 * so these tests exercise the presentational content with explicit fixtures.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { AiIntelligenceContent } from './AiIntelligencePage';
import type { AiRequestContext, AiStatusResponse } from '../types/ai';
import type { DatasetStatusResponse } from '../api/intelligence';

const CONTEXT: AiRequestContext = {
  area_name: 'Bangladesh',
  bbox: '88,20,93,27',
  sensors: 'ALL',
  start_date: '2026-11-07',
  end_date: '2026-11-11',
  active_view: 'ai',
};

const STATUS: AiStatusResponse = {
  provider: 'groq',
  status: 'enabled',
  enabled: true,
  configured: true,
  model: 'openai/gpt-oss-120b',
  capabilities: {
    chat: true,
    function_calling: true,
    detection_explanation: true,
    image_analysis: false,
  },
  limits: {
    requests_per_minute: 12,
    max_message_chars: 1500,
    max_tool_rounds: 3,
    request_timeout_ms: 25000,
  },
  guardrails: [
    'Satellite thermal anomalies, not confirmed wildfires or burned area.',
    'MODIS and VIIRS detections are reported separately and are never added into one fire count.',
  ],
  note: 'Groq is enabled on this server.',
};

const DATASETS: DatasetStatusResponse = {
  datasets: [
    {
      id: 'firms_nrt',
      name: 'NASA FIRMS active fire detections (NRT)',
      provider: 'NASA FIRMS Area API',
      resolution: 'MODIS 1 km, VIIRS 375 m at nadir',
      configured: true,
      used_for: 'Detection counts',
      note: 'Live NRT only.',
    },
  ],
  available_count: 1,
  unavailable_count: 5,
  note: 'Unavailable datasets are reported explicitly.',
};

const noop = () => undefined;

const render = (overrides: Partial<React.ComponentProps<typeof AiIntelligenceContent>> = {}) =>
  renderToString(
    <AiIntelligenceContent
      context={CONTEXT}
      status={STATUS}
      statusError={null}
      datasets={DATASETS}
      datasetsError={null}
      onOpenAiTool={noop}
      onOpenGeographicLayer={noop}
      onOpenGeographicReport={noop}
      onNavigate={noop}
      {...overrides}
    />
  ).replace(/<!-- -->/g, '');

test('renders all 16 features and the status summary', () => {
  const html = render();

  assert.match(html, /AI Intelligence/);
  assert.equal((html.match(/data-testid="ai-feature-\d+"/g) ?? []).length, 16);
  assert.match(html, /data-testid="ai-feature-counts"[\s\S]*?16/);
  assert.match(html, /Available/);
  assert.match(html, /Partial/);
  assert.match(html, /Unavailable/);
  assert.match(html, /Ask FireSync: AI Map Copilot/);
  assert.match(html, /AI Seasonal Fire Historian/);
  assert.match(html, /AI Geographic Fire Intelligence Lab/);
});

test('shows the live provider and dataset status without exposing a key', () => {
  const html = render();

  assert.match(html, /data-testid="ai-provider-status"[\s\S]*?gpt-oss-120b/);
  assert.match(html, /Function calling: yes/);
  assert.match(html, /Image analysis: no/);
  assert.match(html, /data-testid="ai-dataset-status"[\s\S]*?1 configured/);
  assert.match(html, /5 unavailable/);
  assert.doesNotMatch(html, /AIza[0-9A-Za-z_-]{10,}/);
  assert.doesNotMatch(html, /GROQ_API_KEY\s*=/);
});

test('unavailable features state the missing dataset or infrastructure', () => {
  const html = render();

  assert.match(html, /no server-side image pipeline/);
  assert.doesNotMatch(html, /no meteorological data adapter is configured/);
  assert.match(html, /no settlements, infrastructure, administrative-boundary or population dataset/);
  assert.doesNotMatch(html, /no durable watchlist storage, scheduler or notification delivery/);
  assert.match(html, /Simulation is explicitly unavailable/);
  assert.doesNotMatch(html, /spread rate, perimeter or arrival time is produced by this laboratory/i);
});

test('feature 16 lists all ten geographic capabilities with honest statuses', () => {
  const html = render();
  const feature16 = html.slice(html.indexOf('data-testid="ai-feature-16"'));

  assert.match(feature16, /Hotspot density/);
  assert.match(feature16, /Country and district analysis/);
  assert.match(feature16, /Proximity analysis/);
  assert.match(feature16, /Land-cover analysis/);
  assert.match(feature16, /Fire cluster evolution/);
  assert.match(feature16, /Terrain analysis/);
  assert.match(feature16, /Geographic anomaly detection/);
  assert.match(feature16, /Environmental context/);
  assert.match(feature16, /Population exposure screening/);
  assert.match(feature16, /Cross-border activity analysis/);
  assert.match(feature16, /No ESA WorldCover raster/);
  assert.match(feature16, /No population grid is present/);
});

test('keeps the required legend and never renders a combined fire count', () => {
  const html = render();

  assert.match(html, /Satellite thermal anomalies, not confirmed wildfires or burned area\./);
  assert.doesNotMatch(html, /combined (fire )?count/i);
  assert.doesNotMatch(html, /total fire count/i);
});

test('a disabled provider is reported as disabled, not as a working feature', () => {
  const disabled: AiStatusResponse = {
    ...STATUS,
    status: 'disabled',
    enabled: false,
    configured: false,
    model: null,
    capabilities: {
      chat: false,
      function_calling: false,
      detection_explanation: false,
      image_analysis: false,
    },
    note: 'AI is disabled on this server.',
  };

  const html = render({ status: disabled });

  assert.match(html, /AI is disabled on this server\./);
  assert.match(html, /Model: not selected/);
  assert.match(html, /Chat: no/);
  assert.doesNotMatch(html, /Model: gpt/);
});

test('status failures are explicit and do not pretend the provider is ready', () => {
  const html = render({
    status: null,
    statusError: 'status endpoint unavailable',
    datasets: null,
    datasetsError: 'dataset endpoint unavailable',
  });

  assert.match(html, /AI status could not be read: status endpoint unavailable/);
  assert.match(html, /Dataset status could not be read: dataset endpoint unavailable/);
  assert.doesNotMatch(html, /Function calling: yes/);
});

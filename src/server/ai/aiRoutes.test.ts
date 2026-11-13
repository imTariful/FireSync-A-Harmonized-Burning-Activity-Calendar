/**
 * Validation and tool-execution tests for the Groq layer.
 *
 * No network: the model transport is replaced by a fake generate function, and the observation
 * loader returns a fixed fixture. NASA and Groq are never called here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../app';
import { MemoryObservationStore } from '../store';
import type { CanonicalObservation } from '../../types/fire';
import type { ClimatologyResponse, SeasonalStatusResponse } from '../historical';
import type { ModelGenerateFn, ModelGenerateParams, ModelPart } from './groq';
import { ProviderError, runModelChat } from './groq';
import {
  buildCountReply,
  buildFrpReply,
  buildRegionRankingReply,
  buildSensorComparisonReply,
  executeAiTool,
  isCountQuestion,
  isFrpQuestion,
  isRegionRankingQuestion,
  isSensorComparisonQuestion,
  runDeterministicFastPath,
  windowDaysFromMessage,
} from './tools';
import { isValidBbox, parseChatRequest, parseEvidence, parseMapAction } from './schema';
import { readAiConfig, aiStatus } from './config';
import { FixedWindowRateLimiter } from './rateLimit';

function observation(partial: Partial<CanonicalObservation> & Pick<CanonicalObservation, 'id' | 'sensor'>): CanonicalObservation {
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
    record_hash: `hash-${id}`,
    provenance_status: 'VERIFIED',
    ...rest,
  };
}

const FIXTURES: CanonicalObservation[] = [
  observation({ id: 'modis-1', sensor: 'MODIS', frp_mw: 12 }),
  observation({ id: 'modis-2', sensor: 'MODIS', latitude: 22.11, frp_mw: 30 }),
  observation({ id: 'viirs-1', sensor: 'VIIRS', frp_mw: 4 }),
];

// ----------------------------------------------------------------- schema

test('bbox validation accepts real boxes and rejects inverted or out-of-range ones', () => {
  assert.equal(isValidBbox('90,22,91,23'), true);
  assert.equal(isValidBbox('-180,-90,180,90'), true);
  assert.equal(isValidBbox('91,22,90,23'), false, 'west must be lower than east');
  assert.equal(isValidBbox('90,23,91,22'), false, 'south must be lower than north');
  assert.equal(isValidBbox('90,22,91'), false);
  assert.equal(isValidBbox('-181,22,91,23'), false);
  assert.equal(isValidBbox(42), false);
});

test('chat validation bounds the message and drops unknown context fields', () => {
  assert.equal(parseChatRequest({ message: '' }, 1500).ok, false);
  assert.equal(parseChatRequest({ message: 'x'.repeat(1501) }, 1500).ok, false);
  const parsed = parseChatRequest(
    { message: ' show modis ', context: { bbox: '90,22,91,23', active_view: 'hotspots', secret: 'nope' } },
    1500
  );
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.message, 'show modis');
  assert.equal(parsed.value.context?.bbox, '90,22,91,23');
  assert.equal((parsed.value.context as Record<string, unknown>).secret, undefined);
});

test('map actions are validated: sensor enum, live-window days and numeric ranges', () => {
  assert.equal(parseMapAction({ type: 'apply_filters', sensors: 'BOTH' }, '2026-11-10').ok, false);
  assert.equal(parseMapAction({ type: 'apply_filters', days: 6 }, '2026-11-10').ok, false);
  assert.equal(parseMapAction({ type: 'apply_filters', min_frp: -1 }, '2026-11-10').ok, false);
  assert.equal(parseMapAction({ type: 'apply_filters' }, '2026-11-10').ok, false, 'no-op actions are rejected');
  assert.equal(parseMapAction({ type: 'delete_everything' }, '2026-11-10').ok, false);

  const parsed = parseMapAction({ type: 'apply_filters', sensors: 'MODIS', days: 2, min_frp: 5 }, '2026-11-10');
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.deepEqual(parsed.value, { type: 'apply_filters', sensors: 'MODIS', days: 2, min_frp: 5 });
});

test('evidence keeps only known fields and reports what is missing instead of inventing it', () => {
  const parsed = parseEvidence({
    id: 'abc',
    sensor: 'VIIRS',
    satellite: 'NOAA-20',
    latitude: 22.1,
    longitude: 90.1,
    acq_date: '2026-11-09',
    acq_time: '0610',
    datetime_utc: '2026-11-09T06:10:00Z',
    confidence: 'nominal',
    frp_mw: 4.2,
    product: 'VIIRS_NOAA20_NRT',
    something_else: 'ignore me',
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.evidence.sensor, 'VIIRS');
  assert.equal((parsed.value.evidence as unknown as Record<string, unknown>).something_else, undefined);
  assert.ok(parsed.value.fieldsMissing.includes('brightness'));
  assert.ok(parsed.value.fieldsMissing.includes('provenance_status'));
  assert.ok(parsed.value.fieldsProvided.includes('frp_mw'));

  assert.equal(parseEvidence({ id: 'x', sensor: 'MODIS', latitude: 999, longitude: 0, frp_mw: 1, acq_date: '2026-11-09', datetime_utc: 'x' }).ok, false);
  assert.equal(parseEvidence({ id: 'x', sensor: 'MODIS', latitude: 1, longitude: 0, frp_mw: 1, acq_date: '2026-02-31', datetime_utc: 'x' }).ok, false);
  assert.equal(parseEvidence({ id: 'x', sensor: 'AVHRR', latitude: 1, longitude: 0, frp_mw: 1, acq_date: '2026-11-09', datetime_utc: 'x' }).ok, false);
});

// ----------------------------------------------------------------- tools

const stubLoader = async () => ({
  observations: FIXTURES,
  source: 'live' as const,
  provenance: 'VERIFIED' as const,
  retrieved_at: '2026-11-10T00:00:00Z',
  errors: [],
  truncated: false,
});

test('query_hotspots splits sensors and never sums them', async () => {
  const exec = await executeAiTool('query_hotspots', { days: 1, limit: 2 }, { load: stubLoader, today: '2026-11-10' });
  assert.equal(exec.record.ok, true);
  const summary = exec.response.summary as {
    total_matching: number;
    by_sensor: { MODIS: number; VIIRS: number };
    frp_mw: { MODIS: number; VIIRS: number };
    active_1km_cells: number;
    sample: unknown[];
  };
  assert.equal(summary.total_matching, 3);
  assert.equal(summary.by_sensor.MODIS, 2);
  assert.equal(summary.by_sensor.VIIRS, 1);
  assert.equal(summary.frp_mw.MODIS, 42);
  assert.equal(summary.frp_mw.VIIRS, 4);
  assert.equal(summary.sample.length, 2);
  assert.equal(summary.active_1km_cells >= 1, true);
  assert.equal((exec.response.summary as Record<string, unknown>).combined_total, undefined);
});

test('query_hotspots applies the sensor and FRP filters and clamps the window', async () => {
  const exec = await executeAiTool('query_hotspots', { days: 99, sensors: 'MODIS', min_frp: 20 }, { load: stubLoader, today: '2026-11-10' });
  const summary = exec.response.summary as { window_days: number; total_matching: number; by_sensor: { MODIS: number; VIIRS: number } };
  assert.equal(summary.window_days, 5, 'days are clamped to the live NRT maximum');
  assert.equal(summary.total_matching, 1);
  assert.equal(summary.by_sensor.MODIS, 1);
  assert.equal(summary.by_sensor.VIIRS, 0);
});

test('sensor_comparison reports paired cells and an explicit ratio', async () => {
  const exec = await executeAiTool('sensor_comparison', { days: 1 }, { load: stubLoader, today: '2026-11-10' });
  const comparison = exec.response.comparison as {
    modis_detections: number;
    viirs_detections: number;
    paired_1km_cells: number;
    viirs_to_modis_ratio: number | null;
  };
  assert.equal(comparison.modis_detections, 2);
  assert.equal(comparison.viirs_detections, 1);
  assert.equal(comparison.viirs_to_modis_ratio, 0.5);
  assert.equal(comparison.paired_1km_cells, 1);
});

test('rank_regions ranks study regions in one call with sensors kept separate', async () => {
  const exec = await executeAiTool('rank_regions', { days: 1 }, { load: stubLoader, today: '2026-11-10' });
  assert.equal(exec.record.ok, true);
  const ranking = exec.response.ranking as {
    regions: Array<{
      id: string;
      modis_detections: number;
      viirs_detections: number;
      exploratory_detection_total: number;
    }>;
  };
  assert.equal(ranking.regions.length, 4);
  assert.equal(ranking.regions[0].id, 'bangladesh', 'all fixtures sit inside the Bangladesh bbox');
  assert.equal(ranking.regions[0].modis_detections, 2);
  assert.equal(ranking.regions[0].viirs_detections, 1);
  assert.equal(ranking.regions[0].exploratory_detection_total, 3);
  for (const region of ranking.regions.slice(1)) {
    assert.equal(region.exploratory_detection_total, 0);
  }
  const notes = (exec.response.ranking as { notes: string[] }).notes.join(' ');
  assert.match(notes, /EXPLORATORY/);
  assert.match(notes, /not a world country ranking/);
});

test('the ranking fast path matches only unambiguous ranking questions', () => {
  assert.equal(isRegionRankingQuestion('which are got detected most fire hotspot today?'), true);
  assert.equal(isRegionRankingQuestion('which area has the most hotspots?'), true);
  assert.equal(isRegionRankingQuestion('what region recorded the highest fire activity'), true);
  assert.equal(isRegionRankingQuestion('show me the most recent hotspots'), false);
  assert.equal(isRegionRankingQuestion('how many hotspots today'), false);
  assert.equal(isRegionRankingQuestion('where are the hotspots in Bangladesh'), false);
  assert.equal(isRegionRankingQuestion('compare MODIS and VIIRS'), false);
  assert.equal(windowDaysFromMessage('most hotspots in the last 3 days'), 3);
  assert.equal(windowDaysFromMessage('most hotspots today'), 1);
  assert.equal(windowDaysFromMessage('most hotspots in 9 days'), 5, 'windows beyond the NRT limit clamp to the max');
  assert.equal(windowDaysFromMessage('most hotspots in 10 days'), 5, 'multi-digit day counts are parsed, not truncated to one digit');
});

test('buildRegionRankingReply keeps sensors separate and carries the legend', () => {
  const reply = buildRegionRankingReply({
    window_days: 1,
    regions: [
      { id: 'bangladesh', name: 'Bangladesh', country: 'Bangladesh', modis_detections: 5, viirs_detections: 7, exploratory_detection_total: 12 },
      { id: 'amazon_arc', name: 'Amazon Arc', modis_detections: 2, viirs_detections: 1, exploratory_detection_total: 3 },
    ],
  });
  assert.match(reply, /Bangladesh/);
  assert.match(reply, /MODIS 5, VIIRS 7/);
  assert.match(reply, /EXPLORATORY/);
  assert.match(reply, /Satellite thermal anomalies, not confirmed wildfires or burned area\./);
  const empty = buildRegionRankingReply({ window_days: 1, regions: [] });
  assert.match(empty, /No satellite detections/);
});

test('the extended fast path matches count, sensor and FRP intents', async () => {
  // counts
  assert.equal(isCountQuestion('how many hotspots today?'), true);
  assert.equal(isCountQuestion('what is the total number of fire detections in the last 2 days'), true);
  assert.equal(isCountQuestion('count hotspots this week'), true);
  // sensor comparison
  assert.equal(isSensorComparisonQuestion('compare MODIS and VIIRS'), true);
  assert.equal(isSensorComparisonQuestion('which sensor detects more hotspots'), true);
  assert.equal(isSensorComparisonQuestion('MODIS vs VIIRS detections'), true);
  // FRP extremes
  assert.equal(isFrpQuestion('which hotspot has the highest FRP'), true);
  assert.equal(isFrpQuestion('what is the biggest fire detection today'), true);
  assert.equal(isFrpQuestion('show me the max FRP'), true);

  // ambiguous/explanatory phrasing must NOT match any intent
  for (const q of [
    'why are there so many hotspots in the Amazon',
    'what does FRP mean',
    'should we worry about these fires',
    'show me the most recent hotspots',
  ]) {
    assert.equal(isCountQuestion(q) || isSensorComparisonQuestion(q) || isFrpQuestion(q) || isRegionRankingQuestion(q), false, q);
  }
  // "explain ... MODIS and VIIRS" matches the sensor shape but is excluded before matching.
  assert.equal(await runDeterministicFastPath('explain the difference between MODIS and VIIRS', { load: stubLoader, today: '2026-11-10' }), null);
  assert.equal(windowDaysFromMessage('in the last 4 days'), 4);
  assert.equal(windowDaysFromMessage('in the last 12 days'), 5, 'clamps to the NRT window');
  assert.equal(windowDaysFromMessage('today'), 1);
});

test('relative past periods never use the live count fast path', async () => {
  const deps = { load: stubLoader, today: '2026-11-10', history: stubHistory };
  for (const q of [
    'how many detections in bangladesh in past 6 years',
    'how many hotspots in India over the last 5 years',
    'total detections in the past year for Australia',
    'detections last month in Brazil',
    'hotspots this year in Canada',
    'detections in the 2010s in Congo',
    'how many hotspots since 2015 in Chile',
  ]) {
    const res = await runDeterministicFastPath(q, deps);
    // Either the deterministic archive answer or a model fallthrough — never live NRT counts.
    assert.ok(res === null || res.record.name === 'history_period_summary', q);
    assert.ok(!res?.reply.includes('Over today'), q);
  }
  // Live-window phrasings must still use the fast path.
  const live = await runDeterministicFastPath('how many hotspots today?', deps);
  assert.ok(live !== null, 'today count should still fast-path');
});

test('history fast path answers past-period country counts without a model', async () => {
  const deps = { load: stubLoader, today: '2026-11-10', history: stubHistory };
  const res = await runDeterministicFastPath(
    'how many detections in bangladesh in past 6 years and which years as the highest',
    deps
  );
  assert.ok(res !== null, 'past-period count should get a deterministic archive answer');
  assert.equal(res.record.name, 'history_period_summary');
  assert.match(res.reply, /MODIS: 2,200 detections/);
  assert.match(res.reply, /VIIRS: 8,500 detections/);
  assert.match(res.reply, /2021: 1,200/);
  assert.match(res.reply, /highest year\(s\): 2021 \(1,200\)/);
  assert.match(res.reply, /Satellite thermal anomalies, not confirmed wildfires or burned area\./);
  assert.ok(res.dataNotes.some((n) => n.includes('no AI model call')));

  // Explicit range + single sensor.
  const ranged = await runDeterministicFastPath('total MODIS detections in India 2020-2021', deps);
  assert.ok(ranged !== null);
  assert.match(ranged.reply, /MODIS: 2,200 detections/);
  assert.doesNotMatch(ranged.reply, /VIIRS:/);

  // Ambiguous history phrasing still falls through to the model path.
  assert.equal(await runDeterministicFastPath('why were 2019 fires so bad in Australia', deps), null);
  assert.equal(await runDeterministicFastPath('compare MODIS and VIIRS in 2019', deps), null);
});

test('history fast path covers rankings, extremes, anomaly, climatology, persistence', async () => {
  const deps = { load: stubLoader, today: '2026-11-10', history: stubHistory };

  // Country rankings for a single year.
  const rank = await runDeterministicFastPath('which countries had the most detections in 2019', deps);
  assert.ok(rank !== null);
  assert.equal(rank.record.name, 'history_country_rankings');
  assert.match(rank.reply, /Australia \(120,000\)/);
  assert.match(rank.reply, /Satellite thermal anomalies/);

  // Highest FRP days, all-time phrasing.
  const frp = await runDeterministicFastPath('what was the highest FRP ever recorded', deps);
  assert.ok(frp !== null);
  assert.equal(frp.record.name, 'history_frp_extremes');
  assert.match(frp.reply, /6,120\.4 MW/);

  // Month anomaly needs year + month.
  const anom = await runDeterministicFastPath('was June 2019 unusually active in Australia', deps);
  assert.ok(anom !== null);
  assert.equal(anom.record.name, 'history_month_anomaly');
  assert.match(anom.reply, /2\.778× typical/);
  // Missing month falls through to the model.
  assert.equal(await runDeterministicFastPath('was 2019 unusually active in Australia', deps), null);

  // Climatology needs a country and no explicit year.
  const clim = await runDeterministicFastPath('when is fire season in Australia', deps);
  assert.ok(clim !== null);
  assert.equal(clim.record.name, 'history_seasonal_profile');
  assert.match(clim.reply, /not a forecast|not what will happen/i);

  // Seasonal status needs a country.
  const seas = await runDeterministicFastPath('is it burning season now in Australia', deps);
  assert.ok(seas !== null);
  assert.equal(seas.record.name, 'history_seasonal_status');

  // Persistence — no country filter in the tool.
  const pers = await runDeterministicFastPath('which countries have fire activity almost every year', deps);
  assert.ok(pers !== null);
  assert.equal(pers.record.name, 'history_persistent_countries');
  assert.match(pers.reply, /25 yrs/);

  // Daily series for a single year.
  const days = await runDeterministicFastPath('which days were most active in June 2019', deps);
  assert.ok(days !== null);
  assert.equal(days.record.name, 'history_daily_series');

  // Archive coverage.
  const cov = await runDeterministicFastPath('what years does the historical archive cover', deps);
  assert.ok(cov !== null);
  assert.equal(cov.record.name, 'history_status');
  assert.match(cov.reply, /MODIS: 2000-2025/);

  // Live questions must still reach the live fast path, not history.
  const live = await runDeterministicFastPath('how many hotspots today in Canada', deps);
  assert.ok(live !== null);
  assert.notEqual(live.record.name, 'history_status');
  assert.match(live.reply, /Over today/);
});

test('runDeterministicFastPath answers each intent without a model and declines the rest', async () => {
  const deps = { load: stubLoader, today: '2026-11-10' };

  const count = await runDeterministicFastPath('how many hotspots today?', deps);
  assert.ok(count);
  assert.equal(count.record.name, 'query_hotspots');
  assert.match(count.reply, /MODIS 2 detections, VIIRS 1 detections/);
  assert.match(count.reply, /Satellite thermal anomalies/);

  const sensors = await runDeterministicFastPath('compare MODIS and VIIRS', deps);
  assert.ok(sensors);
  assert.equal(sensors.record.name, 'sensor_comparison');
  assert.match(sensors.reply, /paired|1 km cells/);

  const frp = await runDeterministicFastPath('which hotspot has the highest FRP', deps);
  assert.ok(frp);
  assert.equal(frp.record.name, 'hottest_detections');
  assert.match(frp.reply, /FRP 30 MW/);

  const why = await runDeterministicFastPath('why are there so many hotspots', deps);
  assert.equal(why, null, 'explanatory questions fall through to Groq');
});

test('hottest_detections returns per-sensor FRP tops in order', async () => {
  const exec = await executeAiTool('hottest_detections', { days: 1, limit: 2 }, { load: stubLoader, today: '2026-11-10' });
  assert.equal(exec.record.ok, true);
  const hottest = exec.response.hottest as {
    top_per_sensor: { MODIS: Array<{ frp_mw: number; sensor: string }>; VIIRS: Array<{ frp_mw: number }> };
  };
  assert.equal(hottest.top_per_sensor.MODIS[0].frp_mw, 30);
  assert.equal(hottest.top_per_sensor.MODIS[0].sensor, 'MODIS');
  assert.equal(hottest.top_per_sensor.VIIRS[0].frp_mw, 4);
});

test('buildCountReply, buildSensorComparisonReply and buildFrpReply keep sensors separate', () => {
  const count = buildCountReply(
    {
      window_days: 1, bbox_used: 'world', total_matching: 3,
      by_sensor: { MODIS: 2, VIIRS: 1 }, frp_mw: { MODIS: 42, VIIRS: 4 },
      active_1km_cells: 2, first_detection_utc: 'a', last_detection_utc: 'b',
    },
    1, null
  );
  assert.match(count, /MODIS 2 detections, VIIRS 1 detections/);
  assert.match(count, /never summed/);

  const comparison = buildSensorComparisonReply(
    { window_days: 1, bbox_used: 'world', modis_detections: 2, viirs_detections: 1, viirs_to_modis_ratio: 0.5, paired_1km_cells: 1, active_1km_cells: 2 },
    1
  );
  assert.match(comparison, /never merged/);

  const frp = buildFrpReply(
    {
      window_days: 1, bbox_used: 'world',
      top_per_sensor: {
        MODIS: [{ id: 'm', sensor: 'MODIS', satellite: 'Terra', latitude: 1, longitude: 2, acq_date: '2026-11-09', acq_time: '0600', datetime_utc: 'x', confidence: 'nominal', frp_mw: 30, product: 'p' } as never],
        VIIRS: [],
      },
    },
    1
  );
  assert.match(frp, /FRP 30 MW/);
  assert.match(frp, /reported separately/);
});

test('the tools refuse unknown regions, unknown tools and invalid boxes', async () => {
  const unknownRegion = await executeAiTool('focus_region', { region_id: 'atlantis' }, { load: stubLoader, today: '2026-11-10' });
  assert.equal(unknownRegion.record.ok, false);

  const unknownTool = await executeAiTool('drop_database', {}, { load: stubLoader, today: '2026-11-10' });
  assert.equal(unknownTool.record.ok, false);

  const badBox = await executeAiTool('query_hotspots', { days: 1, bbox: '91,22,90,23' }, { load: stubLoader, today: '2026-11-10' });
  assert.equal(badBox.record.ok, false);
  assert.match(String(badBox.response.error), /bbox/);
});

test('focus_region returns a validated action built from the project region table', async () => {
  const exec = await executeAiTool('focus_region', { region_id: 'bangladesh' }, { load: stubLoader, today: '2026-11-10' });
  assert.equal(exec.record.ok, true);
  assert.equal(exec.action?.type, 'focus_region');
  assert.match(String((exec.action as { bbox?: string }).bbox), /^-?\d/);
});

const stubHistory = {
  status: async () => ({
    available: true,
    sensors: {
      MODIS: { years: [2000, 2019, 2025], min_date: '2000-11-01', max_date: '2025-12-31', rows: 111424405 },
      VIIRS: { years: [2012, 2019, 2025], min_date: '2012-01-20', max_date: '2025-12-31', rows: 281144026 },
    },
  }),
  yearTotals: async (sensor: 'MODIS' | 'VIIRS', year: number) =>
    year === 2019
      ? { detections: sensor === 'MODIS' ? 5000 : 12000, frp_sum_mw: 1e6, days_with_data: 360 }
      : null,
  daily: async () => ({
    rows: [
      { period: '2019-06', country: 'GLOBAL', sensor: 'MODIS', detections: 100, frp_sum_mw: 10, frp_max_mw: 5, day_count: 80, night_count: 20, satellites_seen: null },
      { period: '2019-07', country: 'GLOBAL', sensor: 'MODIS', detections: 300, frp_sum_mw: 30, frp_max_mw: 9, day_count: 250, night_count: 50, satellites_seen: null },
    ],
    truncated: false,
  }),
  periodTotals: async () => [
    { year: 2020, sensor: 'MODIS', detections: 1000, frp_sum_mw: 1e5, days_with_data: 300, day_count: 700, night_count: 300 },
    { year: 2021, sensor: 'MODIS', detections: 1200, frp_sum_mw: 1.2e5, days_with_data: 310, day_count: 800, night_count: 400 },
    { year: 2020, sensor: 'VIIRS', detections: 4000, frp_sum_mw: 4e5, days_with_data: 340, day_count: 3000, night_count: 1000 },
    { year: 2021, sensor: 'VIIRS', detections: 4500, frp_sum_mw: 4.5e5, days_with_data: 350, day_count: 3200, night_count: 1300 },
  ],
  countries: async () => ['Bangladesh', 'India', 'Australia', 'Brazil', 'United States'],
  countryTotals: async () => [
    { country: 'Australia', sensor: 'MODIS', detections: 50000, frp_sum_mw: 5e6, days_with_data: 300 },
    { country: 'Australia', sensor: 'VIIRS', detections: 120000, frp_sum_mw: 1.2e7, days_with_data: 340 },
    { country: 'Brazil', sensor: 'VIIRS', detections: 90000, frp_sum_mw: 9e6, days_with_data: 330 },
  ],
  frpExtremes: async () => [
    { period: '2019-08-15', country: 'Australia', sensor: 'VIIRS', frp_max_mw: 6120.4, detections: 14000 },
    { period: '2019-08-15', country: 'Australia', sensor: 'MODIS', frp_max_mw: 2210.0, detections: 6000 },
  ],
  persistence: async () => [
    { country: 'Australia', sensor: 'VIIRS', years_with_data: 14, detections: 1900000 },
    { country: 'Brazil', sensor: 'MODIS', years_with_data: 25, detections: 800000 },
  ],
  monthAnomaly: async () => [
    { country: 'Australia', sensor: 'VIIRS', year: 2019, detections: 250000, other_years_median: 90000, ratio: 2.778 },
  ],
  climatology: async (): Promise<ClimatologyResponse> => ({
    scope: { country: 'Australia', bbox: null, sensor: 'ALL' },
    year_range: { start: 2000, end: 2025 },
    months: [
      { month: 1, sensors: {}, harmonized_equivalent_median: 100, activity_class: 'low' },
      { month: 10, sensors: { MODIS: { median_detections: 5000, p25_detections: 1, p75_detections: 2, years_with_data: 26, years_total: 26, median_frp_sum_mw: null } }, harmonized_equivalent_median: 5000, activity_class: 'high' },
    ],
    season: { peak_months: [10], low_months: [1] },
    legend: 'Satellite thermal anomalies, not confirmed wildfires or burned area.',
    notes: [],
  }),
  seasonalStatus: async (): Promise<SeasonalStatusResponse | null> => ({
    country: 'Australia',
    date: '2026-11-12',
    day_of_year: 316,
    window_days: 15,
    climatology: { scope: { country: 'Australia', bbox: null, sensor: 'ALL' }, year_range: { start: 2000, end: 2025 }, months: [], season: { peak_months: [10], low_months: [1] }, legend: '', notes: [] },
    today_window: {
      MODIS: { median_detections: 17805.5, p25_detections: 14056.5, p75_detections: 29207, years_with_data: 26, years_total: 26 },
    },
    upcoming_months: [{ month: 12, activity_class: 'typical', harmonized_equivalent_median: 36000 }],
    legend: 'Satellite thermal anomalies, not confirmed wildfires or burned area.',
    notes: [],
  }),
};

test('history_period_summary covers multi-year ranges with per-sensor totals', async () => {
  const exec = await executeAiTool(
    'history_period_summary',
    { start_year: 2020, end_year: 2021, country: 'Bangladesh' },
    { load: stubLoader, today: '2026-11-10', history: stubHistory }
  );
  assert.equal(exec.record.ok, true);
  const totals = exec.response.totals_by_sensor as Record<string, { detections: number }>;
  assert.equal(totals.MODIS.detections, 2200);
  assert.equal(totals.VIIRS.detections, 8500);
  assert.equal((exec.response.totals_by_sensor as Record<string, unknown>).combined, undefined);

  const bad = await executeAiTool(
    'history_period_summary',
    { start_year: 2030, end_year: 2020 },
    { load: stubLoader, today: '2026-11-10', history: stubHistory }
  );
  assert.equal(bad.record.ok, false);
});

test('history_country_rankings returns per-sensor top countries', async () => {
  const exec = await executeAiTool(
    'history_country_rankings',
    { year: 2019, limit: 5 },
    { load: stubLoader, today: '2026-11-10', history: stubHistory }
  );
  assert.equal(exec.record.ok, true);
  const top = exec.response.top_per_sensor as { MODIS: Array<{ country: string }>; VIIRS: Array<{ country: string }> };
  assert.equal(top.MODIS[0].country, 'Australia');
  assert.equal(top.VIIRS[0].country, 'Australia');
});

test('history_year_summary reports MODIS and VIIRS separately and flags uncovered years', async () => {
  const exec = await executeAiTool(
    'history_year_summary',
    { year: 2019 },
    { load: stubLoader, today: '2026-11-10', history: stubHistory }
  );
  assert.equal(exec.record.ok, true);
  const per = exec.response.per_sensor as Record<string, { archive_covers_year: boolean; detections: number | null }>;
  assert.equal(per.MODIS.detections, 5000);
  assert.equal(per.VIIRS.detections, 12000);
  assert.equal(per.MODIS.archive_covers_year, true);
  assert.equal((exec.response.per_sensor as Record<string, unknown>).combined_total, undefined);

  const uncovered = await executeAiTool(
    'history_year_summary',
    { year: 2005, sensor: 'VIIRS' },
    { load: stubLoader, today: '2026-11-10', history: stubHistory }
  );
  const viirs = (uncovered.response.per_sensor as Record<string, { archive_covers_year: boolean; detections: number | null }>).VIIRS;
  assert.equal(viirs.archive_covers_year, false);
  assert.equal(viirs.detections, null, 'no fabricated totals for uncovered years');
});

test('history_daily_series validates the window and passes filters through', async () => {
  const bad = await executeAiTool('history_daily_series', { year: 1800 }, { load: stubLoader, today: '2026-11-10', history: stubHistory });
  assert.equal(bad.record.ok, false);

  const exec = await executeAiTool(
    'history_daily_series',
    { year: 2019, country: 'Bangladesh', level: 'monthly', sensor: 'MODIS' },
    { load: stubLoader, today: '2026-11-10', history: stubHistory }
  );
  assert.equal(exec.record.ok, true);
  const query = exec.response.query as { year: number; country: string; level: string; sensor: string };
  assert.deepEqual(query, { year: 2019, month: null, sensor: 'MODIS', country: 'Bangladesh', level: 'monthly' });
  assert.ok((exec.response.notes as string[]).some((n) => n.includes('not confirmed zero activity')));
});

test('history_frp_extremes returns daily-aggregate maxima with sensors separate', async () => {
  const exec = await executeAiTool(
    'history_frp_extremes',
    { sensor: 'VIIRS', limit: 5 },
    { load: stubLoader, today: '2026-11-10', history: stubHistory }
  );
  assert.equal(exec.record.ok, true);
  const rows = exec.response.rows as Array<{ sensor: string; frp_max_mw: number }>;
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => r.sensor === 'VIIRS' || r.sensor === 'MODIS'));
  assert.match(String(exec.record.summary), /FRP/);

  const bad = await executeAiTool(
    'history_frp_extremes',
    { start_year: 1800 },
    { load: stubLoader, today: '2026-11-10', history: stubHistory }
  );
  assert.equal(bad.record.ok, false);
});

test('history_persistent_countries ranks by distinct years with data', async () => {
  const exec = await executeAiTool(
    'history_persistent_countries',
    {},
    { load: stubLoader, today: '2026-11-10', history: stubHistory }
  );
  assert.equal(exec.record.ok, true);
  const rows = exec.response.rows as Array<{ country: string; sensor: string; years_with_data: number }>;
  assert.equal(rows[0].country, 'Australia');
  assert.equal(rows[0].sensor, 'VIIRS');
  assert.equal(rows[0].years_with_data, 14);
});

test('history_month_anomaly validates month and returns ratio rows', async () => {
  const bad = await executeAiTool(
    'history_month_anomaly',
    { year: 2019, month: 13 },
    { load: stubLoader, today: '2026-11-10', history: stubHistory }
  );
  assert.equal(bad.record.ok, false);

  const exec = await executeAiTool(
    'history_month_anomaly',
    { year: 2019, month: 8, country: 'Australia' },
    { load: stubLoader, today: '2026-11-10', history: stubHistory }
  );
  assert.equal(exec.record.ok, true);
  const rows = exec.response.rows as Array<{ ratio: number | null; other_years_median: number }>;
  assert.equal(rows[0].ratio, 2.778);
  assert.ok((exec.response.notes as string[]).some((n) => n.includes('statistical variation')));
});

test('history_seasonal_profile returns monthly climatology classes', async () => {
  const exec = await executeAiTool(
    'history_seasonal_profile',
    { country: 'Australia' },
    { load: stubLoader, today: '2026-11-10', history: stubHistory }
  );
  assert.equal(exec.record.ok, true);
  const months = exec.response.months as Array<{ month: number; class: string }>;
  assert.equal(months.find((m) => m.month === 10)?.class, 'high');
  assert.deepEqual(exec.response.peak_months, [10]);
  assert.ok((exec.response.notes as string[]).some((n) => n.includes('NOT a forecast')));

  const bad = await executeAiTool(
    'history_seasonal_profile',
    {},
    { load: stubLoader, today: '2026-11-10', history: stubHistory }
  );
  assert.equal(bad.record.ok, false);
});

test('history_seasonal_status returns today window and upcoming months', async () => {
  const exec = await executeAiTool(
    'history_seasonal_status',
    { country: 'Australia' },
    { load: stubLoader, today: '2026-11-10', history: stubHistory }
  );
  assert.equal(exec.record.ok, true);
  const win = exec.response.today_window as Record<string, { median_detections: number }>;
  assert.equal(win.MODIS.median_detections, 17805.5);
  assert.equal((exec.response.upcoming_months as Array<{ month: number }>)[0].month, 12);

  const bad = await executeAiTool(
    'history_seasonal_status',
    {},
    { load: stubLoader, today: '2026-11-10', history: stubHistory }
  );
  assert.equal(bad.record.ok, false);
});

// ----------------------------------------------------------------- groq loop

const noToolGenerate: ModelGenerateFn = async () => ({ text: 'MODIS 2 detections.', functionCalls: [] });

test('runModelChat returns text when the model answers directly', async () => {
  const result = await runModelChat({
    generate: noToolGenerate,
    model: 'test-model',
    systemInstruction: 'system',
    turns: [{ role: 'user', parts: [{ text: 'hi' }] }],
  });
  assert.equal(result.text, 'MODIS 2 detections.');
  assert.equal(result.toolCalls.length, 0);
});

test('runModelChat executes tool calls, echoes their results and stops', async () => {
  const calls: ModelGenerateParams[] = [];
  const generate: ModelGenerateFn = async (params) => {
    calls.push(params);
    if (calls.length === 1) {
      return { text: '', functionCalls: [{ name: 'query_hotspots', args: { days: 1 } }] };
    }
    return { text: 'There are 2 MODIS and 1 VIIRS detections.', functionCalls: [] };
  };

  const result = await runModelChat({
    generate,
    model: 'test-model',
    systemInstruction: 'system',
    turns: [{ role: 'user', parts: [{ text: 'how many?' }] }],
    toolDeclarations: [{ name: 'query_hotspots', description: 'd', parameters: { type: 'object', properties: {} } }],
    executeTool: async () => ({ ok: true, summary: { MODIS: 2, VIIRS: 1 } }),
  });

  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].name, 'query_hotspots');
  assert.equal(calls.length, 2);
  const secondTurn = calls[1].contents;
  assert.equal(secondTurn[secondTurn.length - 1].parts[0].functionResponse?.name, 'query_hotspots');
  assert.deepEqual(secondTurn[secondTurn.length - 1].parts[0].functionResponse?.response, {
    ok: true,
    summary: { MODIS: 2, VIIRS: 1 },
  });
});

test('runModelChat echoes raw model parts so tool call ids survive the round trip', async () => {
  const calls: ModelGenerateParams[] = [];
  const signedPart: ModelPart = {
    functionCall: { callId: 'call_abc', name: 'list_regions', args: {} },
  };
  const generate: ModelGenerateFn = async (params) => {
    calls.push(params);
    if (calls.length === 1) {
      return { text: '', functionCalls: [{ id: 'call_abc', name: 'list_regions', args: {} }], parts: [signedPart] };
    }
    return { text: 'done', functionCalls: [] };
  };

  await runModelChat({
    generate,
    model: 'test-model',
    systemInstruction: 'system',
    turns: [{ role: 'user', parts: [{ text: 'hi' }] }],
    toolDeclarations: [{ name: 'list_regions', description: 'd', parameters: { type: 'object', properties: {} } }],
    executeTool: async () => ({ ok: true }),
  });

  const modelTurn = calls[1].contents[calls[1].contents.length - 2];
  assert.equal(modelTurn.role, 'model');
  assert.equal(modelTurn.parts[0].functionCall?.callId, 'call_abc');
  assert.equal(modelTurn.parts[0].functionCall?.name, 'list_regions');
  const toolTurn = calls[1].contents[calls[1].contents.length - 1];
  assert.equal(toolTurn.role, 'user');
  assert.equal(toolTurn.parts[0].functionResponse?.toolCallId, 'call_abc');
});

test('runModelChat synthesises call ids when the provider omits them', async () => {
  const calls: ModelGenerateParams[] = [];
  const generate: ModelGenerateFn = async (params) => {
    calls.push(params);
    if (calls.length === 1) {
      return { text: '', functionCalls: [{ name: 'query_hotspots', args: {} }] };
    }
    return { text: 'done', functionCalls: [] };
  };

  await runModelChat({
    generate,
    model: 'test-model',
    systemInstruction: 'system',
    turns: [{ role: 'user', parts: [{ text: 'hi' }] }],
    toolDeclarations: [{ name: 'query_hotspots', description: 'd', parameters: { type: 'object', properties: {} } }],
    executeTool: async () => ({ ok: true }),
  });

  const modelTurn = calls[1].contents[calls[1].contents.length - 2];
  const toolTurn = calls[1].contents[calls[1].contents.length - 1];
  assert.equal(modelTurn.parts[0].functionCall?.callId, 'call_0');
  assert.equal(toolTurn.parts[0].functionResponse?.toolCallId, 'call_0');
});

test('runModelChat retries once on transient provider errors', async () => {
  let attempts = 0;
  const generate: ModelGenerateFn = async () => {
    attempts += 1;
    if (attempts === 1) {
      throw new ProviderError('Groq request failed: {"error":{"code":504,"status":"DEADLINE_EXCEEDED"}}', 'PROVIDER_ERROR', 502);
    }
    return { text: 'recovered', functionCalls: [] };
  };
  const result = await runModelChat({
    generate,
    model: 'test-model',
    systemInstruction: 'system',
    turns: [{ role: 'user', parts: [{ text: 'hi' }] }],
  });
  assert.equal(result.text, 'recovered');
  assert.equal(attempts, 2);
});

test('runModelChat does not retry client errors and propagates a second transient failure', async () => {
  let clientAttempts = 0;
  await assert.rejects(
    runModelChat({
      generate: async () => {
        clientAttempts += 1;
        throw new ProviderError('Groq request failed: {"error":{"code":400}}', 'PROVIDER_ERROR', 502);
      },
      model: 'test-model',
      systemInstruction: 'system',
      turns: [{ role: 'user', parts: [{ text: 'hi' }] }],
    }),
    /400/
  );
  assert.equal(clientAttempts, 1);

  let transientAttempts = 0;
  await assert.rejects(
    runModelChat({
      generate: async () => {
        transientAttempts += 1;
        throw new ProviderError('Groq request failed: deadline exceeded', 'PROVIDER_ERROR', 502);
      },
      model: 'test-model',
      systemInstruction: 'system',
      turns: [{ role: 'user', parts: [{ text: 'hi' }] }],
    }),
    /deadline/
  );
  assert.equal(transientAttempts, 2);
});

test('runModelChat waits out a short TPM rate-limit hint once', async () => {
  let attempts = 0;
  const generate: ModelGenerateFn = async () => {
    attempts += 1;
    if (attempts === 1) {
      throw new ProviderError(
        'The Groq API rate limit or quota was reached: Rate limit reached ... Please try again in 0.05s.',
        'RATE_LIMITED',
        429
      );
    }
    return { text: 'after wait', functionCalls: [] };
  };
  const result = await runModelChat({
    generate,
    model: 'test-model',
    systemInstruction: 'system',
    turns: [{ role: 'user', parts: [{ text: 'hi' }] }],
  });
  assert.equal(result.text, 'after wait');
  assert.equal(attempts, 2);
});

test('runModelChat parses millisecond retry hints', async () => {
  let attempts = 0;
  const generate: ModelGenerateFn = async () => {
    attempts += 1;
    if (attempts === 1) {
      throw new ProviderError(
        'The Groq API rate limit or quota was reached: Rate limit reached ... Please try again in 200ms.',
        'RATE_LIMITED',
        429
      );
    }
    return { text: 'after ms wait', functionCalls: [] };
  };
  const result = await runModelChat({
    generate,
    model: 'test-model',
    systemInstruction: 'system',
    turns: [{ role: 'user', parts: [{ text: 'hi' }] }],
  });
  assert.equal(result.text, 'after ms wait');
  assert.equal(attempts, 2);
});

test('runModelChat does not retry a rate limit without a short retry hint', async () => {
  let attempts = 0;
  await assert.rejects(
    runModelChat({
      generate: async () => {
        attempts += 1;
        throw new ProviderError('The Groq API rate limit or quota was reached: quota exhausted', 'RATE_LIMITED', 429);
      },
      model: 'test-model',
      systemInstruction: 'system',
      turns: [{ role: 'user', parts: [{ text: 'hi' }] }],
    }),
    /rate limit/i
  );
  assert.equal(attempts, 1);
});

test('runModelChat reports a failing tool to the model instead of crashing', async () => {
  let round = 0;
  const generate: ModelGenerateFn = async () => {
    round += 1;
    if (round === 1) return { text: '', functionCalls: [{ name: 'query_hotspots', args: {} }] };
    return { text: 'The data tool failed, so I cannot quote a count.', functionCalls: [] };
  };
  const result = await runModelChat({
    generate,
    model: 'test-model',
    systemInstruction: 's',
    turns: [{ role: 'user', parts: [{ text: 'q' }] }],
    toolDeclarations: [{ name: 'query_hotspots', description: 'd', parameters: { type: 'object', properties: {} } }],
    executeTool: async () => {
      throw new Error('upstream unavailable');
    },
  });
  assert.equal(result.toolCalls[0].ok, false);
  assert.match(result.text, /failed/);
});

test('runModelChat rejects empty answers and unbounded tool loops', async () => {
  await assert.rejects(
    () =>
      runModelChat({
        generate: async () => ({ text: '', functionCalls: [] }),
        model: 'm',
        systemInstruction: 's',
        turns: [{ role: 'user', parts: [{ text: 'q' }] }],
      }),
    (err: unknown) => err instanceof ProviderError && err.code === 'BAD_RESPONSE'
  );

  await assert.rejects(
    () =>
      runModelChat({
        generate: async () => ({ text: '', functionCalls: [{ name: 'loop', args: {} }] }),
        model: 'm',
        systemInstruction: 's',
        turns: [{ role: 'user', parts: [{ text: 'q' }] }],
        toolDeclarations: [{ name: 'loop', description: 'd', parameters: { type: 'object', properties: {} } }],
        executeTool: async () => ({ ok: true }),
      }),
    (err: unknown) => err instanceof ProviderError && /budget/.test(err.message)
  );
});

test('runModelChat times out a hanging provider', async () => {
  await assert.rejects(
    () =>
      runModelChat({
        generate: () => new Promise(() => {}),
        model: 'm',
        systemInstruction: 's',
        turns: [{ role: 'user', parts: [{ text: 'q' }] }],
        timeoutMs: 25,
      }),
    (err: unknown) => err instanceof ProviderError && err.code === 'TIMEOUT'
  );
});

// ----------------------------------------------------------------- config + limiter

test('AI config is off unless explicitly enabled and keyed', () => {
  assert.deepEqual(
    { enabled: readAiConfig({}).enabled, configured: readAiConfig({}).configured },
    { enabled: false, configured: false }
  );
  const on = readAiConfig({ FIRESYNC_AI_ENABLED: 'true', GROQ_API_KEY: 'k' });
  assert.equal(on.enabled, true);
  assert.equal(on.configured, true);
  assert.equal(aiStatus(on).status, 'enabled');
  assert.equal(aiStatus(readAiConfig({ GROQ_API_KEY: 'k' })).status, 'disabled');
  assert.equal(aiStatus(readAiConfig({ FIRESYNC_AI_ENABLED: 'true' })).status, 'not_configured');
});

test('the rate limiter blocks after the limit and resets after the window', () => {
  const limiter = new FixedWindowRateLimiter(2, 1000);
  assert.equal(limiter.check('ip', 0).allowed, true);
  assert.equal(limiter.check('ip', 1).allowed, true);
  const blocked = limiter.check('ip', 2);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSeconds >= 1);
  assert.equal(limiter.check('other-ip', 2).allowed, true, 'limits are per client');
  assert.equal(limiter.check('ip', 1001).allowed, true, 'the window resets');
});

// ----------------------------------------------------------------- routes

interface Harness {
  base: string;
  close: () => Promise<void>;
}

const AI_ENV = { FIRESYNC_AI_ENABLED: 'true', GROQ_API_KEY: 'server-only-test-key', GROQ_MODEL: 'test-model' };

async function start(
  env: NodeJS.ProcessEnv,
  generate?: ModelGenerateFn,
  fixtures: CanonicalObservation[] = FIXTURES
): Promise<Harness> {
  const { app } = createApp({
    store: new MemoryObservationStore(fixtures),
    env,
    now: () => new Date('2026-11-10T00:00:00Z'),
    enableLiveFires: false,
    ai: generate ? { generate } : undefined,
  });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

test('AI status is truthful and never exposes the key', async (t) => {
  const h = await start(AI_ENV);
  t.after(h.close);
  const res = await fetch(`${h.base}/api/v1/ai/status`);
  const text = await res.text();
  assert.equal(res.status, 200);
  assert.ok(!text.includes('server-only-test-key'), 'the body must not contain the key');
  const body = JSON.parse(text);
  assert.equal(body.status, 'enabled');
  assert.equal(body.model, 'test-model');
  assert.equal(body.capabilities.chat, true);
  assert.equal(body.capabilities.image_analysis, false);
});

test('AI routes answer 503 with a reason when unconfigured', async (t) => {
  const h = await start({});
  t.after(h.close);
  const res = await fetch(`${h.base}/api/v1/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'hello' }),
  });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.code, 'AI_NOT_CONFIGURED');
  assert.match(body.error, /GROQ_API_KEY|FIRESYNC_AI_ENABLED/);
});

test('chat answers with tool-backed numbers and applies a validated map action', async (t) => {
  const generate: ModelGenerateFn = async (params) => {
    const toolTurn = params.contents.some((c) => c.parts.some((p) => p.functionResponse));
    if (!toolTurn) {
      return {
        text: '',
        functionCalls: [
          { name: 'query_hotspots', args: { days: 1 } },
          { name: 'apply_map_filters', args: { sensors: 'MODIS' } },
        ],
      };
    }
    const toolResult = params.contents
      .flatMap((c) => c.parts)
      .find((p) => p.functionResponse?.name === 'query_hotspots')?.functionResponse?.response;
    const summary = (toolResult as { summary?: { by_sensor?: { MODIS?: number } } } | undefined)?.summary;
    return { text: `MODIS has ${summary?.by_sensor?.MODIS ?? 0} detections in this window.`, functionCalls: [] };
  };

  const h = await start(AI_ENV, generate);
  t.after(h.close);

  const res = await fetch(`${h.base}/api/v1/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'show MODIS only for the last day', context: { sensors: 'ALL' } }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.reply, 'MODIS has 2 detections in this window.');
  assert.deepEqual(body.actions, [{ type: 'apply_filters', sensors: 'MODIS' }]);
  assert.deepEqual(body.tool_calls.map((c: { name: string }) => c.name), ['query_hotspots', 'apply_map_filters']);
  assert.ok(body.guardrails.some((g: string) => /Satellite thermal anomalies/.test(g)));
  assert.ok(!JSON.stringify(body).includes('server-only-test-key'));
});

test('chat answers ranking questions through the deterministic fast path without calling Groq', async (t) => {
  let called = 0;
  const h = await start(AI_ENV, async () => {
    called += 1;
    return { text: 'model text', functionCalls: [] };
  });
  t.after(h.close);

  const res = await fetch(`${h.base}/api/v1/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'which area has the most fire hotspots today?', context: {} }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(called, 0, 'the fast path must not call the model');
  assert.equal(body.model, 'deterministic');
  assert.equal(body.tool_calls[0].name, 'rank_regions');
  assert.match(body.reply, /Bangladesh/);
  assert.match(body.reply, /Satellite thermal anomalies, not confirmed wildfires or burned area\./);
});

test('chat answers count questions through the fast path without calling Groq', async (t) => {
  let called = 0;
  const h = await start(AI_ENV, async () => {
    called += 1;
    return { text: 'model text', functionCalls: [] };
  });
  t.after(h.close);

  const res = await fetch(`${h.base}/api/v1/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'how many hotspots today?', context: {} }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(called, 0);
  assert.equal(body.model, 'deterministic');
  assert.equal(body.tool_calls[0].name, 'query_hotspots');
  assert.match(body.reply, /MODIS 2 detections, VIIRS 1 detections/);
});

test('chat rejects an empty message and an over-long one before calling Groq', async (t) => {
  let called = 0;
  const h = await start(AI_ENV, async () => {
    called += 1;
    return { text: 'x', functionCalls: [] };
  });
  t.after(h.close);

  for (const payload of [{ message: '' }, { message: 'x'.repeat(1600) }, {}]) {
    const res = await fetch(`${h.base}/api/v1/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    assert.equal(res.status, 400);
  }
  assert.equal(called, 0, 'invalid input never reaches the provider');
});

test('a provider failure is reported as 502, not as an invented answer', async (t) => {
  const h = await start(AI_ENV, async () => {
    throw new ProviderError('Groq request failed: upstream boom', 'PROVIDER_ERROR', 502);
  });
  t.after(h.close);
  const res = await fetch(`${h.base}/api/v1/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'hello' }),
  });
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.code, 'PROVIDER_ERROR');
});

test('the AI rate limit answers 429 with Retry-After', async (t) => {
  const h = await start(AI_ENV, async () => ({ text: 'ok', functionCalls: [] }));
  t.after(h.close);
  let limited: Response | null = null;
  for (let i = 0; i < 20; i += 1) {
    const res = await fetch(`${h.base}/api/v1/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hi' }),
    });
    if (res.status === 429) {
      limited = res;
      break;
    }
  }
  assert.ok(limited, 'the limiter must eventually answer 429');
  assert.ok(Number(limited?.headers.get('retry-after')) >= 1);
});

test('detection explanation returns the real evidence and what was missing', async (t) => {
  const h = await start(AI_ENV, async () => ({
    text: 'This VIIRS record at 06:10 UTC shows 4.2 MW of radiant power.\n\nSatellite thermal anomalies, not confirmed wildfires or burned area.',
    functionCalls: [],
  }));
  t.after(h.close);

  const res = await fetch(`${h.base}/api/v1/ai/detection-explanation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      observation: {
        id: 'v-1',
        sensor: 'VIIRS',
        satellite: 'NOAA-20',
        latitude: 22.1,
        longitude: 90.1,
        acq_date: '2026-11-09',
        acq_time: '0610',
        datetime_utc: '2026-11-09T06:10:00Z',
        confidence: 'nominal',
        frp_mw: 4.2,
        product: 'VIIRS_NOAA20_NRT',
      },
    }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.evidence.id, 'v-1');
  assert.equal(body.evidence.frp_mw, 4.2);
  assert.ok(body.fields_missing.includes('brightness'));
  assert.match(body.explanation, /Satellite thermal anomalies/);
});

test('detection explanation rejects malformed observations', async (t) => {
  const h = await start(AI_ENV, async () => ({ text: 'x', functionCalls: [] }));
  t.after(h.close);
  const res = await fetch(`${h.base}/api/v1/ai/detection-explanation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ observation: { id: 'x', sensor: 'MODIS', latitude: 500, longitude: 0, frp_mw: 1, acq_date: '2026-11-09', datetime_utc: 'x' } }),
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'INVALID_OBSERVATION');
});

test('cluster investigation is deterministic and an unknown group is a real 404', async (t) => {
  const fixtures = [
    observation({
      id: 'm-1',
      sensor: 'MODIS',
      acq_date: '2026-11-10',
      datetime_utc: '2026-11-10T06:10:00Z',
      latitude: 22.1,
      longitude: 90.1,
      frp_mw: 12,
    }),
    observation({
      id: 'v-1',
      sensor: 'VIIRS',
      acq_date: '2026-11-10',
      datetime_utc: '2026-11-10T06:10:00Z',
      latitude: 22.1,
      longitude: 90.1,
      frp_mw: 4,
    }),
  ];
  const h = await start({}, undefined, fixtures);
  t.after(h.close);

  const res = await fetch(`${h.base}/api/v1/ai/cluster-investigation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bbox: '90,22,91,23', days: 1 }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.total_clusters, 1);
  assert.equal(body.cluster.by_sensor.MODIS, 1);
  assert.equal(body.cluster.by_sensor.VIIRS, 1);
  assert.equal(body.report, null);
  assert.equal(body.ai.status, 'disabled');
  assert.equal(body.sensors, 'ALL');
  assert.ok(Array.isArray(body.guardrails));

  const missing = await fetch(`${h.base}/api/v1/ai/cluster-investigation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bbox: '90,22,91,23', days: 1, cluster_id: 'missing' }),
  });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).code, 'CLUSTER_NOT_FOUND');
});

test('sensor explanation keeps categorical VIIRS confidence null instead of inventing a zero mean', async (t) => {
  const fixtures = [
    observation({ id: 'm-1', sensor: 'MODIS', acq_date: '2026-11-10', datetime_utc: '2026-11-10T10:00:00Z', confidence: 80 }),
    observation({ id: 'v-1', sensor: 'VIIRS', acq_date: '2026-11-10', datetime_utc: '2026-11-10T10:00:00Z', confidence: 'nominal' }),
  ];
  const h = await start({}, undefined, fixtures);
  t.after(h.close);

  const res = await fetch(`${h.base}/api/v1/ai/sensor-explanation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bbox: '90,22,91,23', days: 1 }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.comparison.MODIS.detections, 1);
  assert.equal(body.comparison.VIIRS.detections, 1);
  assert.equal(body.comparison.MODIS.mean_confidence, 80);
  assert.equal(body.comparison.VIIRS.mean_confidence, null, 'a categorical confidence is not a numeric zero');
  assert.equal(body.explanation, null);
  assert.equal(body.ai.status, 'disabled');
});

const stubAgni = {
  status: async () => ({ available: true, rows: 30361118, min_year: 2002, max_year: 2025, min_month: '2002-07', max_month: '2025-12' }),
  series: async (q: { year?: number; month?: number }) => {
    if (q.year !== undefined && q.month !== undefined) {
      return [
        { year: q.year, month: q.month, detections: 500, cells_with_data: 40, partial_coverage: false },
        { year: q.year, month: q.month + 1 > 12 ? q.month + 1 : q.month, detections: 900, cells_with_data: 60, partial_coverage: false },
      ];
    }
    return [
      { year: 2019, month: 8, detections: 12000, cells_with_data: 900, partial_coverage: false },
      { year: 2019, month: 9, detections: 25000, cells_with_data: 1100, partial_coverage: false },
      { year: 2020, month: 8, detections: 8000, cells_with_data: 700, partial_coverage: false },
    ];
  },
  cells: async () => [
    { cell_id: 'EPSG8857_10000m_r-140_c-477', grid_row: -140, grid_col: -477, lon: -50.16, lat: -10.89, value: 73, frp_sum_mw: 9737.4 },
  ],
  countries: async () => ['Australia', 'Brazil', 'United States'],
};

test('agnicalendar_series returns yearly totals and peak months', async () => {
  const exec = await executeAiTool(
    'agnicalendar_series',
    { layer: 'aqua', daynight: 'known', start_year: 2019, end_year: 2020 },
    { load: stubLoader, today: '2026-11-10', agni: stubAgni }
  );
  assert.equal(exec.record.ok, true);
  const yearly = exec.response.yearly_totals as Array<{ year: number; detections: number }>;
  assert.equal(yearly[0].detections, 37000);
  const peak = exec.response.peak_months as Array<{ month: number }>;
  assert.equal(peak[0].month, 9);
  const notes = exec.response.notes as string[];
  assert.ok(notes.some((n) => n.includes('unavailable data, never zero')));
});

test('agnicalendar_calendar aggregates per calendar month', async () => {
  const exec = await executeAiTool(
    'agnicalendar_calendar',
    { layer: 'harmonized' },
    { load: stubLoader, today: '2026-11-10', agni: stubAgni }
  );
  assert.equal(exec.record.ok, true);
  const months = exec.response.months_by_activity as Array<{ month: number; total_detections: number; months_with_data: number }>;
  assert.equal(months[0].month, 9);
  assert.equal(months[0].total_detections, 25000);
});

test('agnicalendar_cells returns top cells with lat/lon', async () => {
  const exec = await executeAiTool(
    'agnicalendar_cells',
    { year: 2019, month: 9, layer: 'aqua', daynight: 'day' },
    { load: stubLoader, today: '2026-11-10', agni: stubAgni }
  );
  assert.equal(exec.record.ok, true);
  const cells = exec.response.cells as Array<{ cell_id: string; lat: number; lon: number; value: number }>;
  assert.equal(cells[0].cell_id, 'EPSG8857_10000m_r-140_c-477');
  assert.equal(cells[0].value, 73);
});

test('agnicalendar_cells rejects invalid year/month', async () => {
  const exec = await executeAiTool(
    'agnicalendar_cells',
    { year: 1999, month: 9 },
    { load: stubLoader, today: '2026-11-10', agni: stubAgni }
  );
  assert.equal(exec.record.ok, false);
});

test('agni fast path answers harmonized-grid questions without a model', async () => {
  const deps = { load: stubLoader, today: '2026-11-10', agni: stubAgni, history: stubHistory };

  // Seasonal calendar on the harmonized grid.
  const cal = await runDeterministicFastPath('which months are usually most active in Australia on the harmonized grid', deps);
  assert.ok(cal !== null);
  assert.equal(cal.record.name, 'agnicalendar_calendar');
  assert.match(cal.reply, /AgniCalendar/);
  assert.match(cal.reply, /not a forecast/);

  // Monthly series with explicit range.
  const ser = await runDeterministicFastPath('show harmonized cell-month activity in Brazil 2019-2020', deps);
  assert.ok(ser !== null);
  assert.equal(ser.record.name, 'agnicalendar_series');
  assert.match(ser.reply, /37,000|12000|25000/);

  // Top cells for an explicit year+month.
  const cells = await runDeterministicFastPath('which cells were most active in September 2019 on the harmonized grid', deps);
  assert.ok(cells !== null);
  assert.equal(cells.record.name, 'agnicalendar_cells');
  assert.match(cells.reply, /EPSG8857_10000m/);

  // Live phrasing and non-agni text must not hit the agni path.
  assert.equal(await runDeterministicFastPath('harmonized activity today in Australia', deps), null);
  assert.equal(await runDeterministicFastPath('how many hotspots today', deps) !== null, true);
});

const stubIncidents = {
  verify: async () => ({
    incidents: [
      {
        id: 'IRWIN-1',
        name: 'Test Fire',
        type_category: 'WF',
        type_kind: 'WF',
        state: 'US-CO',
        city: 'Test',
        county: 'Test County',
        lat: 40.1,
        lon: -106.5,
        size_acres: 120,
        percent_contained: 10,
        discovered_at: '2026-11-10T05:00:00Z',
        out_at: null,
        cause: 'Lightning',
        gacc: 'NRCC',
        nearby_detections: 4,
        nearest_detection_km: 2.1,
        match: 'satellite_corroborated' as const,
      },
    ],
    summary: { total: 1, satellite_corroborated: 1, no_nearby_detections: 0, unmatchable: 0, observations_checked: 2 },
    parameters: { radius_km: 10, window_hours: 72, days: 14 },
    source: {
      name: 'WFIGS Current Wildland Fire Incident Locations (IRWIN)',
      url: 'https://example.invalid',
      attribution: 'WFIGS',
      coverage: 'US wildland fires',
      retrieved_at: '2026-11-10T00:00:00Z',
      cached: false,
      record_count: 1,
    },
    legend: 'Satellite thermal anomalies, not confirmed wildfires or burned area.',
    note: 'stub',
  }),
};

test('official_incidents returns corroborated US incidents', async () => {
  const exec = await executeAiTool(
    'official_incidents',
    { days: 14, state: 'US-CO' },
    { load: stubLoader, today: '2026-11-10', incidents: stubIncidents }
  );
  assert.equal(exec.record.ok, true);
  const summary = exec.response.summary as { total: number; satellite_corroborated: number };
  assert.equal(summary.total, 1);
  assert.equal(summary.satellite_corroborated, 1);
  const incidents = exec.response.incidents as Array<{ match: string; name: string }>;
  assert.equal(incidents[0].match, 'satellite_corroborated');
  const notes = exec.dataNotes.join(' ');
  assert.ok(notes.includes('never a confirmed wildfire'));
});

test('incident fast path answers official-fire questions without a model', async () => {
  const deps = { load: stubLoader, today: '2026-11-10', incidents: stubIncidents };

  const res = await runDeterministicFastPath('are there any official fires in Colorado right now', deps);
  assert.ok(res !== null);
  assert.equal(res.record.name, 'official_incidents');
  assert.match(res.reply, /1 total — 1 with nearby satellite detections/);
  assert.match(res.reply, /Test Fire: US-CO|Test Fire/);
  assert.match(res.reply, /120 acres/);
  assert.match(res.reply, /not proof of, the reported fire/);

  // Explicit historical phrasing stays with the archive/model path.
  assert.equal(await runDeterministicFastPath('official fires in Colorado in 2019', deps), null);
  // Non-incident questions are untouched.
  assert.equal(await runDeterministicFastPath('how many hotspots today', deps) !== null, true);
});

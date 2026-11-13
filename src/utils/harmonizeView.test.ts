import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CanonicalObservation, SatelliteType } from '../types/fire';
import { matchModisViirs, MATCHING_DEFAULTS } from './matching';
import { computeGridCellIndex } from './spatial';
import {
  LEGEND_SENTENCE,
  LOW_SAMPLE_N,
  SENSITIVITY_BLOCK_DEG,
  SENSITIVITY_MAX_INPUT,
  SENSITIVITY_SAMPLE_TARGET,
  agreementCellsToGeoJSON,
  CELL_DAY_LIMITATIONS,
  cellDayAgreement,
  OVERPASS_MIN_N,
  circularGapMinutes,
  circularMedianHours,
  formatClock,
  observedOverpassTimes,
  utcHoursOfDay,
  windowFeasibility,
  computeRobustFrp,
  isDefaultSatelliteSelection,
  satelliteSelectionToOptions,
  spatialBlockSample,
  spearmanRho,
  summarizeTimeOffsets,
  buildHarmonizeView,
  buildScatterGeometry,
  buildWhyDiffer,
  PARTIAL_OTHER_SENSOR_MIN,
  classifyDates,
  computeHarmonizeView,
  computeHarmonizeViewComplete,
  countsByDate,
  niceTicks,
  partialReasonText,
  utcDateOf,
  runSensitivity,
  separateInputs,
  splitBySensor,
} from './harmonizeView';

// ---------------------------------------------------------------------------
// Synthetic data (no network, no NASA, no randomness)
// ---------------------------------------------------------------------------

const T0 = Date.UTC(2026, 0, 15, 6, 0, 0);
const KM_PER_DEG = 111.195;

interface ObsSpec {
  id: string;
  sensor: 'MODIS' | 'VIIRS';
  lat: number;
  lon: number;
  dtMin?: number;
  frp?: number;
  scan?: number;
  track?: number;
  satellite?: SatelliteType;
  daynight?: 'D' | 'N';
  brightness?: number;
  ti4?: number;
}

function obs(s: ObsSpec): CanonicalObservation {
  const iso = new Date(T0 + (s.dtMin ?? 0) * 60_000).toISOString();
  const modis = s.sensor === 'MODIS';
  const px = modis ? 1 : 0.375;
  return {
    id: s.id,
    source_record_id: s.id,
    latitude: s.lat,
    longitude: s.lon,
    acq_date: iso.slice(0, 10),
    acq_time: iso.slice(11, 13) + iso.slice(14, 16),
    datetime_utc: iso,
    sensor: s.sensor,
    satellite: s.satellite ?? (modis ? 'Aqua' : 'NOAA-20'),
    product: modis ? 'MODIS_NRT' : 'VIIRS_NOAA20_NRT',
    processing_version: 'test',
    confidence: 'nominal',
    confidence_category: 'nominal',
    frp_mw: s.frp ?? 10,
    brightness: s.brightness,
    bright_ti4: s.ti4,
    scan: s.scan ?? px,
    track: s.track ?? px,
    daynight: s.daynight ?? 'D',
    source_file: 'synthetic',
    retrieved_at: iso,
    quality_flags: '',
    record_hash: s.id,
  };
}

const M = (id: string, lat: number, lon: number, o: Partial<ObsSpec> = {}) => obs({ id, sensor: 'MODIS', lat, lon, ...o });
const V = (id: string, lat: number, lon: number, o: Partial<ObsSpec> = {}) => obs({ id, sensor: 'VIIRS', lat, lon, ...o });

/** `count` co-located MODIS/VIIRS pairs spaced 0.05 deg apart (far beyond any default radius). */
function pairs(count: number, frp: (i: number) => [number, number] = (i) => [10 + i, 10 + i]) {
  const modis: CanonicalObservation[] = [];
  const viirs: CanonicalObservation[] = [];
  for (let i = 0; i < count; i++) {
    const [mf, vf] = frp(i);
    modis.push(M(`m${i}`, 10 + i * 0.05, 20, { frp: mf }));
    viirs.push(V(`v${i}`, 10 + i * 0.05, 20, { frp: vf }));
  }
  return { modis, viirs };
}

const close = (a: number | null, b: number, eps = 1e-9) => {
  assert.notEqual(a, null);
  assert.ok(Math.abs((a as number) - b) < eps, `${a} !== ${b}`);
};

// ---------------------------------------------------------------------------
// View model
// ---------------------------------------------------------------------------

test('view: counts reconcile and sensors stay separate', () => {
  const modis = [M('m1', 10, 20), M('m2', 10.5, 20), M('m3', 11, 20)];
  const viirs = [V('v1', 10, 20), V('v2', 12, 20)];
  const { view } = computeHarmonizeView(modis, viirs);

  assert.equal(view.label, 'EXPLORATORY');
  assert.deepEqual(Object.keys(view.inputs), ['modis', 'viirs']);
  assert.deepEqual(view.inputs, { modis: 3, viirs: 2 });
  assert.equal(view.point.matched, 1);
  assert.equal(view.point.matched + view.point.viirsOnly, view.inputs.viirs);
  assert.equal(view.point.matched + view.point.modisOnly, view.inputs.modis);
  close(view.point.matchedShareOfModis, 1 / 3);
  close(view.point.matchedShareOfViirs, 1 / 2);
  close(view.detectionRatio.overall, 2 / 3);
  assert.match(view.uncertainty, /EXPLORATORY/);
  assert.ok(view.limitations.length > 0);
  assert.ok(view.method.length > 0);
});

test('view: params default to matching.ts defaults', () => {
  const { view } = computeHarmonizeView([M('m', 10, 20)], [V('v', 10, 20)]);
  assert.equal(view.params.maxDistanceKm, MATCHING_DEFAULTS.maxDistanceKm);
  assert.equal(view.params.maxTimeDiffMinutes, MATCHING_DEFAULTS.maxTimeDiffMinutes);
});

test('view: FRP statistics match a hand calculation (point level)', () => {
  // x = MODIS [10,20,30], y = VIIRS [12,18,36]
  // diffs = [+2,-2,+6]: bias 2, MAE 10/3, RMSE sqrt(44/3); OLS slope 240/200 = 1.2, intercept 22 - 1.2*20 = -2
  const modis = [M('m1', 10, 20, { frp: 10 }), M('m2', 11, 20, { frp: 20 }), M('m3', 12, 20, { frp: 30 })];
  const viirs = [V('v1', 10, 20, { frp: 12 }), V('v2', 11, 20, { frp: 18 }), V('v3', 12, 20, { frp: 36 })];
  const { view } = computeHarmonizeView(modis, viirs);
  const f = view.frp.point;

  assert.equal(f.n, 3);
  assert.equal(f.level, 'point');
  close(f.bias, 2);
  close(f.mae, 10 / 3);
  close(f.rmse, Math.sqrt(44 / 3));
  assert.ok(f.regression);
  close(f.regression!.slope, 1.2);
  close(f.regression!.intercept, -2);
  assert.equal(f.points.length, 3);
  assert.deepEqual(f.points[0], { modisFrpMw: 10, viirsFrpMw: 12 });
  assert.equal(f.lowSample, true);
});

test('view: scatter points and n agree with matching.ts for both levels', () => {
  const { modis, viirs } = pairs(8, (i) => [5 + i, 6 + 2 * i]);
  // add a second VIIRS pixel inside footprint 0 and one with unusable FRP
  viirs.push(V('v0b', 10, 20.0002, { frp: 4 }));
  modis.push(M('mz', 30, 30, { frp: 0 }));
  viirs.push(V('vz', 30, 30, { frp: 7 }));
  const { view, result } = computeHarmonizeView(modis, viirs);

  assert.equal(view.frp.point.points.length, result.point.frpAgreement.n);
  assert.equal(view.frp.point.n, result.point.frpAgreement.n);
  assert.equal(view.frp.cell.points.length, result.cell.frpAgreement.n);
  assert.equal(view.frp.point.excluded, 1); // the FRP=0 MODIS pair
  // cell 0 carries the VIIRS-only sum 6 + 4, compared with MODIS 5 (never added to it)
  const c0 = view.frp.cell.points.find((p) => p.modisFrpMw === 5);
  assert.deepEqual(c0, { modisFrpMw: 5, viirsFrpMw: 10 });
});

test('view: empty and one-sided inputs do not throw and carry no NaN', () => {
  const none = computeHarmonizeView([], []).view;
  assert.equal(none.inputs.modis + none.inputs.viirs, 0);
  assert.equal(none.detectionRatio.overall, null);
  assert.equal(none.point.matchedShareOfModis, null);
  assert.ok(none.warnings.some((w) => /Both sensors are needed/.test(w)));

  const onlyViirs = computeHarmonizeView([], [V('v', 1, 1)]).view;
  assert.equal(onlyViirs.detectionRatio.overall, null);
  assert.equal(onlyViirs.frp.point.n, 0);
  assert.ok(onlyViirs.warnings.some((w) => /0 MODIS and 1 VIIRS/.test(w)));
  assert.doesNotMatch(JSON.stringify(none), /NaN|\[object Object\]/);
});

test('view: small-n warning shows below the threshold and not at it', () => {
  const a = pairs(LOW_SAMPLE_N - 1);
  const small = computeHarmonizeView(a.modis, a.viirs).view;
  assert.ok(small.warnings.some((w) => w.includes(`n=${LOW_SAMPLE_N - 1}`) && /Small sample/.test(w)));

  const b = pairs(LOW_SAMPLE_N);
  const enough = computeHarmonizeView(b.modis, b.viirs).view;
  assert.equal(enough.frp.point.lowSample, false);
  assert.ok(!enough.warnings.some((w) => /Small sample/.test(w)));
});

test('view: zero pairs is reported as such, mixed VIIRS satellites flagged', () => {
  const modis = [M('m', 10, 20)];
  const viirs = [V('v1', 15, 25, { satellite: 'NOAA-20' }), V('v2', 16, 26, { satellite: 'Suomi-NPP' })];
  const { view } = computeHarmonizeView(modis, viirs);
  assert.ok(view.warnings.some((w) => /No point pairs found/.test(w)));
  assert.ok(view.warnings.some((w) => /2 satellites/.test(w)));
});

test('inputs: sensors tagged for the other list are dropped and counted, never reclassified', () => {
  const sep = separateInputs([M('m', 1, 1), V('vx', 1, 1)], [V('v', 1, 1), M('mx', 1, 1)]);
  assert.equal(sep.modis.length, 1);
  assert.equal(sep.viirs.length, 1);
  assert.equal(sep.mismatched, 2);
  const { view } = computeHarmonizeView([M('m', 1, 1), V('vx', 1, 1)], [V('v', 1, 1)]);
  assert.ok(view.warnings.some((w) => /other sensor/.test(w)));

  const split = splitBySensor([M('a', 1, 1), V('b', 1, 1), M('c', 2, 2)]);
  assert.equal(split.modis.length, 2);
  assert.equal(split.viirs.length, 1);
});

test('view: does not mutate its inputs', () => {
  const modis = [M('m1', 10, 20), M('m2', 11, 20)];
  const viirs = [V('v1', 10, 20)];
  const before = JSON.stringify([modis, viirs]);
  computeHarmonizeView(modis, viirs);
  assert.equal(JSON.stringify([modis, viirs]), before);
});

// ---------------------------------------------------------------------------
// Sensitivity
// ---------------------------------------------------------------------------

test('sensitivity: matched count changes with distance and time window', () => {
  // v1 is 1.5 km from m1 at dt 0           -> needs distance >= 1.5
  // v2 is co-located with m2 but +100 min  -> needs window >= 100
  const dLon15 = 1.5 / KM_PER_DEG / Math.cos((10 * Math.PI) / 180);
  const modis = [M('m1', 10, 20), M('m2', 12, 20)];
  const viirs = [V('v1', 10, 20 + dLon15), V('v2', 12, 20, { dtMin: 100 })];
  const all = [...modis, ...viirs];
  const current = matchModisViirs(all); // defaults: 1 km, 180 min
  assert.equal(current.point.matched.length, 1); // only v2 (within 180 min)

  const rep = runSensitivity(all, current);
  assert.equal(rep.rows.length, 9);
  assert.equal(rep.label, 'EXPLORATORY');
  assert.equal(rep.skippedReason, null);

  const row = (d: number, t: number) => rep.rows.find((r) => r.maxDistanceKm === d && r.maxTimeDiffMinutes === t)!;
  assert.equal(row(0.5, 30).matched, 0);
  assert.equal(row(1, 90).matched, 0);
  assert.equal(row(1, 180).matched, 1);
  assert.equal(row(2, 30).matched, 1); // v1 now in range, v2 still outside 30 min
  assert.equal(row(2, 180).matched, 2);

  assert.equal(row(1, 180).isCurrent, true);
  assert.equal(rep.rows.filter((r) => r.isCurrent).length, 1);
  assert.equal(row(1, 180).deltaMatchedVsCurrent, 0);
  assert.equal(row(2, 180).deltaMatchedVsCurrent, 1);
  assert.equal(row(2, 180).matchedShareOfModis, 1);
  assert.deepEqual([rep.range!.matchedMin, rep.range!.matchedMax], [0, 2]);
  assert.match(rep.summary, /ranged 0–2 \(currently 1\)/);
  assert.ok(rep.limitations.length > 0);
});

test('sensitivity: respects base options other than distance/time and a custom grid', () => {
  const all = [
    M('m1', 10, 20),
    M('m2', 12, 20),
    V('v1', 10, 20, { satellite: 'NOAA-20' }),
    V('v2', 12, 20, { satellite: 'Suomi-NPP' }),
  ];
  const base = { viirsSatellites: ['NOAA-20'] as SatelliteType[] };
  const current = matchModisViirs(all, base);
  const rep = runSensitivity(all, current, base, { distancesKm: [1], timeWindowsMin: [60, 120] });
  assert.equal(rep.rows.length, 2);
  assert.ok(rep.rows.every((r) => r.matched === 1)); // Suomi-NPP excluded by the base option
  assert.match(rep.summary, /did not change/);
  assert.equal(matchModisViirs(all).point.matched.length, 2); // sanity: without the filter both pair up
});

test('sensitivity: empty input is skipped with a reason, not faked', () => {
  const empty = runSensitivity([], matchModisViirs([]));
  assert.equal(empty.rows.length, 0);
  assert.ok(empty.skippedReason);
  assert.equal(empty.sample, null);
});

/** Pairs spread over many 0.25 deg blocks: lat step 0.3 so each pair sits in its own block. */
function blockData(count: number) {
  const all: CanonicalObservation[] = [];
  for (let i = 0; i < count; i++) {
    const lat = -20 + Math.floor(i / 40) * 0.3;
    const lon = -60 + (i % 40) * 0.3;
    all.push(M(`m${i}`, lat, lon, { dtMin: 0 }));
    all.push(V(`v${i}`, lat, lon, { dtMin: 20 }));
  }
  return all;
}

test('sensitivity: no silent skip above the old 6000 cap (full run up to the new cap)', () => {
  assert.ok(SENSITIVITY_MAX_INPUT > 6000);
  assert.ok(SENSITIVITY_SAMPLE_TARGET <= SENSITIVITY_MAX_INPUT);
  const all = blockData(3500); // 7000 valid detections > 6000
  const rep = runSensitivity(all, matchModisViirs(all));
  assert.equal(rep.skippedReason, null);
  assert.equal(rep.sample, null);
  assert.equal(rep.rows.length, 9);
  assert.equal(rep.rows.find((r) => r.isCurrent)!.matched, 3500);
});

test('sensitivity: above the cap it runs on a labelled spatial-block sample, deterministically', () => {
  const all = blockData(300); // 600 detections, cap lowered for the test
  const current = matchModisViirs(all);
  const opts = { maxInput: 400, sampleTarget: 200 };
  const a = runSensitivity(all, current, {}, undefined, opts);
  const b = runSensitivity([...all], matchModisViirs([...all]), {}, undefined, opts);

  assert.equal(a.skippedReason, null);
  assert.ok(a.sample);
  assert.equal(a.sample!.of, 600);
  assert.ok(a.sample!.n <= 200 && a.sample!.n > 0);
  assert.equal(a.sample!.label, `computed on a sample of ${a.sample!.n} of 600 detections`);
  assert.match(a.summary, /computed on a sample of \d+ of 600 detections/);
  assert.ok(a.limitations.some((l) => /Sample:/.test(l)));
  assert.equal(a.rows.length, 9);
  // Whole pairs stay together (each pair sits inside one block): every kept MODIS has its VIIRS.
  const cur = a.rows.find((r) => r.isCurrent)!;
  assert.equal(cur.matched, a.sample!.n / 2);
  assert.equal(cur.deltaMatchedVsCurrent, 0);
  assert.equal(a.current.matched, cur.matched);
  // Same input -> same output (also across a copied array).
  assert.deepEqual(a, b);
});

test('sensitivity: sample does not depend on input order', () => {
  const all = blockData(300);
  const reversed = [...all].reverse();
  const a = spatialBlockSample(all, 200);
  const b = spatialBlockSample(reversed, 200);
  assert.deepEqual(new Set(a.observations.map((o) => o.id)), new Set(b.observations.map((o) => o.id)));
  assert.equal(a.blocksKept, b.blocksKept);
});

test('spatialBlockSample: keeps whole blocks only and stays within the target', () => {
  const all = blockData(300);
  const s = spatialBlockSample(all, 100, SENSITIVITY_BLOCK_DEG);
  assert.ok(s.observations.length <= 100);
  assert.equal(s.blocksTotal, 300);
  const key = (o: CanonicalObservation) => `${Math.floor(o.latitude / SENSITIVITY_BLOCK_DEG)}:${Math.floor(o.longitude / SENSITIVITY_BLOCK_DEG)}`;
  const keptKeys = new Set(s.observations.map(key));
  for (const o of all) if (keptKeys.has(key(o))) assert.ok(s.observations.includes(o), 'a kept block lost a detection');
  // A single oversized block is still kept rather than returning nothing.
  const dense = [M('a', 1, 1), V('b', 1, 1), M('c', 1.01, 1.01)];
  assert.equal(spatialBlockSample(dense, 1).observations.length, 3);
});

test('sensitivity: one very dense block is split into finer blocks so the sample stays near the target', () => {
  // 400 detections inside one 0.25 deg block (a 10 x 10 grid of pairs, 0.02 deg apart).
  const dense: CanonicalObservation[] = [];
  for (let i = 0; i < 200; i++) {
    const lat = 5 + (i % 10) * 0.02;
    const lon = 5 + Math.floor(i / 10) * 0.012;
    dense.push(M(`m${i}`, lat, lon), V(`v${i}`, lat, lon, { dtMin: 10 }));
  }
  const rep = runSensitivity(dense, matchModisViirs(dense), {}, undefined, { maxInput: 100, sampleTarget: 100 });
  assert.ok(rep.sample);
  assert.ok(rep.sample!.blockDeg < SENSITIVITY_BLOCK_DEG);
  assert.ok(rep.sample!.n <= 150, `sample ${rep.sample!.n}`);
  assert.match(rep.sample!.label, /^computed on a sample of \d+ of 400 detections$/);
  const again = runSensitivity([...dense], matchModisViirs(dense), {}, undefined, { maxInput: 100, sampleTarget: 100 });
  assert.deepEqual(rep, again);
});

test('sensitivity: sample missing a sensor is reported, not faked', () => {
  // Two blocks, one holding only MODIS and one only VIIRS; a target of 2 keeps exactly one block, so one sensor is missing.
  const modisOnlyBlock = [M('x1', 10, 10), M('x2', 10.01, 10.01)];
  const viirsBlock = [V('y1', 40, 40), V('y2', 40.01, 40.01)];
  const data = [...modisOnlyBlock, ...viirsBlock];
  const rep = runSensitivity(data, matchModisViirs(data), {}, undefined, { maxInput: 2, sampleTarget: 2 });
  assert.equal(rep.rows.length, 0);
  assert.match(rep.skippedReason ?? '', /sample holds no (MODIS|VIIRS)/);
  assert.ok(rep.sample);
});

// ---------------------------------------------------------------------------
// Satellite selection + presets
// ---------------------------------------------------------------------------

test('satellite selection: default adds no filter keys; selections map to matching.ts filters', () => {
  assert.deepEqual(satelliteSelectionToOptions({ modis: 'all', viirs: 'all' }), {});
  assert.equal(isDefaultSatelliteSelection({ modis: 'all', viirs: 'all' }), true);
  assert.deepEqual(satelliteSelectionToOptions({ modis: 'Terra', viirs: 'NOAA-21' }), { modisSatellites: ['Terra'], viirsSatellites: ['NOAA-21'] });
  assert.deepEqual(satelliteSelectionToOptions({ modis: 'all', viirs: 'NOAA-20+NOAA-21' }), { viirsSatellites: ['NOAA-20', 'NOAA-21'] });
  assert.equal(isDefaultSatelliteSelection({ modis: 'Aqua', viirs: 'all' }), false);
});

test('satellite selection: filters change counts per sensor, default stays pooled, partial-day logic unchanged', () => {
  const now = Date.UTC(2026, 0, 20, 12, 0, 0); // far after the data, so no partial day
  const modis = [
    M('t1', 10, 20, { satellite: 'Terra', dtMin: -150 }),
    M('a1', 11, 20, { satellite: 'Aqua', dtMin: 0 }),
    M('a2', 12, 20, { satellite: 'Aqua', dtMin: 0 }),
  ];
  const viirs = [
    V('n20', 10, 20, { satellite: 'NOAA-20', dtMin: 0 }),
    V('n20b', 11, 20, { satellite: 'NOAA-20', dtMin: 20 }),
    V('n21', 12, 20, { satellite: 'NOAA-21', dtMin: 20 }),
  ];
  const pooled = computeHarmonizeViewComplete(modis, viirs, { now, matching: {} });
  assert.deepEqual(pooled.view!.inputs, { modis: 3, viirs: 3 });

  const sel = computeHarmonizeViewComplete(modis, viirs, {
    now,
    matching: { maxTimeDiffMinutes: 60, ...satelliteSelectionToOptions({ modis: 'Aqua', viirs: 'NOAA-20' }) },
  });
  assert.deepEqual(sel.view!.inputs, { modis: 2, viirs: 2 }); // counts stay per sensor
  assert.deepEqual(sel.view!.diagnostics.modisSatellites, ['Aqua']);
  assert.deepEqual(sel.view!.diagnostics.viirsSatellites, ['NOAA-20']);
  assert.equal(sel.view!.point.matched, 1);
  // Date classification and exclusion use the unfiltered lists, exactly as before.
  assert.deepEqual(sel.dates, pooled.dates);
  assert.equal(sel.status, 'ok');
});

test('sensitivity: base satellite filters are honoured in every row', () => {
  const all = [
    M('a1', 10, 20, { satellite: 'Aqua' }),
    V('n20', 10, 20, { satellite: 'NOAA-20', dtMin: 10 }),
    M('t1', 11, 20, { satellite: 'Terra' }),
    V('n21', 11, 20, { satellite: 'NOAA-21', dtMin: 10 }),
  ];
  const base = satelliteSelectionToOptions({ modis: 'Aqua', viirs: 'NOAA-20' });
  const rep = runSensitivity(all, matchModisViirs(all, base), base);
  assert.ok(rep.rows.every((r) => r.matched <= 1));
  assert.equal(rep.rows.find((r) => r.isCurrent)!.matched, 1);
});

// ---------------------------------------------------------------------------
// Time-offset summary
// ---------------------------------------------------------------------------

test('time offset: median, max, outer-20% count and edge note', () => {
  const offsets = [10, 150, 160, 170, 175];
  const modis = offsets.map((_, i) => M(`m${i}`, 10 + i * 0.05, 20, { satellite: 'Terra' }));
  const viirs = offsets.map((d, i) => V(`v${i}`, 10 + i * 0.05, 20, { dtMin: d, satellite: 'NOAA-20' }));
  const { view } = computeHarmonizeView(modis, viirs, { maxTimeDiffMinutes: 180 });
  const t = view.timeOffset;
  assert.equal(t.n, 5);
  assert.equal(t.windowMin, 180);
  assert.equal(t.medianAbsMin, 160);
  assert.equal(t.maxAbsMin, 175);
  assert.equal(t.outerCount, 4); // >= 144 min
  close(t.outerShare, 0.8);
  assert.equal(t.atEdge, true);
  assert.match(t.note ?? '', /4 of 5 pairs \(80%\) lie in the outer 20% of the ±180 min window/);
  assert.deepEqual(t.bySatellitePair, [{ modis: 'Terra', viirs: 'NOAA-20', n: 5, medianAbsMin: 160 }]);
});

test('time offset: no note when offsets are spread; empty when no pairs; negative offsets use |offset|', () => {
  const spread = summarizeTimeOffsets(
    matchModisViirs([
      M('m1', 10, 20),
      V('v1', 10, 20, { dtMin: -20 }),
      M('m2', 11, 20),
      V('v2', 11, 20, { dtMin: 60 }),
      M('m3', 12, 20),
      V('v3', 12, 20, { dtMin: 100 }),
    ]).point.matched,
    180
  );
  assert.equal(spread.atEdge, false);
  assert.equal(spread.note, null);
  assert.equal(spread.outerCount, 0);
  assert.equal(spread.medianAbsMin, 60);

  const none = summarizeTimeOffsets([], 180);
  assert.equal(none.n, 0);
  assert.equal(none.medianAbsMin, null);
  assert.equal(none.outerShare, null);
  assert.equal(none.note, null);
});

test('time offset: mixed satellite combinations are listed and mentioned in the note without claiming a cause', () => {
  const modis = [M('m1', 10, 20, { satellite: 'Terra' }), M('m2', 11, 20, { satellite: 'Aqua' })];
  const viirs = [V('v1', 10, 20, { dtMin: 170, satellite: 'NOAA-20' }), V('v2', 11, 20, { dtMin: 20, satellite: 'NOAA-20' })];
  const t = computeHarmonizeView(modis, viirs, { maxTimeDiffMinutes: 180 }).view.timeOffset;
  assert.equal(t.bySatellitePair.length, 2);
  assert.equal(t.atEdge, true);
  assert.match(t.note ?? '', /2 satellite combinations/);
  assert.match(t.note ?? '', /not been verified/);
});

// ---------------------------------------------------------------------------
// Robust FRP statistics
// ---------------------------------------------------------------------------

test('spearman: monotone, reversed, ties and undefined cases', () => {
  close(spearmanRho([1, 2, 3, 4, 5], [10, 200, 300, 4000, 90000]), 1);
  close(spearmanRho([1, 2, 3, 4, 5], [5, 4, 3, 2, 1]), -1);
  close(spearmanRho([1, 2, 3, 4], [1, 2, 2, 3]), 0.9486832980505138);
  assert.equal(spearmanRho([1, 2], [1, 2]), null); // n < 3
  assert.equal(spearmanRho([1, 2, 3], [7, 7, 7]), null); // no rank variation
  assert.equal(spearmanRho([1, 2, 3], [1, 2]), null);
});

test('robust FRP: median ratio on log scale, spearman, n', () => {
  const pts = [
    { modisFrpMw: 10, viirsFrpMw: 5 },
    { modisFrpMw: 20, viirsFrpMw: 20 },
    { modisFrpMw: 40, viirsFrpMw: 80 },
  ];
  const r = computeRobustFrp(pts);
  assert.equal(r.n, 3);
  close(r.medianRatio, 1); // ratios 0.5, 1, 2 -> median 1
  close(r.spearman, 1);
  assert.equal(r.maxModisFrpMw, 40);
  assert.equal(r.dominance, null); // n < FRP_DOMINANCE_MIN_N
  assert.equal(r.note, null);

  const even = computeRobustFrp([
    { modisFrpMw: 10, viirsFrpMw: 20 },
    { modisFrpMw: 10, viirsFrpMw: 80 },
  ]);
  close(even.medianRatio, 4); // exp(mean(ln 2, ln 8)) = 4 (geometric, not arithmetic 5)

  const none = computeRobustFrp([]);
  assert.equal(none.n, 0);
  assert.equal(none.medianRatio, null);
  assert.equal(none.spearman, null);
  assert.equal(none.maxModisFrpMw, null);
});

test('robust FRP: note appears only when a few pairs dominate the squared error', () => {
  // 40 well-agreeing pairs plus one very intense fire with a huge difference.
  const base = Array.from({ length: 40 }, (_, i) => ({ modisFrpMw: 10 + i, viirsFrpMw: 11 + i }));
  const flat = computeRobustFrp(base);
  assert.equal(flat.drivenByFew, false);
  assert.equal(flat.note, null);

  const withOutlier = computeRobustFrp([...base, { modisFrpMw: 1964.7, viirsFrpMw: 300 }]);
  assert.equal(withOutlier.drivenByFew, true);
  assert.ok(withOutlier.dominance!.share > 0.9);
  assert.equal(withOutlier.dominance!.k, 3); // ceil(5% of 41)
  assert.equal(withOutlier.dominance!.intense, true);
  assert.match(withOutlier.note ?? '', /r² and RMSE are driven by a few very intense fires/);
  assert.match(withOutlier.note ?? '', /1964\.7 MW/);
  // The existing statistics are untouched by the addition.
  const modis = [...base.map((p, i) => M(`m${i}`, 10 + i * 0.05, 20, { frp: p.modisFrpMw })), M('big', 30, 20, { frp: 1964.7 })];
  const viirs = [...base.map((p, i) => V(`v${i}`, 10 + i * 0.05, 20, { frp: p.viirsFrpMw })), V('bigv', 30, 20, { frp: 300 })];
  const { view } = computeHarmonizeView(modis, viirs);
  assert.equal(view.frp.point.n, 41);
  assert.ok(view.frp.point.rmse! > view.frp.point.mae!);
  assert.equal(view.frp.point.robust.n, 41);
  assert.equal(view.frp.point.robust.drivenByFew, true);
  assert.equal(view.frp.cell.robust.n, view.frp.cell.n);
});

test('robust FRP: all-pairs-equal data gives no dominance claim', () => {
  const same = Array.from({ length: 20 }, (_, i) => ({ modisFrpMw: 5 + i, viirsFrpMw: 5 + i }));
  const r = computeRobustFrp(same);
  assert.equal(r.dominance, null); // zero total squared difference
  assert.equal(r.drivenByFew, false);
  close(r.medianRatio, 1);
});

// ---------------------------------------------------------------------------
// Why do they differ
// ---------------------------------------------------------------------------

test('why-differ: five blocks, live numbers embedded', () => {
  const modis = [
    M('m1', 10, 20, { frp: 10, brightness: 330, daynight: 'D' }),
    M('m2', 11, 20, { frp: 50, brightness: 400, daynight: 'N' }),
    M('m3', 40, 40),
  ];
  const viirs = [
    V('v1', 10, 20, { frp: 12, dtMin: 60, ti4: 350 }),
    V('v2', 11, 20, { frp: 45, dtMin: 100, ti4: 360, daynight: 'N' }),
    V('v3', 50, 50),
  ];
  const { view } = computeHarmonizeView(modis, viirs);
  const why = buildWhyDiffer(view);

  assert.deepEqual(why.blocks.map((b) => b.id), ['overpass', 'resolution', 'saturation', 'daynight', 'cloudsmoke']);
  const by = Object.fromEntries(why.blocks.map((b) => [b.id, b]));
  assert.match(by.overpass.live, /2 matched pair\(s\)/);
  assert.match(by.overpass.live, /median time offset \(VIIRS − MODIS\) of \+80 min/);
  assert.match(by.overpass.live, /largest 100 min/);
  assert.match(by.resolution.live, /3 VIIRS vs 3 MODIS/);
  assert.match(by.saturation.live, /MODIS 50\.0 MW, VIIRS 45\.0 MW/);
  assert.match(by.saturation.live, /MODIS 400\.0 K, VIIRS I4 360\.0 K/);
  assert.match(by.daynight.live, /1 matched pair\(s\) in daytime, 1 at night/);
  assert.match(by.cloudsmoke.live, /1 VIIRS and 1 MODIS detection\(s\) have no counterpart/);
  assert.ok(why.blocks.every((b) => b.body.length > 40 && b.title.length > 0));
  assert.match(by.overpass.body, /Terra/);
  // small n -> warning, with the live n
  assert.match(why.warning ?? '', /n=2/);
  assert.doesNotMatch(JSON.stringify(why), /NaN|\[object Object\]/);
});

test('why-differ: no warning when n is large enough; placeholder warning when a sensor is absent', () => {
  const big = pairs(LOW_SAMPLE_N + 5);
  const { view } = computeHarmonizeView(big.modis, big.viirs);
  assert.equal(buildWhyDiffer(view).warning, null);

  const { view: none } = computeHarmonizeView([], []);
  assert.match(buildWhyDiffer(none).warning ?? '', /placeholders, not findings/);
  assert.doesNotMatch(JSON.stringify(buildWhyDiffer(none)), /NaN|\[object Object\]/);
});

// ---------------------------------------------------------------------------
// Scatter geometry
// ---------------------------------------------------------------------------

test('niceTicks: covers the range with round steps', () => {
  assert.deepEqual(niceTicks(0), [0, 1]);
  assert.deepEqual(niceTicks(100), [0, 25, 50, 75, 100]);
  const t = niceTicks(37);
  assert.equal(t[0], 0);
  assert.ok(t[t.length - 1] >= 37);
  assert.ok(t.length >= 3 && t.length <= 8);
});

test('scatter geometry: dots inside the plot, identity diagonal, regression clipped', () => {
  const pts = [
    { modisFrpMw: 10, viirsFrpMw: 12 },
    { modisFrpMw: 20, viirsFrpMw: 18 },
    { modisFrpMw: 30, viirsFrpMw: 36 },
  ];
  const g = buildScatterGeometry(pts, { slope: 1.2, intercept: -2 });
  assert.ok(g.domainMax >= 36);
  for (const d of g.dots) {
    assert.ok(d.cx >= g.plot.left && d.cx <= g.plot.right);
    assert.ok(d.cy >= g.plot.top && d.cy <= g.plot.bottom);
  }
  // identity runs from bottom-left to top-right of the plot
  close(g.identity.x1, g.plot.left);
  close(g.identity.y1, g.plot.bottom);
  close(g.identity.x2, g.plot.right);
  close(g.identity.y2, g.plot.top);
  // y = -2 + 1.2x is negative below x = 1.67 so the line must start inside the plot
  assert.ok(g.regression);
  for (const v of [g.regression!.x1, g.regression!.x2]) assert.ok(v >= g.plot.left - 1e-6 && v <= g.plot.right + 1e-6);
  for (const v of [g.regression!.y1, g.regression!.y2]) assert.ok(v >= g.plot.top - 1e-6 && v <= g.plot.bottom + 1e-6);
  assert.equal(g.notDrawn, 0);
});

test('scatter geometry: no regression, empty and capped inputs', () => {
  assert.equal(buildScatterGeometry([], null).regression, null);
  assert.equal(buildScatterGeometry([], null).dots.length, 0);
  const many = Array.from({ length: 50 }, (_, i) => ({ modisFrpMw: i + 1, viirsFrpMw: i + 1 }));
  const g = buildScatterGeometry(many, null, { maxPoints: 20 });
  assert.equal(g.dots.length, 20);
  assert.equal(g.notDrawn, 30);
  // a line that never enters the square is dropped
  assert.equal(buildScatterGeometry(many, { slope: 0, intercept: -5 }).regression, null);
});

// ---------------------------------------------------------------------------
// GeoJSON
// ---------------------------------------------------------------------------

test('geojson: classes, polygons and no combined MODIS+VIIRS field', () => {
  const modis = [
    M('same', 10, 20, { frp: 10 }),
    M('vhi', 11, 20, { frp: 10 }),
    M('mhi', 12, 20, { frp: 40 }),
    M('nofrp', 13, 20, { frp: 0 }),
    M('monly', 14, 20, { frp: 9 }),
  ];
  const viirs = [
    V('v-same', 10, 20, { frp: 11 }), // +10% -> similar
    V('v-vhi', 11, 20, { frp: 20 }), // +100% -> viirs_higher
    V('v-mhi', 12, 20, { frp: 10 }), // -75% -> modis_higher
    V('v-nofrp', 13, 20, { frp: 5 }),
    V('v-only', 30, 30, { frp: 3 }),
  ];
  const { result } = computeHarmonizeView(modis, viirs);
  const fc = agreementCellsToGeoJSON(result);

  assert.equal(fc.type, 'FeatureCollection');
  assert.equal(fc.label, 'EXPLORATORY');
  assert.equal(fc.similarTolerance, 0.25);
  assert.ok(fc.limitations.length > 0);
  const classes = fc.features.map((f) => f.properties.class).sort();
  assert.deepEqual(classes, ['frp_unavailable', 'modis_higher', 'modis_only', 'similar', 'viirs_higher', 'viirs_only']);

  const similar = fc.features.find((f) => f.properties.class === 'similar')!;
  assert.equal(similar.properties.modis_frp_mw, 10);
  assert.equal(similar.properties.viirs_frp_sum_mw, 11);
  close(similar.properties.rel_diff, 0.1);

  for (const f of fc.features) {
    const keys = Object.keys(f.properties);
    assert.ok(!keys.some((k) => /total|combined|harmon/i.test(k)), `combined field in ${keys.join()}`);
    const ring = f.geometry.coordinates[0];
    assert.equal(ring.length, 5);
    assert.deepEqual(ring[0], ring[4]);
    assert.equal(f.properties.label, 'EXPLORATORY');
  }
  const mOnly = fc.features.find((f) => f.properties.class === 'modis_only')!;
  assert.equal(mOnly.properties.viirs_frp_sum_mw, null);
  const vOnly = fc.features.find((f) => f.properties.class === 'viirs_only')!;
  assert.equal(vOnly.properties.modis_frp_mw, null);
});

test('geojson: footprint size follows scan/track, tolerance and includeUnmatched options', () => {
  const modis = [M('m', 0, 20, { frp: 10, scan: 2, track: 4 })];
  const viirs = [V('v', 0, 20, { frp: 10 })];
  const { result } = computeHarmonizeView(modis, viirs);
  const fc = agreementCellsToGeoJSON(result, { includeUnmatched: false, similarTolerance: 0.5 });
  assert.equal(fc.features.length, 1);
  const ring = fc.features[0].geometry.coordinates[0];
  const widthKm = (ring[1][0] - ring[0][0]) * KM_PER_DEG; // at the equator
  const heightKm = (ring[2][1] - ring[1][1]) * KM_PER_DEG;
  assert.ok(Math.abs(widthKm - 2) < 0.01, `width ${widthKm}`);
  assert.ok(Math.abs(heightKm - 4) < 0.01, `height ${heightKm}`);
  assert.equal(fc.similarTolerance, 0.5);
});

test('geojson: antimeridian-crossing and polar footprints are skipped and counted, not mangled', () => {
  const modis = [M('am', 10, 179.999, { frp: 10 }), M('pole', 89.5, 20, { frp: 10 })];
  const viirs = [V('v1', 10, 179.999), V('v2', 89.5, 20)];
  const { result } = computeHarmonizeView(modis, viirs);
  const fc = agreementCellsToGeoJSON(result);
  assert.equal(fc.features.length, 0);
  assert.equal(fc.skippedGeometry, 2);
});

test('legend sentence is exactly the required text', () => {
  assert.equal(LEGEND_SENTENCE, 'Satellite thermal anomalies, not confirmed wildfires or burned area.');
});

test('buildHarmonizeView accepts a raw matching result', () => {
  const result = matchModisViirs([M('m', 1, 1), V('v', 1, 1)]);
  const view = buildHarmonizeView(result);
  assert.equal(view.point.matched, 1);
});

// ---------------------------------------------------------------------------
// Partial UTC days (clock injected; no real time)
// ---------------------------------------------------------------------------

// T0 is 2026-01-15 06:00 UTC. Yesterday = 2026-01-15, "today" = 2026-01-16 (T0 + 18 h = 00:00).
const NOW = Date.UTC(2026, 0, 16, 1, 0, 0);
const TODAY_MIN = 18 * 60;

/** `n` MODIS detections between 00:43 and 00:47 UTC today (distinct places), as in the real-data problem. */
function todayModis(n: number) {
  return Array.from({ length: n }, (_, i) => M(`tm${i}`, 30 + i * 0.05, 40, { dtMin: TODAY_MIN + 43 + (i % 5) }));
}

test('partial: utcDateOf uses datetime_utc, falls back to acq_date, else null', () => {
  assert.equal(utcDateOf(M('a', 0, 0, { dtMin: TODAY_MIN + 43 })), '2026-01-16');
  assert.equal(utcDateOf({ datetime_utc: 'garbage', acq_date: '2026-01-14' }), '2026-01-14');
  assert.equal(utcDateOf({ datetime_utc: 'garbage', acq_date: 'nope' }), null);
});

test('partial: counts per sensor and UTC date are separate and sorted', () => {
  const modis = [...todayModis(3), M('y1', 1, 1), M('y2', 2, 1)];
  const viirs = [V('y3', 1, 1), V('y4', 2, 1), V('y5', 3, 1)];
  const { dates, undated } = countsByDate(modis, viirs);
  assert.deepEqual(dates, [
    { date: '2026-01-15', modis: 2, viirs: 3 },
    { date: '2026-01-16', modis: 3, viirs: 0 },
  ]);
  assert.deepEqual(undated, { modis: 0, viirs: 0 });
});

test('partial: current UTC date is flagged, an earlier date is not', () => {
  const { dates, todayUtc } = classifyDates([...todayModis(2), M('y', 1, 1)], [V('yv', 1, 1)], NOW);
  assert.equal(todayUtc, '2026-01-16');
  assert.deepEqual(dates.map((d) => [d.date, d.partial, d.reasons]), [
    ['2026-01-15', false, []],
    ['2026-01-16', true, ['current_utc_day']],
  ]);
});

test('partial: the clock decides, so the same data is complete once the day has passed', () => {
  const later = Date.UTC(2026, 0, 17, 0, 5, 0);
  const { dates } = classifyDates(todayModis(2), [V('v', 1, 1, { dtMin: TODAY_MIN + 60 })], later);
  assert.equal(dates.every((d) => !d.partial), true);
});

test('partial: secondary rule needs 0 on one sensor AND many on the other', () => {
  const few = classifyDates(Array.from({ length: PARTIAL_OTHER_SENSOR_MIN - 1 }, (_, i) => M(`f${i}`, i * 0.1, 0)), [], NOW);
  assert.equal(few.dates[0].partial, false);
  const many = classifyDates(Array.from({ length: PARTIAL_OTHER_SENSOR_MIN }, (_, i) => M(`g${i}`, i * 0.1, 0)), [], NOW);
  assert.deepEqual(many.dates[0].reasons, ['one_sensor_empty']);
  const viirsMany = classifyDates([], Array.from({ length: PARTIAL_OTHER_SENSOR_MIN }, (_, i) => V(`h${i}`, i * 0.1, 0)), NOW);
  assert.deepEqual(viirsMany.dates[0].reasons, ['one_sensor_empty']);
  assert.match(partialReasonText(many.dates[0], false), /VIIRS has 0 records on 2026-01-15 while MODIS has 50/);
});

test('partial: current day is excluded by default; ratio and FRP come from the complete day only', () => {
  const { modis: ym, viirs: yv } = pairs(4, () => [10, 20]); // 2026-01-15, VIIRS FRP twice MODIS
  const modis = [...ym, ...todayModis(57)];
  const r = computeHarmonizeViewComplete(modis, yv, { now: NOW });

  assert.equal(r.status, 'ok');
  assert.equal(r.includePartial, false);
  assert.deepEqual(r.excluded.map((d) => [d.date, d.modis, d.viirs]), [['2026-01-16', 57, 0]]);
  assert.deepEqual(r.completeDates.map((d) => d.date), ['2026-01-15']);
  assert.deepEqual(r.view!.inputs, { modis: 4, viirs: 4 });
  close(r.view!.detectionRatio.overall, 1);
  assert.equal(r.view!.frp.point.n, 4);
  close(r.view!.frp.point.bias, 10);
  assert.deepEqual([r.used.modis.length, r.used.viirs.length], [4, 4]);
  assert.ok(!r.view!.warnings.some((w) => /INCLUDED/.test(w)));
});

test('partial: including the partial day adds a strong warning, keeps EXPLORATORY and separate counts', () => {
  const { modis: ym, viirs: yv } = pairs(4);
  const r = computeHarmonizeViewComplete([...ym, ...todayModis(57)], yv, { now: NOW, includePartial: true });
  assert.equal(r.status, 'ok');
  assert.equal(r.excluded.length, 0);
  assert.deepEqual(r.includedPartial.map((d) => d.date), ['2026-01-16']);
  assert.deepEqual(r.view!.inputs, { modis: 61, viirs: 4 });
  assert.equal(r.view!.label, 'EXPLORATORY');
  assert.match(r.view!.warnings[0], /INCLUDED.*2026-01-16 \(MODIS 57, VIIRS 0\)/);
  close(r.view!.detectionRatio.overall, 4 / 61);
});

test('partial: only a partial day -> explicit no_complete_day, never a number', () => {
  const r = computeHarmonizeViewComplete(todayModis(57), [], { now: NOW });
  assert.equal(r.status, 'no_complete_day');
  assert.equal(r.view, null);
  assert.equal(r.result, null);
  assert.deepEqual(r.excluded.map((d) => [d.date, d.modis, d.viirs]), [['2026-01-16', 57, 0]]);
  assert.deepEqual(r.used, { modis: [], viirs: [] });
  // The toggle still lets the user see it, flagged.
  const forced = computeHarmonizeViewComplete(todayModis(57), [], { now: NOW, includePartial: true });
  assert.equal(forced.status, 'ok');
  assert.match(forced.view!.warnings[0], /INCLUDED/);
});

test('partial: no data at all is not "no complete day" (the existing empty state applies)', () => {
  const r = computeHarmonizeViewComplete([], [], { now: NOW });
  assert.equal(r.status, 'ok');
  assert.equal(r.dates.length, 0);
  assert.deepEqual(r.view!.inputs, { modis: 0, viirs: 0 });
});

test('partial: wrong-sensor records are still counted as mismatched and do not create dates', () => {
  const r = computeHarmonizeViewComplete([V('x', 1, 1), M('m', 1, 1)], [M('y', 1, 1), V('v', 1, 1)], { now: NOW });
  assert.match(r.view!.warnings.join(' '), /2 record\(s\) were tagged with the other sensor/);
  assert.deepEqual(r.view!.inputs, { modis: 1, viirs: 1 });
});

test('partial: records without a usable date are reported, not guessed (matching.ts then drops invalid ones itself)', () => {
  const bad = { ...M('u', 1, 1), datetime_utc: 'x', acq_date: 'y' };
  const r = computeHarmonizeViewComplete([bad, M('m', 5, 5)], [V('v', 5, 5)], { now: NOW });
  assert.deepEqual(r.undated, { modis: 1, viirs: 0 });
  assert.equal(r.view!.inputs.modis, 1); // the undated record is not a valid detection for matching.ts
});

test('partial: does not mutate its inputs', () => {
  const modis = todayModis(3);
  const viirs = [V('v', 1, 1)];
  const snap = JSON.stringify([modis, viirs]);
  computeHarmonizeViewComplete(modis, viirs, { now: NOW });
  assert.equal(JSON.stringify([modis, viirs]), snap);
});

// ---------------------------------------------------------------------------
// Observed overpass times (T0 = 06:00 UTC; dtMin shifts the UTC time of day)
// ---------------------------------------------------------------------------

test('overpass: circular median across midnight (no 12 h artefact)', () => {
  close(circularMedianHours([23.5, 0.5]), 0);
  close(circularMedianHours([23, 23.5, 0.25, 0.5, 1]), 0.25);
  close(circularMedianHours([22, 23, 0, 1, 2]), 0);
  close(circularMedianHours([13.5, 14.5, 15]), 14.5);
  assert.equal(circularMedianHours([]), null);
  close(circularGapMinutes(23.5, 0.5), 60);
  close(circularGapMinutes(1, 13), 720);
  assert.equal(formatClock(23.999), '00:00');
  assert.equal(formatClock(15.8), '15:48');
});

test('overpass: UTC time + longitude/15, wrapped to 24 h, per sensor/satellite/daynight', () => {
  // 06:00 UTC at lon 90 -> 12:00; at lon -90 -> 00:00 (wraps); at lon 180 -> 18:00.
  const r = observedOverpassTimes([
    M('a', 10, 90, { satellite: 'Aqua', daynight: 'D' }),
    M('b', 10, -90, { satellite: 'Terra', daynight: 'N' }),
    V('c', 10, 180, { satellite: 'NOAA-21', daynight: 'D' }),
  ]);
  const get = (sat: string, dn: string) => r.rows.find((x) => x.satellite === sat && x.daynight === dn)!;
  close(get('Aqua', 'D').medianLocalHours, 12);
  close(get('Terra', 'N').medianLocalHours, 0);
  close(get('NOAA-21', 'D').medianLocalHours, 18);
  assert.equal(get('Aqua', 'D').label, '12:00');
  assert.deepEqual(r.rows.map((x) => x.sensor), ['MODIS', 'MODIS', 'VIIRS']); // sensors stay separate
  assert.equal(r.skipped, 0);
});

test('overpass: night pass straddling local midnight is summarised near midnight', () => {
  // UTC 06:00 at lon 0 shifted by -6.5..-5.5 h -> local 23:30, 00:00, 00:30
  const list = [-390, -360, -330].map((dt, i) => M(`n${i}`, 10, 0, { satellite: 'Aqua', daynight: 'N', dtMin: dt }));
  const row = observedOverpassTimes(list).rows[0];
  close(row.medianLocalHours, 0);
  assert.equal(row.label, '00:00');
});

test('overpass: small-n flag at OVERPASS_MIN_N, unusable records skipped, no data -> no rows', () => {
  const few = Array.from({ length: OVERPASS_MIN_N - 1 }, (_, i) => M(`f${i}`, 10, 0, { satellite: 'Aqua' }));
  const enough = Array.from({ length: OVERPASS_MIN_N }, (_, i) => V(`e${i}`, 10, 0, { satellite: 'NOAA-21' }));
  const bad = { ...M('bad', 10, 0), datetime_utc: 'nope', acq_time: 'xx' };
  const r = observedOverpassTimes([...few, ...enough, bad]);
  assert.equal(r.rows.find((x) => x.satellite === 'Aqua')!.lowN, true);
  assert.equal(r.rows.find((x) => x.satellite === 'NOAA-21')!.lowN, false);
  assert.equal(r.skipped, 1);
  assert.deepEqual(observedOverpassTimes([]), { rows: [], skipped: 0 });
});

test('overpass: acq_time fallback and why-differ shows live observed values, no stale nominal-as-current text', () => {
  const noIso = { ...M('x', 10, 0), datetime_utc: '' } as CanonicalObservation;
  noIso.acq_time = '1348';
  close(utcHoursOfDay(noIso), 13 + 48 / 60);

  const { modis, viirs } = pairs(2);
  const { view } = computeHarmonizeView(modis, viirs);
  const overpass = observedOverpassTimes([...modis, ...viirs]);
  const why = buildWhyDiffer(view, overpass);
  const ov = why.blocks.find((b) => b.id === 'overpass')!;
  assert.match(ov.live, /Aqua day 07:20 \(n=2, low n < 20\)/);
  assert.match(ov.live, /NOAA-20 day 07:20/);
  assert.match(ov.body, /not verified in this build/);
  assert.match(ov.body, /aqua\.nasa\.gov/);
  assert.match(ov.body, /drifting to later/);
  assert.match(ov.body, /Historically/);
  assert.doesNotMatch(ov.body, /Suomi NPP, NOAA-20/);
  assert.match(ov.body, /Suomi NPP data delivery ended on 2026-11-01/);
  assert.match(buildWhyDiffer(view).blocks[0].live, /No observed overpass times/);
});

// ---------------------------------------------------------------------------
// Window feasibility
// ---------------------------------------------------------------------------

/** `n` detections of one satellite whose approx. local solar time is `localHours` (lon 0 -> local = UTC). */
function atLocal(sensor: 'MODIS' | 'VIIRS', satellite: SatelliteType, daynight: 'D' | 'N', localHours: number, n: number, tag = ''): CanonicalObservation[] {
  const make = sensor === 'MODIS' ? M : V;
  return Array.from({ length: n }, (_, i) => make(`${tag}${sensor}${satellite}${daynight}${i}`, 10, 0, { satellite, daynight, dtMin: Math.round((localHours - 6) * 60) }));
}

test('window feasibility: warns when the observed gap exceeds the window, silent when it fits', () => {
  const o = observedOverpassTimes([
    ...atLocal('MODIS', 'Aqua', 'D', 15.8, 25),
    ...atLocal('VIIRS', 'NOAA-21', 'D', 13.3, 25),
    ...atLocal('MODIS', 'Aqua', 'N', 3.4, 25),
    ...atLocal('VIIRS', 'NOAA-21', 'N', 1.5, 25),
  ]);
  const sel = { modis: 'Aqua', viirs: 'NOAA-21' } as const;

  const narrow = windowFeasibility(o, sel, 60);
  const day = narrow.find((f) => f.daynight === 'D')!;
  assert.equal(day.pairs.length, 1);
  close(day.pairs[0].gapMin, 150, 1.5); // 15:48 vs 13:18 = 150 min
  assert.equal(day.pairs[0].exceedsWindow, true);
  assert.match(day.warning ?? '', /about 150 min apart/);
  assert.match(day.warning ?? '', /±60 min window/);
  assert.match(day.warning ?? '', /Few or no day pairs are expected/);
  assert.match(narrow.find((f) => f.daynight === 'N')!.warning ?? '', /night/); // 3:24 vs 1:30 = 114 min > 60

  const wide = windowFeasibility(o, sel, 180);
  assert.equal(wide.find((f) => f.daynight === 'D')!.warning, null);
  assert.equal(wide.find((f) => f.daynight === 'N')!.warning, null);
  // boundary: gap equal to the window is not larger
  assert.equal(windowFeasibility(o, sel, 150).find((f) => f.daynight === 'D')!.warning, null);
});

test('window feasibility: midnight-safe gap, low-n note, times come only from the data (nothing hard-coded)', () => {
  const o = observedOverpassTimes([...atLocal('MODIS', 'Terra', 'N', 23.75, 5), ...atLocal('VIIRS', 'NOAA-20', 'N', 0.5, 5)]);
  const n = windowFeasibility(o, { modis: 'Terra', viirs: 'NOAA-20' }, 30).find((f) => f.daynight === 'N')!;
  close(n.pairs[0].gapMin, 45, 1e-6);
  assert.equal(n.pairs[0].lowN, true);
  assert.match(n.warning ?? '', /indicative only/);
  // same satellites, different observed times -> different answer
  const o2 = observedOverpassTimes([...atLocal('MODIS', 'Terra', 'N', 0.25, 30), ...atLocal('VIIRS', 'NOAA-20', 'N', 0.5, 30)]);
  assert.equal(windowFeasibility(o2, { modis: 'Terra', viirs: 'NOAA-20' }, 30).find((f) => f.daynight === 'N')!.warning, null);
});

test('window feasibility: "all" uses the closest pair; a side with no observed time warns; no data -> no warning', () => {
  const o = observedOverpassTimes([
    ...atLocal('MODIS', 'Terra', 'D', 8.5, 25),
    ...atLocal('MODIS', 'Aqua', 'D', 15.8, 25),
    ...atLocal('VIIRS', 'NOAA-21', 'D', 15.5, 25),
  ]);
  const all = windowFeasibility(o, { modis: 'all', viirs: 'all' }, 30).find((f) => f.daynight === 'D')!;
  assert.equal(all.pairs.length, 2);
  assert.equal(all.pairs[0].modis, 'Aqua'); // closest first
  assert.equal(all.warning, null); // Aqua <-> NOAA-21 is ~18 min

  const noViirs = windowFeasibility(o, { modis: 'Aqua', viirs: 'NOAA-20' }, 30).find((f) => f.daynight === 'D')!;
  assert.deepEqual(noViirs.missing, [{ sensor: 'VIIRS', satellite: 'NOAA-20' }]);
  assert.match(noViirs.warning ?? '', /No observed day time for VIIRS NOAA-20/);

  const none = windowFeasibility({ rows: [], skipped: 0 }, { modis: 'all', viirs: 'all' }, 30);
  assert.ok(none.every((f) => f.warning === null && f.pairs.length === 0));
});

// ---------------------------------------------------------------------------
// Same-day cell agreement (T0 = 2026-01-15 06:00 UTC; dtMin 1440 = next UTC day)
// ---------------------------------------------------------------------------

const LATER = Date.UTC(2026, 5, 1); // injected "now", long after the data: no partial day

test('cell-day: same cell, same day -> shared; counts stay per sensor; shares and per-cell ratio', () => {
  // shared cell A (1 MODIS, 2 VIIRS), MODIS-only cell B, VIIRS-only cell C
  const a = computeGridCellIndex(10, 20).cellKey;
  assert.equal(computeGridCellIndex(10.0001, 20.0001).cellKey, a); // second VIIRS point is in the same cell
  const r = cellDayAgreement(
    [M('m1', 10, 20), M('m2', 12, 22)],
    [V('v1', 10, 20), V('v2', 10.0001, 20.0001), V('v3', 14, 24)],
    { now: LATER }
  );
  assert.equal(r.status, 'ok');
  assert.equal(r.label, 'EXPLORATORY');
  assert.equal(r.rows.length, 1);
  const d = r.rows[0];
  assert.equal(d.date, '2026-01-15');
  assert.deepEqual(
    [d.modisDetections, d.viirsDetections, d.modisCells, d.viirsCells, d.bothCells, d.modisOnlyCells, d.viirsOnlyCells],
    [2, 3, 2, 2, 1, 1, 1]
  );
  close(d.modisCellsWithViirsShare, 0.5);
  assert.equal(d.viirsInSharedCells, 2);
  close(d.viirsPerSharedCell, 2);
  assert.equal('total' in d, false); // nothing is a MODIS+VIIRS sum
  assert.deepEqual(r.limitations, CELL_DAY_LIMITATIONS);
});

test('cell-day: same cell on different days is NOT shared', () => {
  const r = cellDayAgreement([M('m1', 10, 20)], [V('v1', 10, 20, { dtMin: 1440 })], { now: LATER });
  assert.deepEqual(r.rows.map((x) => x.date), ['2026-01-15', '2026-01-16']);
  const [d1, d2] = r.rows;
  assert.deepEqual([d1.modisCells, d1.viirsCells, d1.bothCells, d1.modisOnlyCells], [1, 0, 0, 1]);
  assert.deepEqual([d2.modisCells, d2.viirsCells, d2.bothCells, d2.viirsOnlyCells], [0, 1, 0, 1]);
  assert.equal(d1.modisCellsWithViirsShare, 0);
  assert.equal(d2.modisCellsWithViirsShare, null); // no MODIS cell that day
  assert.equal(d2.viirsPerSharedCell, null);
});

test('cell-day: antimeridian - 180 and -180 are the same meridian; either side of the seam stays separate; no crash', () => {
  const same = cellDayAgreement([M('m1', 10, 180)], [V('v1', 10, -180)], { now: LATER }).rows[0];
  assert.equal(same.bothCells, 1);
  const seam = cellDayAgreement([M('m1', 10, 179.9999)], [V('v1', 10, -179.9999)], { now: LATER }).rows[0];
  assert.equal(seam.bothCells, 0); // documented limitation: the grid is split at the seam
  assert.deepEqual([seam.modisOnlyCells, seam.viirsOnlyCells], [1, 1]);
  const near = cellDayAgreement([M('m1', 10, 179.9999)], [V('v1', 10, 179.99995)], { now: LATER }).rows[0];
  assert.equal(near.bothCells, 1);
});

test('cell-day: empty input, invalid coordinates, partial days and satellite filter', () => {
  const empty = cellDayAgreement([], [], { now: LATER });
  assert.equal(empty.status, 'no_data');
  assert.deepEqual(empty.rows, []);

  const bad = cellDayAgreement([M('m1', 10, 20), { ...M('m2', 10, 20), latitude: Number.NaN }], [V('v1', 10, 20)], { now: LATER });
  assert.equal(bad.skipped, 1);
  assert.equal(bad.rows[0].modisCells, 1);

  // "now" inside the data day: the only date is partial -> excluded, nothing shown
  const today = Date.UTC(2026, 0, 15, 12, 0, 0);
  const partial = cellDayAgreement([M('m1', 10, 20)], [V('v1', 10, 20)], { now: today });
  assert.equal(partial.status, 'no_complete_day');
  assert.deepEqual(partial.rows, []);
  assert.deepEqual(partial.excluded.map((x) => x.date), ['2026-01-15']);
  // includePartial brings it back, flagged and with a warning
  const inc = cellDayAgreement([M('m1', 10, 20)], [V('v1', 10, 20)], { now: today, includePartial: true });
  assert.equal(inc.rows[0].partial, true);
  assert.match(inc.warnings[0], /INCLUDED/);

  // satellite filter applies per sensor
  const filt = cellDayAgreement(
    [M('m1', 10, 20, { satellite: 'Terra' }), M('m2', 12, 22, { satellite: 'Aqua' })],
    [V('v1', 10, 20, { satellite: 'NOAA-20' }), V('v2', 12, 22, { satellite: 'NOAA-21' })],
    { now: LATER, modisSatellites: ['Aqua'], viirsSatellites: ['NOAA-21'] }
  ).rows[0];
  assert.deepEqual([filt.modisCells, filt.viirsCells, filt.bothCells], [1, 1, 1]);
});

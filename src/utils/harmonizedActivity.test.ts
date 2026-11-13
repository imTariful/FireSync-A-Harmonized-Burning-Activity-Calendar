import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CanonicalObservation, SatelliteType } from '../types/fire';
import { aggregateToSpatialTemporalGrid, buildDailySummariesFromCells, HARMONIZATION_CONSTANTS } from './harmonization';
import { matchModisViirs, type MatchedCell } from './matching';
import {
  HINT_MIN_N,
  SENSITIVITY_MIN_DATES,
  SENSITIVITY_SCALES,
  VIIRS_SCALE_DEFAULT,
  VIIRS_SCALE_LIMITS,
  computeHarmonizedActivity,
  empiricalScaleHint,
} from './harmonizedActivity';

// Run with: npx tsx --test src/utils/harmonizedActivity.test.ts
// Synthetic data only: no network, no randomness. The clock is injected.

let seq = 0;
function obs(
  sensor: 'MODIS' | 'VIIRS',
  date: string,
  lat: number,
  lon: number,
  opts: { hour?: number; frp?: number; satellite?: SatelliteType } = {}
): CanonicalObservation {
  const hour = String(opts.hour ?? 10).padStart(2, '0');
  const id = `${sensor}-${date}-${seq++}`;
  return {
    id,
    source_record_id: id,
    latitude: lat,
    longitude: lon,
    acq_date: date,
    acq_time: `${hour}00`,
    datetime_utc: `${date}T${hour}:00:00Z`,
    sensor,
    satellite: opts.satellite ?? (sensor === 'MODIS' ? 'Aqua' : 'NOAA-20'),
    product: 't',
    processing_version: 'x',
    confidence: 50,
    confidence_category: 'nominal',
    frp_mw: opts.frp ?? 10,
    scan: 1,
    track: 1,
    daynight: 'D',
    source_file: 't',
    retrieved_at: '2026-01-20T00:00:00Z',
    quality_flags: '',
    record_hash: id,
  };
}

/** Cell k sits k × 0.1° (~11 km) apart in latitude, so each k is its own 1 km cell. */
const cellLat = (k: number) => 10 + k * 0.1;
const NOW = Date.parse('2026-01-20T12:00:00Z'); // later than every date used unless a test says otherwise
const D1 = '2026-01-15';
const D2 = '2026-01-16';
const D3 = '2026-01-17';

test('MODIS and VIIRS counts stay separate; cells are counted per cell, not per detection', () => {
  const m = [obs('MODIS', D1, cellLat(1), 20), obs('MODIS', D1, cellLat(1), 20), obs('MODIS', D1, cellLat(3), 20)];
  const v = [obs('VIIRS', D1, cellLat(1), 20), obs('VIIRS', D1, cellLat(1), 20), obs('VIIRS', D1, cellLat(1), 20), obs('VIIRS', D1, cellLat(2), 20)];
  const r = computeHarmonizedActivity(m, v, { now: NOW });
  assert.equal(r.status, 'ok');
  assert.equal(r.rows.length, 1);
  const row = r.rows[0];
  assert.equal(row.modisCount, 3);
  assert.equal(row.viirsCount, 4);
  assert.equal(row.cells, 3);
  assert.equal(row.cellsBoth, 1);
  // No cross-sensor sum of raw counts anywhere in the row.
  assert.deepEqual(
    Object.keys(row).sort(),
    ['cells', 'cellsBoth', 'date', 'index', 'modisCount', 'partial', 'scaleAssumptionShare', 'terms', 'viirsCount'].sort()
  );
  assert.equal(r.label, 'EXPLORATORY');
});

test('the three terms add up to the index (within tolerance) and match the hand-computed value', () => {
  const m = [obs('MODIS', D1, cellLat(1), 20, { frp: 5 }), obs('MODIS', D1, cellLat(3), 20, { frp: 7 })];
  const v = [obs('VIIRS', D1, cellLat(1), 20, { frp: 3 }), obs('VIIRS', D1, cellLat(1), 20, { frp: 3 }), obs('VIIRS', D1, cellLat(2), 20, { frp: 2 })];
  const row = computeHarmonizedActivity(m, v, { now: NOW, viirsScale: 0.3 }).rows[0];
  const sum = row.terms.modis + row.terms.viirsScaled + row.terms.frp;
  assert.ok(Math.abs(sum - row.index) < 1e-9, `${sum} vs ${row.index}`);
  // cell1 both: 0.5*1 + 0.5*0.3*2 + 0.005*ln(1+11); cell3 MODIS-only: 1 + 0.004*ln(1+7); cell2 VIIRS-only: 0.3*1 + 0.004*ln(1+2)
  const expected = 0.5 + 0.3 + 0.005 * Math.log(12) + 1 + 0.004 * Math.log(8) + 0.3 + 0.004 * Math.log(3);
  assert.ok(Math.abs(row.index - expected) < 1e-9);
  assert.ok(Math.abs(row.terms.modis - 1.5) < 1e-9);
  assert.ok(Math.abs(row.terms.viirsScaled - 0.6) < 1e-9);
  assert.ok(row.scaleAssumptionShare !== null && Math.abs(row.scaleAssumptionShare - 0.6 / expected) < 1e-9);
});

test('at the default scale the index equals harmonization.ts (aggregate + daily summary)', () => {
  const m = [obs('MODIS', D1, cellLat(1), 20, { frp: 5 }), obs('MODIS', D1, cellLat(3), 20, { frp: 7 }), obs('MODIS', D2, cellLat(1), 20, { frp: 9 })];
  const v = [
    obs('VIIRS', D1, cellLat(1), 20, { frp: 3 }),
    obs('VIIRS', D1, cellLat(1), 20, { frp: 3 }),
    obs('VIIRS', D1, cellLat(2), 20, { frp: 2 }),
    obs('VIIRS', D2, cellLat(5), 20, { frp: 4 }),
  ];
  const mine = computeHarmonizedActivity(m, v, { now: NOW });
  assert.equal(mine.params.viirsScale, HARMONIZATION_CONSTANTS.VIIRS_COUNT_SCALE_FACTOR);
  const cells = [...aggregateToSpatialTemporalGrid([...m, ...v]).values()];
  const archive = buildDailySummariesFromCells(cells, { start: D1, end: D2 });
  for (const day of archive) {
    const row = mine.rows.find((r) => r.date === day.date)!;
    assert.ok(row, day.date);
    // archive rounds each cell to 3 decimals and the day to 2
    assert.ok(Math.abs(row.index - day.harmonized_activity_units) < 0.01, `${day.date}: ${row.index} vs ${day.harmonized_activity_units}`);
    assert.equal(row.modisCount, day.modis_detections);
    assert.equal(row.viirsCount, day.viirs_detections);
    assert.equal(row.cells, day.active_1km_cells);
  }
});

test('partial UTC day is excluded by default and included by the toggle', () => {
  const today = '2026-01-20';
  const now = Date.parse(`${today}T08:00:00Z`);
  const m = [obs('MODIS', D1, cellLat(1), 20), obs('MODIS', today, cellLat(1), 20)];
  const v = [obs('VIIRS', D1, cellLat(1), 20), obs('VIIRS', today, cellLat(1), 20)];
  const off = computeHarmonizedActivity(m, v, { now });
  assert.deepEqual(off.rows.map((r) => r.date), [D1]);
  assert.deepEqual(off.excluded.map((d) => d.date), [today]);
  assert.equal(off.includedPartial.length, 0);
  assert.ok(off.rows.every((r) => !r.partial));
  const on = computeHarmonizedActivity(m, v, { now, includePartial: true });
  assert.deepEqual(on.rows.map((r) => r.date), [D1, today]);
  assert.equal(on.rows[1].partial, true);
  assert.equal(on.rows[0].partial, false);
  assert.equal(on.excluded.length, 0);
  assert.deepEqual(on.includedPartial.map((d) => d.date), [today]);
  assert.ok(on.warnings.some((w) => /INCLUDED/.test(w)));
  assert.ok(!off.warnings.some((w) => /INCLUDED/.test(w)));
});

test('when every date is partial and the toggle is off there is no number', () => {
  const now = Date.parse('2026-01-20T08:00:00Z');
  const r = computeHarmonizedActivity([obs('MODIS', '2026-01-20', cellLat(1), 20)], [obs('VIIRS', '2026-01-20', cellLat(1), 20)], { now });
  assert.equal(r.status, 'no_complete_day');
  assert.deepEqual(r.rows, []);
  assert.equal(r.excluded.length, 1);
  assert.equal(r.sensitivity.status, 'too_few_dates');
});

test('empty input gives an empty result, not a number', () => {
  const r = computeHarmonizedActivity([], [], { now: NOW });
  assert.equal(r.status, 'empty');
  assert.deepEqual(r.rows, []);
  assert.equal(r.hint, null);
  assert.equal(r.sensitivity.status, 'too_few_dates');
  assert.equal(r.sensitivity.orderChanged, null);
});

test('only one sensor present: its own term only, the other is zero', () => {
  const r = computeHarmonizedActivity([obs('MODIS', D1, cellLat(1), 20)], [], { now: NOW });
  const row = r.rows[0];
  assert.equal(row.viirsCount, 0);
  assert.equal(row.terms.viirsScaled, 0);
  assert.equal(row.scaleAssumptionShare, 0);
  const rv = computeHarmonizedActivity([], [obs('VIIRS', D1, cellLat(1), 20)], { now: NOW });
  assert.equal(rv.rows[0].modisCount, 0);
  assert.equal(rv.rows[0].terms.modis, 0);
  assert.ok(Math.abs(rv.rows[0].terms.viirsScaled - VIIRS_SCALE_DEFAULT) < 1e-9);
});

test('scale edge values: 0.1 and 1.0 accepted, outside or invalid rejected; only the VIIRS term moves', () => {
  const m = [obs('MODIS', D1, cellLat(1), 20)];
  const v = [obs('VIIRS', D1, cellLat(1), 20), obs('VIIRS', D1, cellLat(2), 20)];
  const lo = computeHarmonizedActivity(m, v, { now: NOW, viirsScale: VIIRS_SCALE_LIMITS.min }).rows[0];
  const hi = computeHarmonizedActivity(m, v, { now: NOW, viirsScale: VIIRS_SCALE_LIMITS.max }).rows[0];
  assert.ok(Math.abs(hi.terms.viirsScaled / lo.terms.viirsScaled - 10) < 1e-9);
  assert.equal(hi.terms.modis, lo.terms.modis);
  assert.equal(hi.terms.frp, lo.terms.frp);
  assert.ok(hi.index > lo.index);
  for (const bad of [0.09, 1.01, 0, -1, NaN, Infinity]) {
    assert.throws(() => computeHarmonizedActivity(m, v, { now: NOW, viirsScale: bad }), RangeError, String(bad));
  }
  assert.throws(() => computeHarmonizedActivity(m, v, { now: NOW, cellSizeKm: 0 }), RangeError);
  assert.throws(() => computeHarmonizedActivity(m, v, { now: NOW, cellSizeKm: NaN }), RangeError);
});

test('grid size is a supported parameter: a coarser grid merges neighbouring detections into one cell', () => {
  const m = [obs('MODIS', D1, 10, 20)];
  const v = [obs('VIIRS', D1, 10.012, 20)]; // ~1.3 km north of the MODIS detection
  const fine = computeHarmonizedActivity(m, v, { now: NOW, cellSizeKm: 0.5 }).rows[0];
  assert.equal(fine.cellsBoth, 0);
  const coarse = computeHarmonizedActivity(m, v, { now: NOW, cellSizeKm: 50 }).rows[0];
  assert.equal(coarse.cellsBoth, 1);
  assert.equal(coarse.modisCount, 1);
  assert.equal(coarse.viirsCount, 1);
});

test('day bucketing and weights are reported as fixed', () => {
  const p = computeHarmonizedActivity([], [], { now: NOW }).params;
  assert.equal(p.dayBucketing, 'UTC date');
  assert.equal(p.dayBucketingAdjustable, false);
  assert.equal(p.weightsAdjustable, false);
  assert.equal(p.defaultViirsScale, HARMONIZATION_CONSTANTS.VIIRS_COUNT_SCALE_FACTOR);
});

test('a detection just after midnight UTC is bucketed by its UTC date, not its acq_date text', () => {
  const o = obs('MODIS', D1, cellLat(1), 20, { hour: 23 });
  const shifted = { ...o, acq_date: D2 }; // wrong text; datetime_utc says D1
  const r = computeHarmonizedActivity([shifted], [], { now: NOW });
  assert.deepEqual(r.rows.map((x) => x.date), [D1]);
});

test('sensitivity: order unchanged when one date clearly dominates at every scale', () => {
  // D1: 6 MODIS cells; D2: 3 MODIS cells; D3: 1 MODIS cell. VIIRS adds a little everywhere.
  const m: CanonicalObservation[] = [];
  const v: CanonicalObservation[] = [];
  [[D1, 6], [D2, 3], [D3, 1]].forEach(([d, n]) => {
    for (let k = 1; k <= (n as number); k++) m.push(obs('MODIS', d as string, cellLat(k), 20));
    v.push(obs('VIIRS', d as string, cellLat(20), 20));
  });
  const r = computeHarmonizedActivity(m, v, { now: NOW });
  assert.equal(r.sensitivity.status, 'order_unchanged');
  assert.equal(r.sensitivity.orderChanged, false);
  assert.deepEqual(r.sensitivity.rows.map((x) => x.ranks[0]), [1, 2, 3]);
  assert.equal(r.sensitivity.scales.length, 4);
  assert.deepEqual(r.sensitivity.scales.map((s) => s.label), ['lower', 'default', 'higher', 'one']);
  assert.equal(r.sensitivity.scales[1].scale, VIIRS_SCALE_DEFAULT);
});

test('sensitivity: order changes when a VIIRS-heavy date overtakes a MODIS-heavy date at a higher scale', () => {
  const m: CanonicalObservation[] = [];
  const v: CanonicalObservation[] = [];
  // D1: 4 MODIS-only cells -> ~4.0 at any scale. D2: 10 VIIRS-only cells -> ~2.9 at 0.294, ~10 at 1.0. D3: 1 MODIS cell.
  for (let k = 1; k <= 4; k++) m.push(obs('MODIS', D1, cellLat(k), 20));
  for (let k = 1; k <= 10; k++) v.push(obs('VIIRS', D2, cellLat(k), 20));
  m.push(obs('MODIS', D3, cellLat(1), 20));
  const r = computeHarmonizedActivity(m, v, { now: NOW });
  assert.equal(r.sensitivity.status, 'order_changed');
  assert.equal(r.sensitivity.orderChanged, true);
  const d1 = r.sensitivity.rows.find((x) => x.date === D1)!;
  const d2 = r.sensitivity.rows.find((x) => x.date === D2)!;
  const iDefault = r.sensitivity.scales.findIndex((s) => s.label === 'default');
  const iOne = r.sensitivity.scales.findIndex((s) => s.label === 'one');
  assert.ok(d1.ranks[iDefault] < d2.ranks[iDefault]);
  assert.ok(d2.ranks[iOne] < d1.ranks[iOne]);
  assert.match(r.sensitivity.note, /not validated/);
});

test('sensitivity: too few dates says nothing about the order', () => {
  assert.equal(SENSITIVITY_MIN_DATES, 3);
  const m = [obs('MODIS', D1, cellLat(1), 20), obs('MODIS', D2, cellLat(1), 20)];
  const v = [obs('VIIRS', D1, cellLat(2), 20)];
  const r = computeHarmonizedActivity(m, v, { now: NOW });
  assert.equal(r.sensitivity.datesCompared, 2);
  assert.equal(r.sensitivity.status, 'too_few_dates');
  assert.equal(r.sensitivity.orderChanged, null);
  assert.match(r.sensitivity.note, /No claim is made/);
  // the values themselves are still reported
  assert.equal(r.sensitivity.rows[0].values.length, SENSITIVITY_SCALES.length);
});

test('sensitivity values equal a direct run at the same scale', () => {
  const m = [obs('MODIS', D1, cellLat(1), 20), obs('MODIS', D2, cellLat(2), 20), obs('MODIS', D3, cellLat(3), 20)];
  const v = [obs('VIIRS', D1, cellLat(1), 20), obs('VIIRS', D2, cellLat(5), 20), obs('VIIRS', D3, cellLat(5), 20)];
  const r = computeHarmonizedActivity(m, v, { now: NOW });
  SENSITIVITY_SCALES.forEach((s, i) => {
    const direct = computeHarmonizedActivity(m, v, { now: NOW, viirsScale: s.scale });
    direct.rows.forEach((row, j) => assert.ok(Math.abs(row.index - r.sensitivity.rows[j].values[i]) < 1e-9));
  });
});

test('empirical hint: median, IQR, implied scale and n, flagged small when n < 20', () => {
  const cells = [1, 2, 3, 4, 5].map((k) => ({ viirsCount: k }) as MatchedCell);
  const h = empiricalScaleHint(cells, 180);
  assert.equal(h.n, 5);
  assert.equal(h.median, 3);
  assert.equal(h.q1, 2);
  assert.equal(h.q3, 4);
  assert.equal(h.iqr, 2);
  assert.ok(Math.abs(h.impliedScale! - 1 / 3) < 1e-12);
  assert.equal(h.smallN, true);
  assert.match(h.caveats[0], /Small sample/);
  assert.match(h.basis, /±180 min/);
  assert.ok(h.caveats.some((c) => /Not a calibration factor/.test(c)));
});

test('empirical hint: n at the threshold is not flagged; n just below is', () => {
  const mk = (n: number) => empiricalScaleHint(Array.from({ length: n }, () => ({ viirsCount: 3 }) as MatchedCell));
  assert.equal(mk(HINT_MIN_N - 1).smallN, true);
  assert.equal(mk(HINT_MIN_N).smallN, false);
  assert.equal(mk(HINT_MIN_N).impliedScale, 1 / 3);
});

test('empirical hint: empty and out-of-range cases', () => {
  const e = empiricalScaleHint([]);
  assert.equal(e.n, 0);
  assert.equal(e.median, null);
  assert.equal(e.impliedScale, null);
  assert.equal(e.smallN, true);
  assert.equal(empiricalScaleHint(null).n, 0);
  const big = empiricalScaleHint(Array.from({ length: 25 }, () => ({ viirsCount: 20 }) as MatchedCell));
  assert.equal(big.impliedScale, 0.05);
  assert.equal(big.impliedScaleInRange, false);
  assert.ok(big.caveats.some((c) => /outside the slider range/.test(c)));
  const one = empiricalScaleHint(Array.from({ length: 25 }, () => ({ viirsCount: 1 }) as MatchedCell));
  assert.equal(one.impliedScale, 1);
  assert.equal(one.impliedScaleInRange, true);
});

test('empirical hint from a real matching run (the matching cell level)', () => {
  // 3 MODIS footprints, each with 2 VIIRS detections inside, within the time window
  const list: CanonicalObservation[] = [];
  for (let k = 1; k <= 3; k++) {
    list.push(obs('MODIS', D1, cellLat(k), 20, { hour: 10 }));
    list.push(obs('VIIRS', D1, cellLat(k), 20, { hour: 11 }));
    list.push(obs('VIIRS', D1, cellLat(k) + 0.001, 20, { hour: 11 }));
  }
  const res = matchModisViirs(list, {});
  const r = computeHarmonizedActivity(
    list.filter((o) => o.sensor === 'MODIS'),
    list.filter((o) => o.sensor === 'VIIRS'),
    { now: NOW, matchedCells: res.cell.cells, matchWindowMinutes: 180 }
  );
  assert.ok(r.hint);
  assert.equal(r.hint!.n, 3);
  assert.equal(r.hint!.median, 2);
  assert.equal(r.hint!.impliedScale, 0.5);
  assert.equal(r.hint!.smallN, true);
  // The hint does not change the index.
  const without = computeHarmonizedActivity(
    list.filter((o) => o.sensor === 'MODIS'),
    list.filter((o) => o.sensor === 'VIIRS'),
    { now: NOW }
  );
  assert.equal(r.rows[0].index, without.rows[0].index);
});

test('satellite selection restricts what is counted, per sensor', () => {
  const m = [obs('MODIS', D1, cellLat(1), 20, { satellite: 'Aqua' }), obs('MODIS', D1, cellLat(2), 20, { satellite: 'Terra' })];
  const v = [obs('VIIRS', D1, cellLat(1), 20, { satellite: 'NOAA-20' }), obs('VIIRS', D1, cellLat(3), 20, { satellite: 'NOAA-21' })];
  const r = computeHarmonizedActivity(m, v, { now: NOW, modisSatellites: ['Aqua'], viirsSatellites: ['NOAA-21'] });
  assert.equal(r.rows[0].modisCount, 1);
  assert.equal(r.rows[0].viirsCount, 1);
});

test('inputs are not mutated, wrong-sensor and invalid records are counted as skipped', () => {
  const good = obs('MODIS', D1, cellLat(1), 20);
  const wrong = obs('VIIRS', D1, cellLat(2), 20); // VIIRS in the MODIS list
  const badCoord = obs('MODIS', D1, NaN, 20);
  const noFrp = { ...obs('MODIS', D1, cellLat(4), 20), frp_mw: NaN };
  const m = Object.freeze([Object.freeze(good), Object.freeze(wrong), Object.freeze(badCoord), Object.freeze(noFrp)]) as readonly CanonicalObservation[];
  const r = computeHarmonizedActivity(m, [], { now: NOW });
  assert.equal(r.rows[0].modisCount, 2);
  assert.equal(r.skipped, 2);
  assert.ok(Number.isFinite(r.rows[0].index));
  assert.ok(r.warnings.some((w) => /not used/.test(w)));
});

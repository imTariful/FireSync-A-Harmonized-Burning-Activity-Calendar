import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CanonicalObservation, SatelliteType } from '../types/fire';
import { haversineDistanceKm } from './spatial';
import { computeFrpAgreement, matchModisViirs, MATCHING_DEFAULTS } from './matching';

// ---------------------------------------------------------------------------
// Synthetic data helpers (no network, no NASA, no randomness except a seeded PRNG)
// ---------------------------------------------------------------------------

const T0 = Date.UTC(2026, 0, 15, 6, 0, 0);
const KM_PER_DEG = haversineDistanceKm(0, 0, 0, 1);

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
    scan: s.scan ?? px,
    track: s.track ?? px,
    daynight: 'D',
    source_file: 'synthetic',
    retrieved_at: iso,
    quality_flags: '',
    record_hash: s.id,
  };
}

const M = (id: string, lat: number, lon: number, o: Partial<ObsSpec> = {}) =>
  obs({ id, sensor: 'MODIS', lat, lon, ...o });
const V = (id: string, lat: number, lon: number, o: Partial<ObsSpec> = {}) =>
  obs({ id, sensor: 'VIIRS', lat, lon, ...o });

/** degrees of longitude spanned by `km` of true east-west distance at `lat` */
const dLon = (km: number, lat: number) => km / (KM_PER_DEG * Math.cos((lat * Math.PI) / 180));
/** degrees of latitude spanned by `km` */
const dLat = (km: number) => km / KM_PER_DEG;

const near = (a: number | null, b: number, eps = 1e-9) =>
  assert.ok(a !== null && Math.abs(a - b) <= eps, `expected ${a} ~ ${b} (eps ${eps})`);

const ids = (list: CanonicalObservation[]) => list.map((o) => o.id);
const pairIds = (r: ReturnType<typeof matchModisViirs>) =>
  r.point.matched.map((p) => `${p.modis.id}>${p.viirs.id}`).sort();

// ---------------------------------------------------------------------------
// Empty input
// ---------------------------------------------------------------------------

test('empty input: everything empty, ratios and stats undefined (null), still labelled EXPLORATORY', () => {
  const r = matchModisViirs([]);
  assert.equal(r.label, 'EXPLORATORY');
  assert.deepEqual(r.point.matched, []);
  assert.deepEqual(r.point.modisOnly, []);
  assert.deepEqual(r.point.viirsOnly, []);
  assert.deepEqual(r.cell.cells, []);
  assert.equal(r.detectionRatio.overall.ratio, null);
  assert.equal(r.detectionRatio.coDetected.ratio, null);
  for (const f of [r.point.frpAgreement, r.cell.frpAgreement]) {
    assert.equal(f.n, 0);
    assert.equal(f.bias, null);
    assert.equal(f.mae, null);
    assert.equal(f.rmse, null);
    assert.equal(f.regression, null);
  }
  assert.deepEqual(r.params.maxDistanceKm, MATCHING_DEFAULTS.maxDistanceKm);
  assert.equal(r.params.maxTimeDiffMinutes, 180);
  assert.match(r.uncertainty, /EXPLORATORY/);
  assert.ok(r.limitations.length > 0);
});

test('invalid options throw RangeError', () => {
  assert.throws(() => matchModisViirs([], { maxDistanceKm: -1 }), RangeError);
  assert.throws(() => matchModisViirs([], { maxTimeDiffMinutes: Number.NaN }), RangeError);
  assert.throws(() => matchModisViirs([], { gridCellSizeKm: 0 }), RangeError);
});

test('invalid records are excluded and counted, not guessed at', () => {
  const badTime = { ...M('bad-time', 10, 90), datetime_utc: 'garbage', acq_date: 'x', acq_time: 'y' };
  const timeFromParts = { ...V('parts-ok', 10, 90), datetime_utc: 'garbage', acq_date: '2026-01-15', acq_time: '0600' };
  const unknown = { ...M('weird', 10, 90), sensor: 'AVHRR' } as unknown as CanonicalObservation;
  const r = matchModisViirs([
    M('nan-lat', Number.NaN, 90),
    M('lat95', 95, 90),
    M('lon200', 10, 200),
    badTime,
    unknown,
    M('good', 10, 90),
    timeFromParts,
  ]);
  assert.equal(r.counts.excluded.invalidCoordinates, 3);
  assert.equal(r.counts.excluded.invalidTime, 1);
  assert.equal(r.counts.excluded.unknownSensor, 1);
  assert.equal(r.counts.modisInput, 1);
  assert.equal(r.counts.viirsInput, 1);
  // acq_date/acq_time fallback produced a usable timestamp, so the pair matches
  assert.deepEqual(pairIds(r), ['good>parts-ok']);
  assert.match(r.uncertainty, /ignored/);
});

// ---------------------------------------------------------------------------
// One-sided data
// ---------------------------------------------------------------------------

test('one-sided data: VIIRS only', () => {
  const r = matchModisViirs([V('v1', 10, 90), V('v2', 11, 91), V('v3', 12, 92)]);
  assert.equal(r.point.matched.length, 0);
  assert.equal(r.cell.cells.length, 0);
  assert.deepEqual(ids(r.point.viirsOnly), ['v1', 'v2', 'v3']);
  assert.deepEqual(ids(r.cell.viirsOnly), ['v1', 'v2', 'v3']);
  assert.equal(r.point.modisOnly.length, 0);
  assert.equal(r.detectionRatio.overall.viirs, 3);
  assert.equal(r.detectionRatio.overall.modis, 0);
  assert.equal(r.detectionRatio.overall.ratio, null); // no divide-by-zero, no fake number
  assert.equal(r.point.frpAgreement.n, 0);
});

test('one-sided data: MODIS only', () => {
  const r = matchModisViirs([M('m1', 10, 90), M('m2', 11, 91)]);
  assert.equal(r.point.matched.length, 0);
  assert.deepEqual(ids(r.point.modisOnly), ['m1', 'm2']);
  assert.deepEqual(ids(r.cell.modisOnly), ['m1', 'm2']);
  assert.equal(r.detectionRatio.overall.ratio, 0);
  assert.equal(r.detectionRatio.coDetected.ratio, null);
  assert.match(r.limitations.join(' '), /not that the other sensor saw no fire/);
});

// ---------------------------------------------------------------------------
// Antimeridian
// ---------------------------------------------------------------------------

test('antimeridian: pair across +180/-180 at both levels (either direction)', () => {
  const lat = 10;
  const trueKm = haversineDistanceKm(lat, 179.9995, lat, -179.9995);
  near(trueKm, 0.001 * KM_PER_DEG * Math.cos((lat * Math.PI) / 180), 1e-3);

  for (const [mLon, vLon] of [
    [179.9995, -179.9995],
    [-179.9995, 179.9995],
  ]) {
    const r = matchModisViirs([M('m', lat, mLon), V('v', lat, vLon)]);
    assert.deepEqual(pairIds(r), ['m>v'], `m=${mLon} v=${vLon}`);
    near(r.point.matched[0].distanceKm, trueKm, 1e-9);
    assert.equal(r.cell.cells.length, 1);
    assert.equal(r.cell.cells[0].viirsCount, 1);
  }
});

test('antimeridian: exactly +180 vs -180 is the same place', () => {
  const r = matchModisViirs([M('m', 0, 180), V('v', 0, -180)]);
  assert.deepEqual(pairIds(r), ['m>v']);
  near(r.point.matched[0].distanceKm, 0, 1e-9);
  assert.equal(r.cell.cells.length, 1);
});

test('antimeridian: respects the distance limit on both sides of the seam', () => {
  // 0.02 deg of longitude at lat 10 is ~2.19 km
  const a = matchModisViirs([M('m', 10, 179.99), V('v', 10, -179.99)]);
  assert.equal(a.point.matched.length, 0);
  const b = matchModisViirs([M('m', 10, 179.99), V('v', 10, -179.99)], { maxDistanceKm: 3 });
  assert.deepEqual(pairIds(b), ['m>v']);
  // far apart in longitude (2 degrees) is never matched just because the numbers are near +-180
  const c = matchModisViirs([M('m', 10, 179), V('v', 10, -179)], { maxDistanceKm: 3 });
  assert.equal(c.point.matched.length, 0);
});

test('antimeridian: also correct when the grid index is used (many detections elsewhere)', () => {
  // With only a couple of detections the matcher falls back to scanning everything, which would hide
  // an antimeridian bug in the grid lookup. Fillers make the real indexed path run.
  const filler: CanonicalObservation[] = [];
  for (let i = 0; i < 20; i++) {
    for (let j = 0; j < 20; j++) filler.push(V(`f-${i}-${j}`, 30 + i * 0.1, 100 + j * 0.3));
  }
  for (const lat of [0, 10, 45, 70]) {
    for (const [mLon, vLon] of [
      [179.9995, -179.9995],
      [-179.9995, 179.9995],
      [180, -180],
      [-180, 180],
    ]) {
      const r = matchModisViirs([M('m', lat, mLon), V('v', lat, vLon), ...filler]);
      assert.deepEqual(pairIds(r), ['m>v'], `lat=${lat} m=${mLon} v=${vLon}`);
      assert.equal(r.cell.cells.length, 1, `cell lat=${lat} m=${mLon} v=${vLon}`);
      assert.deepEqual(ids(r.cell.cells[0].viirs), ['v']);
    }
  }
});

// ---------------------------------------------------------------------------
// Same pixel, different time
// ---------------------------------------------------------------------------

test('same pixel, different time: window is +-3 h inclusive and configurable', () => {
  const run = (dtMin: number, opts = {}) =>
    matchModisViirs([M('m', 23.7, 90.3), V('v', 23.7, 90.3, { dtMin })], opts);

  assert.deepEqual(pairIds(run(0)), ['m>v']);
  assert.deepEqual(pairIds(run(180)), ['m>v'], 'exactly +3 h is inside');
  assert.deepEqual(pairIds(run(-180)), ['m>v'], 'exactly -3 h is inside');
  near(run(-180).point.matched[0].timeDiffMinutes, -180, 1e-9);

  for (const dt of [181, -181, 300, 1440]) {
    const r = run(dt);
    assert.equal(r.point.matched.length, 0, `dt=${dt}`);
    assert.deepEqual(ids(r.point.modisOnly), ['m']);
    assert.deepEqual(ids(r.point.viirsOnly), ['v']);
    assert.equal(r.cell.cells.length, 0, `cell level dt=${dt}`);
    assert.deepEqual(ids(r.cell.modisOnly), ['m']);
    assert.deepEqual(ids(r.cell.viirsOnly), ['v']);
  }
  assert.deepEqual(pairIds(run(300, { maxTimeDiffMinutes: 300 })), ['m>v']);
  assert.equal(run(60, { maxTimeDiffMinutes: 30 }).point.matched.length, 0);
});

// ---------------------------------------------------------------------------
// Tie-breaking and one-to-one
// ---------------------------------------------------------------------------

test('tie-break: equal distance and time -> smaller id wins, regardless of input order', () => {
  const lat = 10;
  const d = dLon(0.4, lat);
  const m = M('M', lat, 90);
  const east = V('v-b', lat, 90 + d);
  const west = V('v-a', lat, 90 - d);
  for (const input of [[m, east, west], [west, east, m], [east, m, west]]) {
    const r = matchModisViirs(input);
    assert.deepEqual(pairIds(r), ['M>v-a']);
    assert.deepEqual(ids(r.point.viirsOnly), ['v-b']);
    // cell level: both are inside the 1x1 km footprint, so both belong to the one MODIS cell
    assert.equal(r.cell.cells.length, 1);
    assert.deepEqual(ids(r.cell.cells[0].viirs), ['v-a', 'v-b']);
  }
});

test('tie-break: distances within 1 mm count as equal, so id decides (floating-point noise cannot)', () => {
  const lat = 10;
  const m = M('M', lat, 90);
  // v-b is 0.1 mm closer than v-a, which is below the 1 mm tie resolution -> tie -> smaller id (v-a) wins
  const a = V('v-a', lat, 90 + dLon(0.4 + 1e-7, lat));
  const b = V('v-b', lat, 90 - dLon(0.4, lat));
  assert.deepEqual(pairIds(matchModisViirs([m, a, b])), ['M>v-a']);
  // but a real difference (10 cm) is not a tie: the nearer one wins
  const c = V('v-c', lat, 90 + dLon(0.4 + 1e-4, lat));
  assert.deepEqual(pairIds(matchModisViirs([m, c, b])), ['M>v-b']);
});

test('tie-break: equal distance -> smaller |dt| wins over id order', () => {
  const lat = 10;
  const d = dLon(0.4, lat);
  const r = matchModisViirs([
    M('M', lat, 90),
    V('v-a', lat, 90 - d, { dtMin: 10 }),
    V('v-b', lat, 90 + d, { dtMin: -5 }),
  ]);
  assert.deepEqual(pairIds(r), ['M>v-b']);
});

test('tie-break: distance outranks time', () => {
  const lat = 10;
  const r = matchModisViirs([
    M('M', lat, 90),
    V('near-late', lat, 90 + dLon(0.2, lat), { dtMin: 170 }),
    V('far-exact', lat, 90 - dLon(0.8, lat), { dtMin: 0 }),
  ]);
  assert.deepEqual(pairIds(r), ['M>near-late']);
});

test('one-to-one: two MODIS compete for one VIIRS, the nearer MODIS wins (any input order)', () => {
  const lat = 10;
  const m1 = M('m1', lat, 90 - dLon(0.3, lat));
  const m2 = M('m2', lat, 90 + dLon(0.6, lat));
  const v = V('v', lat, 90);
  for (const input of [[m1, m2, v], [v, m2, m1]]) {
    const r = matchModisViirs(input);
    assert.deepEqual(pairIds(r), ['m1>v']);
    assert.deepEqual(ids(r.point.modisOnly), ['m2']);
    assert.equal(r.point.viirsOnly.length, 0);
  }
});

// ---------------------------------------------------------------------------
// Cell-to-cell aggregation
// ---------------------------------------------------------------------------

test('cell level: several 375 m VIIRS detections aggregate into one 2x2 km MODIS cell', () => {
  const lat = 23.7;
  const lon = 90.3;
  const at = (eastKm: number, northKm: number) => [lat + dLat(northKm), lon + dLon(eastKm, lat)] as const;
  const r = matchModisViirs([
    M('m', lat, lon, { scan: 2, track: 2, frp: 40 }),
    V('in1', ...at(0.3, 0.3), { frp: 5 }),
    V('in2', ...at(-0.9, -0.5), { frp: 7 }),
    V('in3', ...at(0.2, -0.95), { frp: 3 }),
    V('out', ...at(1.5, 0), { frp: 99 }), // 1.5 km east > 1 km half-width
  ]);

  assert.equal(r.cell.cells.length, 1);
  const c = r.cell.cells[0];
  assert.equal(c.viirsCount, 3);
  assert.deepEqual(ids(c.viirs).sort(), ['in1', 'in2', 'in3']);
  assert.equal(c.viirsFrpSumMw, 15); // VIIRS-only sum, never added to MODIS FRP
  assert.equal(c.modisFrpMw, 40);
  assert.equal(c.footprintKm2, 4);
  assert.equal(c.footprintFallback, false);
  assert.match(c.gridCell.cellKey, /^cell_-?\d+_-?\d+$/);
  assert.deepEqual(ids(r.cell.viirsOnly), ['out']);

  // point level is one-to-one within 1 km, so only the nearest VIIRS pairs; others stay unmatched there
  assert.equal(r.point.matched.length, 1);
  assert.equal(r.point.viirsOnly.length, 3);

  assert.equal(r.detectionRatio.overall.viirs, 4);
  assert.equal(r.detectionRatio.overall.modis, 1);
  assert.equal(r.detectionRatio.coDetected.ratio, 3);
  const f = r.cell.frpAgreement;
  assert.equal(f.n, 1);
  assert.equal(f.bias, -25);
  assert.equal(f.mae, 25);
  assert.equal(f.rmse, 25);
  assert.equal(f.regression, null); // n < 3
});

test('cell level: a VIIRS detection inside two overlapping footprints is assigned once, to the nearest', () => {
  const lat = 10;
  const lon = 90;
  const r = matchModisViirs([
    M('m1', lat, lon, { scan: 2, track: 2 }),
    M('m2', lat, lon + dLon(1.2, lat), { scan: 2, track: 2 }),
    V('v', lat, lon + dLon(0.9, lat)), // 0.9 km from m1, 0.3 km from m2; inside both
  ]);
  assert.equal(r.cell.cells.length, 1);
  assert.equal(r.cell.cells[0].modis.id, 'm2');
  assert.equal(r.cell.cells[0].viirsCount, 1);
  assert.deepEqual(ids(r.cell.modisOnly), ['m1']);
  assert.equal(r.cell.viirsOnly.length, 0);
  assert.equal(r.detectionRatio.coDetected.viirs, 1); // not double counted
});

test('cell level: missing scan/track falls back to a nominal 1 km pixel and says so', () => {
  const lat = 10;
  const r = matchModisViirs([
    M('m', lat, 90, { scan: 0, track: 0 }),
    V('in', lat, 90 + dLon(0.4, lat)),
    V('out', lat, 90 + dLon(0.6, lat)),
  ]);
  assert.equal(r.counts.modisFootprintFallbacks, 1);
  const c = r.cell.cells[0];
  assert.equal(c.footprintFallback, true);
  assert.equal(c.footprintKm2, 1);
  assert.deepEqual(ids(c.viirs), ['in']);
  assert.deepEqual(ids(r.cell.viirsOnly), ['out']);
  assert.match(r.limitations.join(' '), /nominal 1 km pixel/);
});

test('cell level: high latitude (equal-area grid distorts east-west) still finds a VIIRS 1.4 km away', () => {
  const lat = 70;
  const lon = 20;
  // 400 filler VIIRS far away so the grid index (not the brute-force fallback) is exercised
  const filler: CanonicalObservation[] = [];
  for (let i = 0; i < 20; i++) {
    for (let j = 0; j < 20; j++) filler.push(V(`f-${i}-${j}`, lat + 2 + i * 0.1, lon + 10 + j * 0.3));
  }
  const r = matchModisViirs(
    [M('m', lat, lon, { scan: 3, track: 1 }), V('v', lat, lon + dLon(1.4, lat)), ...filler],
    { maxDistanceKm: 1.5 }
  );
  assert.equal(r.cell.cells.length, 1);
  assert.deepEqual(ids(r.cell.cells[0].viirs), ['v']);
  assert.deepEqual(pairIds(r), ['m>v']);
});

// ---------------------------------------------------------------------------
// FRP agreement
// ---------------------------------------------------------------------------

function frpSites(modisFrp: number[], viirsFrp: number[]): CanonicalObservation[] {
  const out: CanonicalObservation[] = [];
  modisFrp.forEach((fm, i) => {
    const lon = 90 + i * 0.5; // ~50 km apart: no cross-site matching
    out.push(M(`m${i}`, 10, lon, { frp: fm }), V(`v${i}`, 10, lon + dLon(0.1, 10), { frp: viirsFrp[i] }));
  });
  return out;
}

test('FRP agreement: n, bias (VIIRS-MODIS), MAE, RMSE and OLS match hand-computed values', () => {
  // x=[10,20,30,40], y=[12,18,35,38]: d=[2,-2,5,-2]
  const r = matchModisViirs(frpSites([10, 20, 30, 40], [12, 18, 35, 38]));
  for (const f of [r.point.frpAgreement, r.cell.frpAgreement]) {
    assert.equal(f.n, 4);
    assert.equal(f.excluded, 0);
    near(f.bias, 0.75);
    near(f.mae, 2.75);
    near(f.rmse, Math.sqrt(9.25));
    assert.ok(f.regression);
    near(f.regression.slope, 475 / 500);
    near(f.regression.intercept, 2);
    const rr = 475 / Math.sqrt(500 * 484.75);
    near(f.regression.r, rr);
    near(f.regression.r2, rr * rr);
    assert.match(f.note, /Small sample/);
  }
});

test('FRP agreement: FRP <= 0 is excluded (missing is stored as 0), matching itself is unaffected', () => {
  const r = matchModisViirs(frpSites([10, 20, 30, 40, 50], [12, 18, 35, 38, 0]));
  assert.equal(r.point.matched.length, 5);
  assert.equal(r.point.frpAgreement.n, 4);
  assert.equal(r.point.frpAgreement.excluded, 1);
  assert.equal(r.cell.frpAgreement.n, 4);
  assert.equal(r.cell.frpAgreement.excluded, 1);
  assert.equal(r.cell.cells.filter((c) => c.viirsFrpSumMw === null).length, 1);
});

test('FRP agreement: regression withheld for n<3 or zero MODIS variance, never fabricated', () => {
  const flat = matchModisViirs(frpSites([10, 10, 10], [5, 6, 7])).point.frpAgreement;
  assert.equal(flat.n, 3);
  assert.equal(flat.regression, null);
  assert.match(flat.note, /zero variance/);

  const two = computeFrpAgreement(
    [
      { modis: 1, viirs: 2 },
      { modis: 2, viirs: 3 },
    ],
    0,
    'x'
  );
  assert.equal(two.regression, null);
  assert.match(two.note, /n=2 < 3/);
});

// ---------------------------------------------------------------------------
// Guard rails
// ---------------------------------------------------------------------------

test('multiple VIIRS satellites are called out, and filters restrict the input', () => {
  const input = [
    M('m', 10, 90),
    V('n20', 10, 90, { satellite: 'NOAA-20' }),
    V('n21', 10, 90 + dLon(0.1, 10), { satellite: 'NOAA-21' }),
  ];
  const both = matchModisViirs(input);
  assert.deepEqual(both.counts.viirsSatellitesPresent, ['NOAA-20', 'NOAA-21']);
  assert.match(both.limitations.join(' '), /several satellites/);
  assert.equal(both.cell.cells[0].viirsCount, 2);

  const only21 = matchModisViirs(input, { viirsSatellites: ['NOAA-21'] });
  assert.equal(only21.counts.excluded.filteredBySatellite, 1);
  assert.deepEqual(only21.counts.viirsSatellitesPresent, ['NOAA-21']);
  assert.equal(only21.cell.cells[0].viirsCount, 1);
  assert.doesNotMatch(only21.limitations.join(' '), /several satellites/);
});

test('inputs are not mutated and results reference the original objects', () => {
  const m = Object.freeze(M('m', 10, 90));
  const v = Object.freeze(V('v', 10, 90));
  const input = Object.freeze([m, v]);
  const r = matchModisViirs(input);
  assert.equal(r.point.matched[0].modis, m);
  assert.equal(r.point.matched[0].viirs, v);
});

test('MODIS and VIIRS are never summed together: only per-sensor counts and a ratio are reported', () => {
  const r = matchModisViirs([M('m', 10, 90, { frp: 40 }), V('v', 10, 90, { frp: 8 })]);
  assert.equal(r.detectionRatio.overall.viirs, 1);
  assert.equal(r.detectionRatio.overall.modis, 1);
  assert.equal(r.cell.cells[0].viirsFrpSumMw, 8);
  assert.equal(r.cell.cells[0].modisFrpMw, 40);
  assert.ok(!JSON.stringify(r).includes('total_'), 'no combined totals in the output');
});

// ---------------------------------------------------------------------------
// Grid index == brute force (guards the equal-area distortion + antimeridian logic)
// ---------------------------------------------------------------------------

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('grid-indexed matching equals a brute-force reference (several latitudes + antimeridian)', () => {
  const rnd = mulberry32(20260615);
  const regions: Array<{ lat: number; lon: number }> = [
    { lat: 5, lon: 90 },
    { lat: 40, lon: 10 },
    { lat: 70, lon: 20 },
    { lat: -35, lon: -60 },
    { lat: 10, lon: 180 }, // straddles the antimeridian
    { lat: 60, lon: -180 },
  ];
  const input: CanonicalObservation[] = [];
  let k = 0;
  for (const reg of regions) {
    const pt = (): [number, number] => {
      const lat = reg.lat + (rnd() - 0.5) * 0.4;
      let lon = reg.lon + (rnd() - 0.5) * 0.4 / Math.max(0.2, Math.cos((reg.lat * Math.PI) / 180));
      if (lon > 180) lon -= 360;
      if (lon < -180) lon += 360;
      return [lat, lon];
    };
    for (let i = 0; i < 60; i++) {
      const [lat, lon] = pt();
      input.push(M(`m${k++}`, lat, lon, { dtMin: (rnd() - 0.5) * 240, scan: 1 + rnd() * 3, track: 1 + rnd() * 3 }));
    }
    for (let i = 0; i < 150; i++) {
      const [lat, lon] = pt();
      input.push(V(`v${k++}`, lat, lon, { dtMin: (rnd() - 0.5) * 240 }));
    }
  }

  const maxDistanceKm = 1.5;
  const windowMin = 120;
  const r = matchModisViirs(input, { maxDistanceKm, maxTimeDiffMinutes: windowMin });

  const ms = input.filter((o) => o.sensor === 'MODIS');
  const vs = input.filter((o) => o.sensor === 'VIIRS');
  const t = (o: CanonicalObservation) => Date.parse(o.datetime_utc);
  const wrap = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;
  const inside = (m: CanonicalObservation, v: CanonicalObservation) => {
    const dx = wrap(v.longitude - m.longitude) * KM_PER_DEG * Math.cos((((m.latitude + v.latitude) / 2) * Math.PI) / 180);
    const dy = (v.latitude - m.latitude) * KM_PER_DEG;
    return Math.abs(dx) <= m.scan / 2 + 1e-9 && Math.abs(dy) <= m.track / 2 + 1e-9;
  };

  interface C { m: CanonicalObservation; v: CanonicalObservation; dKey: number; dt: number; d: number }
  const all: C[] = [];
  for (const m of ms) {
    for (const v of vs) {
      const dt = Math.abs(t(v) - t(m));
      if (dt > windowMin * 60_000) continue;
      const d = haversineDistanceKm(m.latitude, m.longitude, v.latitude, v.longitude);
      all.push({ m, v, d, dKey: Math.round(d * 1e6), dt });
    }
  }
  const cmp = (a: C, b: C) =>
    a.dKey - b.dKey || a.dt - b.dt || (a.m.id < b.m.id ? -1 : a.m.id > b.m.id ? 1 : 0) || (a.v.id < b.v.id ? -1 : a.v.id > b.v.id ? 1 : 0);

  // reference point matching
  const usedM = new Set<string>();
  const usedV = new Set<string>();
  const refPairs: string[] = [];
  for (const c of all.filter((c) => c.d <= maxDistanceKm + 1e-9).sort(cmp)) {
    if (usedM.has(c.m.id) || usedV.has(c.v.id)) continue;
    usedM.add(c.m.id);
    usedV.add(c.v.id);
    refPairs.push(`${c.m.id}>${c.v.id}`);
  }
  assert.ok(refPairs.length > 50, `test data too sparse (${refPairs.length} pairs)`);
  assert.deepEqual(pairIds(r), refPairs.sort());

  // reference cell assignment
  const cellOfV = new Map<string, string>();
  for (const c of all.filter((c) => inside(c.m, c.v)).sort(cmp)) {
    if (!cellOfV.has(c.v.id)) cellOfV.set(c.v.id, c.m.id);
  }
  const refCells = [...cellOfV.entries()].map(([v, m]) => `${m}>${v}`).sort();
  const gotCells = r.cell.cells.flatMap((c) => c.viirs.map((v) => `${c.modis.id}>${v.id}`)).sort();
  assert.ok(refCells.length > 50, `test data too sparse (${refCells.length} cell members)`);
  assert.deepEqual(gotCells, refCells);
});

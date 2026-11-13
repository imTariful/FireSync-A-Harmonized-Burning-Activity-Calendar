/**
 * MODIS <-> VIIRS detection matching (EXPLORATORY).
 *
 * Pure module: no UI, no server, no network, no randomness, no mutation of inputs.
 *
 * Science rules honoured here:
 *  - MODIS and VIIRS are never merged or summed across sensors. VIIRS FRP is summed ONLY across
 *    VIIRS detections that fall inside one MODIS footprint (same sensor), and compared against
 *    that MODIS detection's own FRP.
 *  - Every result carries label 'EXPLORATORY', the method, and a limitations list.
 *  - "MODIS-only" / "VIIRS-only" mean "no counterpart found by this method". They are NOT
 *    non-detections: this module has no overpass-swath, cloud or scan-angle coverage information.
 *  - Nothing here predicts anything or claims ground truth.
 *
 * Two comparison levels are produced:
 *  1. point:  one-to-one pairing of detection centres (distance + time window).
 *  2. cell:   every VIIRS detection is assigned to at most one MODIS "equivalent cell"
 *             (the MODIS pixel footprint, scan x track), then compared cell-to-cell.
 *
 * Spatial indexing uses the equal-area grid from spatial.ts (computeGridCellIndex). The index is
 * only a candidate filter; haversine distance (point level) and local tangent-plane offsets
 * (footprint test) decide membership, so the result does not depend on grid-cell edges.
 */

import type { CanonicalObservation, SatelliteType } from '../types/fire';
import { computeGridCellIndex, haversineDistanceKm, projectToEqualAreaKm } from './spatial';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface MatchingOptions {
  /** Max centre-to-centre distance for point pairing, km. Default 1. */
  maxDistanceKm?: number;
  /** Max |t_viirs - t_modis| in minutes (inclusive). Default 180 (= +-3 h). */
  maxTimeDiffMinutes?: number;
  /** Equal-area grid cell size (km) used only for the reported `gridCell` join key. Default 1. */
  gridCellSizeKm?: number;
  /** Restrict MODIS input to these satellites (e.g. ['Aqua']). Default: all. */
  modisSatellites?: readonly SatelliteType[];
  /** Restrict VIIRS input to these satellites (e.g. ['NOAA-20']). Default: all. */
  viirsSatellites?: readonly SatelliteType[];
}

export interface ResolvedMatchingOptions {
  maxDistanceKm: number;
  maxTimeDiffMinutes: number;
  gridCellSizeKm: number;
  modisSatellites: readonly SatelliteType[] | null;
  viirsSatellites: readonly SatelliteType[] | null;
}

export const MATCHING_DEFAULTS = Object.freeze({
  maxDistanceKm: 1.0,
  maxTimeDiffMinutes: 180,
  gridCellSizeKm: 1.0,
});

export interface MatchedPair {
  modis: CanonicalObservation;
  viirs: CanonicalObservation;
  distanceKm: number;
  /** t_viirs - t_modis in minutes (signed). */
  timeDiffMinutes: number;
}

export interface MatchedCell {
  /** The MODIS detection that defines the cell. */
  modis: CanonicalObservation;
  /** VIIRS detections assigned to this cell, nearest first. Never empty. */
  viirs: CanonicalObservation[];
  viirsCount: number;
  /** Sum of VIIRS FRP inside the cell (VIIRS only). null if any VIIRS FRP is missing/<=0. */
  viirsFrpSumMw: number | null;
  modisFrpMw: number | null;
  /** Footprint used (km). */
  footprintScanKm: number;
  footprintTrackKm: number;
  footprintKm2: number;
  /** True when MODIS scan/track was missing/implausible and the nominal 1 km pixel was used. */
  footprintFallback: boolean;
  /** Equal-area grid cell (spatial.ts) containing the MODIS centre, for joining to 1-km cell products. */
  gridCell: { gridX: number; gridY: number; cellKey: string };
}

export interface FrpRegression {
  /** y = intercept + slope * x, with x = MODIS FRP and y = VIIRS FRP (ordinary least squares). */
  slope: number;
  intercept: number;
  /** Pearson r; null when VIIRS FRP has zero variance. */
  r: number | null;
  r2: number | null;
}

export interface FrpAgreement {
  /** Sample size actually used. */
  n: number;
  /** Candidate pairs/cells dropped because an FRP value was missing, non-finite or <= 0. */
  excluded: number;
  /** What y (VIIRS side) is at this level. */
  viirsQuantity: string;
  /** mean(y - x), VIIRS minus MODIS, MW. null when n = 0. */
  bias: number | null;
  mae: number | null;
  rmse: number | null;
  /** null when n < 3 or MODIS FRP has zero variance. */
  regression: FrpRegression | null;
  note: string;
}

export interface Ratio {
  viirs: number;
  modis: number;
  /** viirs / modis; null when modis = 0. */
  ratio: number | null;
  basis: string;
}

export interface MatchingResult {
  label: 'EXPLORATORY';
  method: string;
  params: ResolvedMatchingOptions;
  counts: {
    modisInput: number;
    viirsInput: number;
    excluded: { invalidCoordinates: number; invalidTime: number; unknownSensor: number; filteredBySatellite: number };
    viirsSatellitesPresent: string[];
    modisSatellitesPresent: string[];
    modisFootprintFallbacks: number;
  };
  point: {
    matched: MatchedPair[];
    viirsOnly: CanonicalObservation[];
    modisOnly: CanonicalObservation[];
    frpAgreement: FrpAgreement;
  };
  cell: {
    cells: MatchedCell[];
    viirsOnly: CanonicalObservation[];
    modisOnly: CanonicalObservation[];
    frpAgreement: FrpAgreement;
  };
  detectionRatio: {
    /** All valid VIIRS detections / all valid MODIS detections passed in. Coverage-dependent. */
    overall: Ratio;
    /** VIIRS detections inside co-detected MODIS cells / number of those cells. */
    coDetected: Ratio;
  };
  limitations: string[];
  /** One human-readable paragraph: label + method + sample sizes + limitations. */
  uncertainty: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NOMINAL_MODIS_PIXEL_KM = 1.0;
/** MODIS pixels grow to ~4.8 km at scan edge; anything above this is treated as bad metadata. */
const MAX_PLAUSIBLE_PIXEL_KM = 10;
/** Rule-of-thumb flag for "small sample", not a validated threshold. */
const LOW_SAMPLE_N = 30;
const MIN_REGRESSION_N = 3;
const EPS_KM = 1e-9;
const DEG_TO_RAD = Math.PI / 180;
const MS_PER_MIN = 60_000;
/** Km per degree of great-circle arc, derived from spatial.ts so the two can never disagree. */
const KM_PER_DEG = haversineDistanceKm(0, 0, 0, 1);

// ---------------------------------------------------------------------------
// Input preparation
// ---------------------------------------------------------------------------

interface Prep {
  obs: CanonicalObservation;
  idx: number;
  id: string;
  lat: number;
  lon: number;
  tMs: number;
}

function parseTimeMs(o: CanonicalObservation): number {
  const direct = Date.parse(o.datetime_utc);
  if (Number.isFinite(direct)) return direct;
  const t = String(o.acq_time ?? '').padStart(4, '0');
  const d = String(o.acq_date ?? '');
  if (/^\d{4}$/.test(t) && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
    const ms = Date.parse(`${d}T${t.slice(0, 2)}:${t.slice(2)}:00Z`);
    if (Number.isFinite(ms)) return ms;
  }
  return NaN;
}

function validCoords(lat: unknown, lon: unknown): boolean {
  return (
    typeof lat === 'number' &&
    typeof lon === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180
  );
}

function usableFrp(v: unknown): v is number {
  // The FIRMS parser maps a missing FRP to 0, so 0 cannot be told apart from "no value".
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function footprintOf(o: CanonicalObservation): { scanKm: number; trackKm: number; fallback: boolean } {
  const ok = (v: unknown): v is number =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= MAX_PLAUSIBLE_PIXEL_KM;
  if (ok(o.scan) && ok(o.track)) return { scanKm: o.scan, trackKm: o.track, fallback: false };
  return { scanKm: NOMINAL_MODIS_PIXEL_KM, trackKm: NOMINAL_MODIS_PIXEL_KM, fallback: true };
}

function resolveOptions(options: MatchingOptions): ResolvedMatchingOptions {
  const maxDistanceKm = options.maxDistanceKm ?? MATCHING_DEFAULTS.maxDistanceKm;
  const maxTimeDiffMinutes = options.maxTimeDiffMinutes ?? MATCHING_DEFAULTS.maxTimeDiffMinutes;
  const gridCellSizeKm = options.gridCellSizeKm ?? MATCHING_DEFAULTS.gridCellSizeKm;
  if (!Number.isFinite(maxDistanceKm) || maxDistanceKm < 0) {
    throw new RangeError('maxDistanceKm must be a finite number >= 0');
  }
  if (!Number.isFinite(maxTimeDiffMinutes) || maxTimeDiffMinutes < 0) {
    throw new RangeError('maxTimeDiffMinutes must be a finite number >= 0');
  }
  if (!Number.isFinite(gridCellSizeKm) || gridCellSizeKm <= 0) {
    throw new RangeError('gridCellSizeKm must be a finite number > 0');
  }
  return {
    maxDistanceKm,
    maxTimeDiffMinutes,
    gridCellSizeKm,
    modisSatellites: options.modisSatellites ?? null,
    viirsSatellites: options.viirsSatellites ?? null,
  };
}

// ---------------------------------------------------------------------------
// Spatial index on the equal-area grid (candidate filter only)
// ---------------------------------------------------------------------------

/**
 * The equal-area projection is not conformal: 1 true km spans more than 1 projected km east-west
 * away from the standard parallel. Rather than hard-coding the parallel, the reach is measured
 * from projectToEqualAreaKm itself so it follows spatial.ts if that ever changes.
 */
function projectedPerTrueKm(lat: number, axis: 'x' | 'y'): number {
  const step = 0.05;
  const a = projectToEqualAreaKm(lat, 0);
  if (axis === 'x') {
    const b = projectToEqualAreaKm(lat, step);
    const trueKm = haversineDistanceKm(lat, 0, lat, step);
    return trueKm > 0 ? Math.abs(b.xKm - a.xKm) / trueKm : Infinity;
  }
  const lat2 = lat + step <= 90 ? lat + step : lat - step;
  const b = projectToEqualAreaKm(lat2, 0);
  return Math.abs(b.yKm - a.yKm) / haversineDistanceKm(lat, 0, lat2, 0);
}

/** y stretch is largest at the equator for this projection (cos(phi)/cos(phi0)); evaluate there. */
const Y_FACTOR = projectedPerTrueKm(0, 'y');
const POLAR_BRUTE_FORCE_LAT = 89;
const REACH_SAFETY = 1.05;

class GridIndex {
  private readonly buckets = new Map<string, number[]>();
  private readonly all: number[] = [];

  constructor(
    private readonly items: readonly Prep[],
    private readonly cellKm: number
  ) {
    items.forEach((p, i) => {
      const { gridX, gridY } = computeGridCellIndex(p.lat, p.lon, cellKm);
      const key = `${gridX}|${gridY}`;
      const b = this.buckets.get(key);
      if (b) b.push(i);
      else this.buckets.set(key, [i]);
      this.all.push(i);
    });
  }

  /** Indices of items that MAY lie within radiusKm (true distance) of (lat, lon). Superset; verify after. */
  query(lat: number, lon: number, radiusKm: number): number[] {
    if (this.items.length === 0) return [];
    const marginDeg = (radiusKm / KM_PER_DEG) * REACH_SAFETY + 0.01;
    const latHi = Math.abs(lat) + marginDeg;
    // Near the poles the grid distorts without bound and fires are essentially absent: stay exact.
    if (latHi >= POLAR_BRUTE_FORCE_LAT) return this.all;

    const xFactor = projectedPerTrueKm(latHi, 'x');
    const kx = Math.ceil((radiusKm * xFactor * REACH_SAFETY) / this.cellKm);
    const ky = Math.ceil((radiusKm * Y_FACTOR * REACH_SAFETY) / this.cellKm);
    if ((2 * kx + 1) * (2 * ky + 1) > this.buckets.size) return this.all;

    // Antimeridian: the grid's x axis is not periodic, so also look from the lon +-360 image.
    const lonVariants = [lon];
    const kmPerDegLon = haversineDistanceKm(latHi, 0, latHi, 1);
    const reachDegLon = kmPerDegLon > 0 ? (radiusKm * REACH_SAFETY) / kmPerDegLon : Infinity;
    if (180 - Math.abs(lon) <= reachDegLon + 1e-6) {
      lonVariants.push(lon - 360 * Math.sign(lon || 1));
    }

    const found = new Set<number>();
    for (const lv of lonVariants) {
      const { gridX, gridY } = computeGridCellIndex(lat, lv, this.cellKm);
      for (let dx = -kx; dx <= kx; dx++) {
        for (let dy = -ky; dy <= ky; dy++) {
          const b = this.buckets.get(`${gridX + dx}|${gridY + dy}`);
          if (b) for (const i of b) found.add(i);
        }
      }
    }
    return [...found];
  }
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function wrapLonDelta(d: number): number {
  return ((((d + 180) % 360) + 360) % 360) - 180;
}

/** Is the VIIRS centre inside the (axis-aligned) MODIS footprint? Antimeridian-safe. */
function insideFootprint(m: Prep, v: Prep, scanKm: number, trackKm: number): boolean {
  const dLon = wrapLonDelta(v.lon - m.lon);
  const midLat = (m.lat + v.lat) / 2;
  const dxKm = dLon * KM_PER_DEG * Math.cos(midLat * DEG_TO_RAD); // east-west  ~ scan direction
  const dyKm = (v.lat - m.lat) * KM_PER_DEG; // north-south ~ track direction
  return Math.abs(dxKm) <= scanKm / 2 + EPS_KM && Math.abs(dyKm) <= trackKm / 2 + EPS_KM;
}

// ---------------------------------------------------------------------------
// Candidate ordering (the tie-breaking rule)
// ---------------------------------------------------------------------------

interface Cand {
  m: Prep;
  v: Prep;
  distKm: number;
  /** distance quantised to 1 mm so floating-point noise cannot decide ties */
  dKey: number;
  absDtMs: number;
}

/**
 * Deterministic order: nearer distance, then smaller |dt|, then MODIS id, VIIRS id,
 * then input position. Independent of input order unless ids are duplicated.
 */
function cmpCand(a: Cand, b: Cand): number {
  return (
    a.dKey - b.dKey ||
    a.absDtMs - b.absDtMs ||
    cmpStr(a.m.id, b.m.id) ||
    cmpStr(a.v.id, b.v.id) ||
    a.m.idx - b.m.idx ||
    a.v.idx - b.v.idx
  );
}

function cmpPrepByTime(a: Prep, b: Prep): number {
  return a.tMs - b.tMs || cmpStr(a.id, b.id) || a.idx - b.idx;
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

/**
 * Agreement of VIIRS-side FRP (y) against MODIS FRP (x). Samples must already be usable (finite, > 0).
 * `excluded` is only echoed back. Exported so a UI can reuse the exact same maths.
 */
export function computeFrpAgreement(
  samples: ReadonlyArray<{ modis: number; viirs: number }>,
  excluded: number,
  viirsQuantity: string
): FrpAgreement {
  const n = samples.length;
  if (n === 0) {
    return {
      n: 0,
      excluded,
      viirsQuantity,
      bias: null,
      mae: null,
      rmse: null,
      regression: null,
      note: 'No usable FRP pairs: agreement statistics are undefined.',
    };
  }

  let sumX = 0;
  let sumY = 0;
  let sumAbs = 0;
  let sumSq = 0;
  for (const s of samples) {
    const d = s.viirs - s.modis;
    sumX += s.modis;
    sumY += s.viirs;
    sumAbs += Math.abs(d);
    sumSq += d * d;
  }
  const meanX = sumX / n;
  const meanY = sumY / n;

  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const s of samples) {
    const dx = s.modis - meanX;
    const dy = s.viirs - meanY;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }

  let regression: FrpRegression | null = null;
  const notes: string[] = [];
  if (n < MIN_REGRESSION_N) {
    notes.push(`Regression not reported (n=${n} < ${MIN_REGRESSION_N}).`);
  } else if (!(sxx > 0)) {
    notes.push('Regression not reported (MODIS FRP has zero variance).');
  } else {
    const slope = sxy / sxx;
    const r = syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
    regression = { slope, intercept: meanY - slope * meanX, r, r2: r === null ? null : r * r };
  }
  if (n < LOW_SAMPLE_N) {
    notes.push(`Small sample (n=${n} < ${LOW_SAMPLE_N}, rule-of-thumb flag): treat statistics as indicative only.`);
  }

  return {
    n,
    excluded,
    viirsQuantity,
    bias: sumY / n - sumX / n,
    mae: sumAbs / n,
    rmse: Math.sqrt(sumSq / n),
    regression,
    note: notes.join(' '),
  };
}

function ratioOf(viirs: number, modis: number, basis: string): Ratio {
  return { viirs, modis, ratio: modis > 0 ? viirs / modis : null, basis };
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export function matchModisViirs(
  observations: readonly CanonicalObservation[],
  options: MatchingOptions = {}
): MatchingResult {
  const params = resolveOptions(options);
  const windowMs = params.maxTimeDiffMinutes * MS_PER_MIN;
  const modisFilter = params.modisSatellites ? new Set<string>(params.modisSatellites) : null;
  const viirsFilter = params.viirsSatellites ? new Set<string>(params.viirsSatellites) : null;

  // ---- 1. validate + split by sensor -------------------------------------------------------
  const excluded = { invalidCoordinates: 0, invalidTime: 0, unknownSensor: 0, filteredBySatellite: 0 };
  const modis: Prep[] = [];
  const viirs: Prep[] = [];

  observations.forEach((o, idx) => {
    if (!o || (o.sensor !== 'MODIS' && o.sensor !== 'VIIRS')) {
      excluded.unknownSensor++;
      return;
    }
    const filter = o.sensor === 'MODIS' ? modisFilter : viirsFilter;
    if (filter && !filter.has(o.satellite)) {
      excluded.filteredBySatellite++;
      return;
    }
    if (!validCoords(o.latitude, o.longitude)) {
      excluded.invalidCoordinates++;
      return;
    }
    const tMs = parseTimeMs(o);
    if (!Number.isFinite(tMs)) {
      excluded.invalidTime++;
      return;
    }
    const p: Prep = { obs: o, idx, id: String(o.id ?? ''), lat: o.latitude, lon: o.longitude, tMs };
    (o.sensor === 'MODIS' ? modis : viirs).push(p);
  });

  const footprints = new Map<Prep, ReturnType<typeof footprintOf>>();
  for (const m of modis) footprints.set(m, footprintOf(m.obs));
  let modisFootprintFallbacks = 0;
  for (const f of footprints.values()) if (f.fallback) modisFootprintFallbacks++;

  // ---- 2. candidate generation (index = filter, haversine/tangent = decision) ---------------
  let maxHalfDiag = 0;
  for (const f of footprints.values()) maxHalfDiag = Math.max(maxHalfDiag, Math.hypot(f.scanKm, f.trackKm) / 2);
  const index = new GridIndex(viirs, Math.max(1, params.maxDistanceKm, maxHalfDiag));

  const pointCands: Cand[] = [];
  const cellCands: Cand[] = [];
  for (const m of modis) {
    const fp = footprints.get(m)!;
    const halfDiag = (Math.hypot(fp.scanKm, fp.trackKm) / 2) * 1.01;
    const radius = Math.max(params.maxDistanceKm, halfDiag);
    for (const vi of index.query(m.lat, m.lon, radius)) {
      const v = viirs[vi];
      const absDtMs = Math.abs(v.tMs - m.tMs);
      if (absDtMs > windowMs) continue;
      const distKm = haversineDistanceKm(m.lat, m.lon, v.lat, v.lon);
      const cand: Cand = { m, v, distKm, dKey: Math.round(distKm * 1e6), absDtMs };
      if (distKm <= params.maxDistanceKm + EPS_KM) pointCands.push(cand);
      if (insideFootprint(m, v, fp.scanKm, fp.trackKm)) cellCands.push(cand);
    }
  }

  // ---- 3a. point level: greedy one-to-one --------------------------------------------------
  pointCands.sort(cmpCand);
  const usedM = new Set<Prep>();
  const usedV = new Set<Prep>();
  const pairsRaw: Cand[] = [];
  for (const c of pointCands) {
    if (usedM.has(c.m) || usedV.has(c.v)) continue;
    usedM.add(c.m);
    usedV.add(c.v);
    pairsRaw.push(c);
  }
  pairsRaw.sort((a, b) => cmpPrepByTime(a.m, b.m));
  const matched: MatchedPair[] = pairsRaw.map((c) => ({
    modis: c.m.obs,
    viirs: c.v.obs,
    distanceKm: c.distKm,
    timeDiffMinutes: (c.v.tMs - c.m.tMs) / MS_PER_MIN,
  }));
  const pointModisOnly = modis.filter((m) => !usedM.has(m)).sort(cmpPrepByTime).map((p) => p.obs);
  const pointViirsOnly = viirs.filter((v) => !usedV.has(v)).sort(cmpPrepByTime).map((p) => p.obs);

  // ---- 3b. cell level: each VIIRS goes to at most one MODIS footprint ----------------------
  cellCands.sort(cmpCand);
  const cellOfV = new Map<Prep, Prep>();
  const membersOfM = new Map<Prep, Cand[]>();
  for (const c of cellCands) {
    if (cellOfV.has(c.v)) continue;
    cellOfV.set(c.v, c.m);
    const list = membersOfM.get(c.m);
    if (list) list.push(c);
    else membersOfM.set(c.m, [c]);
  }

  const cellModisSorted = [...membersOfM.keys()].sort(cmpPrepByTime);
  const cells: MatchedCell[] = cellModisSorted.map((m) => {
    const fp = footprints.get(m)!;
    const members = membersOfM.get(m)!; // already nearest-first (global sort order)
    const allUsable = members.every((c) => usableFrp(c.v.obs.frp_mw));
    const { gridX, gridY, cellKey } = computeGridCellIndex(m.lat, m.lon, params.gridCellSizeKm);
    return {
      modis: m.obs,
      viirs: members.map((c) => c.v.obs),
      viirsCount: members.length,
      viirsFrpSumMw: allUsable ? members.reduce((s, c) => s + c.v.obs.frp_mw, 0) : null,
      modisFrpMw: usableFrp(m.obs.frp_mw) ? m.obs.frp_mw : null,
      footprintScanKm: fp.scanKm,
      footprintTrackKm: fp.trackKm,
      footprintKm2: fp.scanKm * fp.trackKm,
      footprintFallback: fp.fallback,
      gridCell: { gridX, gridY, cellKey },
    };
  });
  const cellModisOnly = modis.filter((m) => !membersOfM.has(m)).sort(cmpPrepByTime).map((p) => p.obs);
  const cellViirsOnly = viirs.filter((v) => !cellOfV.has(v)).sort(cmpPrepByTime).map((p) => p.obs);

  // ---- 4. statistics -----------------------------------------------------------------------
  const pointSamples: { modis: number; viirs: number }[] = [];
  let pointFrpExcluded = 0;
  for (const p of matched) {
    if (usableFrp(p.modis.frp_mw) && usableFrp(p.viirs.frp_mw)) {
      pointSamples.push({ modis: p.modis.frp_mw, viirs: p.viirs.frp_mw });
    } else pointFrpExcluded++;
  }
  const cellSamples: { modis: number; viirs: number }[] = [];
  let cellFrpExcluded = 0;
  for (const c of cells) {
    if (c.modisFrpMw !== null && c.viirsFrpSumMw !== null) {
      cellSamples.push({ modis: c.modisFrpMw, viirs: c.viirsFrpSumMw });
    } else cellFrpExcluded++;
  }

  const pointFrp = computeFrpAgreement(pointSamples, pointFrpExcluded, 'FRP (MW) of the single matched VIIRS pixel');
  const cellFrp = computeFrpAgreement(
    cellSamples,
    cellFrpExcluded,
    'sum of VIIRS FRP (MW) over VIIRS detections inside the MODIS footprint (VIIRS only, never added to MODIS)'
  );

  const viirsInCells = cells.reduce((s, c) => s + c.viirsCount, 0);
  const detectionRatio = {
    overall: ratioOf(
      viirs.length,
      modis.length,
      'all valid VIIRS detections / all valid MODIS detections supplied; depends on spatial/temporal coverage of each input'
    ),
    coDetected: ratioOf(
      viirsInCells,
      cells.length,
      'VIIRS detections inside MODIS footprints that contain at least one VIIRS detection / number of those MODIS footprints'
    ),
  };

  const viirsSatellitesPresent = [...new Set(viirs.map((p) => p.obs.satellite))].sort();
  const modisSatellitesPresent = [...new Set(modis.map((p) => p.obs.satellite))].sort();

  // ---- 5. documentation strings ------------------------------------------------------------
  const limitations = buildLimitations({
    params,
    viirsSatellitesPresent,
    modisFootprintFallbacks,
    modisCount: modis.length,
    pointFrp,
    cellFrp,
    excluded,
  });
  const method =
    `Point level: one-to-one greedy pairing of detection centres within ${params.maxDistanceKm} km ` +
    `(haversine) and +-${params.maxTimeDiffMinutes} min, ordered by distance, then |dt|, then id. ` +
    `Cell level: each VIIRS detection assigned to at most one MODIS footprint (scan x track rectangle centred on ` +
    `the MODIS point, nominal 1 km if scan/track missing) within the same time window, nearest first. ` +
    `Candidates found via the equal-area grid (spatial.ts); MODIS and VIIRS are never summed together.`;

  const uncertainty =
    `EXPLORATORY. ${method} ` +
    `Sample sizes: ${modis.length} MODIS, ${viirs.length} VIIRS valid detections; ${matched.length} point pairs; ` +
    `${cells.length} co-detected MODIS cells; FRP n=${pointFrp.n} (point), n=${cellFrp.n} (cell). ` +
    `Limitations: ${limitations.join(' ')}`;

  return {
    label: 'EXPLORATORY',
    method,
    params,
    counts: {
      modisInput: modis.length,
      viirsInput: viirs.length,
      excluded,
      viirsSatellitesPresent,
      modisSatellitesPresent,
      modisFootprintFallbacks,
    },
    point: { matched, viirsOnly: pointViirsOnly, modisOnly: pointModisOnly, frpAgreement: pointFrp },
    cell: { cells, viirsOnly: cellViirsOnly, modisOnly: cellModisOnly, frpAgreement: cellFrp },
    detectionRatio,
    limitations,
    uncertainty,
  };
}

function buildLimitations(ctx: {
  params: ResolvedMatchingOptions;
  viirsSatellitesPresent: string[];
  modisFootprintFallbacks: number;
  modisCount: number;
  pointFrp: FrpAgreement;
  cellFrp: FrpAgreement;
  excluded: { invalidCoordinates: number; invalidTime: number; unknownSensor: number; filteredBySatellite: number };
}): string[] {
  const out: string[] = [
    'Matching is by detection location and time only; agreement between sensors is not ground truth and nothing here is a prediction.',
    '"MODIS-only" / "VIIRS-only" mean no counterpart was found, not that the other sensor saw no fire: no overpass-swath, cloud or scan-angle coverage data are used, so absence may simply mean no observation.',
    `Time window +-${ctx.params.maxTimeDiffMinutes} min is inclusive; differing Terra/Aqua vs VIIRS overpass times and the fire diurnal cycle mean a wider window raises the risk of pairing different burning states.`,
    'The MODIS footprint is approximated as an axis-aligned rectangle (scan east-west, track north-south) centred on the reported point; true pixel orientation, bow-tie overlap and sub-pixel position are unknown. VIIRS membership is decided by pixel centre only.',
    'Greedy one-to-one point pairing depends on the ordering rule (distance, |dt|, id) and is not a globally optimal assignment. Point-level FRP compares a 375 m pixel with a ~1 km (or larger) pixel; cell-level FRP compares MODIS FRP with the VIIRS FRP sum inside that footprint.',
    'FRP statistics use co-detected cases only (both sensors above their detection thresholds), which biases agreement; ordinary least squares ignores error in the MODIS values (attenuates slope); FRP is retrieved differently per product, so agreement does not show which sensor is correct. FRP <= 0 or missing is excluded because the FIRMS parser stores missing FRP as 0.',
    'Detection ratios depend on pixel size, detection thresholds and coverage; the co-detected ratio is conditional on at least one VIIRS detection and is not a calibration factor.',
  ];
  if (ctx.viirsSatellitesPresent.length > 1) {
    out.push(
      `VIIRS input contains several satellites (${ctx.viirsSatellitesPresent.join(', ')}); one fire seen by more than one satellite is counted once per satellite, which inflates VIIRS counts and FRP sums. Use viirsSatellites to compare one satellite at a time.`
    );
  }
  if (ctx.modisFootprintFallbacks > 0) {
    out.push(
      `${ctx.modisFootprintFallbacks} of ${ctx.modisCount} MODIS detections had missing or implausible scan/track and used a nominal 1 km pixel.`
    );
  }
  const dropped =
    ctx.excluded.invalidCoordinates + ctx.excluded.invalidTime + ctx.excluded.unknownSensor;
  if (dropped > 0) {
    out.push(
      `${dropped} input record(s) were ignored (invalid coordinates: ${ctx.excluded.invalidCoordinates}, invalid time: ${ctx.excluded.invalidTime}, unknown sensor: ${ctx.excluded.unknownSensor}).`
    );
  }
  if (ctx.pointFrp.n < LOW_SAMPLE_N || ctx.cellFrp.n < LOW_SAMPLE_N) {
    out.push(
      `Small FRP sample (point n=${ctx.pointFrp.n}, cell n=${ctx.cellFrp.n}; flag below ${LOW_SAMPLE_N} is a rule of thumb): statistics are indicative only.`
    );
  }
  return out;
}

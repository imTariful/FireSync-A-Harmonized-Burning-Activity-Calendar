/**
 * Harmonization panel view-model (EXPLORATORY).
 *
 * Pure module: no UI, no network, no randomness, no mutation of inputs. It only reshapes the output of
 * matching.ts (matchModisViirs) for display, and re-runs that same function for the sensitivity check.
 *
 * Science rules honoured here:
 *  - MODIS and VIIRS stay separate everywhere. No field in this module is a MODIS+VIIRS sum. The only
 *    sum that exists is matching.ts's "VIIRS FRP inside one MODIS footprint" (VIIRS only), which is
 *    compared against, never added to, the MODIS value.
 *  - Every combined/comparative number carries the EXPLORATORY label, the method and the limitations.
 *  - "X-only" means "no counterpart found by this method", never "the other sensor saw nothing".
 *  - No prediction and no ground-truth claim.
 */

import type { CanonicalObservation, SatelliteType } from '../types/fire';
import { computeGridCellIndex } from './spatial';
import {
  MATCHING_DEFAULTS,
  matchModisViirs,
  type FrpAgreement,
  type MatchedCell,
  type MatchedPair,
  type MatchingOptions,
  type MatchingResult,
} from './matching';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const EXPLORATORY_LABEL = 'EXPLORATORY' as const;

/** Must stay exactly as written (product requirement). */
export const LEGEND_SENTENCE = 'Satellite thermal anomalies, not confirmed wildfires or burned area.';

/** Mirrors matching.ts (LOW_SAMPLE_N is private there). A rule-of-thumb flag, not a validated threshold. */
export const LOW_SAMPLE_N = 30;

/** Slider bounds used by the panel; exported so tests and the panel agree. */
export const CONTROL_LIMITS = Object.freeze({
  distanceKm: { min: 0.25, max: 5, step: 0.25 },
  timeMinutes: { min: 15, max: 360, step: 15 },
});

/**
 * Up to this many valid detections the sensitivity grid (9 matching runs) runs on ALL of them. Measured cost
 * (synthetic, single thread, one run): ~60 ms at 11 000 detections spread over a region, ~150 ms in a very dense
 * 0.2 deg x 0.2 deg cluster, ~330 ms at 20 000 dense. So 9 runs at the cap take roughly 0.5-2.5 s.
 * Raised from 6000 because typical views hold ~11 000 detections.
 */
export const SENSITIVITY_MAX_INPUT = 15000;

/** Above SENSITIVITY_MAX_INPUT the grid runs on a deterministic spatial-block sample of about this many detections. */
export const SENSITIVITY_SAMPLE_TARGET = 12000;

/** Side of a sampling block in degrees (~28 km). Much larger than the 0.5-2 km matching radii of the grid. */
export const SENSITIVITY_BLOCK_DEG = 0.25;

/**
 * If the kept blocks still hold more than SENSITIVITY_SAMPLE_TARGET x this (one block is too dense), the block side
 * is halved, down to SENSITIVITY_MIN_BLOCK_DEG (~5.5 km, still above the 2 km largest grid radius).
 */
export const SENSITIVITY_OVERSHOOT = 1.5;
export const SENSITIVITY_MIN_BLOCK_DEG = 0.05;

/** Outer share of the time window used by the time-offset summary (|offset| >= 80% of the window). */
export const TIME_EDGE_FRACTION = 0.8;

/** Flag "pairs sit at the window edge" when at least this share of pairs is in the outer 20%. Rule of thumb: an even spread across the window would put about 20% there. */
export const TIME_EDGE_FLAG_SHARE = 0.4;

/** Robust FRP note: the top share of pairs (by squared FRP difference) checked for dominance. */
export const FRP_DOMINANCE_TOP_FRACTION = 0.05;
/** ...and the share of the total squared error they must carry for r2/RMSE to be called "driven by a few". Rule of thumb. */
export const FRP_DOMINANCE_MIN_SHARE = 0.5;
/** Dominance is only judged from this many pairs upward. */
export const FRP_DOMINANCE_MIN_N = 10;

/** Above this many points the scatter draws an evenly spaced subset (statistics still use all points). */
export const SCATTER_MAX_POINTS = 1500;

const NOMINAL_PIXEL_KM = 1;
const NOMINAL_VIIRS_PIXEL_KM = 0.375;
const MAX_PLAUSIBLE_PIXEL_KM = 10;
/** Great-circle km per degree (same sphere as spatial.ts to within display needs; used only to size polygons). */
const KM_PER_DEG = 111.195;

export type ComparisonLevel = 'point' | 'cell';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function usable(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function mean(values: readonly number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

/** Number formatting for prose; never prints NaN/undefined. */
export function fmt(v: number | null | undefined, digits = 1): string {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : '–';
}

export function fmtSigned(v: number | null | undefined, digits = 1): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '–';
  return `${v > 0 ? '+' : ''}${v.toFixed(digits)}`;
}

export function fmtPct(v: number | null | undefined, digits = 0): string {
  return typeof v === 'number' && Number.isFinite(v) ? `${(v * 100).toFixed(digits)}%` : '–';
}

// ---------------------------------------------------------------------------
// Input: keep sensors separate
// ---------------------------------------------------------------------------

export interface SeparatedInput {
  modis: CanonicalObservation[];
  viirs: CanonicalObservation[];
  /** Records passed in the wrong list (e.g. a VIIRS record in `modis`); they are dropped, not guessed. */
  mismatched: number;
}

/** Split a mixed list (e.g. useViewportFires().observations) by sensor, for wiring convenience. */
export function splitBySensor(observations: readonly CanonicalObservation[]): SeparatedInput {
  const modis: CanonicalObservation[] = [];
  const viirs: CanonicalObservation[] = [];
  for (const o of observations) {
    if (o?.sensor === 'MODIS') modis.push(o);
    else if (o?.sensor === 'VIIRS') viirs.push(o);
  }
  return { modis, viirs, mismatched: 0 };
}

/** Accept MODIS and VIIRS as two separate lists; anything with the wrong sensor tag is dropped and counted. */
export function separateInputs(
  modis: readonly CanonicalObservation[],
  viirs: readonly CanonicalObservation[]
): SeparatedInput {
  const m = modis.filter((o) => o?.sensor === 'MODIS');
  const v = viirs.filter((o) => o?.sensor === 'VIIRS');
  return { modis: m, viirs: v, mismatched: modis.length - m.length + (viirs.length - v.length) };
}

// ---------------------------------------------------------------------------
// View model
// ---------------------------------------------------------------------------

export interface ScatterPoint {
  modisFrpMw: number;
  /** VIIRS side only: a single VIIRS pixel (point level) or the VIIRS-only sum inside one MODIS footprint (cell level). */
  viirsFrpMw: number;
}

export interface FrpView {
  level: ComparisonLevel;
  n: number;
  excluded: number;
  /** Plain-language meaning of the y axis, from matching.ts. */
  yQuantity: string;
  bias: number | null;
  mae: number | null;
  rmse: number | null;
  regression: { slope: number; intercept: number; r: number | null; r2: number | null } | null;
  points: ScatterPoint[];
  lowSample: boolean;
  note: string;
  /** Outlier-resistant companions to r2/RMSE (EXPLORATORY). */
  robust: RobustFrp;
}

export interface RobustFrp {
  /** Pairs with FRP > 0 on both sides (the same pairs as the scatter). */
  n: number;
  /** Spearman rank correlation (Pearson r of average ranks); null when n < 3 or one side has no rank variation. */
  spearman: number | null;
  /** exp(median(ln(VIIRS / MODIS))) over the pairs; > 1 means the VIIRS side is higher. null when n = 0. */
  medianRatio: number | null;
  /** Largest MODIS FRP among these pairs, MW. */
  maxModisFrpMw: number | null;
  /** The k pairs with the largest squared FRP difference carry `share` of the total squared difference. null when n is too small to judge. */
  dominance: { k: number; n: number; share: number; intense: boolean } | null;
  /** True when r2 and RMSE are driven by a few pairs (share >= FRP_DOMINANCE_MIN_SHARE). */
  drivenByFew: boolean;
  /** Plain-language note; null when nothing needs saying. */
  note: string | null;
}

export interface DayNightCounts {
  day: number;
  night: number;
}

export interface HarmonizeDiagnostics {
  /** t_viirs - t_modis over matched point pairs, minutes. */
  timeDiff: { n: number; medianMin: number | null; medianAbsMin: number | null; maxAbsMin: number | null };
  modisSatellites: string[];
  viirsSatellites: string[];
  footprint: {
    cells: number;
    meanModisKm2: number | null;
    meanViirsPerCell: number | null;
    fallbacks: number;
  };
  maxFrpMw: { modis: number | null; viirs: number | null };
  maxBrightnessK: { modisBrightness: number | null; viirsI4: number | null };
  /** By each record's own day/night flag. */
  matchedByDayNight: DayNightCounts;
  modisByDayNight: DayNightCounts;
  viirsByDayNight: DayNightCounts;
}

export interface TimeOffsetSummary {
  /** Matched point pairs. */
  n: number;
  /** The matching window (+-), minutes. */
  windowMin: number;
  medianAbsMin: number | null;
  maxAbsMin: number | null;
  /** Pairs with |offset| >= TIME_EDGE_FRACTION x window (the outer 20%). */
  outerCount: number;
  outerShare: number | null;
  /** True when outerShare >= TIME_EDGE_FLAG_SHARE. */
  atEdge: boolean;
  /** Pairs and median |offset| per (MODIS satellite, VIIRS satellite) combination actually matched. */
  bySatellitePair: { modis: string; viirs: string; n: number; medianAbsMin: number }[];
  /** Plain-language note, or null when the offsets are not concentrated at the edge. */
  note: string | null;
}

export interface HarmonizeView {
  label: typeof EXPLORATORY_LABEL;
  /** Time-offset summary of the matched pairs (EXPLORATORY). */
  timeOffset: TimeOffsetSummary;
  params: { maxDistanceKm: number; maxTimeDiffMinutes: number };
  /** Valid detections per sensor, kept separate. */
  inputs: { modis: number; viirs: number };
  /** One-to-one point pairing. matched + viirsOnly = viirs input; matched + modisOnly = modis input. */
  point: { matched: number; viirsOnly: number; modisOnly: number; matchedShareOfModis: number | null; matchedShareOfViirs: number | null };
  /** Footprint-level view: VIIRS detections assigned to at most one MODIS footprint. */
  cell: { coDetectedCells: number; viirsInCells: number; viirsOnly: number; modisOnly: number };
  /** VIIRS count / MODIS count (a ratio of two separate counts, not a sum). Coverage dependent. */
  detectionRatio: {
    overall: number | null;
    overallBasis: string;
    coDetected: number | null;
    coDetectedBasis: string;
  };
  frp: Record<ComparisonLevel, FrpView>;
  diagnostics: HarmonizeDiagnostics;
  /** Human-readable caution lines with live numbers; empty when nothing needs flagging. */
  warnings: string[];
  method: string;
  limitations: string[];
  uncertainty: string;
}

/** Average ranks (ties share the mean rank), 1-based. */
function averageRanks(values: readonly number[]): number[] {
  const idx = values.map((_, i) => i).sort((a, b) => values[a] - values[b] || a - b);
  const ranks = new Array<number>(values.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && values[idx[j + 1]] === values[idx[i]]) j++;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[idx[k]] = r;
    i = j + 1;
  }
  return ranks;
}

function pearson(x: readonly number[], y: readonly number[]): number | null {
  const n = x.length;
  if (n < 3) return null;
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
    syy += (y[i] - my) ** 2;
  }
  if (sxx <= 0 || syy <= 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

/** Spearman rank correlation of x and y (null when undefined). Exported for tests. */
export function spearmanRho(x: readonly number[], y: readonly number[]): number | null {
  if (x.length !== y.length) return null;
  return pearson(averageRanks(x), averageRanks(y));
}

/** Robust FRP statistics for one comparison level, from the same pairs the scatter shows. */
export function computeRobustFrp(points: readonly ScatterPoint[], level: ComparisonLevel = 'point'): RobustFrp {
  const n = points.length;
  const xs = points.map((p) => p.modisFrpMw);
  const ys = points.map((p) => p.viirsFrpMw);
  const logRatios = points.map((p) => Math.log(p.viirsFrpMw / p.modisFrpMw));
  const medLog = median(logRatios);
  const maxModis = n ? Math.max(...xs) : null;

  let dominance: RobustFrp['dominance'] = null;
  if (n >= FRP_DOMINANCE_MIN_N) {
    const sq = points.map((p, i) => ({ e: (p.viirsFrpMw - p.modisFrpMw) ** 2, size: Math.max(xs[i], ys[i]) }));
    const total = sq.reduce((a, b) => a + b.e, 0);
    if (total > 0) {
      const k = Math.max(1, Math.ceil(FRP_DOMINANCE_TOP_FRACTION * n));
      const top = [...sq].sort((a, b) => b.e - a.e).slice(0, k);
      const share = top.reduce((a, b) => a + b.e, 0) / total;
      const medSize = median(sq.map((q) => q.size)) ?? 0;
      const meanTopSize = top.reduce((a, b) => a + b.size, 0) / k;
      dominance = { k, n, share, intense: medSize > 0 && meanTopSize >= 3 * medSize };
    }
  }
  const drivenByFew = dominance !== null && dominance.share >= FRP_DOMINANCE_MIN_SHARE;
  const what = level === 'cell' ? 'footprints' : 'pairs';
  const note =
    drivenByFew && dominance
      ? `r² and RMSE are driven by a few ${dominance.intense ? 'very intense fires' : `${what} with large FRP differences`}: the ${dominance.k} of ${dominance.n} ${what} ` +
        `(${fmtPct(FRP_DOMINANCE_TOP_FRACTION)}) with the largest differences carry ${fmtPct(dominance.share)} of the total squared difference` +
        `${maxModis !== null ? ` (largest MODIS FRP here ${fmt(maxModis)} MW)` : ''}. Spearman ρ and the median ratio are far less sensitive to such cases.`
      : null;

  return {
    n,
    spearman: spearmanRho(xs, ys),
    medianRatio: medLog === null ? null : Math.exp(medLog),
    maxModisFrpMw: maxModis,
    dominance,
    drivenByFew,
    note,
  };
}

function frpView(level: ComparisonLevel, a: FrpAgreement, points: ScatterPoint[]): FrpView {
  return {
    robust: computeRobustFrp(points, level),
    level,
    n: a.n,
    excluded: a.excluded,
    yQuantity: a.viirsQuantity,
    bias: a.bias,
    mae: a.mae,
    rmse: a.rmse,
    regression: a.regression,
    points,
    lowSample: a.n < LOW_SAMPLE_N,
    note: a.note,
  };
}

function dayNight(list: readonly CanonicalObservation[]): DayNightCounts {
  let day = 0;
  let night = 0;
  for (const o of list) {
    if (o.daynight === 'D') day++;
    else if (o.daynight === 'N') night++;
  }
  return { day, night };
}

function maxOf(values: readonly (number | undefined)[]): number | null {
  let best: number | null = null;
  for (const v of values) if (typeof v === 'number' && Number.isFinite(v) && v > 0 && (best === null || v > best)) best = v;
  return best;
}

export function summarizeTimeOffsets(matched: readonly MatchedPair[], windowMin: number): TimeOffsetSummary {
  const abs = matched.map((p) => Math.abs(p.timeDiffMinutes));
  const n = abs.length;
  const threshold = TIME_EDGE_FRACTION * windowMin - 1e-9;
  const outerCount = abs.filter((a) => a >= threshold).length;
  const outerShare = n > 0 ? outerCount / n : null;
  const atEdge = outerShare !== null && outerShare >= TIME_EDGE_FLAG_SHARE;

  const groups = new Map<string, { modis: string; viirs: string; abs: number[] }>();
  for (const p of matched) {
    const key = `${p.modis.satellite}|${p.viirs.satellite}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { modis: p.modis.satellite, viirs: p.viirs.satellite, abs: [] }));
    g.abs.push(Math.abs(p.timeDiffMinutes));
  }
  const bySatellitePair = [...groups.values()]
    .map((g) => ({ modis: g.modis, viirs: g.viirs, n: g.abs.length, medianAbsMin: median(g.abs) as number }))
    .sort((a, b) => b.n - a.n || (a.modis + a.viirs < b.modis + b.viirs ? -1 : 1));

  let note: string | null = null;
  if (atEdge && outerShare !== null) {
    note =
      `${outerCount} of ${n} pairs (${fmtPct(outerShare)}) lie in the outer 20% of the ±${windowMin} min window (an even spread would put about 20% there). ` +
      `The window, not the fire, may be deciding which detections pair up; treat the match count as window-dependent. A narrower window or one satellite per sensor can be tried.`;
    if (bySatellitePair.length > 1) {
      note += ` These pairs mix ${bySatellitePair.length} satellite combinations whose overpass times differ (see the per-combination medians); a cause has not been verified for this view.`;
    }
  }

  return {
    n,
    windowMin,
    medianAbsMin: median(abs),
    maxAbsMin: n ? Math.max(...abs) : null,
    outerCount,
    outerShare,
    atEdge,
    bySatellitePair,
    note,
  };
}

/** Build the display model from one matching result. */
export function buildHarmonizeView(result: MatchingResult, extra: { mismatched?: number } = {}): HarmonizeView {
  const { point, cell, counts } = result;

  const pointPoints: ScatterPoint[] = [];
  for (const p of point.matched) {
    if (usable(p.modis.frp_mw) && usable(p.viirs.frp_mw)) {
      pointPoints.push({ modisFrpMw: p.modis.frp_mw, viirsFrpMw: p.viirs.frp_mw });
    }
  }
  const cellPoints: ScatterPoint[] = [];
  for (const c of cell.cells) {
    if (c.modisFrpMw !== null && c.viirsFrpSumMw !== null) {
      cellPoints.push({ modisFrpMw: c.modisFrpMw, viirsFrpMw: c.viirsFrpSumMw });
    }
  }

  const matched = point.matched.length;
  const modisAll = [...point.matched.map((p) => p.modis), ...point.modisOnly];
  const viirsAll = [...point.matched.map((p) => p.viirs), ...point.viirsOnly];

  const absDt = point.matched.map((p) => Math.abs(p.timeDiffMinutes));
  const diagnostics: HarmonizeDiagnostics = {
    timeDiff: {
      n: matched,
      medianMin: median(point.matched.map((p) => p.timeDiffMinutes)),
      medianAbsMin: median(absDt),
      maxAbsMin: absDt.length ? Math.max(...absDt) : null,
    },
    modisSatellites: counts.modisSatellitesPresent,
    viirsSatellites: counts.viirsSatellitesPresent,
    footprint: {
      cells: cell.cells.length,
      meanModisKm2: mean(cell.cells.map((c) => c.footprintKm2)),
      meanViirsPerCell: result.detectionRatio.coDetected.ratio,
      fallbacks: counts.modisFootprintFallbacks,
    },
    maxFrpMw: {
      modis: maxOf(modisAll.map((o) => o.frp_mw)),
      viirs: maxOf(viirsAll.map((o) => o.frp_mw)),
    },
    maxBrightnessK: {
      modisBrightness: maxOf(modisAll.map((o) => o.brightness)),
      viirsI4: maxOf(viirsAll.map((o) => o.bright_ti4)),
    },
    matchedByDayNight: dayNight(point.matched.map((p) => p.modis)),
    modisByDayNight: dayNight(modisAll),
    viirsByDayNight: dayNight(viirsAll),
  };

  const warnings: string[] = [];
  const mismatched = extra.mismatched ?? 0;
  if (mismatched > 0) {
    warnings.push(`${mismatched} record(s) were tagged with the other sensor and were ignored.`);
  }
  if (counts.modisInput === 0 || counts.viirsInput === 0) {
    warnings.push(
      `Both sensors are needed for a comparison; this view has ${counts.modisInput} MODIS and ${counts.viirsInput} VIIRS detection(s).`
    );
  } else if (matched === 0) {
    warnings.push(
      `No point pairs found at ${result.params.maxDistanceKm} km / ±${result.params.maxTimeDiffMinutes} min. Agreement statistics are undefined.`
    );
  } else if (point.frpAgreement.n < LOW_SAMPLE_N) {
    warnings.push(
      `Small sample: only n=${point.frpAgreement.n} matched pair(s) with usable FRP (flag below ${LOW_SAMPLE_N} is a rule of thumb). Treat every statistic here as indicative only.`
    );
  }
  if (counts.viirsSatellitesPresent.length > 1) {
    warnings.push(
      `VIIRS data from ${counts.viirsSatellitesPresent.length} satellites (${counts.viirsSatellitesPresent.join(', ')}) are mixed: one fire seen by more than one satellite is counted once per satellite.`
    );
  }
  if (counts.modisFootprintFallbacks > 0) {
    warnings.push(
      `${counts.modisFootprintFallbacks} of ${counts.modisInput} MODIS detections had no usable pixel size; a nominal 1 km pixel was assumed.`
    );
  }

  return {
    label: EXPLORATORY_LABEL,
    timeOffset: summarizeTimeOffsets(point.matched, result.params.maxTimeDiffMinutes),
    params: { maxDistanceKm: result.params.maxDistanceKm, maxTimeDiffMinutes: result.params.maxTimeDiffMinutes },
    inputs: { modis: counts.modisInput, viirs: counts.viirsInput },
    point: {
      matched,
      viirsOnly: point.viirsOnly.length,
      modisOnly: point.modisOnly.length,
      matchedShareOfModis: counts.modisInput > 0 ? matched / counts.modisInput : null,
      matchedShareOfViirs: counts.viirsInput > 0 ? matched / counts.viirsInput : null,
    },
    cell: {
      coDetectedCells: cell.cells.length,
      viirsInCells: result.detectionRatio.coDetected.viirs,
      viirsOnly: cell.viirsOnly.length,
      modisOnly: cell.modisOnly.length,
    },
    detectionRatio: {
      overall: result.detectionRatio.overall.ratio,
      overallBasis: result.detectionRatio.overall.basis,
      coDetected: result.detectionRatio.coDetected.ratio,
      coDetectedBasis: result.detectionRatio.coDetected.basis,
    },
    frp: {
      point: frpView('point', point.frpAgreement, pointPoints),
      cell: frpView('cell', cell.frpAgreement, cellPoints),
    },
    diagnostics,
    warnings,
    method: result.method,
    limitations: result.limitations,
    uncertainty: result.uncertainty,
  };
}

/** Convenience: separate inputs -> match -> view. Throws RangeError only for invalid options (see matching.ts). */
export function computeHarmonizeView(
  modis: readonly CanonicalObservation[],
  viirs: readonly CanonicalObservation[],
  options: MatchingOptions = {}
): { view: HarmonizeView; result: MatchingResult } {
  const sep = separateInputs(modis, viirs);
  const result = matchModisViirs([...sep.modis, ...sep.viirs], options);
  return { view: buildHarmonizeView(result, { mismatched: sep.mismatched }), result };
}

// ---------------------------------------------------------------------------
// Satellite selection and presets
// ---------------------------------------------------------------------------
//
// Uses matching.ts's existing modisSatellites / viirsSatellites filters. 'all' means "no filter" (every satellite
// of that sensor that is loaded), which is the current default behaviour. Counts stay per sensor.

export type ModisSelection = 'all' | 'Terra' | 'Aqua';
export type ViirsSelection = 'all' | 'NOAA-20' | 'NOAA-21' | 'NOAA-20+NOAA-21';

export interface SatelliteSelection {
  modis: ModisSelection;
  viirs: ViirsSelection;
}

export const DEFAULT_SATELLITE_SELECTION: SatelliteSelection = Object.freeze({ modis: 'all', viirs: 'all' });

export const MODIS_SELECTION_OPTIONS: readonly { value: ModisSelection; label: string }[] = Object.freeze([
  { value: 'all', label: 'Terra + Aqua (default)' },
  { value: 'Terra', label: 'Terra' },
  { value: 'Aqua', label: 'Aqua' },
]);

export const VIIRS_SELECTION_OPTIONS: readonly { value: ViirsSelection; label: string }[] = Object.freeze([
  { value: 'all', label: 'All loaded (default)' },
  { value: 'NOAA-20', label: 'NOAA-20' },
  { value: 'NOAA-21', label: 'NOAA-21' },
  { value: 'NOAA-20+NOAA-21', label: 'NOAA-20 + NOAA-21' },
]);

const VIIRS_SELECTION_SATELLITES: Record<Exclude<ViirsSelection, 'all'>, readonly SatelliteType[]> = {
  'NOAA-20': ['NOAA-20'],
  'NOAA-21': ['NOAA-21'],
  'NOAA-20+NOAA-21': ['NOAA-20', 'NOAA-21'],
};

/** Matching options for a selection. 'all' leaves the key out entirely (= matching.ts default, no filter). */
export function satelliteSelectionToOptions(sel: SatelliteSelection): Pick<MatchingOptions, 'modisSatellites' | 'viirsSatellites'> {
  const out: Pick<MatchingOptions, 'modisSatellites' | 'viirsSatellites'> = {};
  if (sel.modis !== 'all') out.modisSatellites = [sel.modis];
  if (sel.viirs !== 'all') out.viirsSatellites = VIIRS_SELECTION_SATELLITES[sel.viirs];
  return out;
}

export function isDefaultSatelliteSelection(sel: SatelliteSelection): boolean {
  return sel.modis === 'all' && sel.viirs === 'all';
}

// ---------------------------------------------------------------------------
// Observed overpass times (approximate local solar time)
// ---------------------------------------------------------------------------
//
// Nominal equator-crossing times are design values and drift (NASA reports Aqua drifting later and Terra earlier).
// Instead of hard-coding them, derive the times actually present in the loaded detections.
// Approximation: local solar time = UTC time of day + longitude / 15 h (mean solar time; no equation of time,
// no terrain/swath correction). Detections of one satellite span many longitudes, so this is a median of
// per-detection values, not an equator-crossing time.

/** Below this many detections a (satellite, day/night) median is flagged as low-n. */
export const OVERPASS_MIN_N = 20;

export const OVERPASS_APPROX_NOTE =
  'Approximate: local solar time = UTC time of day + longitude / 15 h, taken per detection and summarised by the circular median (midnight-safe). ' +
  'It ignores the equation of time and the swath geometry, so treat it as a rough guide, not an equator-crossing time.';

export interface OverpassRow {
  sensor: 'MODIS' | 'VIIRS';
  satellite: SatelliteType;
  daynight: 'D' | 'N';
  n: number;
  /** Circular median local solar time in hours, [0, 24). */
  medianLocalHours: number;
  /** HH:MM form of medianLocalHours. */
  label: string;
  /** n < OVERPASS_MIN_N. */
  lowN: boolean;
}

export interface OverpassObserved {
  rows: OverpassRow[];
  /** Records without a usable time, longitude or day/night flag (not used). */
  skipped: number;
}

/** UTC time of day in hours from datetime_utc, else acq_time (HHMM); null when neither is usable. */
export function utcHoursOfDay(o: Pick<CanonicalObservation, 'datetime_utc' | 'acq_time'>): number | null {
  const t = typeof o?.datetime_utc === 'string' ? Date.parse(o.datetime_utc) : NaN;
  if (Number.isFinite(t)) {
    const ms = ((t % 86_400_000) + 86_400_000) % 86_400_000;
    return ms / 3_600_000;
  }
  const a = typeof o?.acq_time === 'string' ? o.acq_time.trim() : '';
  if (/^\d{1,4}$/.test(a)) {
    const p = a.padStart(4, '0');
    const hh = Number(p.slice(0, 2));
    const mm = Number(p.slice(2));
    if (hh < 24 && mm < 60) return hh + mm / 60;
  }
  return null;
}

/** Wrap hours to [0, 24). */
export function wrapHours(h: number): number {
  const w = ((h % 24) + 24) % 24;
  return w >= 24 ? 0 : w;
}

/** Signed circular difference a - b in hours, in [-12, 12). */
function circDiffHours(a: number, b: number): number {
  return wrapHours(a - b + 12) - 12;
}

/**
 * Circular median of times of day (hours, any real numbers; wrapped to 24 h). Midnight-safe: 23.5 and 0.5 give 0.
 * Method: pick the sample with the smallest total circular distance (ties: the earliest) as an anchor, express every
 * value as a signed offset from it in [-12, 12), take the ordinary median of the offsets, add it back to the anchor.
 * Returns null for an empty input. Meaningful for unimodal data (one overpass per day/night class).
 */
export function circularMedianHours(values: readonly number[]): number | null {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x)).map(wrapHours);
  if (v.length === 0) return null;
  let anchor = v[0];
  let best = Infinity;
  for (const c of [...v].sort((a, b) => a - b)) {
    let sum = 0;
    for (const x of v) sum += Math.abs(circDiffHours(x, c));
    if (sum < best - 1e-12) {
      best = sum;
      anchor = c;
    }
  }
  const off = median(v.map((x) => circDiffHours(x, anchor)));
  return off === null ? null : wrapHours(anchor + off);
}

/** Circular distance in minutes between two times of day (hours), in [0, 720]. */
export function circularGapMinutes(aHours: number, bHours: number): number {
  return Math.abs(circDiffHours(aHours, bHours)) * 60;
}

export function formatClock(hours: number): string {
  const total = Math.round(wrapHours(hours) * 60) % 1440;
  const hh = Math.floor(total / 60);
  const mm = total % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/**
 * Observed approximate local solar time per (sensor, satellite, day/night). Pure; MODIS and VIIRS rows stay separate.
 * Input is one mixed list or the two sensor lists concatenated; the record's own `sensor` tag decides.
 */
export function observedOverpassTimes(observations: readonly CanonicalObservation[]): OverpassObserved {
  const groups = new Map<string, { sensor: 'MODIS' | 'VIIRS'; satellite: SatelliteType; daynight: 'D' | 'N'; hours: number[] }>();
  let skipped = 0;
  for (const o of observations) {
    const sensor = o?.sensor;
    const dn = o?.daynight;
    const h = o ? utcHoursOfDay(o) : null;
    const lon = o?.longitude;
    if ((sensor !== 'MODIS' && sensor !== 'VIIRS') || (dn !== 'D' && dn !== 'N') || h === null || typeof lon !== 'number' || !Number.isFinite(lon) || Math.abs(lon) > 180 || !o.satellite) {
      skipped++;
      continue;
    }
    const key = `${sensor}|${o.satellite}|${dn}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { sensor, satellite: o.satellite, daynight: dn, hours: [] }));
    g.hours.push(wrapHours(h + lon / 15));
  }
  const rows: OverpassRow[] = [];
  for (const g of groups.values()) {
    const m = circularMedianHours(g.hours);
    if (m === null) continue;
    rows.push({ sensor: g.sensor, satellite: g.satellite, daynight: g.daynight, n: g.hours.length, medianLocalHours: m, label: formatClock(m), lowN: g.hours.length < OVERPASS_MIN_N });
  }
  const sensorRank = { MODIS: 0, VIIRS: 1 } as const;
  rows.sort((a, b) => sensorRank[a.sensor] - sensorRank[b.sensor] || (a.satellite < b.satellite ? -1 : a.satellite > b.satellite ? 1 : 0) || (a.daynight === b.daynight ? 0 : a.daynight === 'D' ? -1 : 1));
  return { rows, skipped };
}

/** One-line text for a row, e.g. "Aqua day 15:48 (n=412)" or "NOAA-21 night 01:32 (n=7, low n)". */
export function overpassRowText(r: OverpassRow): string {
  return `${r.satellite} ${r.daynight === 'D' ? 'day' : 'night'} ${r.label} (n=${r.n}${r.lowN ? `, low n < ${OVERPASS_MIN_N}` : ''})`;
}

// ---------------------------------------------------------------------------
// Window feasibility (observed local-time gap vs the chosen matching window)
// ---------------------------------------------------------------------------
//
// If the selected MODIS and VIIRS satellites cross a place hours apart, a +-window match cannot find many pairs
// however good the data are. The gap is computed from the OBSERVED medians (observedOverpassTimes); nothing here
// hard-codes a satellite time. It is a rough guide: median local solar time per satellite, not per location.

export interface WindowGapPair {
  modis: SatelliteType;
  viirs: SatelliteType;
  /** Circular gap between the two observed median local solar times, minutes. */
  gapMin: number;
  nModis: number;
  nViirs: number;
  /** Either median rests on fewer than OVERPASS_MIN_N detections. */
  lowN: boolean;
  /** gapMin > the chosen window. */
  exceedsWindow: boolean;
}

export interface WindowFeasibility {
  daynight: 'D' | 'N';
  pairs: WindowGapPair[];
  /** Selected satellites with no observed time in this day/night class. */
  missing: { sensor: 'MODIS' | 'VIIRS'; satellite: SatelliteType }[];
  /** Plain-language warning, or null when nothing needs flagging. */
  warning: string | null;
}

function selectedSatellites(
  sensor: 'MODIS' | 'VIIRS',
  selection: SatelliteSelection,
  rows: readonly OverpassRow[]
): SatelliteType[] {
  const sel = sensor === 'MODIS' ? selection.modis : selection.viirs;
  if (sel !== 'all') return sensor === 'MODIS' ? [sel as SatelliteType] : [...VIIRS_SELECTION_SATELLITES[sel as Exclude<ViirsSelection, 'all'>]];
  const seen: SatelliteType[] = [];
  for (const r of rows) if (r.sensor === sensor && !seen.includes(r.satellite)) seen.push(r.satellite);
  return seen;
}

/**
 * Median local-time gap between the selected MODIS and VIIRS satellites, day and night separately, and a warning when
 * every selected pair is further apart than the window (few or no pairs expected). Pure; times come only from `overpass`.
 */
export function windowFeasibility(overpass: OverpassObserved, selection: SatelliteSelection, windowMin: number): WindowFeasibility[] {
  const out: WindowFeasibility[] = [];
  for (const dn of ['D', 'N'] as const) {
    const word = dn === 'D' ? 'day' : 'night';
    const rows = overpass.rows.filter((r) => r.daynight === dn);
    const mSel = selectedSatellites('MODIS', selection, overpass.rows);
    const vSel = selectedSatellites('VIIRS', selection, overpass.rows);
    const mRows = mSel.map((sat) => rows.find((r) => r.sensor === 'MODIS' && r.satellite === sat)).filter((r): r is OverpassRow => !!r);
    const vRows = vSel.map((sat) => rows.find((r) => r.sensor === 'VIIRS' && r.satellite === sat)).filter((r): r is OverpassRow => !!r);
    const missing = [
      ...mSel.filter((sat) => !mRows.some((r) => r.satellite === sat)).map((satellite) => ({ sensor: 'MODIS' as const, satellite })),
      ...vSel.filter((sat) => !vRows.some((r) => r.satellite === sat)).map((satellite) => ({ sensor: 'VIIRS' as const, satellite })),
    ];

    const pairs: WindowGapPair[] = [];
    for (const m of mRows) {
      for (const v of vRows) {
        const gapMin = circularGapMinutes(m.medianLocalHours, v.medianLocalHours);
        pairs.push({ modis: m.satellite, viirs: v.satellite, gapMin, nModis: m.n, nViirs: v.n, lowN: m.lowN || v.lowN, exceedsWindow: gapMin > windowMin });
      }
    }
    pairs.sort((a, b) => a.gapMin - b.gapMin);

    let warning: string | null = null;
    if (pairs.length === 0) {
      if (mRows.length > 0 || vRows.length > 0) {
        const absent = missing.map((x) => `${x.sensor} ${x.satellite}`).join(', ') || (mRows.length === 0 ? 'MODIS' : 'VIIRS');
        warning = `No observed ${word} time for ${absent} in this view, so few or no ${word}time pairs are expected for the selected satellites.`;
      }
    } else if (pairs.every((p) => p.exceedsWindow)) {
      const best = pairs[0];
      const lead =
        pairs.length === 1
          ? `The selected MODIS ${best.modis} and VIIRS ${best.viirs} pass about ${Math.round(best.gapMin)} min apart (${word}, median approx. local solar time)`
          : `The closest selected ${word} pair, MODIS ${best.modis} and VIIRS ${best.viirs}, passes about ${Math.round(best.gapMin)} min apart (median approx. local solar time)`;
      warning =
        `${lead}, more than your ±${windowMin} min window. Few or no ${word} pairs are expected. Widen the window or choose other satellites.` +
        (best.lowN ? ` One of these medians rests on fewer than ${OVERPASS_MIN_N} detections, so the gap is indicative only.` : '');
    }
    out.push({ daynight: dn, pairs, missing, warning });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Partial UTC days
// ---------------------------------------------------------------------------
//
// A UTC day that is still running (or that one sensor has not delivered yet) holds only part of the data, so
// comparing sensors on it is meaningless: e.g. MODIS 57 detections between 00:43-00:47 UTC and VIIRS 0 on the
// current day, versus MODIS 332 / VIIRS 1997 the day before. By default such dates are excluded from matching,
// the detection ratio and the FRP agreement. Counts stay per sensor; nothing here sums MODIS and VIIRS.

/** Secondary heuristic: one sensor has 0 records on a date while the other has at least this many. Rule of thumb, not validated. */
export const PARTIAL_OTHER_SENSOR_MIN = 50;

export type PartialReason = 'current_utc_day' | 'one_sensor_empty';

/** Per-sensor record counts for one UTC date (kept separate; there is deliberately no total). */
export interface DateCounts {
  /** UTC date, YYYY-MM-DD. */
  date: string;
  modis: number;
  viirs: number;
}

export interface DateCompleteness extends DateCounts {
  partial: boolean;
  /** Empty when the date is complete. */
  reasons: PartialReason[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The UTC date (YYYY-MM-DD) of a detection, from datetime_utc, else acq_date; null when neither is usable. */
export function utcDateOf(o: Pick<CanonicalObservation, 'datetime_utc' | 'acq_date'>): string | null {
  const t = typeof o?.datetime_utc === 'string' ? Date.parse(o.datetime_utc) : NaN;
  if (Number.isFinite(t)) return new Date(t).toISOString().slice(0, 10);
  return typeof o?.acq_date === 'string' && DATE_RE.test(o.acq_date) ? o.acq_date : null;
}

/** Current UTC date for an injected clock (Date or epoch ms). */
export function utcDateOfNow(now: Date | number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** Records per sensor and UTC date, sorted by date. Records without a usable date are counted in `undated`. */
export function countsByDate(
  modis: readonly CanonicalObservation[],
  viirs: readonly CanonicalObservation[]
): { dates: DateCounts[]; undated: { modis: number; viirs: number } } {
  const map = new Map<string, DateCounts>();
  const undated = { modis: 0, viirs: 0 };
  const add = (list: readonly CanonicalObservation[], key: 'modis' | 'viirs') => {
    for (const o of list) {
      const d = utcDateOf(o);
      if (d === null) {
        undated[key]++;
        continue;
      }
      let row = map.get(d);
      if (!row) map.set(d, (row = { date: d, modis: 0, viirs: 0 }));
      row[key]++;
    }
  };
  add(modis, 'modis');
  add(viirs, 'viirs');
  return { dates: [...map.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)), undated };
}

/**
 * Flag each date as PARTIAL when it equals the current UTC date (`now` is injected, so this is deterministic),
 * or, secondarily, when one sensor has 0 records while the other has at least PARTIAL_OTHER_SENSOR_MIN.
 * The secondary rule is a heuristic: a small viewport can legitimately have one sensor at 0 on a finished day.
 */
export function classifyDates(
  modis: readonly CanonicalObservation[],
  viirs: readonly CanonicalObservation[],
  now: Date | number
): { dates: DateCompleteness[]; undated: { modis: number; viirs: number }; todayUtc: string } {
  const todayUtc = utcDateOfNow(now);
  const { dates, undated } = countsByDate(modis, viirs);
  return {
    todayUtc,
    undated,
    dates: dates.map((c) => {
      const reasons: PartialReason[] = [];
      if (c.date === todayUtc) reasons.push('current_utc_day');
      if ((c.modis === 0 && c.viirs >= PARTIAL_OTHER_SENSOR_MIN) || (c.viirs === 0 && c.modis >= PARTIAL_OTHER_SENSOR_MIN)) {
        reasons.push('one_sensor_empty');
      }
      return { ...c, partial: reasons.length > 0, reasons };
    }),
  };
}

export function partialReasonText(date: DateCompleteness, included: boolean): string {
  const verb = included ? 'was included' : 'was excluded';
  const parts: string[] = [];
  if (date.reasons.includes('current_utc_day')) parts.push(`Today's UTC day is not finished; it ${verb}.`);
  if (date.reasons.includes('one_sensor_empty')) {
    const [empty, other, n] = date.modis === 0 ? ['MODIS', 'VIIRS', date.viirs] : ['VIIRS', 'MODIS', date.modis];
    parts.push(
      `${empty} has 0 records on ${date.date} while ${other} has ${n}; coverage looks incomplete (heuristic, not proof); it ${verb}.`
    );
  }
  return parts.join(' ');
}

export interface HarmonizeCompleteOptions {
  /** Injected clock (Date or epoch ms). Required so callers and tests control "today". */
  now: Date | number;
  /** Include partial dates anyway (the view then carries a strong warning). Default false. */
  includePartial?: boolean;
  matching?: MatchingOptions;
}

export interface HarmonizeCompleteResult {
  /**
   * 'ok': a view was computed. 'no_complete_day': there are dates, every one is partial and includePartial is off;
   * then `view` and `result` are null (never a number).
   */
  status: 'ok' | 'no_complete_day';
  view: HarmonizeView | null;
  result: MatchingResult | null;
  todayUtc: string;
  /** Every date seen, with its per-sensor counts and partial flag. */
  dates: DateCompleteness[];
  /** Partial dates left out of the computation (empty when includePartial). */
  excluded: DateCompleteness[];
  /** Partial dates that are part of the computation (only with includePartial). */
  includedPartial: DateCompleteness[];
  /** Complete dates used. */
  completeDates: DateCompleteness[];
  includePartial: boolean;
  /** The per-sensor lists that were actually matched (use these, not the raw inputs, e.g. for the sensitivity grid). */
  used: { modis: CanonicalObservation[]; viirs: CanonicalObservation[] };
  /** Records with no usable date; they cannot be classified, so they are passed on unchanged (matching.ts drops invalid records itself). */
  undated: { modis: number; viirs: number };
}

/**
 * Like computeHarmonizeView, but partial UTC dates are excluded from matching, the detection ratio and the FRP
 * agreement unless `includePartial`. Pure; throws RangeError only for invalid matching options.
 */
export function computeHarmonizeViewComplete(
  modis: readonly CanonicalObservation[],
  viirs: readonly CanonicalObservation[],
  opts: HarmonizeCompleteOptions
): HarmonizeCompleteResult {
  const includePartial = opts.includePartial ?? false;
  const sep = separateInputs(modis, viirs);
  const { dates, undated, todayUtc } = classifyDates(sep.modis, sep.viirs, opts.now);
  const partial = dates.filter((d) => d.partial);
  const complete = dates.filter((d) => !d.partial);
  const partialSet = new Set(partial.map((d) => d.date));

  const base = { todayUtc, dates, undated, includePartial, completeDates: complete };

  if (!includePartial && dates.length > 0 && complete.length === 0) {
    return {
      ...base,
      status: 'no_complete_day',
      view: null,
      result: null,
      excluded: partial,
      includedPartial: [],
      used: { modis: [], viirs: [] },
    };
  }

  const keep = (o: CanonicalObservation) => {
    if (includePartial) return true;
    const d = utcDateOf(o);
    return d === null || !partialSet.has(d);
  };
  const used = { modis: sep.modis.filter(keep), viirs: sep.viirs.filter(keep) };
  const result = matchModisViirs([...used.modis, ...used.viirs], opts.matching ?? {});
  const view = buildHarmonizeView(result, { mismatched: sep.mismatched });

  if (includePartial && partial.length > 0) {
    const list = partial.map((d) => `${d.date} (MODIS ${d.modis}, VIIRS ${d.viirs})`).join('; ');
    view.warnings.unshift(
      `Partial UTC day(s) are INCLUDED: ${list}. Their detection counts and ratio compare unequal observation windows and are not meaningful. Treat every number here as EXPLORATORY and do not quote it.`
    );
  }

  return {
    ...base,
    status: 'ok',
    view,
    result,
    excluded: includePartial ? [] : partial,
    includedPartial: includePartial ? partial : [],
    used,
  };
}

// ---------------------------------------------------------------------------
// Same-day cell agreement on the 1 km equal-area grid (EXPLORATORY)
// ---------------------------------------------------------------------------
//
// Per UTC date: which 1 km grid cells (spatial.ts) hold a MODIS detection, a VIIRS detection, or both.
// MODIS and VIIRS stay separate: every count below is a count of one sensor, or of cells (not detections),
// and nothing is a MODIS+VIIRS sum. Partial UTC dates are excluded by the same rule as the main view.

export const CELL_DAY_METHOD =
  'Each detection is assigned to a 1 km equal-area grid cell (spatial.ts) and to its UTC date. For each complete UTC date the cells with at least one MODIS detection, ' +
  'at least one VIIRS detection, or both are counted. “Share of MODIS cells with VIIRS” = cells with both ÷ cells with MODIS. “VIIRS per shared cell” = VIIRS detections in cells ' +
  'that also have MODIS ÷ number of such cells. Partial UTC dates are excluded as in the main comparison. Counts stay separate per sensor.';

export const CELL_DAY_LIMITATIONS: readonly string[] = Object.freeze([
  'Ignores time of day and the fire diurnal cycle: a MODIS and a VIIRS detection in the same cell on the same UTC day may be hours apart.',
  'Absence can mean no overpass or cloud, not that the other sensor saw no fire. “MODIS-only” and “VIIRS-only” mean no detection by the other sensor in that cell on that day.',
  'A grid cell is not the true MODIS footprint (about 1 km at nadir, larger toward the scan edge), and a detection near a cell edge can fall in a neighbouring cell.',
  'A UTC day splits a local day, so one local fire event can appear on two UTC dates.',
  'Agreement is not validation: it says nothing about which sensor is closer to the truth.',
  'Cells on either side of the ±180° meridian are separate grid cells, so a cluster straddling it is split.',
]);

export interface CellDayRow {
  /** UTC date, YYYY-MM-DD. */
  date: string;
  /** Detection counts, kept separate per sensor. */
  modisDetections: number;
  viirsDetections: number;
  /** Cells (not detections) with at least one detection of that sensor. */
  modisCells: number;
  viirsCells: number;
  /** Cells with both sensors / only MODIS / only VIIRS. */
  bothCells: number;
  modisOnlyCells: number;
  viirsOnlyCells: number;
  /** bothCells / modisCells, or null when there is no MODIS cell. */
  modisCellsWithViirsShare: number | null;
  /** VIIRS detections inside the shared cells (VIIRS only). */
  viirsInSharedCells: number;
  /** viirsInSharedCells / bothCells, or null when no cell is shared. */
  viirsPerSharedCell: number | null;
  /** True only when includePartial pulled in a partial UTC date. */
  partial: boolean;
}

export interface CellDayAgreement {
  label: typeof EXPLORATORY_LABEL;
  /** 'no_data': no dated detection; 'no_complete_day': every date is partial and includePartial is off. */
  status: 'ok' | 'no_data' | 'no_complete_day';
  todayUtc: string;
  rows: CellDayRow[];
  /** Partial dates left out (empty with includePartial). */
  excluded: DateCompleteness[];
  includePartial: boolean;
  /** Records not used: no UTC date, or no valid latitude/longitude. */
  skipped: number;
  warnings: string[];
  method: string;
  limitations: readonly string[];
}

export interface CellDayOptions {
  /** Injected clock (Date or epoch ms). */
  now: Date | number;
  includePartial?: boolean;
  /** Same meaning as the matching options: restrict to these satellites; omitted = every loaded satellite. */
  modisSatellites?: readonly SatelliteType[];
  viirsSatellites?: readonly SatelliteType[];
}

/** Longitude wrapped to [-180, 180) so that 180 and -180 are the same meridian. */
function wrapLon(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

type CellCounts = Map<string, number>;

export function cellDayAgreement(
  modis: readonly CanonicalObservation[],
  viirs: readonly CanonicalObservation[],
  opts: CellDayOptions
): CellDayAgreement {
  const includePartial = opts.includePartial ?? false;
  const sep = separateInputs(modis, viirs);
  const { dates, todayUtc } = classifyDates(sep.modis, sep.viirs, opts.now);
  const partialSet = new Set(dates.filter((d) => d.partial).map((d) => d.date));
  const completeCount = dates.filter((d) => !d.partial).length;
  const excluded = includePartial ? [] : dates.filter((d) => d.partial);

  const base = {
    label: EXPLORATORY_LABEL,
    todayUtc,
    includePartial,
    method: CELL_DAY_METHOD,
    limitations: CELL_DAY_LIMITATIONS,
    excluded,
  };

  if (dates.length === 0) return { ...base, status: 'no_data', rows: [], skipped: sep.modis.length + sep.viirs.length, warnings: [] };
  if (!includePartial && completeCount === 0) return { ...base, status: 'no_complete_day', rows: [], skipped: 0, warnings: [] };

  const days = new Map<string, { m: CellCounts; v: CellCounts }>();
  let skipped = 0;
  const add = (list: readonly CanonicalObservation[], key: 'm' | 'v', sats: readonly SatelliteType[] | undefined) => {
    for (const o of list) {
      if (sats && !sats.includes(o.satellite)) continue;
      const d = utcDateOf(o);
      const lat = o.latitude;
      const lon = o.longitude;
      if (d === null || typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 360) {
        skipped++;
        continue;
      }
      if (!includePartial && partialSet.has(d)) continue;
      const cell = computeGridCellIndex(lat, wrapLon(lon)).cellKey;
      let day = days.get(d);
      if (!day) days.set(d, (day = { m: new Map(), v: new Map() }));
      day[key].set(cell, (day[key].get(cell) ?? 0) + 1);
    }
  };
  add(sep.modis, 'm', opts.modisSatellites);
  add(sep.viirs, 'v', opts.viirsSatellites);

  const rows: CellDayRow[] = [...days.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, { m, v }]) => {
      let both = 0;
      let viirsInShared = 0;
      for (const [cell, n] of v) {
        if (m.has(cell)) {
          both++;
          viirsInShared += n;
        }
      }
      const sum = (c: CellCounts) => [...c.values()].reduce((a, b) => a + b, 0);
      return {
        date,
        modisDetections: sum(m),
        viirsDetections: sum(v),
        modisCells: m.size,
        viirsCells: v.size,
        bothCells: both,
        modisOnlyCells: m.size - both,
        viirsOnlyCells: v.size - both,
        modisCellsWithViirsShare: m.size > 0 ? both / m.size : null,
        viirsInSharedCells: viirsInShared,
        viirsPerSharedCell: both > 0 ? viirsInShared / both : null,
        partial: partialSet.has(date),
      };
    });

  const warnings: string[] = [];
  if (includePartial && partialSet.size > 0) {
    warnings.push(`Partial UTC day(s) are INCLUDED (${[...partialSet].sort().join(', ')}); their cell counts compare unequal observation windows and are not meaningful.`);
  }
  return { ...base, status: rows.length > 0 ? 'ok' : 'no_data', rows, skipped, warnings };
}

// ---------------------------------------------------------------------------
// Sensitivity check
// ---------------------------------------------------------------------------

export interface SensitivityGrid {
  distancesKm: readonly number[];
  timeWindowsMin: readonly number[];
}

export const DEFAULT_SENSITIVITY_GRID: SensitivityGrid = Object.freeze({
  distancesKm: Object.freeze([0.5, 1, 2]) as readonly number[],
  timeWindowsMin: Object.freeze([30, 90, 180]) as readonly number[],
});

export interface SensitivityRow {
  maxDistanceKm: number;
  maxTimeDiffMinutes: number;
  /** True when this row equals the setting currently in use. */
  isCurrent: boolean;
  matched: number;
  viirsOnly: number;
  modisOnly: number;
  matchedShareOfModis: number | null;
  matchedShareOfViirs: number | null;
  /** matched - matched at the current setting (0 for the current row). */
  deltaMatchedVsCurrent: number;
  coDetectedCells: number;
  /** VIIRS detections per co-detected MODIS footprint at this setting. */
  coDetectedRatio: number | null;
  frpN: number;
  frpBiasMw: number | null;
}

export interface SensitivitySample {
  /** Detections the grid was run on. */
  n: number;
  /** Valid detections in view. */
  of: number;
  blocksKept: number;
  blocksTotal: number;
  blockDeg: number;
  /** "computed on a sample of N of M detections" */
  label: string;
}

export interface SensitivityReport {
  label: typeof EXPLORATORY_LABEL;
  rows: SensitivityRow[];
  /** At the current setting; on the sample when `sample` is set. */
  current: { matched: number; matchedShareOfModis: number | null };
  range: { matchedMin: number; matchedMax: number; shareOfModisMin: number | null; shareOfModisMax: number | null } | null;
  /** null = the grid ran on all valid detections. */
  sample: SensitivitySample | null;
  /** Reason the grid was not run (no data / sample lacks a sensor); rows is empty then. */
  skippedReason: string | null;
  summary: string;
  limitations: string[];
}

const SENSITIVITY_LIMITATIONS = [
  'The grid is a small, arbitrary set of settings, not a search for a "best" setting and not a confidence interval.',
  'It shows how much the counts depend on the matching parameters only; it does not test whether any pairing is physically the same fire.',
  'Greedy one-to-one pairing is not guaranteed to be monotone, so a larger window can occasionally change which detections pair up.',
];

const SENSITIVITY_SAMPLE_LIMITATIONS = [
  'Sample: whole spatial blocks of detections are kept or dropped (same blocks for the same input), so pairs inside a block stay together. A pair that straddles the edge of a kept block can lose its partner, so matched counts on the sample are slightly low.',
  'The sample covers areas, not a random draw of detections: a few dense blocks (for example intense fires) may be missing, so absolute counts are not those of the full view. Read the shares and how they change across settings, not the totals.',
];

function sameNumber(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-9;
}

/** Deterministic 32-bit mix of a block's integer coordinates (murmur3 finalizer). No randomness, no input-order dependence. */
function blockHash(ix: number, iy: number): number {
  let h = (Math.imul(ix | 0, 0x9e3779b1) ^ Math.imul(iy | 0, 0x85ebca6b)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

export interface SpatialBlockSample {
  observations: CanonicalObservation[];
  blocksKept: number;
  blocksTotal: number;
}

/**
 * Deterministic spatial-block subsample. Detections are grouped into lat/lon blocks of `blockDeg`; blocks are
 * ordered by a fixed hash of their integer coordinates and whole blocks are kept while the total stays <= target
 * (stopping at the first block that does not fit; if even the first block exceeds target it is kept anyway).
 * Same input -> same output; the result does not depend on the order of `observations` apart from preserving it.
 */
export function spatialBlockSample(
  observations: readonly CanonicalObservation[],
  target: number,
  blockDeg: number = SENSITIVITY_BLOCK_DEG
): SpatialBlockSample {
  const key = (o: CanonicalObservation) => `${Math.floor(o.latitude / blockDeg)}:${Math.floor(o.longitude / blockDeg)}`;
  const blocks = new Map<string, { ix: number; iy: number; size: number }>();
  for (const o of observations) {
    const k = key(o);
    const b = blocks.get(k);
    if (b) b.size++;
    else blocks.set(k, { ix: Math.floor(o.latitude / blockDeg), iy: Math.floor(o.longitude / blockDeg), size: 1 });
  }
  const order = [...blocks.entries()]
    .map(([k, b]) => ({ k, h: blockHash(b.ix, b.iy), ix: b.ix, iy: b.iy, size: b.size }))
    .sort((a, b) => a.h - b.h || a.ix - b.ix || a.iy - b.iy);

  const kept = new Set<string>();
  let total = 0;
  for (const b of order) {
    if (total + b.size > target) {
      if (kept.size === 0) {
        kept.add(b.k);
        total += b.size;
      }
      break;
    }
    kept.add(b.k);
    total += b.size;
  }
  return { observations: observations.filter((o) => kept.has(key(o))), blocksKept: kept.size, blocksTotal: blocks.size };
}

export interface SensitivityRunOptions {
  /** Run on everything up to this many valid detections. Default SENSITIVITY_MAX_INPUT. */
  maxInput?: number;
  /** Sample size above that. Default SENSITIVITY_SAMPLE_TARGET. */
  sampleTarget?: number;
  blockDeg?: number;
}

/**
 * Re-run matching over distance x time-window combinations (everything else, e.g. satellite filters, is taken
 * from `base`). Up to `maxInput` valid detections all of them are used and `currentResult` is only used to label
 * the current row (it is not re-run). Above it the grid runs on a deterministic spatial-block sample, the current
 * setting is re-run on that same sample so deltas are like-for-like, and the report says so (`sample`).
 */
export function runSensitivity(
  observations: readonly CanonicalObservation[],
  currentResult: MatchingResult,
  base: MatchingOptions = {},
  grid: SensitivityGrid = DEFAULT_SENSITIVITY_GRID,
  opts: SensitivityRunOptions = {}
): SensitivityReport {
  const maxInput = opts.maxInput ?? SENSITIVITY_MAX_INPUT;
  const sampleTarget = opts.sampleTarget ?? SENSITIVITY_SAMPLE_TARGET;
  const blockDeg = opts.blockDeg ?? SENSITIVITY_BLOCK_DEG;

  const shareOf = (r: MatchingResult) => (r.counts.modisInput > 0 ? r.point.matched.length / r.counts.modisInput : null);
  const summarise = (r: MatchingResult) => ({ matched: r.point.matched.length, matchedShareOfModis: shareOf(r) });

  const validInput = currentResult.counts.modisInput + currentResult.counts.viirsInput;
  const fail = (reason: string, sample: SensitivitySample | null = null): SensitivityReport => ({
    label: EXPLORATORY_LABEL,
    rows: [],
    current: summarise(currentResult),
    range: null,
    sample,
    skippedReason: reason,
    summary: reason,
    limitations: SENSITIVITY_LIMITATIONS,
  });

  if (currentResult.counts.modisInput === 0 || currentResult.counts.viirsInput === 0) {
    return fail('Sensitivity check needs both MODIS and VIIRS detections in view.');
  }

  let input: readonly CanonicalObservation[] = observations;
  let ref = currentResult;
  let sample: SensitivitySample | null = null;
  if (validInput > maxInput) {
    // Only detections that matching accepted (valid, passed the satellite filters) are eligible, so N and M count the same thing.
    const eligible = new Set<CanonicalObservation>();
    for (const p of currentResult.point.matched) {
      eligible.add(p.modis);
      eligible.add(p.viirs);
    }
    for (const o of currentResult.point.modisOnly) eligible.add(o);
    for (const o of currentResult.point.viirsOnly) eligible.add(o);
    const pool = observations.filter((o) => eligible.has(o));
    let usedDeg = blockDeg;
    let s = spatialBlockSample(pool, sampleTarget, usedDeg);
    // A single very dense block can overshoot the target; use finer blocks (deterministic: same halving every time).
    while (s.observations.length > sampleTarget * SENSITIVITY_OVERSHOOT && usedDeg / 2 >= SENSITIVITY_MIN_BLOCK_DEG - 1e-12) {
      usedDeg /= 2;
      s = spatialBlockSample(pool, sampleTarget, usedDeg);
    }
    input = s.observations;
    ref = matchModisViirs(input, { ...base, maxDistanceKm: currentResult.params.maxDistanceKm, maxTimeDiffMinutes: currentResult.params.maxTimeDiffMinutes });
    sample = {
      n: ref.counts.modisInput + ref.counts.viirsInput,
      of: validInput,
      blocksKept: s.blocksKept,
      blocksTotal: s.blocksTotal,
      blockDeg: usedDeg,
      label: '',
    };
    sample.label = `computed on a sample of ${sample.n} of ${sample.of} detections`;
    if (ref.counts.modisInput === 0 || ref.counts.viirsInput === 0) {
      return fail(`Sensitivity check ${sample.label}, but the sample holds no ${ref.counts.modisInput === 0 ? 'MODIS' : 'VIIRS'} detection. Zoom in to run it on all detections.`, sample);
    }
  }

  const current = summarise(ref);
  const distances = [...new Set(grid.distancesKm)].sort((a, b) => a - b);
  const times = [...new Set(grid.timeWindowsMin)].sort((a, b) => a - b);
  const rows: SensitivityRow[] = [];
  for (const d of distances) {
    for (const t of times) {
      const r = matchModisViirs(input, { ...base, maxDistanceKm: d, maxTimeDiffMinutes: t });
      const matched = r.point.matched.length;
      rows.push({
        maxDistanceKm: d,
        maxTimeDiffMinutes: t,
        isCurrent: sameNumber(d, currentResult.params.maxDistanceKm) && sameNumber(t, currentResult.params.maxTimeDiffMinutes),
        matched,
        viirsOnly: r.point.viirsOnly.length,
        modisOnly: r.point.modisOnly.length,
        matchedShareOfModis: shareOf(r),
        matchedShareOfViirs: r.counts.viirsInput > 0 ? matched / r.counts.viirsInput : null,
        deltaMatchedVsCurrent: matched - current.matched,
        coDetectedCells: r.cell.cells.length,
        coDetectedRatio: r.detectionRatio.coDetected.ratio,
        frpN: r.point.frpAgreement.n,
        frpBiasMw: r.point.frpAgreement.bias,
      });
    }
  }

  const matchedVals = rows.map((r) => r.matched);
  const shares = rows.map((r) => r.matchedShareOfModis).filter((v): v is number => v !== null);
  const range = {
    matchedMin: Math.min(...matchedVals),
    matchedMax: Math.max(...matchedVals),
    shareOfModisMin: shares.length ? Math.min(...shares) : null,
    shareOfModisMax: shares.length ? Math.max(...shares) : null,
  };
  const modisBasis = ref.counts.modisInput;
  const summary =
    (sample ? `Sensitivity check ${sample.label} (${sample.blocksKept} of ${sample.blocksTotal} spatial blocks of ${sample.blockDeg}°). ` : '') +
    `Across ${rows.length} settings (distance ${distances.join('/')} km × window ±${times.join('/')} min) the number of matched pairs ` +
    `ranged ${range.matchedMin}–${range.matchedMax} (currently ${current.matched}), i.e. ` +
    `${fmtPct(range.shareOfModisMin)}–${fmtPct(range.shareOfModisMax)} of the ${modisBasis} MODIS detections${sample ? ' in the sample' : ''}. ` +
    (range.matchedMin === range.matchedMax
      ? 'The count did not change across this grid.'
      : 'The match count depends on these settings, so quote a range, not a single number.');

  return {
    label: EXPLORATORY_LABEL,
    rows,
    current,
    range,
    sample,
    skippedReason: null,
    summary,
    limitations: sample ? [...SENSITIVITY_SAMPLE_LIMITATIONS, ...SENSITIVITY_LIMITATIONS] : SENSITIVITY_LIMITATIONS,
  };
}

// ---------------------------------------------------------------------------
// "Why do they differ?" — generic explanation + LIVE numbers
// ---------------------------------------------------------------------------

export type WhyId = 'overpass' | 'resolution' | 'saturation' | 'daynight' | 'cloudsmoke';

export interface WhyBlock {
  id: WhyId;
  title: string;
  /** General background (does not depend on the data). */
  body: string;
  /** Sentence built from the numbers currently in view. */
  live: string;
}

export interface WhyDiffer {
  blocks: WhyBlock[];
  /** Shown first when n is small or one sensor is absent; null otherwise. */
  warning: string | null;
}

export function buildWhyDiffer(view: HarmonizeView, overpass?: OverpassObserved): WhyDiffer {
  const d = view.diagnostics;
  const { modis, viirs } = view.inputs;
  const p = view.point;

  let warning: string | null = null;
  if (modis === 0 || viirs === 0) {
    warning = `Both sensors are needed. This view has ${modis} MODIS and ${viirs} VIIRS detection(s), so the numbers below are placeholders, not findings.`;
  } else if (view.frp.point.n < LOW_SAMPLE_N) {
    warning = `Small sample (n=${view.frp.point.n} matched pairs with usable FRP; flag below ${LOW_SAMPLE_N}). The numbers quoted in these explanations are indicative only and may change a lot with a different view.`;
  }

  const timeMatch =
    d.timeDiff.n > 0
      ? `In this view, ${d.timeDiff.n} matched pair(s) have a median time offset (VIIRS − MODIS) of ${fmtSigned(d.timeDiff.medianMin, 0)} min ` +
        `(median |offset| ${fmt(d.timeDiff.medianAbsMin, 0)} min, largest ${fmt(d.timeDiff.maxAbsMin, 0)} min) within your ±${view.params.maxTimeDiffMinutes} min window. ` +
        `Satellites present: MODIS ${d.modisSatellites.join(', ') || 'none'}; VIIRS ${d.viirsSatellites.join(', ') || 'none'}.`
      : `No matched pairs at ±${view.params.maxTimeDiffMinutes} min, so there is no time offset to report. Satellites present: MODIS ${d.modisSatellites.join(', ') || 'none'}; VIIRS ${d.viirsSatellites.join(', ') || 'none'}.`;

  const observedText =
    overpass && overpass.rows.length > 0
      ? ` Observed approx. local solar time (median, this view): ${overpass.rows.map(overpassRowText).join('; ')}. Approximation, see the overpass section.`
      : ' No observed overpass times are available for this view.';
  const timeLive = timeMatch + observedText;

  const resLive =
    d.footprint.cells > 0
      ? `In this view, ${d.footprint.cells} MODIS footprint(s) contain at least one VIIRS detection, with on average ${fmt(d.footprint.meanViirsPerCell, 2)} VIIRS detection(s) per footprint ` +
        `(mean MODIS footprint ${fmt(d.footprint.meanModisKm2, 2)} km²). Overall there are ${viirs} VIIRS vs ${modis} MODIS detections (ratio ${fmt(view.detectionRatio.overall, 2)}), which depends on coverage and is not a calibration factor.`
      : `In this view, no MODIS footprint contains a VIIRS detection. Overall there are ${viirs} VIIRS vs ${modis} MODIS detections (ratio ${fmt(view.detectionRatio.overall, 2)}).`;

  const satLive =
    `Highest FRP in view: MODIS ${fmt(d.maxFrpMw.modis)} MW, VIIRS ${fmt(d.maxFrpMw.viirs)} MW. ` +
    `Highest brightness temperature in view: MODIS ${fmt(d.maxBrightnessK.modisBrightness)} K, VIIRS I4 ${fmt(d.maxBrightnessK.viirsI4)} K. ` +
    `This panel does not test for saturation; ${view.frp.point.excluded} matched pair(s) were excluded from the FRP statistics because an FRP value was missing or ≤ 0.`;

  const dn = d.matchedByDayNight;
  const dnLive =
    `By MODIS day/night flag: ${dn.day} matched pair(s) in daytime, ${dn.night} at night. ` +
    `MODIS detections: ${d.modisByDayNight.day} day / ${d.modisByDayNight.night} night; VIIRS: ${d.viirsByDayNight.day} day / ${d.viirsByDayNight.night} night.`;

  const cloudLive =
    `In this view ${p.viirsOnly} VIIRS and ${p.modisOnly} MODIS detection(s) have no counterpart (${fmtPct(1 - (p.matchedShareOfViirs ?? 0))} of VIIRS, ${fmtPct(1 - (p.matchedShareOfModis ?? 0))} of MODIS). ` +
    `Without swath, cloud or smoke data this cannot be split into "not observed", "observed but not detected" and "different location/time".`;

  const blocks: WhyBlock[] = [
    {
      id: 'overpass',
      title: 'Different overpass times',
      body:
        'The sensors fly on different satellites that cross a place at different local solar times, and those times are not fixed. NASA reports that Aqua is drifting to later crossing times and Terra to earlier ones (aqua.nasa.gov, modis-land.gsfc.nasa.gov/news.html; not verified in this build). ' +
        'Historically, as design values only, Terra crossed at about 10:30 and Aqua at about 13:30 local solar time; do not use these as current times. The currently passing VIIRS satellites are NOAA-20 and NOAA-21 (Suomi NPP data delivery ended on 2026-11-01). The observed values for this view are shown below. ' +
        'Fires change within hours (the diurnal cycle), so two sensors can see different burning states, or one fire only once. Orbit tracks also differ, so a place is not always seen by both.',
      live: timeLive,
    },
    {
      id: 'resolution',
      title: 'Pixel size: 375 m vs 1 km',
      body:
        'VIIRS active-fire pixels are nominally 375 m at nadir; MODIS pixels are nominally 1 km, and both grow toward the scan edge. ' +
        'One MODIS pixel can cover several VIIRS pixels, and small, cool fires are more detectable at finer resolution. That is why this panel compares a MODIS footprint with VIIRS detections inside it, and why raw counts are never added together.',
      live: resLive,
    },
    {
      id: 'saturation',
      title: 'Saturation and FRP retrieval',
      body:
        'Very intense fires can saturate the thermal channels, which lowers retrieved brightness and FRP. FRP is also derived differently for each product, so a difference in FRP does not show which sensor is closer to the true radiative power.',
      live: satLive,
    },
    {
      id: 'daynight',
      title: 'Day versus night',
      body:
        'Detection thresholds, background temperature and solar reflection differ between day and night, so match rates and agreement can differ too. Night detections are generally less affected by sun glint and reflective surfaces.',
      live: dnLive,
    },
    {
      id: 'cloudsmoke',
      title: 'Cloud and smoke',
      body:
        'Cloud blocks the thermal signal and thick smoke can attenuate it. If one sensor had clear sky at its overpass and the other did not, a detection can be missing for reasons unrelated to the fire itself. "No counterpart" is therefore not the same as "no fire".',
      live: cloudLive,
    },
  ];

  return { blocks, warning };
}

// ---------------------------------------------------------------------------
// Scatter geometry (pure, so the SVG component stays dumb and the maths is tested)
// ---------------------------------------------------------------------------

export interface ScatterGeometry {
  width: number;
  height: number;
  plot: { left: number; top: number; right: number; bottom: number };
  /** Both axes share this domain [0, domainMax] so the 1:1 line is a true diagonal. */
  domainMax: number;
  xTicks: { value: number; pos: number }[];
  yTicks: { value: number; pos: number }[];
  dots: { cx: number; cy: number }[];
  /** y = x (perfect agreement). */
  identity: { x1: number; y1: number; x2: number; y2: number };
  /** OLS line clipped to the plot; null when no regression or it leaves the plot entirely. */
  regression: { x1: number; y1: number; x2: number; y2: number } | null;
  /** Points not drawn because of the SCATTER_MAX_POINTS cap (statistics still include them). */
  notDrawn: number;
}

/** Ticks at 1/2/2.5/5 × 10^k covering [0, max]; always includes 0 and a tick >= max. */
export function niceTicks(max: number, target = 4): number[] {
  if (!(max > 0) || !Number.isFinite(max)) return [0, 1];
  const raw = max / target;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const frac = raw / pow;
  const mult = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 2.5 ? 2.5 : frac <= 5 ? 5 : 10;
  const step = mult * pow;
  const ticks: number[] = [];
  for (let v = 0; v < max + step * 0.999; v += step) ticks.push(Number(v.toPrecision(12)));
  if (ticks[ticks.length - 1] < max) ticks.push(Number((ticks[ticks.length - 1] + step).toPrecision(12)));
  return ticks;
}

export function buildScatterGeometry(
  points: readonly ScatterPoint[],
  regression: { slope: number; intercept: number } | null,
  opts: { width?: number; height?: number; maxPoints?: number } = {}
): ScatterGeometry {
  const width = opts.width ?? 320;
  const height = opts.height ?? 260;
  const maxPoints = opts.maxPoints ?? SCATTER_MAX_POINTS;
  const plot = { left: 44, top: 12, right: width - 12, bottom: height - 38 };

  let peak = 0;
  for (const p of points) peak = Math.max(peak, p.modisFrpMw, p.viirsFrpMw);
  const ticks = niceTicks(peak);
  const domainMax = ticks[ticks.length - 1];

  const sx = (v: number) => plot.left + (v / domainMax) * (plot.right - plot.left);
  const sy = (v: number) => plot.bottom - (v / domainMax) * (plot.bottom - plot.top);

  const stride = points.length > maxPoints ? points.length / maxPoints : 1;
  const dots: { cx: number; cy: number }[] = [];
  for (let i = 0; i < Math.min(points.length, maxPoints); i++) {
    const p = points[Math.floor(i * stride)];
    dots.push({ cx: sx(p.modisFrpMw), cy: sy(p.viirsFrpMw) });
  }

  let reg: ScatterGeometry['regression'] = null;
  if (regression && Number.isFinite(regression.slope) && Number.isFinite(regression.intercept)) {
    // Clip y = a + b x to the square [0, domainMax]^2.
    const { slope: b, intercept: a } = regression;
    let lo = 0;
    let hi = domainMax;
    if (b > 0) {
      lo = Math.max(lo, (0 - a) / b);
      hi = Math.min(hi, (domainMax - a) / b);
    } else if (b < 0) {
      lo = Math.max(lo, (domainMax - a) / b);
      hi = Math.min(hi, (0 - a) / b);
    } else if (a < 0 || a > domainMax) {
      lo = 1;
      hi = 0;
    }
    if (lo <= hi) reg = { x1: sx(lo), y1: sy(a + b * lo), x2: sx(hi), y2: sy(a + b * hi) };
  }

  return {
    width,
    height,
    plot,
    domainMax,
    xTicks: ticks.map((value) => ({ value, pos: sx(value) })),
    yTicks: ticks.map((value) => ({ value, pos: sy(value) })),
    dots,
    identity: { x1: sx(0), y1: sy(0), x2: sx(domainMax), y2: sy(domainMax) },
    regression: reg,
    notDrawn: Math.max(0, points.length - maxPoints),
  };
}

// ---------------------------------------------------------------------------
// GeoJSON for a later map toggle (lowest priority item)
// ---------------------------------------------------------------------------

export type AgreementClass =
  | 'similar'
  | 'viirs_higher'
  | 'modis_higher'
  | 'frp_unavailable'
  | 'modis_only'
  | 'viirs_only';

export interface AgreementProperties {
  class: AgreementClass;
  label: typeof EXPLORATORY_LABEL;
  /** Each sensor's own values; there is deliberately no combined field. */
  modis_frp_mw: number | null;
  /** Sum over VIIRS detections inside this one MODIS footprint (VIIRS only). */
  viirs_frp_sum_mw: number | null;
  viirs_count: number;
  /** (viirs_frp_sum - modis_frp) / modis_frp; null when either is unavailable. */
  rel_diff: number | null;
  cell_key: string | null;
  sensor: 'MODIS' | 'VIIRS' | 'MODIS+VIIRS cell';
  footprint_km: { scan: number; track: number };
}

export interface AgreementFeature {
  type: 'Feature';
  properties: AgreementProperties;
  geometry: { type: 'Polygon'; coordinates: number[][][] };
}

export interface AgreementFeatureCollection {
  type: 'FeatureCollection';
  features: AgreementFeature[];
  /** Foreign members (allowed by RFC 7946) describing how to read the layer. */
  label: typeof EXPLORATORY_LABEL;
  method: string;
  limitations: string[];
  similarTolerance: number;
  /** Footprints dropped because the rectangle would cross ±180° (not split here) or lies near a pole. */
  skippedGeometry: number;
}

export interface AgreementOptions {
  /** |viirs_sum − modis| / modis at or below this counts as "similar". Exploratory threshold, not validated. Default 0.25. */
  similarTolerance?: number;
  /** Also emit MODIS-only and VIIRS-only footprints (cell level). Default true. */
  includeUnmatched?: boolean;
}

function footprintKm(scan: unknown, track: unknown, nominal: number): { scan: number; track: number } {
  const ok = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= MAX_PLAUSIBLE_PIXEL_KM;
  return ok(scan) && ok(track) ? { scan, track } : { scan: nominal, track: nominal };
}

function rectangle(lat: number, lon: number, scanKm: number, trackKm: number): number[][][] | null {
  if (Math.abs(lat) > 89) return null;
  const dLat = trackKm / 2 / KM_PER_DEG;
  const dLon = scanKm / 2 / (KM_PER_DEG * Math.cos((lat * Math.PI) / 180));
  const west = lon - dLon;
  const east = lon + dLon;
  if (west < -180 || east > 180) return null;
  const south = lat - dLat;
  const north = lat + dLat;
  return [
    [
      [west, south],
      [east, south],
      [east, north],
      [west, north],
      [west, south],
    ],
  ];
}

function classifyCell(c: MatchedCell, tol: number): { cls: AgreementClass; rel: number | null } {
  if (c.modisFrpMw === null || c.viirsFrpSumMw === null) return { cls: 'frp_unavailable', rel: null };
  const rel = (c.viirsFrpSumMw - c.modisFrpMw) / c.modisFrpMw;
  if (Math.abs(rel) <= tol) return { cls: 'similar', rel };
  return { cls: rel > 0 ? 'viirs_higher' : 'modis_higher', rel };
}

/**
 * Cells (MODIS footprints) classed by FRP agreement, for a later map toggle. MODIS and VIIRS are never summed:
 * matched cells carry both values side by side; unmatched footprints carry only their own sensor's value.
 * Footprints are axis-aligned rectangles (the same approximation matching.ts uses), not true pixel outlines.
 */
export function agreementCellsToGeoJSON(
  result: MatchingResult,
  options: AgreementOptions = {}
): AgreementFeatureCollection {
  const tol = options.similarTolerance ?? 0.25;
  const includeUnmatched = options.includeUnmatched ?? true;
  const features: AgreementFeature[] = [];
  let skipped = 0;

  for (const c of result.cell.cells) {
    const ring = rectangle(c.modis.latitude, c.modis.longitude, c.footprintScanKm, c.footprintTrackKm);
    if (!ring) {
      skipped++;
      continue;
    }
    const { cls, rel } = classifyCell(c, tol);
    features.push({
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: ring },
      properties: {
        class: cls,
        label: EXPLORATORY_LABEL,
        modis_frp_mw: c.modisFrpMw,
        viirs_frp_sum_mw: c.viirsFrpSumMw,
        viirs_count: c.viirsCount,
        rel_diff: rel,
        cell_key: c.gridCell.cellKey,
        sensor: 'MODIS+VIIRS cell',
        footprint_km: { scan: c.footprintScanKm, track: c.footprintTrackKm },
      },
    });
  }

  if (includeUnmatched) {
    for (const o of result.cell.modisOnly) {
      const fp = footprintKm(o.scan, o.track, NOMINAL_PIXEL_KM);
      const ring = rectangle(o.latitude, o.longitude, fp.scan, fp.track);
      if (!ring) {
        skipped++;
        continue;
      }
      features.push({
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: ring },
        properties: {
          class: 'modis_only',
          label: EXPLORATORY_LABEL,
          modis_frp_mw: usable(o.frp_mw) ? o.frp_mw : null,
          viirs_frp_sum_mw: null,
          viirs_count: 0,
          rel_diff: null,
          cell_key: null,
          sensor: 'MODIS',
          footprint_km: fp,
        },
      });
    }
    for (const o of result.cell.viirsOnly) {
      const fp = footprintKm(o.scan, o.track, NOMINAL_VIIRS_PIXEL_KM);
      const ring = rectangle(o.latitude, o.longitude, fp.scan, fp.track);
      if (!ring) {
        skipped++;
        continue;
      }
      features.push({
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: ring },
        properties: {
          class: 'viirs_only',
          label: EXPLORATORY_LABEL,
          modis_frp_mw: null,
          viirs_frp_sum_mw: usable(o.frp_mw) ? o.frp_mw : null,
          viirs_count: 1,
          rel_diff: null,
          cell_key: null,
          sensor: 'VIIRS',
          footprint_km: fp,
        },
      });
    }
  }

  return {
    type: 'FeatureCollection',
    features,
    label: EXPLORATORY_LABEL,
    method: result.method,
    limitations: result.limitations,
    similarTolerance: tol,
    skippedGeometry: skipped,
  };
}

export { MATCHING_DEFAULTS };

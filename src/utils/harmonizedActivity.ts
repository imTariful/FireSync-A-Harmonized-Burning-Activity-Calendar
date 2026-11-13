/**
 * Harmonized activity index per UTC date (EXPLORATORY).
 *
 * Pure module: no UI, no network, no randomness, no mutation of inputs, clock injected.
 *
 * What it does
 *  - Per UTC date it reports the MODIS count and the VIIRS count SEPARATELY, the number of 1 km cells, and the
 *    harmonized activity index split into its three terms (MODIS term, scaled VIIRS term, FRP term).
 *    The only place the two sensors are mixed is the index itself; no field is a MODIS+VIIRS sum of raw counts.
 *  - The per-cell formula is the one in harmonization.ts (aggregateToSpatialTemporalGrid), re-evaluated with an
 *    adjustable VIIRS scale. A test pins this module to harmonization.ts at the default scale, so the two cannot
 *    drift apart silently. harmonization.ts itself is not changed and still uses the fixed constant.
 *  - The scale is NOT validated (see reports/evidence/*). The empirical hint below is a conditional descriptive
 *    statistic of the current view, not a calibration factor.
 *  - Partial UTC dates are excluded by default, with the same rule (classifyDates) as the Harmonize panel.
 *
 * Not supported by harmonization.ts, therefore fixed and NOT adjustable here: day bucketing (always the UTC
 * date) and the cell weights / FRP coefficients (0.5, 0.5, 0.005 for mixed cells; 1 and 0.004 for single-sensor
 * cells). Grid size IS a parameter of aggregateToSpatialTemporalGrid, so it is adjustable.
 */

import type { CanonicalObservation, SatelliteType } from '../types/fire';
import { HARMONIZATION_CONSTANTS, aggregateToSpatialTemporalGrid } from './harmonization';
import { EXPLORATORY_LABEL, classifyDates, separateInputs, utcDateOf, type DateCompleteness } from './harmonizeView';
import type { MatchedCell } from './matching';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The constant the archive pages use (1 / 3.4). Read from harmonization.ts, never copied. */
export const VIIRS_SCALE_DEFAULT: number = HARMONIZATION_CONSTANTS.VIIRS_COUNT_SCALE_FACTOR;

/** Slider range for the adjustable scale. */
export const VIIRS_SCALE_LIMITS = Object.freeze({ min: 0.1, max: 1.0, step: 0.01 });

/** Grid sizes offered for the (supported) cellSizeKm parameter. */
export const CELL_SIZE_OPTIONS_KM: readonly number[] = Object.freeze([0.5, 1, 2]);
export const CELL_SIZE_DEFAULT_KM = 1;

/**
 * Cell weights and FRP coefficients exactly as written in harmonization.ts (they are inline literals there, not
 * exported). harmonizedActivity.test.ts compares this module with harmonization.ts at the default scale.
 */
export const INDEX_WEIGHTS = Object.freeze({
  mixed: Object.freeze({ modis: 0.5, viirs: 0.5, frp: 0.005 }),
  modisOnly: Object.freeze({ modis: 1, viirs: 0, frp: 0.004 }),
  viirsOnly: Object.freeze({ modis: 0, viirs: 1, frp: 0.004 }),
});

/** Below this many shared cells the empirical hint is flagged as a small sample (rule of thumb, not validated). */
export const HINT_MIN_N = 20;

/** Fewer dates than this: the sensitivity check refuses to say anything about the order. */
export const SENSITIVITY_MIN_DATES = 3;

/** Sensitivity grid: a lower value, the default, a higher value, and 1.0 (VIIRS counted like MODIS). */
export const SENSITIVITY_SCALES: readonly { label: SensitivityLabel; scale: number }[] = Object.freeze([
  { label: 'lower' as const, scale: 0.15 },
  { label: 'default' as const, scale: VIIRS_SCALE_DEFAULT },
  { label: 'higher' as const, scale: 0.5 },
  { label: 'one' as const, scale: 1.0 },
]);

export type SensitivityLabel = 'lower' | 'default' | 'higher' | 'one';

const TIE_EPS = 1e-9;
const RANGE_EPS = 1e-9;

export const ACTIVITY_METHOD =
  'Detections are assigned to 1 km equal-area cells (spatial.ts) and to their UTC date. Per cell the index is ' +
  '0.5 × MODIS count + 0.5 × (scale × VIIRS count) + 0.005 × ln(1 + FRP total) when both sensors detected in the cell that day; ' +
  'MODIS count + 0.004 × ln(1 + MODIS FRP) for MODIS-only cells; scale × VIIRS count + 0.004 × ln(1 + VIIRS FRP) for VIIRS-only cells ' +
  '(the same formulas as harmonization.ts). A date’s index is the sum over its cells, shown as three terms. MODIS and VIIRS raw counts are never added together.';

export const ACTIVITY_LIMITATIONS: readonly string[] = Object.freeze([
  'The VIIRS scale (default 0.294 = 1 / 3.4) is a literature ratio, not validated on this data; the term that depends on it is shown separately for that reason.',
  'A MODIS detection weighs 1 in a MODIS-only cell but 0.5 in a cell where VIIRS also detected, so the index of a date depends on how much the two sensors overlap, not only on how much burned.',
  'Detection counts depend on overpass times, scan angle, cloud and smoke; two UTC days are comparable only when both sensors observed them completely.',
  'The index is a relative number for comparing dates inside this view. It is not burned area, fire size, emissions or a count of fires.',
  'Day bucketing (UTC date) and the cell weights are fixed by harmonization.ts and cannot be changed here.',
  'Cells either side of the ±180° meridian are separate cells.',
]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IndexTerms {
  /** MODIS term (MODIS counts, weight 0.5 in shared cells, 1 in MODIS-only cells). */
  modis: number;
  /** VIIRS term = weight × viirsScale × VIIRS counts. This is the part that rests on the scale assumption. */
  viirsScaled: number;
  /** ln(1 + FRP) term. */
  frp: number;
}

export interface ActivityDateRow {
  /** UTC date, YYYY-MM-DD. */
  date: string;
  /** Raw detection counts, kept separate. There is deliberately no total. */
  modisCount: number;
  viirsCount: number;
  /** Cells (not detections) with at least one detection of either sensor / of both sensors. */
  cells: number;
  cellsBoth: number;
  terms: IndexTerms;
  /** Harmonized activity index (EXPLORATORY): sum of the cell indices. */
  index: number;
  /** viirsScaled / index, or null when the index is 0: how much of the number rests on the scale assumption. */
  scaleAssumptionShare: number | null;
  /** True only when includePartial pulled in a partial UTC date. */
  partial: boolean;
}

export interface ScaleHint {
  label: typeof EXPLORATORY_LABEL;
  /** Number of MODIS footprints that contain at least one VIIRS detection (the shared cells). */
  n: number;
  median: number | null;
  q1: number | null;
  q3: number | null;
  iqr: number | null;
  /** 1 / median, or null. NOT a calibration factor. */
  impliedScale: number | null;
  /** True when the implied scale lies inside the slider range. */
  impliedScaleInRange: boolean | null;
  smallN: boolean;
  minN: number;
  basis: string;
  caveats: string[];
}

export interface SensitivityDateRow {
  date: string;
  /** Index at each sensitivity scale (same order as `scales`). */
  values: number[];
  /** Rank at each scale, 1 = highest index; equal values share a rank. */
  ranks: number[];
}

export interface ActivitySensitivity {
  scales: { label: SensitivityLabel; scale: number }[];
  rows: SensitivityDateRow[];
  datesCompared: number;
  /** 'too_few_dates': nothing is claimed about the order. */
  status: 'too_few_dates' | 'order_unchanged' | 'order_changed';
  /** null when status is 'too_few_dates'. */
  orderChanged: boolean | null;
  note: string;
}

export interface ActivityParams {
  viirsScale: number;
  defaultViirsScale: number;
  cellSizeKm: number;
  includePartial: boolean;
  /** Always 'UTC date': harmonization.ts buckets by acq_date and has no day-bucketing parameter. */
  dayBucketing: 'UTC date';
  dayBucketingAdjustable: false;
  weightsAdjustable: false;
}

export interface HarmonizedActivityResult {
  label: typeof EXPLORATORY_LABEL;
  /** 'empty': no usable dated detection; 'no_complete_day': every date is partial and includePartial is off. */
  status: 'ok' | 'empty' | 'no_complete_day';
  todayUtc: string;
  params: ActivityParams;
  rows: ActivityDateRow[];
  /** Partial dates left out (empty with includePartial). */
  excluded: DateCompleteness[];
  /** Partial dates that are part of the numbers (only with includePartial). */
  includedPartial: DateCompleteness[];
  /** Records not used: no UTC date, no valid coordinates, or wrong sensor tag. */
  skipped: number;
  hint: ScaleHint | null;
  sensitivity: ActivitySensitivity;
  warnings: string[];
  method: string;
  limitations: readonly string[];
}

export interface HarmonizedActivityOptions {
  /** Injected clock (Date or epoch ms). Required so callers and tests control "today". */
  now: Date | number;
  /** Include partial UTC dates anyway. Default false. */
  includePartial?: boolean;
  /** Default VIIRS_SCALE_DEFAULT; must be within VIIRS_SCALE_LIMITS, else RangeError. */
  viirsScale?: number;
  /** Default 1. Must be a positive finite number, else RangeError. */
  cellSizeKm?: number;
  /** Same meaning as in the matching options. Omitted = every loaded satellite. */
  modisSatellites?: readonly SatelliteType[];
  viirsSatellites?: readonly SatelliteType[];
  /** MODIS footprints with VIIRS inside (MatchingResult.cell.cells of the current view) for the empirical hint. */
  matchedCells?: readonly MatchedCell[] | null;
  /** Matching time window (minutes), only used to word the hint's basis. */
  matchWindowMinutes?: number;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

export function assertViirsScale(scale: number): void {
  if (
    typeof scale !== 'number' ||
    !Number.isFinite(scale) ||
    scale < VIIRS_SCALE_LIMITS.min - RANGE_EPS ||
    scale > VIIRS_SCALE_LIMITS.max + RANGE_EPS
  ) {
    throw new RangeError(`viirsScale must be a number between ${VIIRS_SCALE_LIMITS.min} and ${VIIRS_SCALE_LIMITS.max}, got ${String(scale)}`);
  }
}

function assertCellSize(km: number): void {
  if (typeof km !== 'number' || !Number.isFinite(km) || km <= 0) {
    throw new RangeError(`cellSizeKm must be a positive finite number, got ${String(km)}`);
  }
}

// ---------------------------------------------------------------------------
// Core: per-cell terms, summed per date
// ---------------------------------------------------------------------------

interface CellCounts {
  date: string;
  m: number;
  v: number;
  frpTotal: number;
  frpModis: number;
  frpViirs: number;
}

interface DateAccumulator {
  modisCount: number;
  viirsCount: number;
  cells: number;
  cellsBoth: number;
  list: CellCounts[];
}

/** Terms of one cell, following harmonization.ts. */
function cellTerms(c: CellCounts, scale: number): IndexTerms {
  if (c.m > 0 && c.v > 0) {
    const w = INDEX_WEIGHTS.mixed;
    return { modis: w.modis * c.m, viirsScaled: w.viirs * scale * c.v, frp: w.frp * Math.log1p(c.frpTotal) };
  }
  if (c.m > 0) {
    const w = INDEX_WEIGHTS.modisOnly;
    return { modis: w.modis * c.m, viirsScaled: 0, frp: w.frp * Math.log1p(c.frpModis) };
  }
  const w = INDEX_WEIGHTS.viirsOnly;
  return { modis: 0, viirsScaled: w.viirs * scale * c.v, frp: w.frp * Math.log1p(c.frpViirs) };
}

/** The cell index as ONE expression (independent of cellTerms), so a test can check that the terms add up to it. */
function cellIndex(c: CellCounts, scale: number): number {
  if (c.m > 0 && c.v > 0) return 0.5 * c.m + 0.5 * (c.v * scale) + 0.005 * Math.log1p(c.frpTotal);
  if (c.m > 0) return c.m + 0.004 * Math.log1p(c.frpModis);
  return c.v * scale + 0.004 * Math.log1p(c.frpViirs);
}

function safeFrp(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

function round(v: number, digits = 4): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

function rowsAt(acc: Map<string, DateAccumulator>, scale: number, partialDates: ReadonlySet<string>): ActivityDateRow[] {
  const rows: ActivityDateRow[] = [];
  for (const [date, a] of acc) {
    const terms: IndexTerms = { modis: 0, viirsScaled: 0, frp: 0 };
    let index = 0;
    for (const c of a.list) {
      const t = cellTerms(c, scale);
      terms.modis += t.modis;
      terms.viirsScaled += t.viirsScaled;
      terms.frp += t.frp;
      index += cellIndex(c, scale);
    }
    rows.push({
      date,
      modisCount: a.modisCount,
      viirsCount: a.viirsCount,
      cells: a.cells,
      cellsBoth: a.cellsBoth,
      terms,
      index,
      scaleAssumptionShare: index > 0 ? terms.viirsScaled / index : null,
      partial: partialDates.has(date),
    });
  }
  return rows.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Empirical scale hint (conditional, descriptive)
// ---------------------------------------------------------------------------

/** Quantile with linear interpolation between order statistics (sorted ascending, non-empty). */
function quantileSorted(sorted: readonly number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Median and IQR of VIIRS detections per MODIS footprint, among footprints that contain at least one VIIRS
 * detection (the matching cell level), and the implied scale 1 / median.
 *
 * This is conditional on shared cells and on the window of the current view. It is not a calibration factor:
 * footprints with no VIIRS are not in the sample, and the VIIRS-to-MODIS detection ratio over the whole view
 * is a different quantity.
 */
export function empiricalScaleHint(cells: readonly MatchedCell[] | null | undefined, windowMinutes?: number): ScaleHint {
  const counts = (cells ?? [])
    .map((c) => c?.viirsCount)
    .filter((x): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 1)
    .sort((a, b) => a - b);
  const n = counts.length;
  const windowText = typeof windowMinutes === 'number' && Number.isFinite(windowMinutes) ? ` (±${windowMinutes} min matching window)` : '';
  const basis =
    `Median and IQR of VIIRS detections per MODIS footprint, among the ${n} footprint(s) that contain at least one VIIRS detection${windowText}, ` +
    'complete UTC days only unless partial days are included. Implied scale = 1 ÷ median.';
  const caveats = [
    'Conditional on shared cells and on this window: MODIS footprints with no VIIRS inside are not counted, so the median cannot be below 1.',
    'Not a calibration factor and not the same quantity as the overall VIIRS ÷ MODIS detection ratio.',
    'Depends on the overpass times of the loaded satellites and on where and when fires burned.',
  ];
  const smallN = n < HINT_MIN_N;
  if (smallN) caveats.unshift(`Small sample (n = ${n} < ${HINT_MIN_N}): treat as anecdotal.`);
  if (n === 0) {
    return { label: EXPLORATORY_LABEL, n, median: null, q1: null, q3: null, iqr: null, impliedScale: null, impliedScaleInRange: null, smallN, minN: HINT_MIN_N, basis, caveats };
  }
  const median = quantileSorted(counts, 0.5);
  const q1 = quantileSorted(counts, 0.25);
  const q3 = quantileSorted(counts, 0.75);
  const impliedScale = 1 / median;
  const impliedScaleInRange = impliedScale >= VIIRS_SCALE_LIMITS.min - RANGE_EPS && impliedScale <= VIIRS_SCALE_LIMITS.max + RANGE_EPS;
  if (!impliedScaleInRange) caveats.push(`The implied scale ${round(impliedScale, 3)} is outside the slider range ${VIIRS_SCALE_LIMITS.min} to ${VIIRS_SCALE_LIMITS.max}.`);
  return { label: EXPLORATORY_LABEL, n, median, q1, q3, iqr: q3 - q1, impliedScale, impliedScaleInRange, smallN, minN: HINT_MIN_N, basis, caveats };
}

// ---------------------------------------------------------------------------
// Sensitivity of the date order
// ---------------------------------------------------------------------------

function ranksOf(values: readonly number[]): number[] {
  return values.map((v) => 1 + values.filter((w) => w > v + TIE_EPS).length);
}

function sensitivityOf(acc: Map<string, DateAccumulator>, partialDates: ReadonlySet<string>): ActivitySensitivity {
  const scales = SENSITIVITY_SCALES.map((s) => ({ label: s.label, scale: s.scale }));
  const perScale = scales.map((s) => rowsAt(acc, s.scale, partialDates));
  const dates = perScale[0].map((r) => r.date);
  const rankSets = perScale.map((rows) => ranksOf(rows.map((r) => r.index)));
  const rows: SensitivityDateRow[] = dates.map((date, i) => ({
    date,
    values: perScale.map((rs) => rs[i].index),
    ranks: rankSets.map((rk) => rk[i]),
  }));
  const defaultIdx = scales.findIndex((s) => s.label === 'default');
  const datesCompared = dates.length;

  if (datesCompared < SENSITIVITY_MIN_DATES) {
    return {
      scales,
      rows,
      datesCompared,
      status: 'too_few_dates',
      orderChanged: null,
      note: `Only ${datesCompared} date(s) in view; at least ${SENSITIVITY_MIN_DATES} are needed before the order of dates says anything. No claim is made about the order.`,
    };
  }
  const changed = rankSets.some((rk) => rk.some((r, i) => r !== rankSets[defaultIdx][i]));
  return {
    scales,
    rows,
    datesCompared,
    status: changed ? 'order_changed' : 'order_unchanged',
    orderChanged: changed,
    note: changed
      ? 'The order of the dates changes with the VIIRS scale: which date looks most active depends on the scale assumption, which is not validated.'
      : `The order of the ${datesCompared} dates is the same at every scale tested. This says the ranking is not sensitive to the scale here; it does not validate the scale.`,
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function computeHarmonizedActivity(
  modis: readonly CanonicalObservation[],
  viirs: readonly CanonicalObservation[],
  opts: HarmonizedActivityOptions
): HarmonizedActivityResult {
  const includePartial = opts.includePartial ?? false;
  const viirsScale = opts.viirsScale ?? VIIRS_SCALE_DEFAULT;
  const cellSizeKm = opts.cellSizeKm ?? CELL_SIZE_DEFAULT_KM;
  assertViirsScale(viirsScale);
  assertCellSize(cellSizeKm);

  const params: ActivityParams = {
    viirsScale,
    defaultViirsScale: VIIRS_SCALE_DEFAULT,
    cellSizeKm,
    includePartial,
    dayBucketing: 'UTC date',
    dayBucketingAdjustable: false,
    weightsAdjustable: false,
  };

  const sep = separateInputs(modis, viirs);
  const satOk = (o: CanonicalObservation, allow?: readonly SatelliteType[]) => !allow || allow.includes(o.satellite);
  const m0 = sep.modis.filter((o) => satOk(o, opts.modisSatellites));
  const v0 = sep.viirs.filter((o) => satOk(o, opts.viirsSatellites));

  const { dates, todayUtc } = classifyDates(m0, v0, opts.now);
  const partial = dates.filter((d) => d.partial);
  const complete = dates.filter((d) => !d.partial);
  const partialSet = new Set(partial.map((d) => d.date));
  const includedPartialSet = includePartial ? partialSet : new Set<string>();

  const hint = opts.matchedCells ? empiricalScaleHint(opts.matchedCells, opts.matchWindowMinutes) : null;
  const method = ACTIVITY_METHOD;
  const limitations = ACTIVITY_LIMITATIONS;
  const emptyAcc = new Map<string, DateAccumulator>();

  const base = {
    label: EXPLORATORY_LABEL,
    todayUtc,
    params,
    hint,
    method,
    limitations,
  } as const;

  if (!includePartial && dates.length > 0 && complete.length === 0) {
    return {
      ...base,
      status: 'no_complete_day',
      rows: [],
      excluded: partial,
      includedPartial: [],
      skipped: sep.mismatched,
      sensitivity: sensitivityOf(emptyAcc, includedPartialSet),
      warnings: ['Every UTC date in view is partial, so no index is shown. Pick a range with at least one finished day.'],
    };
  }

  // Re-bucket by UTC date (copies; inputs untouched) and aggregate with harmonization.ts.
  let skipped = sep.mismatched;
  const prepared: CanonicalObservation[] = [];
  for (const o of [...m0, ...v0]) {
    const d = utcDateOf(o);
    const ok = d !== null && Number.isFinite(o.latitude) && Number.isFinite(o.longitude) && Math.abs(o.latitude) <= 90;
    if (!ok || (!includePartial && partialSet.has(d))) {
      if (!ok) skipped++;
      continue;
    }
    prepared.push({ ...o, acq_date: d, frp_mw: safeFrp(o.frp_mw) });
  }

  const cellMap = aggregateToSpatialTemporalGrid(prepared, cellSizeKm);
  const acc = new Map<string, DateAccumulator>();
  for (const cell of cellMap.values()) {
    let a = acc.get(cell.date);
    if (!a) acc.set(cell.date, (a = { modisCount: 0, viirsCount: 0, cells: 0, cellsBoth: 0, list: [] }));
    a.modisCount += cell.modis_count;
    a.viirsCount += cell.viirs_count;
    a.cells += 1;
    if (cell.modis_count > 0 && cell.viirs_count > 0) a.cellsBoth += 1;
    a.list.push({
      date: cell.date,
      m: cell.modis_count,
      v: cell.viirs_count,
      frpTotal: cell.total_frp_sum,
      frpModis: cell.modis_frp_sum,
      frpViirs: cell.viirs_frp_sum,
    });
  }

  const rows = rowsAt(acc, viirsScale, includedPartialSet);
  const warnings: string[] = [];
  if (includePartial && partial.length > 0) {
    warnings.push(
      `Partial UTC day(s) are INCLUDED: ${partial.map((d) => `${d.date} (MODIS ${d.modis}, VIIRS ${d.viirs})`).join('; ')}. Their indices compare unequal observation windows; do not quote them.`
    );
  }
  if (skipped > 0) warnings.push(`${skipped} record(s) were not used (no UTC date, invalid coordinates or wrong sensor tag).`);

  return {
    ...base,
    status: rows.length === 0 ? 'empty' : 'ok',
    rows,
    excluded: includePartial ? [] : partial,
    includedPartial: includePartial ? partial : [],
    skipped,
    sensitivity: sensitivityOf(acc, includedPartialSet),
    warnings,
  };
}

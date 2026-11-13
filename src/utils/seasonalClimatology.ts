/**
 * Seasonal climatology helpers (pure functions, no I/O).
 *
 * Everything here describes what was TYPICAL in the 2000-2025 historical archive.
 * Nothing in this module predicts, forecasts or claims future fire activity;
 * "activity_class" is a relative label for a calendar month's historical median,
 * not a warning about a specific future date.
 */

import { HARMONIZATION_CONSTANTS } from './harmonization';
import { computeMedian } from './anomaly';

export type ActivityClass = 'low' | 'typical' | 'elevated' | 'high' | 'unavailable';

export interface MonthlyClimatology {
  /** Calendar month 1-12. */
  month: number;
  /** Per-sensor statistics; sensors are never merged. */
  sensors: Record<
    string,
    {
      median_detections: number;
      p25_detections: number;
      p75_detections: number;
      years_with_data: number;
      years_total: number;
      median_frp_sum_mw: number | null;
    }
  >;
  /**
   * MODIS + 0.294 * VIIRS monthly medians — the fixed EXPLORATORY harmonization
   * coefficient applied to climatological medians. Not a validated calibration.
   */
  harmonized_equivalent_median: number | null;
  activity_class: ActivityClass;
}

export interface SeasonSummary {
  /** Up to 3 calendar months with the highest median detections. */
  peak_months: number[];
  /** Up to 3 calendar months with the lowest nonzero median detections. */
  low_months: number[];
}

/** Linear-interpolation quantile (same convention as common spreadsheet PERCENTILE). */
export function quantile(sortedValues: number[], q: number): number {
  if (!sortedValues.length) return 0;
  const pos = (sortedValues.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const next = sortedValues[base + 1];
  if (next === undefined) return sortedValues[base];
  return sortedValues[base] + rest * (next - sortedValues[base]);
}

export interface ActivityThresholds {
  q1: number;
  q2: number;
  q3: number;
}

/**
 * Quartile thresholds across the 12 monthly median values of ONE scope
 * (country or bbox, harmonized-equivalent or a single sensor).
 * Deterministic: same input always yields the same classes.
 */
export function activityThresholds(monthlyMedians: number[]): ActivityThresholds {
  const sorted = monthlyMedians.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return { q1: 0, q2: 0, q3: 0 };
  return {
    q1: quantile(sorted, 0.25),
    q2: quantile(sorted, 0.5),
    q3: quantile(sorted, 0.75),
  };
}

/**
 * Classify a month's typical activity relative to the scope's own seasonal range.
 * Uses the harmonized-equivalent (or per-sensor) median so MODIS/VIIRS are never summed raw.
 * F26 fix: null/missing values are classified as 'unavailable', not 'low'.
 */
export function classifyActivity(value: number | null, t: ActivityThresholds): ActivityClass {
  if (value === null || !Number.isFinite(value)) return 'unavailable';
  if (value <= 0) return 'low';
  if (t.q3 > t.q1) {
    if (value > t.q3) return 'high';
    if (value > t.q2) return 'elevated';
    if (value > t.q1) return 'typical';
    return 'low';
  }
  // Degenerate range (e.g. only one active month or all zeros): only a strictly
  // positive value above the flat level counts as elevated.
  if (value > t.q2 && t.q2 > 0) return 'elevated';
  return value > 0 ? 'typical' : 'low';
}

/**
 * EXPLORATORY harmonized equivalent of two sensor counts using the fixed
 * literature coefficient. This is NOT a validated calibration and the result
 * must always be labelled EXPLORATORY.
 */
export function harmonizedEquivalent(modis: number, viirs: number): number {
  return modis + HARMONIZATION_CONSTANTS.VIIRS_COUNT_SCALE_FACTOR * viirs;
}

/** Peak/low months from monthly climatology rows (uses harmonized-equivalent median).
 * F26 fix: exclude months with null/unavailable baseline from both peak and low rankings.
 */
export function seasonSummary(months: MonthlyClimatology[]): SeasonSummary {
  // Only include months with actual observed data for ranking.
  const scored = months
    .filter((m) => m.harmonized_equivalent_median !== null && Number.isFinite(m.harmonized_equivalent_median!))
    .map((m) => ({ month: m.month, value: m.harmonized_equivalent_median! }))
    .sort((a, b) => b.value - a.value || a.month - b.month);
  const peak = scored.filter((m) => m.value > 0).slice(0, 3).map((m) => m.month);
  const peakSet = new Set(peak);
  const low = scored
    .filter((m) => !peakSet.has(m.month))
    .slice()
    .sort((a, b) => a.value - b.value || a.month - b.month)
    .slice(0, 3)
    .map((m) => m.month);
  return { peak_months: peak, low_months: low };
}

export type PeriodStatus =
  | 'well_below_typical'
  | 'below_typical'
  | 'within_typical'
  | 'above_typical'
  | 'well_above_typical'
  | 'insufficient_baseline';

/**
 * Compare an observed value (e.g. live detections in the current period) against the
 * climatological median and quartiles for the same calendar period.
 * This is a "current vs typical" descriptor — NOT a forecast and NOT a validated anomaly.
 */
export function classifyVsClimatology(
  observed: number,
  median: number,
  p25: number,
  p75: number,
  yearsWithData: number,
  minYears = 5
): PeriodStatus {
  if (yearsWithData < minYears) return 'insufficient_baseline';
  const iqr = p75 - p25;
  if (iqr <= 0) {
    if (observed === median) return 'within_typical';
    return observed > median ? 'above_typical' : 'below_typical';
  }
  if (observed > p75 + 1.5 * iqr) return 'well_above_typical';
  if (observed > p75) return 'above_typical';
  if (observed < p25 - 1.5 * iqr) return 'well_below_typical';
  if (observed < p25) return 'below_typical';
  return 'within_typical';
}

/** Day-of-year window (inclusive, wraps around year end) centred on `doy`. */
export function doyWindow(doy: number, radiusDays: number, yearLength = 365): { start: number; end: number } {
  const clamp = (d: number) => ((d - 1 + yearLength) % yearLength) + 1;
  return { start: clamp(doy - radiusDays), end: clamp(doy + radiusDays) };
}

/** True when `doy` falls inside a possibly year-wrapping window. */
export function doyInWindow(doy: number, start: number, end: number, yearLength = 365): boolean {
  if (start <= end) return doy >= start && doy <= end;
  return doy >= start || doy <= end;
}

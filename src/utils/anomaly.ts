/**
 * Historical Baseline and Anomaly Detection for FireSync.
 * 
 * Implements non-parametric seasonal medians and Median Absolute Deviation (MAD)
 * for robust historical activity anomaly scoring without assuming normal distributions.
 * 
 * Note: Anomalies indicate statistically unusual historical activity, NOT fire forecasts.
 */

import { DailyActivitySummary } from '../types/fire';

export interface BaselineStatistics {
  median: number;
  mad: number;
  sampleCount: number;
  isSufficient: boolean;
}

/**
 * Computes the median of a numerical array.
 */
export function computeMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

/**
 * Computes Median Absolute Deviation (MAD) of a numerical array.
 */
export function computeMAD(values: number[], median?: number): number {
  if (values.length === 0) return 0;
  const med = median !== undefined ? median : computeMedian(values);
  const deviations = values.map((v) => Math.abs(v - med));
  return computeMedian(deviations);
}

/**
 * Computes the robust Z-score using median and MAD (scaled by 1.4826 for asymptotic normality consistency).
 */
export function computeRobustZScore(
  observed: number,
  median: number,
  mad: number
): number {
  if (mad === 0) {
    // If MAD is zero (e.g. historical values are identical or zero), check if observed differs
    if (observed === median) return 0;
    // Small pseudo-variance regularizer
    return Number(((observed - median) / 1.0).toFixed(2));
  }
  const consistencyFactor = 1.4826;
  const score = (observed - median) / (consistencyFactor * mad);
  return Number(score.toFixed(2));
}

/**
 * Categorizes an anomaly score into scientific activity levels.
 */
export function categorizeAnomaly(
  zScore: number,
  isSufficientData: boolean
): 'normal' | 'moderate_anomaly' | 'high_anomaly' | 'extreme_anomaly' | 'insufficient_data' {
  if (!isSufficientData) return 'insufficient_data';
  if (zScore >= 3.5) return 'extreme_anomaly';
  if (zScore >= 2.5) return 'high_anomaly';
  if (zScore >= 1.5) return 'moderate_anomaly';
  return 'normal';
}

/** Minimum number of OTHER calendar years a month needs before its baseline is trusted. */
export const MIN_BASELINE_YEARS = 3;

/**
 * Modified z-score for a value against a set of historical values (Iglewicz & Hoaglin).
 * Uses median/MAD; when MAD is 0 (very common for sparse fire counts) it falls back to
 * 1.2533 x the mean absolute deviation instead of treating the raw difference as a z-score.
 * Returns null when the history has no variability at all (no meaningful scale).
 */
export function computeModifiedZScore(observed: number, history: number[]): number | null {
  if (history.length === 0) return null;
  const med = computeMedian(history);
  const mad = computeMAD(history, med);
  if (mad > 0) {
    return Number(((observed - med) / (1.4826 * mad)).toFixed(2));
  }
  const meanAd = history.reduce((s, v) => s + Math.abs(v - med), 0) / history.length;
  if (meanAd === 0) return null;
  return Number(((observed - med) / (1.253314 * meanAd)).toFixed(2));
}

export interface BaselineOptions {
  /** Today (UTC, YYYY-MM-DD). Days after it are never scored and never used as history. */
  today?: string;
  /** Minimum number of other years of history per month. */
  minYears?: number;
}

/**
 * Annotates daily summaries with a seasonal baseline and an anomaly score.
 *
 * Baseline for a day = the same calendar month in OTHER years only (a day, and the rest of its
 * own year, never take part in its own baseline), never using future days. A month with fewer
 * than `minYears` other years of history is reported as `insufficient_data`, not as "normal".
 *
 * Caveat: the caller passes only dates with observations; an absent date is unknown
 * coverage, not zero fire. Per-day observation opportunity is still unavailable, so a
 * day with no detection but a valid overpass cannot be distinguished from no coverage.
 */
export function applyHistoricalBaselines(
  dailySummaries: DailyActivitySummary[],
  historicalSummaries: DailyActivitySummary[],
  options: BaselineOptions = {}
): DailyActivitySummary[] {
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const minYears = options.minYears ?? MIN_BASELINE_YEARS;

  // month -> year -> values (past days only)
  const byMonthYear = new Map<number, Map<number, number[]>>();
  for (const h of historicalSummaries) {
    if (h.date > today) continue;
    let years = byMonthYear.get(h.month);
    if (!years) {
      years = new Map();
      byMonthYear.set(h.month, years);
    }
    let list = years.get(h.year);
    if (!list) {
      list = [];
      years.set(h.year, list);
    }
    list.push(h.harmonized_activity_units);
  }

  const cache = new Map<string, { values: number[]; years: number; median: number; mad: number }>();
  const baselineFor = (month: number, excludeYear: number) => {
    const key = `${month}|${excludeYear}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const values: number[] = [];
    let years = 0;
    for (const [y, list] of byMonthYear.get(month) ?? []) {
      if (y === excludeYear) continue;
      years += 1;
      values.push(...list);
    }
    const median = values.length ? Number(computeMedian(values).toFixed(2)) : 0;
    const mad = values.length ? Number(computeMAD(values, median).toFixed(2)) : 0;
    const out = { values, years, median, mad };
    cache.set(key, out);
    return out;
  };

  return dailySummaries.map((day) => {
    const base = baselineFor(day.month, day.year);
    const scoreable = day.date <= today && base.years >= minYears;
    const z = scoreable ? computeModifiedZScore(day.harmonized_activity_units, base.values) : null;
    if (z === null) {
      return {
        ...day,
        historical_baseline_median: base.median,
        historical_baseline_mad: base.mad,
        anomaly_score: 0,
        anomaly_category: 'insufficient_data' as const,
      };
    }
    return {
      ...day,
      historical_baseline_median: base.median,
      historical_baseline_mad: base.mad,
      anomaly_score: z,
      anomaly_category: categorizeAnomaly(z, true),
    };
  });
}

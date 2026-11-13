/**
 * Calendar statistics for the burning-activity calendar (pure functions, no UI).
 *
 * The colour value is the HARMONIZED activity (BAU), never MODIS + VIIRS raw counts added together.
 * Raw per-sensor counts are carried along separately so they can be shown next to it.
 */
import { DailyActivitySummary } from '../types/fire';
import { computeMedian } from './anomaly';

export interface MonthCell {
  year: number;
  month: number;
  harmonized: number;
  modis: number;
  viirs: number;
  activeDays: number;
}

export interface MonthYearMatrix {
  years: number[];
  cells: Map<string, MonthCell>;
  /** Largest harmonized value of any month (0 when there is no activity). */
  max: number;
}

export const monthKey = (year: number, month: number) => `${year}-${month}`;

export function buildMonthYearMatrix(daily: DailyActivitySummary[], today?: string): MonthYearMatrix {
  const cutoff = today ?? new Date().toISOString().slice(0, 10);
  const cells = new Map<string, MonthCell>();
  const years = new Set<number>();
  for (const d of daily) {
    if (d.date > cutoff) continue;
    years.add(d.year);
    const key = monthKey(d.year, d.month);
    let c = cells.get(key);
    if (!c) {
      c = { year: d.year, month: d.month, harmonized: 0, modis: 0, viirs: 0, activeDays: 0 };
      cells.set(key, c);
    }
    c.harmonized += d.harmonized_activity_units;
    c.modis += d.modis_detections;
    c.viirs += d.viirs_detections;
    if (d.total_raw_detections > 0) c.activeDays += 1;
  }
  let max = 0;
  for (const c of cells.values()) {
    c.harmonized = Number(c.harmonized.toFixed(2));
    if (c.harmonized > max) max = c.harmonized;
  }
  return { years: [...years].sort((a, b) => a - b), cells, max };
}

export interface MonthComparison {
  year: number;
  month: number;
  /** Days of the month that have elapsed (month-to-date window used for both sides). */
  throughDay: number;
  current: number | null;
  /** Median of the same window in other years. */
  historicalMedian: number | null;
  yearsUsed: number;
  /** current relative to the median, in percent; null when the median is 0 or missing. */
  pctVsMedian: number | null;
  status: 'ok' | 'insufficient_history' | 'no_current_data';
}

/**
 * Compares month-to-date harmonized activity with the same days (1..throughDay) of the same
 * month in every OTHER year. Needs at least `minYears` other years, otherwise `insufficient_history`.
 */
export function compareMonthToHistory(
  daily: DailyActivitySummary[],
  today: string,
  minYears = 3
): MonthComparison {
  const [ty, tm, td] = today.split('-').map(Number);
  const perYear = new Map<number, number>();
  for (const d of daily) {
    if (d.month !== tm || d.date > today || d.day > td) continue;
    perYear.set(d.year, (perYear.get(d.year) ?? 0) + d.harmonized_activity_units);
  }
  // F25 fix: treat missing current-year data as genuinely absent, NOT as zero.
  // A missing entry means no observations were loaded for this year/month, not that
  // there was no fire activity.
  const hasCurrent = perYear.has(ty);
  if (!hasCurrent) {
    return {
      year: ty, month: tm, throughDay: td, current: null,
      historicalMedian: null, yearsUsed: 0, pctVsMedian: null,
      status: 'no_current_data',
    };
  }
  const current = Number((perYear.get(ty)!).toFixed(2));
  const others = [...perYear.entries()].filter(([y]) => y !== ty).map(([, v]) => v);
  if (others.length < minYears) {
    return {
      year: ty, month: tm, throughDay: td, current, historicalMedian: null,
      yearsUsed: others.length, pctVsMedian: null, status: 'insufficient_history',
    };
  }
  const median = Number(computeMedian(others).toFixed(2));
  return {
    year: ty, month: tm, throughDay: td, current, historicalMedian: median,
    yearsUsed: others.length,
    pctVsMedian: median > 0 ? Number((((current - median) / median) * 100).toFixed(0)) : null,
    status: 'ok',
  };
}

/** Sequential colour ramp (viridis stops: colour-blind safe, monotonic lightness). */
export const RAMP = ['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725'] as const;

/** 0 = no activity; 1..5 = ramp step. Linear in value / max. */
export function rampStep(value: number, max: number): 0 | 1 | 2 | 3 | 4 | 5 {
  if (!(value > 0) || !(max > 0)) return 0;
  const f = value / max;
  if (f > 0.8) return 5;
  if (f > 0.6) return 4;
  if (f > 0.4) return 3;
  if (f > 0.2) return 2;
  return 1;
}

/** Text colour that keeps >= 4.5:1 contrast on the given ramp step. */
export function textOnStep(step: 0 | 1 | 2 | 3 | 4 | 5): 'light' | 'dark' {
  return step >= 3 ? 'dark' : 'light';
}

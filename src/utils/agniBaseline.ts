/** Descriptive same-layer/month comparisons; sparse observations are not exposure. */
export interface BaselineMonth {
  year: number;
  month: number;
  detections: number | null;
  partial_coverage: boolean;
  population_key?: string;
}

export interface AgniComparison {
  year: number;
  month: number;
  observed: number | null;
  baseline_median: number | null;
  baseline_years: number[];
  valid_years: number;
  percentile: number | null;
  ratio: number | null;
  status: 'unknown' | 'partial_coverage' | 'insufficient_history' | 'within_historical_range' | 'unusually_high' | 'unusually_low';
}

export function compareAgniMonth(rows: readonly BaselineMonth[], year: number, month: number): AgniComparison {
  const target = rows.find((r) => r.year === year && r.month === month);
  const history = rows.filter((r) => r.year !== year && r.month === month && !r.partial_coverage && r.detections != null && Number.isFinite(r.detections) && r.population_key === target?.population_key);
  const years = [...new Set(history.map((r) => r.year))].sort((a, b) => a - b);
  // Duplicate year/month rows are ambiguous, not independent historical samples.
  const valid = history.length === years.length;
  const out: AgniComparison = { year, month, observed: target?.detections ?? null, baseline_median: null, baseline_years: years, valid_years: valid ? years.length : 0, percentile: null, ratio: null, status: 'unknown' };
  if (out.observed == null || !Number.isFinite(out.observed)) return out;
  if (target?.partial_coverage) return { ...out, status: 'partial_coverage' };
  if (!valid || years.length < 5) return { ...out, status: 'insufficient_history' };
  const values = history.map((r) => r.detections!).sort((a, b) => a - b);
  const mid = Math.floor(values.length / 2);
  out.baseline_median = values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
  const lower = values.filter((v) => v < out.observed!).length;
  const tied = values.filter((v) => v === out.observed).length;
  out.percentile = 100 * (lower + tied / 2) / values.length;
  out.ratio = out.baseline_median > 0 ? out.observed / out.baseline_median : null;
  out.status = out.percentile >= 95 ? 'unusually_high' : out.percentile <= 5 ? 'unusually_low' : 'within_historical_range';
  return out;
}

export function agniSeason(rows: readonly BaselineMonth[], targetYear: number) {
  const months = Array.from({ length: 12 }, (_, i) => {
    const month = i + 1;
    // A virtual target enables the same sample rules without including targetYear.
    const population_key = rows.find((r) => r.year === targetYear && r.month === month)?.population_key;
    const comparison = compareAgniMonth([...rows.filter((r) => r.year !== targetYear), { year: targetYear, month, detections: 0, partial_coverage: false, population_key }], targetYear, month);
    return { month, median: comparison.baseline_median, valid_years: comparison.valid_years, baseline_years: comparison.baseline_years };
  });
  const ranked = months.filter((m) => m.median != null).sort((a, b) => b.median! - a.median!);
  return { months, peak_months: ranked.slice(0, 3).map((m) => m.month) };
}

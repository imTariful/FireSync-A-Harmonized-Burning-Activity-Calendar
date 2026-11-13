import type { DailyActivitySummary } from '../types/fire';
import type { AgniMonthRow } from '../api/agnicalendar';

export interface VisualPoint { key: string; label: string; values: Record<string, number | null>; note?: string }
export interface VisualSeries { key: string; label: string; color: string }
export interface VisualMetric { key: string; label: string; unit: string; series: VisualSeries[]; note: string }
type DailyVisualRow = { [K in keyof Pick<DailyActivitySummary, 'date' | 'modis_detections' | 'viirs_detections' | 'modis_frp_mw' | 'viirs_frp_mw' | 'harmonized_activity_units'>]: K extends 'date' ? string : number | null };

export function availableValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Per-sensor heat scale: null stays unpainted, measured zero remains a faint solid stripe. */
export function sensorHeatOpacity(value: number | null, maximum: number): number {
  if (availableValue(value) === null) return 0;
  return value === 0 || maximum <= 0 ? 0.08 : Math.min(0.95, 0.15 + 0.8 * Math.min(1, value! / maximum));
}

/** Unavailable gaps in a daily input series stay null. Never interpolate observations. */
export function dailyVisualPoints(rows: DailyVisualRow[]): VisualPoint[] {
  const days = new Map(rows.filter((r) => {
    const time = Date.parse(`${r.date}T00:00:00Z`);
    return /^\d{4}-\d{2}-\d{2}$/.test(r.date) && Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === r.date;
  }).map((r) => [r.date, r]));
  const keys = [...days.keys()].sort();
  if (!keys.length) return [];
  const output: VisualPoint[] = [];
  const end = Date.parse(`${keys.at(-1)}T00:00:00Z`);
  for (let time = Date.parse(`${keys[0]}T00:00:00Z`); time <= end; time += 86400000) {
    const key = new Date(time).toISOString().slice(0, 10), row = days.get(key);
    output.push({ key, label: key, values: {
      modis: availableValue(row?.modis_detections), viirs: availableValue(row?.viirs_detections),
      modisFrp: availableValue(row?.modis_frp_mw), viirsFrp: availableValue(row?.viirs_frp_mw), bau: availableValue(row?.harmonized_activity_units),
    }, note: row ? undefined : 'No observation record for this date; not a zero-fire day.' });
  }
  return output;
}

/** Twelve UTC months; missing values stay null. Monthly input stays monthly. */
export function monthlyVisualPoints(rows: AgniMonthRow[], year: number): VisualPoint[] {
  const months = new Map(rows.filter((r) => r.year === year).map((r) => [r.month, r]));
  return Array.from({ length: 12 }, (_, i) => {
    const row = months.get(i + 1), key = `${year}-${String(i + 1).padStart(2, '0')}`;
    return { key, label: key, values: { activity: availableValue(row?.detections), frp: availableValue(row?.frp_sum_mw), cells: availableValue(row?.cells_with_data) },
      note: row?.partial_coverage ? 'Partial source coverage: interpret comparisons cautiously.' : !row ? 'No monthly record; unavailable, not zero activity.' : undefined };
  });
}

export function chartMaximum(points: VisualPoint[], keys: string[]): number {
  const max = points.reduce((best, p) => keys.reduce((n, key) => Math.max(n, availableValue(p.values[key]) ?? 0), best), 0);
  if (!max) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(max));
  return Math.ceil(max / magnitude) * magnitude;
}

/** Nulls break the line instead of implying measured zero or interpolation across gaps. */
export function chartLine(values: (number | null)[], max: number, width: number, height: number): string {
  let connected = false;
  return values.map((value, i) => {
    if (availableValue(value) === null) { connected = false; return ''; }
    const x = values.length === 1 ? width / 2 : i * width / (values.length - 1);
    const y = height - value! / max * height;
    const command = `${connected ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`;
    connected = true;
    return command;
  }).filter(Boolean).join(' ');
}

export function rankedPeriods(points: VisualPoint[], series: string): VisualPoint[] {
  return points.filter((p) => availableValue(p.values[series]) !== null)
    .sort((a, b) => b.values[series]! - a.values[series]! || a.key.localeCompare(b.key)).slice(0, 5);
}

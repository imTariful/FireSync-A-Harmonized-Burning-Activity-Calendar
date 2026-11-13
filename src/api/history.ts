/**
 * Browser client for the local historical FIRMS archive (`/api/v1/history/*`).
 * All dates are real archive dates (MODIS from 2000-11-01, VIIRS S-NPP from 2012-01-20);
 * the live 5-day window does not apply here.
 */

import type { CanonicalObservation } from '../types/fire';
import type { ActivityClass, MonthlyClimatology, SeasonSummary } from '../utils/seasonalClimatology';

export interface HistoryStatus {
  available: boolean;
  root: string;
  sensors: Record<string, { years: number[]; min_date: string | null; max_date: string | null; rows: number | null }>;
  note: string;
}

export interface HistoryDailyRow {
  period: string;
  country: string;
  sensor: string;
  detections: number;
  frp_sum_mw: number | null;
  frp_max_mw: number | null;
  day_count: number;
  night_count: number;
  satellites_seen: number | null;
}

export interface HistoryDailyResponse {
  level: 'daily' | 'monthly';
  scope: string;
  sensor: string;
  country: string | null;
  start_date?: string | null;
  end_date?: string | null;
  legend: string;
  rows: HistoryDailyRow[];
  truncated: boolean;
}

export interface HistoryFrpExtremeRow {
  period: string;
  country: string;
  sensor: string;
  frp_max_mw: number;
  detections: number;
}

export interface HistoryPersistenceRow {
  country: string;
  sensor: string;
  years_with_data: number;
  detections: number;
}

export interface HistoryMonthAnomalyRow {
  country: string;
  sensor: string;
  year: number;
  detections: number;
  other_years_median: number | null;
  valid_years?: number;
  baseline_years?: number[];
  ratio: number | null;
}

export interface HistoryClimatologyResponse {
  scope: { country: string | null; bbox: { west: number; south: number; east: number; north: number } | null; sensor: string };
  year_range: { start: number; end: number } | null;
  months: MonthlyClimatology[];
  season: SeasonSummary;
  legend: string;
  notes: string[];
}

export interface HistorySeasonalStatusResponse {
  country: string;
  date: string;
  day_of_year: number;
  window_days: number;
  climatology: HistoryClimatologyResponse;
  today_window: Record<
    string,
    { median_detections: number; p25_detections: number; p75_detections: number; years_with_data: number; years_total: number; period_status?: string }
  >;
  upcoming_months: { month: number; activity_class: ActivityClass; harmonized_equivalent_median: number | null }[];
  legend: string;
  notes: string[];
}

export interface HistoryObservationsResponse {
  date: string;
  sensor: string;
  legend: string;
  rows: CanonicalObservation[];
  count: number;
  truncated: boolean;
}

export interface HistoryCoverageResponse {
  sensor: string;
  note: string;
  days_with_data: number;
  rows: Array<{ date: string; sensor: string; global_rows: number }>;
}

export interface HistoryYearResponse {
  sensor: string;
  year: number;
  detections: number;
  frp_sum_mw: number | null;
  days_with_data: number;
  legend: string;
}

export interface HistoryCountryTotal {
  country: string;
  sensor: string;
  detections: number;
  frp_sum_mw: number | null;
  days_with_data: number;
}

export interface HistoryRankingsResponse {
  year: number;
  sensor: string;
  legend: string;
  note: string;
  rows: HistoryCountryTotal[];
}

function qs(params: Record<string, string | number | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) detail = body.error;
    } catch {
      /* keep HTTP status */
    }
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

export const historyApi = {
  status: () => getJson<HistoryStatus>('/api/v1/history/status'),

  daily: (params: { year?: number; month?: number; start_date?: string; end_date?: string; sensor?: string; country?: string; level?: 'daily' | 'monthly'; global?: boolean; limit?: number }) =>
    getJson<HistoryDailyResponse>(`/api/v1/history/daily${qs({ ...params, global: params.global ? 'true' : undefined })}`),

  observations: (params: { date: string; sensor?: string; bbox?: string; country?: string; satellite?: string; daynight?: 'D' | 'N'; min_frp?: number; limit?: number }) =>
    getJson<HistoryObservationsResponse>(`/api/v1/history/observations${qs(params)}`),

  coverage: (sensor?: string) =>
    getJson<HistoryCoverageResponse>(`/api/v1/history/coverage${qs({ sensor })}`),

  year: (sensor: 'MODIS' | 'VIIRS', year: number) =>
    getJson<HistoryYearResponse>(`/api/v1/history/year/${sensor}/${year}`),

  rankings: (year: number, sensor?: string) =>
    getJson<HistoryRankingsResponse>(`/api/v1/history/rankings${qs({ year, sensor })}`),

  frpExtremes: (params: { sensor?: string; country?: string; start_year?: number; end_year?: number; limit?: number }) =>
    getJson<{ sensor: string; legend: string; note: string; rows: HistoryFrpExtremeRow[] }>(`/api/v1/history/frp-extremes${qs(params)}`),

  persistence: (params: { sensor?: string; start_year?: number; end_year?: number; limit?: number }) =>
    getJson<{ sensor: string; legend: string; note: string; rows: HistoryPersistenceRow[] }>(`/api/v1/history/persistence${qs(params)}`),

  monthAnomaly: (params: { year: number; month: number; country?: string; sensor?: string; limit?: number }) =>
    getJson<{ year: number; month: number; sensor: string; legend: string; note: string; rows: HistoryMonthAnomalyRow[] }>(`/api/v1/history/month-anomaly${qs(params)}`),

  climatology: (params: { country?: string; bbox?: string; sensor?: string; start_year?: number; end_year?: number }) =>
    getJson<HistoryClimatologyResponse>(`/api/v1/history/climatology${qs(params)}`),

  seasonalStatus: (params: { country: string; sensor?: string; date?: string; window_days?: number; observed_modis?: number; observed_viirs?: number }) =>
    getJson<HistorySeasonalStatusResponse>(`/api/v1/history/seasonal-status${qs(params)}`),

  countries: () => getJson<{ legend: string; note: string; rows: string[] }>('/api/v1/history/countries'),

  exportUrl: (
    kind: 'daily' | 'observations' | 'coverage' | 'frp-extremes' | 'persistence' | 'month-anomaly',
    params: Record<string, string | number | undefined>
  ) => `/api/v1/history/export/${kind}.csv${qs(params)}`,
};

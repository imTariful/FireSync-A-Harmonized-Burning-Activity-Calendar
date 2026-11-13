/**
 * Typed API client for FireSync REST API endpoints under /api/v1
 */

import {
  CanonicalObservation,
  DailyActivitySummary,
  CalibrationModelMetrics,
  IngestionJob,
  RegionDefinition,
  FilterState,
} from '../types/fire';
import { clampToLiveWindow } from '../utils/filterValidation';
import type { AreaScope } from '../utils/area';

type ObservationQuery = {
  source?: 'live' | 'store'; days?: number; start_date?: string; end_date?: string;
  bbox?: string; aoi?: string; sensors?: string; satellites?: string;
  min_confidence?: number; min_frp?: number;
};
export type LiveFilters = Pick<FilterState, 'startDate' | 'endDate'> & Partial<Pick<FilterState, 'satellite' | 'minConfidence' | 'minFRP'>>;

/** One filter contract for live summaries, calendars, comparison and their CSV downloads. */
export function liveObservationQuery(filters: LiveFilters, scope: AreaScope = {}, today?: string) {
  const range = clampToLiveWindow(filters.startDate, filters.endDate, today);
  return {
    source: 'live' as const, start_date: range.start, end_date: range.end,
    bbox: scope.bbox, aoi: scope.aoi, sensors: scope.sensors,
    satellites: filters.satellite && filters.satellite !== 'ALL' ? filters.satellite : undefined,
    min_confidence: filters.minConfidence || undefined,
    min_frp: filters.minFRP || undefined,
  };
}

export interface HealthResponse {
  status: string;
  timestamp: string;
  service: string;
  version: string;
  database: {
    status: string;
    storage_type: string;
    durable: boolean;
    location: string;
    records_count: number;
    postgres_configured: boolean;
    postgis_active: boolean;
  };
  firms_integration: {
    api_configured: boolean;
    endpoint: string;
    supported_products: string[];
    live_nrt_max_days: number;
  };
  provenance: {
    local_store_status: 'VERIFIED' | 'UNVERIFIED';
    raw_source_files_present: boolean;
    reason: string;
    checksum_note: string;
  };
  calibration: {
    status: 'EXPLORATORY' | 'INSUFFICIENT' | 'CALIBRATED' | 'VALIDATED';
    note: string;
  };
}

export interface MetadataResponse {
  project: string;
  team: string;
  study_regions: RegionDefinition[];
  dataset_metadata: Record<string, unknown>;
  available_sensors: string[];
  available_satellites: string[];
  metrics: { id: string; name: string }[];
}

export interface SourceMetadata {
  data_source: 'live' | 'store';
  provenance_status: 'VERIFIED' | 'UNVERIFIED';
  retrieved_at: string | null;
  cached: boolean;
  source_errors: string[];
  truncated: boolean;
}

export interface HotspotsResponse extends SourceMetadata {
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
  observations: CanonicalObservation[];
}

export interface FiresResponse {
  total: number;
  truncated: boolean;
  errors: string[];
  observations: CanonicalObservation[];
  /** ISO time the data was fetched from NASA (kept when served from the 30-min server cache). */
  retrieved_at?: string;
  cached?: boolean;
  counts?: { MODIS: number; VIIRS: number };
}

export interface CalendarResponse extends SourceMetadata {
  period: { start_date: string; end_date: string };
  total_days: number;
  observed_days: number;
  active_days: number;
  missing_days: number | null;
  coverage_status: string;
  coverage_note: string;
  daily_summaries: DailyActivitySummary[];
}

export interface AnalyticsSummaryResponse extends SourceMetadata {
  kpis: {
    total_modis_detections: number;
    total_viirs_detections: number;
    total_raw_detections: number;
    active_spatial_temporal_bins: number;
    harmonized_activity_units: number;
    total_frp_mw: number;
    modis_frp_mw: number;
    viirs_frp_mw: number;
    /** null = not computed (unknown), never a made-up 100. */
    data_coverage_completeness_pct: number | null;
    active_days?: number;
    most_recent_successful_ingestion: string | null;
  };
  filter_record_count: number;
}

export interface SensorComparisonResponse {
  comparison: {
    modis_total_detections: number;
    viirs_total_detections: number;
    ratio_viirs_to_modis: number | null;
    paired_1km_cells_count: number;
    calibration_metrics: CalibrationModelMetrics;
    frp: {
      modis_total_mw: number;
      viirs_total_mw: number;
      note: string;
    };
    matched_points: Array<{
      modis: string;
      viirs: string;
      distance_km: number;
      time_diff_minutes: number;
      modis_frp_mw: number;
      viirs_frp_mw: number;
      date: string;
    }>;
    paired_cells: Array<{
      cell_id: string;
      date: string;
      modis_count: number;
      viirs_count: number;
    }>;
    matching_summary: {
      method: string;
      label: string;
      point_pairs: number;
      co_detected_cells: number;
      detection_ratio: number | null;
      limitations: string[];
    };
    provenance_status: 'VERIFIED' | 'UNVERIFIED';
    data_source: 'live' | 'store';
    retrieved_at: string | null;
    cached: boolean;
    source_errors: string[];
    truncated: boolean;
    calibration_status: string;
  };
  sensor_specifications: Array<{
    sensor: string;
    satellites: string[];
    nadir_pixel_resolution: string;
    edge_pixel_resolution: string;
    bands_used: string;
    detection_characteristics: string;
  }>;
}

export interface AnomaliesResponse extends SourceMetadata {
  total_anomalies_detected: number;
  methodology: string;
  thresholds: Record<string, string>;
  notice: string;
  anomalies: DailyActivitySummary[];
}

export interface IngestionJobsResponse {
  total_jobs: number;
  jobs: IngestionJob[];
}

/**
 * Live NRT exports: keep the requested range inside the live window so the download matches the live page
 * instead of failing with LIVE_WINDOW. A store export (explicit `source`) is passed through untouched.
 */
function clampExportRange(
  params: Record<string, string | number | undefined>
): Record<string, string | number | undefined> {
  if (params.source !== 'live') return params;
  const start = typeof params.start_date === 'string' ? params.start_date : undefined;
  const end = typeof params.end_date === 'string' ? params.end_date : undefined;
  if (!start || !end) return params;
  const clamped = clampToLiveWindow(start, end);
  return { ...params, start_date: clamped.start, end_date: clamped.end };
}

function buildQuery(params: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, val] of Object.entries(params)) {
    if (val !== undefined && val !== null && val !== '') {
      query.set(key, String(val));
    }
  }
  const qStr = query.toString();
  return qStr ? `?${qStr}` : '';
}

/** Every API call must fail honestly on a non-OK response; `res.json()` alone hides HTTP errors. */
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message =
      body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
        ? body.error
        : `HTTP ${res.status}`;
    throw new Error(message);
  }
  return body as T;
}

export const api = {
  async getHealth(): Promise<HealthResponse> {
    return request<HealthResponse>('/api/v1/health');
  },

  async getMetadata(): Promise<MetadataResponse> {
    return request<MetadataResponse>('/api/v1/metadata');
  },

  async getDataAvailability(): Promise<{
    local_store: {
      total_records: number;
      first_observation_date: string | null;
      last_observation_date: string | null;
      modis_count: number;
      viirs_count: number;
      data_status: string;
      provenance_status: 'VERIFIED' | 'UNVERIFIED';
      raw_source_files_present: boolean;
      reason: string;
    };
    live_nrt: {
      available: boolean;
      max_days: number;
      endpoint: string;
      products: string[];
      note: string;
    };
    official_nasa_firms: {
      products: Array<{ product: string; availability: string; status: string }>;
      api_key_configured: boolean;
      registration_url: string;
    };
    storage: { kind: string; durable: boolean };
    calibration_status: string;
  }> {
    return request('/api/v1/data-availability');
  },

  async getHotspots(params: {
    source?: 'live' | 'store';
    days?: number;
    start_date?: string;
    end_date?: string;
    bbox?: string;
    aoi?: string;
    sensors?: string;
    satellites?: string;
    min_confidence?: number;
    min_frp?: number;
    limit?: number;
    offset?: number;
  }): Promise<HotspotsResponse> {
    return request(`/api/v1/hotspots${buildQuery(params)}`);
  },

  /**
   * Live NASA FIRMS hotspots (MODIS and VIIRS kept separate). area = "world" or "west,south,east,north".
   * Pass an AbortSignal to cancel the request (e.g. when the map moves again).
   */
  async getFires(
    params: { area: string; days: number; cap?: number },
    signal?: AbortSignal
  ): Promise<FiresResponse> {
    return request<FiresResponse>(`/api/v1/fires${buildQuery(params)}`, { signal });
  },

  async getCalendar(params: ObservationQuery): Promise<CalendarResponse> {
    return request(`/api/v1/calendar${buildQuery(params)}`);
  },

  async getAnalyticsSummary(params: {
    source?: 'live' | 'store';
    days?: number;
    start_date?: string;
    end_date?: string;
    bbox?: string;
    aoi?: string;
    sensors?: string;
    satellites?: string;
    min_confidence?: number;
    min_frp?: number;
  }): Promise<AnalyticsSummaryResponse> {
    return request(`/api/v1/analytics/summary${buildQuery(params)}`);
  },

  async getSensorComparison(params: ObservationQuery): Promise<SensorComparisonResponse> {
    return request(`/api/v1/analytics/sensors${buildQuery(params)}`);
  },

  async getAnomalies(params: {
    source?: 'live' | 'store';
    days?: number;
    start_date?: string;
    end_date?: string;
    bbox?: string;
  }): Promise<AnomaliesResponse> {
    return request(`/api/v1/analytics/anomalies${buildQuery(params)}`);
  },

  async getCalibrationMetrics(params: ObservationQuery = {}): Promise<CalibrationModelMetrics> {
    return request<CalibrationModelMetrics>(`/api/v1/analytics/calibration${buildQuery(params)}`);
  },

  async getCalibrationHoldout(params: {
    source?: 'live' | 'store';
    days?: number;
    start_date?: string;
    end_date?: string;
    bbox?: string;
    aoi?: string;
  } = {}): Promise<CalibrationModelMetrics> {
    return request<CalibrationModelMetrics>(`/api/v1/analytics/calibration/holdout${buildQuery(params)}`);
  },

  async getTimeseries(params: {
    source?: 'live' | 'store';
    days?: number;
    start_date?: string;
    end_date?: string;
    bbox?: string;
  }): Promise<{ start_date: string; end_date: string; series: any[] }> {
    return request(`/api/v1/analytics/timeseries${buildQuery(params)}`);
  },

  async getIngestionJobs(): Promise<IngestionJobsResponse> {
    return request('/api/v1/ingestion/jobs');
  },

  async getIngestionJob(id: string): Promise<IngestionJob> {
    return request(`/api/v1/ingestion/jobs/${encodeURIComponent(id)}`);
  },

  /** Tests the SERVER-configured FIRMS key. The browser never receives or supplies the key. */
  async testFirmsKey(): Promise<{ valid: boolean; message: string }> {
    return request('/api/v1/ingestion/test-key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
  },

  async triggerIngestion(data: {
    bbox: string;
    day_range: number;
    date?: string;
    products?: string[];
  }): Promise<{ message: string; job: IngestionJob }> {
    return request('/api/v1/ingestion/trigger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
  },

  // The pages show live NASA FIRMS detections, so a download must be built from the same live source and the
  // page can never hand back an empty store export. The range is clamped to the live window for the same reason.
  // Callers may override `source` explicitly.
  getExportCsvUrl(params: Record<string, string | number | undefined>): string {
    return `/api/v1/export/csv${buildQuery(clampExportRange({ source: 'live', ...params }))}`;
  },

  getExportCalendarCsvUrl(params: Record<string, string | number | undefined>): string {
    return `/api/v1/export/calendar.csv${buildQuery(clampExportRange({ source: 'live', ...params }))}`;
  },

  getExportValidationCsvUrl(params: Record<string, string | number | undefined> = {}): string {
    return `/api/v1/export/validation.csv${buildQuery(params)}`;
  },

  getExportMatchedCsvUrl(params: Record<string, string | number | undefined>): string {
    return `/api/v1/export/matched.csv${buildQuery(params)}`;
  },

  getExportHarmonizedCsvUrl(params: Record<string, string | number | undefined>): string {
    return `/api/v1/export/harmonized.csv${buildQuery(params)}`;
  },

  getExportProvenanceCsvUrl(params: Record<string, string | number | undefined> = {}): string {
    return `/api/v1/export/provenance.csv${buildQuery(params)}`;
  },
};

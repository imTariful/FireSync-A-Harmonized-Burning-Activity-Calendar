/**
 * Typed client for the deterministic analysis + geographic endpoints.
 *
 * These routes work with or without Groq: AI text is optional enrichment, and the numeric
 * results always come from the server's own calculations.
 */

export interface AiNarrativeInfo {
  status: 'enabled' | 'disabled' | 'not_configured';
  model: string | null;
  reason: string | null;
}

export interface SourceMeta {
  data_source: 'live' | 'store';
  provenance_status: string;
  retrieved_at: string | null;
  source_errors: string[];
  truncated: boolean;
}

export interface WindowMeta {
  start_date: string;
  end_date: string;
  days: number;
}

export interface ClusterSummary {
  id: string;
  label: 'candidate_hotspot_group';
  detection_count: number;
  by_sensor: { MODIS: number; VIIRS: number };
  centroid: { latitude: number; longitude: number };
  bbox: { west: number; south: number; east: number; north: number };
  first_detection_utc: string;
  last_detection_utc: string;
  duration_hours: number;
  active_days: number;
  daily_counts: Array<{ date: string; MODIS: number; VIIRS: number }>;
  evolution: {
    phase: 'single_pass' | 'increasing' | 'steady' | 'decreasing' | 'fading';
    recent_24h_detections: number;
    early_half_detections: number;
    late_half_detections: number;
  };
  frp_mw: { MODIS: number; VIIRS: number; mean: number; max: number };
  satellites: string[];
  active_1km_cells: number;
  mean_confidence: number | null;
  notes: string[];
}

export interface ClusterInvestigationResponse {
  window: WindowMeta;
  area: { bbox: string };
  sensors: 'ALL' | 'MODIS' | 'VIIRS';
  total_clusters: number;
  analysed_detections: number;
  cluster: ClusterSummary | null;
  clusters: ClusterSummary[];
  report: string | null;
  ai: AiNarrativeInfo;
  guardrails: string[];
  notes: string[];
  source: SourceMeta;
}

export interface AuditCheck {
  id: string;
  label: string;
  status: 'pass' | 'warn' | 'fail' | 'not_applicable';
  detail: string;
}

export interface AuditResponse {
  audit: {
    checked_records: number;
    checks: AuditCheck[];
    summary: { pass: number; warn: number; fail: number; not_applicable: number };
    by_sensor: { MODIS: number; VIIRS: number };
    scientific_status: 'EXPLORATORY';
    limitations: string[];
  };
  summary_text: string | null;
  ai: AiNarrativeInfo;
  source: SourceMeta;
}

export interface DensityResponse {
  window: WindowMeta;
  bbox: string;
  sensors: 'ALL' | 'MODIS' | 'VIIRS';
  density: {
    area_km2: number;
    cell_size_km: number;
    total_detections: number;
    by_sensor: { MODIS: number; VIIRS: number };
    densities_per_1000_km2: { MODIS: number; VIIRS: number };
    active_cells: number;
    top_cells: Array<{ cell_id: string; center_lat: number; center_lon: number; modis: number; viirs: number }>;
    cells_omitted: number;
    notes: string[];
  };
  source: SourceMeta;
}

export interface ClustersResponse {
  window: WindowMeta;
  bbox: string;
  sensors: 'ALL' | 'MODIS' | 'VIIRS';
  clusters: {
    clusters: ClusterSummary[];
    found_clusters: number;
    total_detections: number;
    analysed_detections: number;
    truncated: boolean;
    options: { linkKm: number; linkHours: number; maxClusters: number; maxDetections: number };
    notes: string[];
  };
  source: SourceMeta;
}

export interface CoverageResponse {
  coverage: {
    start_date: string;
    end_date: string;
    observed_days: number;
    no_record_days: number;
    single_sensor_days: number;
    source_errors: string[];
    notes: string[];
    days: Array<{
      date: string;
      MODIS: number;
      VIIRS: number;
      record_count: number;
      status: 'observed' | 'no_observation_record';
      single_sensor: boolean;
    }>;
  };
  ingestion?: {
    storage: string;
    durable: boolean;
    job_counts: { completed: number; failed: number; running: number; pending: number; cancelled: number };
    recent_jobs: Array<{
      id: string;
      status: string;
      source_products: string[] | null;
      bbox: string | null;
      retrieved_at: string | null;
      completed_at: string | null;
      records_imported: number | null;
      error_message: string | null;
    }>;
    note: string;
  };
  source: SourceMeta;
}

export interface RegionsResponse {
  regions: Array<{
    region_id: string;
    name: string;
    bbox: string;
    area_km2: number;
    total_detections: number;
    by_sensor: { MODIS: number; VIIRS: number };
    densities_per_1000_km2: { MODIS: number; VIIRS: number };
    active_cells: number;
  }>;
  notes: string[];
}

export interface SensorPeakHour {
  hour_utc: string;
  count: number;
}

export interface SensorStats {
  detections: number;
  frp_total_mw: number;
  frp_mean_mw: number | null;
  mean_confidence: number | null;
  peak_hours_utc: SensorPeakHour[];
  satellites: string[];
}

export interface SensorExplanationResponse {
  comparison: {
    window: WindowMeta;
    bbox: string;
    MODIS: SensorStats;
    VIIRS: SensorStats;
    cells: { total: number; paired: number; modis_only: number; viirs_only: number };
    sensor_only_note: string;
  };
  explanation: string | null;
  ai: AiNarrativeInfo;
  guardrails: string[];
  source: SourceMeta;
  notes: string[];
}

export interface CompareWindow {
  label: 'window_a' | 'window_b';
  start_date: string;
  end_date: string;
  days: number;
}

export interface ComparePeriodStats {
  label: string;
  day_count: number;
  by_sensor: { MODIS: number; VIIRS: number };
  frp_mw: { MODIS: number; VIIRS: number };
  active_1km_cells: number;
  active_days: number;
  first_detection_utc: string | null;
  last_detection_utc: string | null;
}

export interface CompareChange {
  absolute: number;
  percent: number | null;
  direction: 'increase' | 'decrease' | 'unchanged';
}

export interface CompareResponse {
  window_a: CompareWindow;
  window_b: CompareWindow;
  a: ComparePeriodStats;
  b: ComparePeriodStats;
  change: { MODIS: CompareChange; VIIRS: CompareChange; active_1km_cells: CompareChange };
  normalized: {
    a_per_day: { MODIS: number; VIIRS: number };
    b_per_day: { MODIS: number; VIIRS: number };
  };
  notes: string[];
  coverage_note: string;
  source: SourceMeta;
}

export interface WeatherDayEntry {
  date: string;
  temperature_2m_max_c: number | null;
  temperature_2m_min_c: number | null;
  precipitation_mm: number | null;
  wind_speed_10m_max_kmh: number | null;
  relative_humidity_2m_mean_pct: number | null;
}

export interface WeatherCorrelation {
  variable: string;
  label: string;
  unit: string;
  MODIS: { r: number | null; pairs: number };
  VIIRS: { r: number | null; pairs: number };
}

export interface WeatherResponse {
  window: WindowMeta;
  bbox: string;
  analysis: {
    weather: {
      available: boolean;
      reason: string | null;
      point: { latitude: number; longitude: number } | null;
      days: WeatherDayEntry[];
      provider: string;
      api: string;
      retrieved_at: string | null;
    };
    fire_daily: Array<{
      date: string;
      MODIS: number;
      VIIRS: number;
      record_count: number;
      status: 'observed' | 'no_observation_record';
      single_sensor: boolean;
    }>;
    correlations: WeatherCorrelation[];
    paired_days: number;
    notes: string[];
  };
  explanation: string | null;
  ai: AiNarrativeInfo;
  source: SourceMeta;
}

export interface DatasetStatusResponse {
  datasets: Array<{
    id: string;
    name: string;
    provider: string;
    resolution: string;
    configured: boolean;
    used_for: string;
    note: string;
  }>;
  available_count: number;
  unavailable_count: number;
  note: string;
}

export interface ReportResponse {
  report: {
    markdown: string;
    html: string;
    pdf: 'unavailable';
    pdf_note: string;
    sections: string[];
  };
  stats: {
    modis_detections: number;
    viirs_detections: number;
    modis_frp_mw: number;
    viirs_frp_mw: number;
    active_1km_cells: number;
    active_days: number;
  };
  ai: AiNarrativeInfo;
}

async function post<T>(url: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message =
      payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
        ? payload.error
        : `HTTP ${res.status}`;
    throw new Error(message);
  }
  return payload as T;
}

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return payload as T;
}

export const intelligenceApi = {
  clusterInvestigation(bbox: string, days: number, options: { sensors?: string; cluster_id?: string } = {}) {
    return post<ClusterInvestigationResponse>('/api/v1/ai/cluster-investigation', { bbox, days, ...options });
  },
  scientificAudit(bbox: string, days: number, sensors?: string) {
    return post<AuditResponse>('/api/v1/ai/scientific-audit', { bbox, days, sensors });
  },
  sensorExplanation(bbox: string, days: number) {
    return post<SensorExplanationResponse>('/api/v1/ai/sensor-explanation', { bbox, days });
  },
  report(bbox: string, days: number, options: { sensors?: string; language?: 'en' | 'bn' } = {}) {
    return post<ReportResponse>('/api/v1/ai/report', { bbox, days, ...options });
  },
  geographicAnalysis(bbox: string, days: number, topic: 'density' | 'clusters' | 'coverage') {
    return post<{ topic: string; result: unknown; explanation: string | null; ai: AiNarrativeInfo }>(
      '/api/v1/ai/geographic-analysis',
      { bbox, days, topic }
    );
  },
  density(bbox: string, days: number, sensors?: string) {
    return post<DensityResponse>('/api/v1/geo/density', { bbox, days, sensors });
  },
  clusters(bbox: string, days: number, sensors?: 'ALL' | 'MODIS' | 'VIIRS') {
    return post<ClustersResponse>('/api/v1/geo/clusters', { bbox, days, sensors });
  },
  compare(bbox: string, daysA: number, daysB: number, sensors?: 'ALL' | 'MODIS' | 'VIIRS') {
    return post<CompareResponse>('/api/v1/geo/compare', {
      bbox,
      days_a: daysA,
      days_b: daysB,
      sensors,
    });
  },
  coverage(bbox: string, days: number) {
    return post<CoverageResponse>('/api/v1/geo/coverage', { bbox, days });
  },
  weather(bbox: string, days: number) {
    return post<WeatherResponse>('/api/v1/geo/weather', { bbox, days });
  },
  compareRegions(regions: Array<{ id: string; name: string; bbox: string }>, days: number) {
    return post<RegionsResponse>('/api/v1/geo/regions/compare', { regions, days });
  },
  proximity(bbox: string, days: number, features: Array<Record<string, unknown>>, bufferKm: number) {
    return post<{
      proximity: {
        available: boolean;
        reason: string | null;
        buffer_km: number;
        features: Array<{
          id: string;
          name: string;
          type: string;
          nearest: Record<string, { distance_km: number; observation_id: string; datetime_utc: string } | null>;
          within_buffer: { MODIS: number; VIIRS: number };
        }>;
        notes: string[];
      };
    }>('/api/v1/geo/proximity', { bbox, days, features, buffer_km: bufferKm });
  },
  datasets() {
    return get<DatasetStatusResponse>('/api/v1/geo/datasets/status');
  },
};

/**
 * Browser client for the AgniCalendar harmonized dataset API.
 * Separate from the FIRMS country archive: 10 km EPSG:8857 cells x UTC month.
 */

export type AgniLayer = 'aqua' | 'snpp' | 'harmonized';
export type AgniDayNight = 'day' | 'night' | 'unknown' | 'known';
export type AgniFireType = '0' | '1' | '2' | '3' | 'UNKNOWN' | 'all';

export interface AgniQueryParams {
  layer?: AgniLayer;
  daynight?: AgniDayNight;
  fire_type?: AgniFireType;
  bbox?: string;
  aoi?: string;
  country?: string;
  start_year?: number;
  end_year?: number;
  year?: number;
  month?: number;
  limit?: number;
}

export interface AgniStatus {
  available: boolean;
  rows: number | null;
  min_year: number | null;
  max_year: number | null;
  min_month: string | null;
  max_month: string | null;
  fire_types: string[];
  layers: Record<AgniLayer, { description: string; available_from: string | null }>;
  support_statuses: Array<{ status: string; rows: number }>;
  caveats: string[];
}

export interface AgniMonthRow {
  year: number;
  month: number;
  detections: number | null;
  frp_sum_mw: number | null;
  cells_with_data: number;
  partial_coverage: boolean;
}

export interface AgniCellRow {
  cell_id: string;
  grid_row: number;
  grid_col: number;
  lon: number;
  lat: number;
  value: number | null;
  frp_sum_mw: number | null;
}

export interface AgniCellFeature {
  type: 'Feature';
  geometry: { type: 'Polygon'; coordinates: number[][][] };
  properties: Record<string, string | number | null>;
}

export interface AgniCellsGeoJSONEnvelope {
  type: 'FeatureCollection';
  features: AgniCellFeature[];
  truncated: boolean;
  year: number;
  month: number;
  layer: AgniLayer;
  daynight: AgniDayNight;
  fire_type: AgniFireType;
  note?: string;
}

function qs(params: object): string {
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

interface AgniEnvelope<T> {
  rows: T[];
  layer?: AgniLayer;
  daynight?: AgniDayNight;
  fire_type?: AgniFireType;
  note?: string;
}

export const agniApi = {
  cellMonthExportUrl: (params: AgniQueryParams & { year: number; month: number }) => `/api/v1/agnicalendar/export/cell-months.csv${qs(params)}`,
  intelligence: (params: AgniQueryParams & { year: number }) => getJson<{ target_year: number; comparisons: import('../utils/agniBaseline').AgniComparison[]; season: { peak_months: number[] }; method: string; limitation: string }>(`/api/v1/agnicalendar/intelligence${qs(params)}`),
  provenance: () => getJson<{ available: boolean; model_id: string | null; reference_sensor?: string; predictor_sensor?: string; training_years?: number[]; model_pair_sha256?: string; validation_metrics: null; reason: string }>('/api/v1/agnicalendar/provenance'),
  comparison: (params: AgniQueryParams & { year: number; month: number }) => getJson<{ rows: Array<{ daynight: string; aqua_all_observed: number | null; snpp_all_observed: number | null; aqua_supported: number | null; snpp_supported: number | null; aqua_equivalent_estimate: number | null; supported_cell_month_types: number; source_cell_month_types: number; aqua_frp_sum_mw: number | null; snpp_frp_sum_mw: number | null; aqua_versions: string; snpp_versions: string; product_status: string; quality_flags: string }>; note: string }>(`/api/v1/agnicalendar/comparison${qs(params)}`),
  status: () => getJson<AgniStatus>('/api/v1/agnicalendar/status'),

  countries: () => getJson<{ countries: string[] }>('/api/v1/agnicalendar/countries'),

  series: (params: AgniQueryParams = {}) =>
    getJson<AgniEnvelope<AgniMonthRow>>(`/api/v1/agnicalendar/series${qs(params)}`),

  calendar: (params: AgniQueryParams = {}) =>
    getJson<AgniEnvelope<AgniMonthRow>>(`/api/v1/agnicalendar/calendar${qs(params)}`),

  cells: (params: AgniQueryParams & { year: number; month: number }) =>
    getJson<AgniEnvelope<AgniCellRow>>(`/api/v1/agnicalendar/cells${qs(params)}`),

  cellsGeoJson: (params: AgniQueryParams & { year: number; month: number; limit?: number }) =>
    getJson<AgniCellsGeoJSONEnvelope>(`/api/v1/agnicalendar/cells.geojson${qs(params)}`),

  exportUrl: (params: AgniQueryParams = {}) =>
    `/api/v1/agnicalendar/export/series.csv${qs(params)}`,
};

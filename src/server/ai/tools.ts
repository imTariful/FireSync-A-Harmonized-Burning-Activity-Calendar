/**
 * Typed FireSync data tools the Groq model may call.
 *
 * Every number in a model answer comes from these functions. They are deterministic, bounded and
 * read only what the app already serves: live NASA FIRMS NRT observations (or the local store when
 * live is unavailable). Map changes are returned as validated action objects and applied by the UI.
 */

import type {
  AiDetectionEvidence,
  AiHotspotSummary,
  AiMapAction,
  AiObservationLoader,
  AiToolCallRecord,
} from '../../types/ai';
import { isPointInBbox, STUDY_REGIONS } from '../../utils/spatial';
import { aggregateToSpatialTemporalGrid } from '../../utils/harmonization';
import type { CanonicalObservation } from '../../types/fire';
import type { ClimatologyResponse, CountryTotal, DailyRow, FrpExtremeRow, MonthAnomalyRow, PeriodYearRow, PersistenceRow, SeasonalStatusResponse } from '../historical';
import type { IncidentVerification } from '../incidents';
import { isValidBbox, parseMapAction } from './schema';
import { AI_LIMITS } from './config';

export interface ToolDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

const BBOX_PARAM = {
  type: 'string',
  description:
    'Optional area as "west,south,east,north" in decimal degrees, e.g. "88.0,20.5,92.7,26.6". Omit for the whole globe.',
};

export const AI_TOOL_DECLARATIONS: ToolDeclaration[] = [
  {
    name: 'list_regions',
    description:
      'List the study regions the map can focus on. Use this before focus_region when you need a region id.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'query_hotspots',
    description:
      'Count and sample real satellite active-fire detections (hotspots) in an area and a live NRT window. Returns MODIS and VIIRS counts separately, FRP sums, active 1 km cells, first/last detection times and a small sample of records.',
    parameters: {
      type: 'object',
      properties: {
        days: { type: 'integer', description: 'Days back from today, 1 to 5 (live NRT only). Default 1.', minimum: 1, maximum: 5 },
        bbox: BBOX_PARAM,
        sensors: { type: 'string', enum: ['ALL', 'MODIS', 'VIIRS'], description: 'Sensor filter. Default ALL (still reported separately).' },
        min_frp: { type: 'number', description: 'Minimum fire radiative power in MW. Optional.', minimum: 0, maximum: 10000 },
        min_confidence: { type: 'number', description: 'Minimum confidence (0-100 scale). Optional.', minimum: 0, maximum: 100 },
        limit: { type: 'integer', description: 'Sample size to return, 1 to 25. Default 5.', minimum: 1, maximum: 25 },
      },
      required: ['days'],
    },
  },
  {
    name: 'sensor_comparison',
    description:
      'Compare MODIS and VIIRS detections in one area and window: per-sensor totals, their ratio, and how many 1 km cells both sensors detected. Never a combined fire count.',
    parameters: {
      type: 'object',
      properties: {
        days: { type: 'integer', description: 'Days back from today, 1 to 5. Default 1.', minimum: 1, maximum: 5 },
        bbox: BBOX_PARAM,
      },
      required: ['days'],
    },
  },
  {
    name: 'rank_regions',
    description:
      'Rank the FireSync study regions by satellite detection counts in ONE call. Use this for "which area/region has the most hotspots" questions instead of calling query_hotspots once per region. MODIS and VIIRS counts stay separate per region; the ranking score is an EXPLORATORY combined detection count, not a fire count.',
    parameters: {
      type: 'object',
      properties: {
        days: { type: 'integer', description: 'Days back from today, 1 to 5 (live NRT only). Default 1.', minimum: 1, maximum: 5 },
      },
      required: ['days'],
    },
  },
  {
    name: 'hottest_detections',
    description:
      'Return the highest-FRP (fire radiative power) detections in an area and window, top N per sensor kept separate. Use for "hottest/biggest/strongest hotspot" questions. FRP is radiant power in MW; MODIS and VIIRS values are reported separately and are not ranked against each other.',
    parameters: {
      type: 'object',
      properties: {
        days: { type: 'integer', description: 'Days back from today, 1 to 5 (live NRT only). Default 1.', minimum: 1, maximum: 5 },
        bbox: BBOX_PARAM,
        sensors: { type: 'string', enum: ['ALL', 'MODIS', 'VIIRS'], description: 'Sensor filter. Default ALL (still reported separately).' },
        limit: { type: 'integer', description: 'Top records per sensor, 1 to 5. Default 3.', minimum: 1, maximum: 5 },
      },
      required: ['days'],
    },
  },
  {
    name: 'apply_map_filters',
    description:
      'Change the map filters the user sees. Use this whenever the user asks to show, hide or narrow detections. Only these filters can be changed; the action is validated before it reaches the map.',
    parameters: {
      type: 'object',
      properties: {
        sensors: { type: 'string', enum: ['ALL', 'MODIS', 'VIIRS'], description: 'Sensor shown on the map.' },
        days: { type: 'integer', description: 'Live window length in days, 1 to 5.', minimum: 1, maximum: 5 },
        min_frp: { type: 'number', description: 'Minimum FRP in MW.', minimum: 0, maximum: 10000 },
        min_confidence: { type: 'number', description: 'Minimum confidence, 0 to 100.', minimum: 0, maximum: 100 },
      },
      required: [],
    },
  },
  {
    name: 'history_year_summary',
    description:
      'Yearly totals from the LOCAL historical FIRMS archive (2000-2025), not live data. MODIS covers 2000-11 onward (Terra+Aqua); VIIRS covers 2012-01-20 onward and is Suomi-NPP only in this archive. Returns per-sensor detections, total FRP and days with data. Use for "how did year X compare", seasonal climatology and historian questions. MODIS and VIIRS are never summed.',
    parameters: {
      type: 'object',
      properties: {
        year: { type: 'integer', description: 'Calendar year, 2000 to 2025.', minimum: 2000, maximum: 2025 },
        sensor: { type: 'string', enum: ['ALL', 'MODIS', 'VIIRS'], description: 'Default ALL (each sensor reported separately).' },
      },
      required: ['year'],
    },
  },
  {
    name: 'history_daily_series',
    description:
      'Daily or monthly detection series from the LOCAL historical FIRMS archive for one year, optionally filtered by month, sensor and country. Use for "which months/days were most active", year-over-year and seasonal historian questions. MODIS and VIIRS rows stay separate. A missing date means no archive rows, not confirmed zero activity.',
    parameters: {
      type: 'object',
      properties: {
        year: { type: 'integer', description: 'Calendar year, 2000 to 2025.', minimum: 2000, maximum: 2025 },
        month: { type: 'integer', description: 'Optional month 1-12.', minimum: 1, maximum: 12 },
        start_date: { type: 'string', description: 'Optional inclusive ISO start date YYYY-MM-DD (use with end_date for multi-day/multi-month ranges within the year).' },
        end_date: { type: 'string', description: 'Optional inclusive ISO end date YYYY-MM-DD.' },
        sensor: { type: 'string', enum: ['MODIS', 'VIIRS'], description: 'Optional single-sensor filter.' },
        country: { type: 'string', description: 'Optional country name exactly as in the archive, e.g. "Bangladesh". Omit for global totals.' },
        level: { type: 'string', enum: ['daily', 'monthly'], description: 'Aggregation level. Default monthly for whole-year questions, daily for single-month/day questions.' },
      },
      required: ['year'],
    },
  },
  {
    name: 'history_period_summary',
    description:
      'Multi-year totals from the LOCAL historical FIRMS archive for a contiguous year range, optionally restricted to one country and/or one sensor. Returns per-year rows plus per-sensor period totals. Use for "how many hotspots between YEAR1-YEAR2 in COUNTRY" questions — one call covers the whole range; do NOT loop yearly calls. MODIS and VIIRS totals are always separate and never summed.',
    parameters: {
      type: 'object',
      properties: {
        start_year: { type: 'integer', description: 'First year, 2000 to 2025.', minimum: 2000, maximum: 2025 },
        end_year: { type: 'integer', description: 'Last year, 2000 to 2025, >= start_year.', minimum: 2000, maximum: 2025 },
        country: { type: 'string', description: 'Optional country name exactly as in the archive, e.g. "Bangladesh". Omit for global totals.' },
        sensor: { type: 'string', enum: ['MODIS', 'VIIRS'], description: 'Optional single-sensor filter.' },
      },
      required: ['start_year', 'end_year'],
    },
  },
  {
    name: 'history_country_rankings',
    description:
      'Rank countries by detections in the LOCAL historical archive for ONE year. Returns up to 50 country rows with MODIS and VIIRS kept in separate entries. Use for "which countries/regions had the most hotspots/activity in YEAR" questions.',
    parameters: {
      type: 'object',
      properties: {
        year: { type: 'integer', description: 'Calendar year, 2000 to 2025.', minimum: 2000, maximum: 2025 },
        sensor: { type: 'string', enum: ['MODIS', 'VIIRS'], description: 'Optional single-sensor filter.' },
        limit: { type: 'integer', description: 'Top N per sensor, 1 to 20. Default 10.', minimum: 1, maximum: 20 },
      },
      required: ['year'],
    },
  },
  {
    name: 'history_frp_extremes',
    description:
      'Highest daily FRP maxima in the LOCAL historical archive, optionally filtered by sensor, country and year range. Use for "highest/strongest FRP ever", "biggest fire days", "record FRP" questions. Returns period, country, sensor, frp_max_mw and detections — MODIS and VIIRS rows stay separate. These are daily-aggregate maxima, not single-observation extremes.',
    parameters: {
      type: 'object',
      properties: {
        sensor: { type: 'string', enum: ['MODIS', 'VIIRS'], description: 'Optional single-sensor filter.' },
        country: { type: 'string', description: 'Optional country name exactly as in the archive.' },
        start_year: { type: 'integer', description: 'Optional first year, 2000 to 2025.', minimum: 2000, maximum: 2025 },
        end_year: { type: 'integer', description: 'Optional last year, 2000 to 2025.', minimum: 2000, maximum: 2025 },
        limit: { type: 'integer', description: 'Top N rows, 1 to 50. Default 10.', minimum: 1, maximum: 50 },
      },
      required: [],
    },
  },
  {
    name: 'history_persistent_countries',
    description:
      'Countries ranked by how many distinct archive years they have detections in (recurring-activity proxy), optionally filtered by sensor and year range. Use for "which countries have fire activity almost every year", "persistent/recurring hotspots", "long-term fire countries" questions. MODIS and VIIRS rows stay separate and are never merged.',
    parameters: {
      type: 'object',
      properties: {
        sensor: { type: 'string', enum: ['MODIS', 'VIIRS'], description: 'Optional single-sensor filter.' },
        start_year: { type: 'integer', description: 'Optional first year, 2000 to 2025.', minimum: 2000, maximum: 2025 },
        end_year: { type: 'integer', description: 'Optional last year, 2000 to 2025.', minimum: 2000, maximum: 2025 },
        limit: { type: 'integer', description: 'Top N rows, 1 to 50. Default 20.', minimum: 1, maximum: 50 },
      },
      required: [],
    },
  },
  {
    name: 'history_month_anomaly',
    description:
      'Compare one calendar month of one year against the median of the same calendar month across all OTHER archive years, per country+sensor. Use for "was MONTH YEAR unusually active for COUNTRY", "anomaly", "above/below normal" historical questions. Ratios are statistical variation only — never call them confirmed fires or forecasts.',
    parameters: {
      type: 'object',
      properties: {
        year: { type: 'integer', description: 'Calendar year, 2000 to 2025.', minimum: 2000, maximum: 2025 },
        month: { type: 'integer', description: 'Calendar month 1-12.', minimum: 1, maximum: 12 },
        country: { type: 'string', description: 'Optional country name exactly as in the archive.' },
        sensor: { type: 'string', enum: ['MODIS', 'VIIRS'], description: 'Optional single-sensor filter.' },
        limit: { type: 'integer', description: 'Top N rows, 1 to 50. Default 20.', minimum: 1, maximum: 50 },
      },
      required: ['year', 'month'],
    },
  },
  {
    name: 'history_seasonal_profile',
    description:
      'Seasonal climatology for a country (or bounding box) from the LOCAL historical archive: per-calendar-month typical activity classes (low/typical/elevated/high), median detections per sensor, peak and low months. Use for "when is fire/burning season in X", "which months are usually most active", "what is typical for MONTH in COUNTRY". This is climatology of 2000-2025 — NEVER call it a forecast or prediction.',
    parameters: {
      type: 'object',
      properties: {
        country: { type: 'string', description: 'Country name exactly as in the archive, e.g. "Australia". Provide country OR bbox.' },
        bbox: { type: 'string', description: 'Optional west,south,east,north bounding box instead of country.' },
        sensor: { type: 'string', enum: ['MODIS', 'VIIRS'], description: 'Optional single-sensor filter.' },
      },
      required: [],
    },
  },
  {
    name: 'history_seasonal_status',
    description:
      'Current seasonal status for a COUNTRY: today\'s day-of-year window detection distribution across archive years (median/quartiles per sensor), the period status when observed counts are known, and the activity class of the next 3 calendar months. Use for "is now the burning season", "is activity above/below normal right now", "what is coming up seasonally". Climatology only — never a forecast.',
    parameters: {
      type: 'object',
      properties: {
        country: { type: 'string', description: 'Country name exactly as in the archive.' },
        sensor: { type: 'string', enum: ['MODIS', 'VIIRS'], description: 'Optional single-sensor filter.' },
      },
      required: ['country'],
    },
  },
  {
    name: 'agnicalendar_series',
    description:
      'Monthly satellite-detection totals from the AgniCalendar harmonized dataset (10 km cells x UTC month, 2002-2025) — a SEPARATE product from the FIRMS country archive. Use for "monthly/seasonal activity in a region over many years" on the harmonized grid. layer=aqua (MODIS Aqua counts, reference), snpp (VIIRS SNPP counts, from 2012), or harmonized (RF-B estimates on approved support only). daynight=day|night|unknown|known. fire_type=0 is presumed vegetation. Missing months are unavailable data, never zero. Descriptive calendar — never a forecast.',
    parameters: {
      type: 'object',
      properties: {
        layer: { type: 'string', enum: ['aqua', 'snpp', 'harmonized'], description: 'Measurement layer. Default aqua.' },
        daynight: { type: 'string', enum: ['day', 'night', 'unknown', 'known'], description: 'DAY+NIGHT known components (default), single component, or UNKNOWN-DN.' },
        fire_type: { type: 'string', enum: ['0', '1', '2', '3', 'UNKNOWN', 'all'], description: "Fire type; '0' is source-reported presumed vegetation. Default '0'." },
        bbox: { type: 'string', description: 'Optional west,south,east,north bounding box. Omit for global.' },
        country: { type: 'string', description: 'Optional country name (majority-vote cell mapping, e.g. "Australia", "Brazil"). Overrides bbox.' },
        start_year: { type: 'integer', description: 'First year, 2002-2025.' },
        end_year: { type: 'integer', description: 'Last year, 2002-2025.' },
      },
      required: [],
    },
  },
  {
    name: 'agnicalendar_calendar',
    description:
      'Seasonal month-profile of the AgniCalendar harmonized dataset: total detections and years-with-data per calendar month for a scope (global or bbox). Use for "which months are usually most active in REGION on the harmonized grid", "long-term seasonal pattern". Returns observed-only totals — missing cell-months are unavailable, not zero. Descriptive climatology, never a forecast.',
    parameters: {
      type: 'object',
      properties: {
        layer: { type: 'string', enum: ['aqua', 'snpp', 'harmonized'] },
        daynight: { type: 'string', enum: ['day', 'night', 'unknown', 'known'] },
        fire_type: { type: 'string', enum: ['0', '1', '2', '3', 'UNKNOWN', 'all'] },
        bbox: { type: 'string', description: 'Optional west,south,east,north bounding box. Omit for global.' },
        country: { type: 'string', description: 'Optional country name (majority-vote cell mapping). Overrides bbox.' },
        start_year: { type: 'integer' },
        end_year: { type: 'integer' },
      },
      required: [],
    },
  },
  {
    name: 'agnicalendar_cells',
    description:
      'Top 10 km grid cells by detection count for ONE year+month in the AgniCalendar harmonized dataset. Use for "where were the most active cells in MONTH YEAR". Returns cell_id, lat/lon centre, detections and FRP sum (sensor layers only). Cells are detection aggregates, not fire perimeters.',
    parameters: {
      type: 'object',
      properties: {
        year: { type: 'integer', description: '2002-2025.' },
        month: { type: 'integer', description: '1-12.' },
        layer: { type: 'string', enum: ['aqua', 'snpp', 'harmonized'] },
        daynight: { type: 'string', enum: ['day', 'night', 'unknown', 'known'] },
        fire_type: { type: 'string', enum: ['0', '1', '2', '3', 'UNKNOWN', 'all'] },
        bbox: { type: 'string', description: 'Optional west,south,east,north bounding box. Omit for global.' },
        country: { type: 'string', description: 'Optional country name (majority-vote cell mapping). Overrides bbox.' },
        limit: { type: 'integer', description: 'Top N cells, 1-50. Default 15.', minimum: 1, maximum: 50 },
      },
      required: ['year', 'month'],
    },
  },
  {
    name: 'official_incidents',
    description:
      'Official US wildland-fire incident records (WFIGS/IRWIN, refreshed ~5 min) corroborated against satellite detections. Use for "are there official/verified fires", "real world incidents near X", "incidents in STATE". Returns incidents with match=satellite_corroborated|no_nearby_detections, nearby detection counts, size acres, containment, cause, discovery time. US wildland fires only; RX=prescribed fire. A satellite anomaly is never an official confirmation — corroboration means detections occurred near the incident in time and space.',
    parameters: {
      type: 'object',
      properties: {
        days: { type: 'integer', description: 'Incidents discovered within this many days, 1-60. Default 14.' },
        state: { type: 'string', description: 'Optional US state filter in IRWIN form, e.g. "US-CO", "US-CA".' },
      },
      required: [],
    },
  },
  {
    name: 'focus_region',
    description: 'Move the map to a study region listed by list_regions.',
    parameters: {
      type: 'object',
      properties: {
        region_id: { type: 'string', description: 'Region id from list_regions, e.g. "amazon".' },
      },
      required: ['region_id'],
    },
  },
];

export interface AiToolExecution {
  record: AiToolCallRecord;
  /** Exactly what the model sees. Compact, bounded, and free of raw credentials. */
  response: Record<string, unknown>;
  action?: AiMapAction;
  dataNotes: string[];
}

const MAX_DAYS = 5;

function clampDays(raw: unknown): number {
  const days = Math.floor(Number(raw));
  if (!Number.isFinite(days) || days < 1) return 1;
  return Math.min(days, MAX_DAYS);
}

function confidenceValue(value: number | string): number {
  if (typeof value === 'number') return value;
  // F56 fix: map VIIRS raw categorical values ('h','n','l') and canonical labels consistently.
  if (value === 'high' || value === 'h') return 80;
  if (value === 'nominal' || value === 'n') return 50;
  if (value === 'low' || value === 'l') return 30;
  return 0;
}

function evidenceFields(o: CanonicalObservation): AiDetectionEvidence {
  const evidence: AiDetectionEvidence = {
    id: o.id,
    sensor: o.sensor,
    satellite: o.satellite,
    latitude: o.latitude,
    longitude: o.longitude,
    acq_date: o.acq_date,
    acq_time: o.acq_time,
    datetime_utc: o.datetime_utc,
    confidence: o.confidence,
    frp_mw: o.frp_mw,
    product: o.product,
    provenance_status: o.provenance_status ?? 'UNVERIFIED',
  };
  if (typeof o.brightness === 'number') evidence.brightness = o.brightness;
  if (typeof o.bright_ti4 === 'number') evidence.bright_ti4 = o.bright_ti4;
  if (typeof o.bright_ti5 === 'number') evidence.bright_ti5 = o.bright_ti5;
  if (o.daynight) evidence.daynight = o.daynight;
  if (typeof o.scan === 'number') evidence.scan = o.scan;
  if (typeof o.track === 'number') evidence.track = o.track;
  return evidence;
}

function summarise(
  observations: CanonicalObservation[],
  params: { days: number; bbox: string | null; sensors: 'ALL' | 'MODIS' | 'VIIRS'; minFrp: number | null; minConfidence: number | null; limit: number },
  payload: Awaited<ReturnType<AiObservationLoader>>
): AiHotspotSummary {
  const modis = observations.filter((o) => o.sensor === 'MODIS');
  const viirs = observations.filter((o) => o.sensor === 'VIIRS');
  const times = observations.map((o) => o.datetime_utc).sort();
  const cells = aggregateToSpatialTemporalGrid(observations, 1.0);
  const notes: string[] = [
    `Live window: the last ${params.days} day(s) of NASA FIRMS NRT data.`,
    'MODIS and VIIRS counts are reported separately and are never added together.',
  ];
  if (payload.truncated) notes.push('The upstream response was capped before analysis, so counts are a lower bound.');
  if (payload.source === 'store') notes.push('Source is the local store, not live NRT data.');
  for (const error of payload.errors.slice(0, 3)) notes.push(`Source error: ${error}`);

  return {
    window_days: params.days,
    bbox_used: params.bbox ?? 'world',
    filters: { sensors: params.sensors, min_frp: params.minFrp, min_confidence: params.minConfidence },
    total_matching: observations.length,
    by_sensor: { MODIS: modis.length, VIIRS: viirs.length },
    frp_mw: {
      MODIS: Number(modis.reduce((sum, o) => sum + o.frp_mw, 0).toFixed(1)),
      VIIRS: Number(viirs.reduce((sum, o) => sum + o.frp_mw, 0).toFixed(1)),
    },
    active_1km_cells: cells.size,
    first_detection_utc: times[0] ?? null,
    last_detection_utc: times[times.length - 1] ?? null,
    sample: [...observations]
      .sort((a, b) => (a.datetime_utc < b.datetime_utc ? 1 : -1))
      .slice(0, params.limit)
      .map(evidenceFields),
    source: payload.source,
    provenance_status: payload.provenance,
    retrieved_at: payload.retrieved_at,
    source_errors: payload.errors.slice(0, 5),
    truncated: payload.truncated,
    notes,
  };
}

/** Injectable historical-archive access so tests never touch the real Parquet store. */
export interface HistoryToolDeps {
  status?: () => Promise<{
    available: boolean;
    sensors: Record<string, { years: number[]; min_date: string | null; max_date: string | null; rows: number | null }>;
  }>;
  yearTotals?: (
    sensor: 'MODIS' | 'VIIRS',
    year: number
  ) => Promise<{ detections: number; frp_sum_mw: number | null; days_with_data: number } | null>;
  daily?: (q: {
    year?: number;
    month?: number;
    startDate?: string;
    endDate?: string;
    sensor?: string;
    country?: string;
    level?: 'daily' | 'monthly';
    global?: boolean;
    limit?: number;
  }) => Promise<{ rows: DailyRow[]; truncated: boolean }>;
  periodTotals?: (q: {
    startYear: number;
    endYear: number;
    country?: string;
    sensor?: string;
  }) => Promise<PeriodYearRow[]>;
  countries?: () => Promise<string[]>;
  countryTotals?: (year: number) => Promise<CountryTotal[]>;
  frpExtremes?: (q: {
    sensor?: string;
    country?: string;
    startYear?: number;
    endYear?: number;
    limit?: number;
  }) => Promise<FrpExtremeRow[]>;
  persistence?: (q: {
    startYear?: number;
    endYear?: number;
    sensor?: string;
    limit?: number;
  }) => Promise<PersistenceRow[]>;
  monthAnomaly?: (q: {
    year: number;
    month: number;
    country?: string;
    sensor?: string;
    limit?: number;
  }) => Promise<MonthAnomalyRow[]>;
  climatology?: (q: {
    country?: string;
    bbox?: { west: number; south: number; east: number; north: number };
    sensor?: string;
    startYear?: number;
    endYear?: number;
  }) => Promise<ClimatologyResponse>;
  seasonalStatus?: (q: {
    country: string;
    sensor?: string;
    date?: string;
    windowDays?: number;
    observed?: { MODIS?: number; VIIRS?: number };
  }) => Promise<SeasonalStatusResponse | null>;
}

/** Injectable AgniCalendar access so tests never touch the real Parquet store. */
export interface AgniToolDeps {
  status?: () => Promise<{
    available: boolean;
    rows: number | null;
    min_year: number | null;
    max_year: number | null;
    min_month: string | null;
    max_month: string | null;
  }>;
  series?: (q: {
    scope?: { kind: 'global' } | { kind: 'bbox'; bbox: { west: number; south: number; east: number; north: number } };
    country?: string;
    layer?: 'aqua' | 'snpp' | 'harmonized';
    daynight?: 'day' | 'night' | 'unknown' | 'known';
    fireType?: '0' | '1' | '2' | '3' | 'UNKNOWN' | 'all';
    startYear?: number;
    endYear?: number;
    year?: number;
    month?: number;
  }) => Promise<Array<{ year: number; month: number; detections: number | null; cells_with_data: number; partial_coverage: boolean }>>;
  cells?: (q: {
    scope?: { kind: 'global' } | { kind: 'bbox'; bbox: { west: number; south: number; east: number; north: number } };
    country?: string;
    layer?: 'aqua' | 'snpp' | 'harmonized';
    daynight?: 'day' | 'night' | 'unknown' | 'known';
    fireType?: '0' | '1' | '2' | '3' | 'UNKNOWN' | 'all';
    startYear?: number;
    endYear?: number;
    year?: number;
    month?: number;
    limit?: number;
  }) => Promise<Array<{ cell_id: string; grid_row: number; grid_col: number; lon: number; lat: number; value: number | null; frp_sum_mw: number | null }>>;
  countries?: () => Promise<string[]>;
}

export interface IncidentToolDeps {
  verify?: (
    observations: CanonicalObservation[],
    opts: { days?: number; state?: string }
  ) => Promise<IncidentVerification>;
}

async function resolveIncidents(deps: IncidentToolDeps | undefined) {
  const mod = await import('../incidents');
  return {
    verify:
      deps?.verify ??
      ((observations: CanonicalObservation[], opts: { days?: number; state?: string }) =>
        mod.verifyIncidents(observations, opts)),
  };
}

async function resolveAgni(deps: AgniToolDeps | undefined) {
  const mod = await import('../agnicalendar');
  return {
    status: deps?.status ?? (() => mod.agniStatus()),
    series: deps?.series ?? ((q: Parameters<NonNullable<AgniToolDeps['series']>>[0]) => mod.agniMonthlySeries(q)),
    cells: deps?.cells ?? ((q: Parameters<NonNullable<AgniToolDeps['cells']>>[0]) => mod.agniTopCells(q)),
    countries: deps?.countries ?? (() => mod.agniCountries()),
  };
}

async function resolveHistory(deps: HistoryToolDeps | undefined) {
  const mod = await import('../historical');
  return {
    status: deps?.status ?? (() => mod.historicalStatus()),
    yearTotals: deps?.yearTotals ?? ((s: 'MODIS' | 'VIIRS', y: number) => mod.historicalYearTotals(s, y)),
    daily: deps?.daily ?? ((q: Parameters<NonNullable<HistoryToolDeps['daily']>>[0]) => mod.historicalDaily(q)),
    periodTotals:
      deps?.periodTotals ??
      ((q: Parameters<NonNullable<HistoryToolDeps['periodTotals']>>[0]) => mod.historicalPeriodTotals(q)),
    countries: deps?.countries ?? (() => mod.historicalCountries()),
    countryTotals: deps?.countryTotals ?? ((y: number) => mod.historicalCountryTotals(y)),
    frpExtremes: deps?.frpExtremes ?? ((q: Parameters<NonNullable<HistoryToolDeps['frpExtremes']>>[0]) => mod.historicalFrpExtremes(q)),
    persistence: deps?.persistence ?? ((q: Parameters<NonNullable<HistoryToolDeps['persistence']>>[0]) => mod.historicalPersistence(q)),
    monthAnomaly: deps?.monthAnomaly ?? ((q: Parameters<NonNullable<HistoryToolDeps['monthAnomaly']>>[0]) => mod.historicalMonthAnomaly(q)),
    climatology: deps?.climatology ?? ((q: Parameters<NonNullable<HistoryToolDeps['climatology']>>[0]) => mod.historicalClimatology(q)),
    seasonalStatus: deps?.seasonalStatus ?? ((q: Parameters<NonNullable<HistoryToolDeps['seasonalStatus']>>[0]) => mod.historicalSeasonalStatus(q)),
  };
}

/**
 * Execute one model tool call. Unknown tools, bad arguments and unknown regions return an explicit
 * failure to the model instead of being silently repaired.
 */
export async function executeAiTool(
  name: string,
  args: Record<string, unknown>,
  deps: { load: AiObservationLoader; today: string; maxSample?: number; history?: HistoryToolDeps; agni?: AgniToolDeps; incidents?: IncidentToolDeps }
): Promise<AiToolExecution> {
  const { load, today } = deps;

  if (name === 'list_regions') {
    const regions = STUDY_REGIONS.map((r) => ({
      id: r.id,
      name: r.name,
      country: r.country,
      bbox: `${r.bbox.west},${r.bbox.south},${r.bbox.east},${r.bbox.north}`,
    }));
    return {
      record: { name, ok: true, summary: `${regions.length} study regions available.` },
      response: { ok: true, regions },
      dataNotes: [],
    };
  }

  if (name === 'focus_region') {
    const regionId = typeof args.region_id === 'string' ? args.region_id.toLowerCase() : '';
    const region = STUDY_REGIONS.find((r) => r.id === regionId || r.name.toLowerCase() === regionId);
    if (!region) {
      return {
        record: { name, ok: false, summary: 'Unknown region id.' },
        response: { ok: false, error: `Unknown region "${regionId}". Call list_regions first.` },
        dataNotes: [],
      };
    }
    const bbox = `${region.bbox.west},${region.bbox.south},${region.bbox.east},${region.bbox.north}`;
    const parsed = parseMapAction({ type: 'focus_region', region_id: region.id, name: region.name, bbox }, today);
    if (!parsed.ok) {
      return {
        record: { name, ok: false, summary: parsed.error },
        response: { ok: false, error: parsed.error },
        dataNotes: [],
      };
    }
    return {
      record: { name, ok: true, summary: `Focused ${region.name}.` },
      response: { ok: true, focused_region: { id: region.id, name: region.name, bbox } },
      action: parsed.value,
      dataNotes: [],
    };
  }

  if (name === 'apply_map_filters') {
    const parsed = parseMapAction({ type: 'apply_filters', ...args }, today);
    if (!parsed.ok) {
      return {
        record: { name, ok: false, summary: parsed.error },
        response: { ok: false, error: parsed.error },
        dataNotes: [],
      };
    }
    return {
      record: { name, ok: true, summary: 'Map filters queued for the UI.' },
      response: { ok: true, applied: parsed.value, note: 'The browser applies this to the map now.' },
      action: parsed.value,
      dataNotes: [],
    };
  }

  if (name === 'rank_regions') {
    const days = clampDays(args.days);
    const payload = await load({ days, bbox: null });
    const regions = STUDY_REGIONS.map((region) => {
      const inside = payload.observations.filter((o) =>
        isPointInBbox(o.latitude, o.longitude, region.bbox)
      );
      const modis = inside.filter((o) => o.sensor === 'MODIS').length;
      const viirs = inside.filter((o) => o.sensor === 'VIIRS').length;
      return {
        id: region.id,
        name: region.name,
        country: region.country,
        modis_detections: modis,
        viirs_detections: viirs,
        // EXPLORATORY ranking score only: MODIS+VIIRS detections summed for ordering. Never a fire count.
        exploratory_detection_total: modis + viirs,
        active_1km_cells: aggregateToSpatialTemporalGrid(inside, 1.0).size,
      };
    }).sort((a, b) => b.exploratory_detection_total - a.exploratory_detection_total);
    const notes = [
      'Regions are ranked by an EXPLORATORY sum of MODIS and VIIRS detections; per-sensor counts are authoritative and are never merged into a fire count.',
      'Only the four built-in study regions are ranked; this is not a world country ranking.',
      'A region with zero detections means no observation record matched its bbox in this window, not confirmed zero fire.',
    ];
    if (payload.truncated) notes.push('The upstream response was capped before analysis, so counts are a lower bound.');
    if (payload.source === 'store') notes.push('Source is the local store, not live NRT data.');
    for (const error of payload.errors.slice(0, 3)) notes.push(`Source error: ${error}`);
    return {
      record: {
        name,
        ok: true,
        summary: `Top region: ${regions[0]?.name ?? 'none'} (${regions[0]?.exploratory_detection_total ?? 0} detections, EXPLORATORY).`,
      },
      response: {
        ok: true,
        ranking: {
          window_days: days,
          regions,
          source: payload.source,
          provenance_status: payload.provenance,
          retrieved_at: payload.retrieved_at,
          truncated: payload.truncated,
          notes,
        },
      },
      dataNotes: notes.slice(0, 2),
    };
  }

  if (name === 'hottest_detections') {
    const days = clampDays(args.days);
    let bbox: string | null = null;
    if (args.bbox !== undefined && args.bbox !== null && args.bbox !== '') {
      if (!isValidBbox(args.bbox)) {
        return {
          record: { name, ok: false, summary: 'Invalid bbox.' },
          response: { ok: false, error: 'bbox must be "west,south,east,north" with west<east and south<north.' },
          dataNotes: [],
        };
      }
      bbox = args.bbox;
    }
    const sensors = args.sensors === 'MODIS' || args.sensors === 'VIIRS' ? args.sensors : 'ALL';
    const limit = Math.min(Math.max(Math.floor(Number(args.limit)) || 3, 1), 5);

    const payload = await load({ days, bbox });
    let filtered = payload.observations;
    if (sensors !== 'ALL') filtered = filtered.filter((o) => o.sensor === sensors);

    const perSensor: Record<'MODIS' | 'VIIRS', ReturnType<typeof evidenceFields>[]> = { MODIS: [], VIIRS: [] };
    for (const sensor of ['MODIS', 'VIIRS'] as const) {
      perSensor[sensor] = filtered
        .filter((o) => o.sensor === sensor)
        .sort((a, b) => b.frp_mw - a.frp_mw)
        .slice(0, limit)
        .map(evidenceFields);
    }
    const notes = [
      'FRP is fire radiative power in MW; MODIS and VIIRS tops are reported separately and are not ranked against each other because pixel sizes and overpass timing differ.',
      'A high-FRP detection is still a satellite thermal anomaly, not a confirmed wildfire.',
    ];
    if (payload.truncated) notes.push('The upstream response was capped before analysis, so the true maximum may be higher.');
    if (payload.source === 'store') notes.push('Source is the local store, not live NRT data.');
    for (const error of payload.errors.slice(0, 3)) notes.push(`Source error: ${error}`);
    // F59 fix: use a reduce loop for the extremum instead of Math.max(...spread),
    // which exceeds the JS argument limit for large (200,000+) result sets.
    const topFrp = filtered.reduce((max, o) => (o.frp_mw > max ? o.frp_mw : max), 0);
    return {
      record: {
        name,
        ok: true,
        summary: `Highest FRP ${topFrp} MW (per-sensor tops returned).`,
      },
      response: {
        ok: true,
        hottest: {
          window_days: days,
          bbox_used: bbox ?? 'world',
          sensors,
          top_per_sensor: perSensor,
          source: payload.source,
          provenance_status: payload.provenance,
          retrieved_at: payload.retrieved_at,
          truncated: payload.truncated,
          notes,
        },
      },
      dataNotes: notes.slice(0, 2),
    };
  }

  if (name === 'query_hotspots' || name === 'sensor_comparison') {
    const days = clampDays(args.days);
    let bbox: string | null = null;
    if (args.bbox !== undefined && args.bbox !== null && args.bbox !== '') {
      if (!isValidBbox(args.bbox)) {
        return {
          record: { name, ok: false, summary: 'Invalid bbox.' },
          response: { ok: false, error: 'bbox must be "west,south,east,north" with west<east and south<north.' },
          dataNotes: [],
        };
      }
      bbox = args.bbox;
    }
    const sensors = args.sensors === 'MODIS' || args.sensors === 'VIIRS' ? args.sensors : 'ALL';
    const minFrp = Number.isFinite(Number(args.min_frp)) ? Number(args.min_frp) : null;
    const minConfidence = Number.isFinite(Number(args.min_confidence)) ? Number(args.min_confidence) : null;
    const limit = Math.min(Math.max(Math.floor(Number(args.limit)) || 5, 1), deps.maxSample ?? 25);

    const payload = await load({ days, bbox });
    let filtered = payload.observations;
    if (sensors !== 'ALL') filtered = filtered.filter((o) => o.sensor === sensors);
    if (minFrp !== null) filtered = filtered.filter((o) => o.frp_mw >= minFrp);
    if (minConfidence !== null) filtered = filtered.filter((o) => confidenceValue(o.confidence) >= minConfidence);

    if (name === 'query_hotspots') {
      const summary = summarise(filtered, { days, bbox, sensors, minFrp, minConfidence, limit }, payload);
      return {
        record: {
          name,
          ok: true,
          summary: `${summary.total_matching} detections (MODIS ${summary.by_sensor.MODIS}, VIIRS ${summary.by_sensor.VIIRS}).`,
        },
        response: { ok: true, summary: summary as unknown as Record<string, unknown> },
        dataNotes: summary.notes.slice(0, 3),
      };
    }

    const modis = filtered.filter((o) => o.sensor === 'MODIS').length;
    const viirs = filtered.filter((o) => o.sensor === 'VIIRS').length;
    const cells = Array.from(aggregateToSpatialTemporalGrid(filtered, 1.0).values());
    const pairedCells = cells.filter((c) => c.modis_count > 0 && c.viirs_count > 0).length;
    const notes = [
      'Each sensor is counted alone; they are never summed into a fire count.',
      'Paired cells are 1 km daily cells where both sensors reported at least one detection.',
    ];
    if (payload.truncated) notes.push('Upstream data was capped, so counts are a lower bound.');
    return {
      record: { name, ok: true, summary: `MODIS ${modis}, VIIRS ${viirs}, paired cells ${pairedCells}.` },
      response: {
        ok: true,
        comparison: {
          window_days: days,
          bbox_used: bbox ?? 'world',
          modis_detections: modis,
          viirs_detections: viirs,
          viirs_to_modis_ratio: modis > 0 ? Number((viirs / modis).toFixed(2)) : null,
          paired_1km_cells: pairedCells,
          active_1km_cells: cells.length,
          source: payload.source,
          provenance_status: payload.provenance,
          retrieved_at: payload.retrieved_at,
          truncated: payload.truncated,
          notes,
        },
      },
      dataNotes: notes.slice(0, 2),
    };
  }

  if (name === 'history_country_rankings') {
    const year = Math.floor(Number(args.year));
    if (!Number.isInteger(year) || year < 2000 || year > 2025) {
      return {
        record: { name, ok: false, summary: 'Invalid year.' },
        response: { ok: false, error: 'year must be an integer between 2000 and 2025.' },
        dataNotes: [],
      };
    }
    const history = await resolveHistory(deps.history);
    const status = await history.status().catch(() => null);
    if (!status?.available) {
      return {
        record: { name, ok: false, summary: 'Historical archive unavailable.' },
        response: { ok: false, error: 'The local historical archive is not available on this server.' },
        dataNotes: [],
      };
    }
    const sensor = args.sensor === 'MODIS' || args.sensor === 'VIIRS' ? args.sensor : undefined;
    const limit = Math.min(Math.max(Math.floor(Number(args.limit)) || 10, 1), 20);
    let rows = await history.countryTotals(year).catch(() => [] as CountryTotal[]);
    if (sensor) rows = rows.filter((r) => r.sensor === sensor);
    const top = {
      MODIS: rows.filter((r) => r.sensor === 'MODIS').slice(0, limit),
      VIIRS: rows.filter((r) => r.sensor === 'VIIRS').slice(0, limit),
    };
    const notes = [
      'Country labels come from the source archive ZIP filenames, not a spatial join.',
      'MODIS and VIIRS rankings are separate and never merged; VIIRS is Suomi-NPP only from 2012-01-20.',
      'Counts are satellite thermal anomalies, not confirmed wildfires.',
    ];
    const topName = top.MODIS[0] ?? top.VIIRS[0];
    return {
      record: {
        name,
        ok: true,
        summary: `${year} top country: ${topName?.country ?? 'none'} (${topName?.sensor ?? '-'}, ${topName?.detections.toLocaleString() ?? 0}).`,
      },
      response: {
        ok: true,
        year,
        sensor: sensor ?? 'ALL',
        top_per_sensor: top,
        notes,
      },
      dataNotes: notes.slice(0, 2),
    };
  }

  if (name === 'history_period_summary') {
    const startYear = Math.floor(Number(args.start_year));
    const endYear = Math.floor(Number(args.end_year));
    if (!Number.isInteger(startYear) || !Number.isInteger(endYear) || startYear < 2000 || endYear > 2025 || startYear > endYear) {
      return {
        record: { name, ok: false, summary: 'Invalid year range.' },
        response: { ok: false, error: 'start_year and end_year must be integers with 2000 <= start_year <= end_year <= 2025.' },
        dataNotes: [],
      };
    }
    const history = await resolveHistory(deps.history);
    const status = await history.status().catch(() => null);
    if (!status?.available) {
      return {
        record: { name, ok: false, summary: 'Historical archive unavailable.' },
        response: { ok: false, error: 'The local historical archive is not available on this server.' },
        dataNotes: [],
      };
    }
    const sensor = args.sensor === 'MODIS' || args.sensor === 'VIIRS' ? args.sensor : undefined;
    const country = typeof args.country === 'string' && args.country.trim() ? args.country.trim() : undefined;
    const rows = await history
      .periodTotals({ startYear, endYear, country, sensor })
      .catch(() => [] as PeriodYearRow[]);

    // Per-sensor period totals computed deterministically; sensors never merged.
    const totalsBySensor: Record<
      string,
      { detections: number; frp_sum_mw: number | null; years_with_data: number; day_count: number; night_count: number }
    > = {};
    for (const sensorName of ['MODIS', 'VIIRS'] as const) {
      const mine = rows.filter((r) => r.sensor === sensorName);
      if (!mine.length) continue;
      totalsBySensor[sensorName] = {
        detections: mine.reduce((a, r) => a + r.detections, 0),
        frp_sum_mw: mine.every((r) => r.frp_sum_mw == null)
          ? null
          : mine.reduce((a, r) => a + (r.frp_sum_mw ?? 0), 0),
        years_with_data: mine.length,
        day_count: mine.reduce((a, r) => a + (r.day_count ?? 0), 0),
        night_count: mine.reduce((a, r) => a + (r.night_count ?? 0), 0),
      };
    }
    const notes = [
      'Local FIRMS historical archive; counts are satellite thermal anomalies (hotspot detections), not confirmed wildfires or burned area.',
      'MODIS and VIIRS totals are reported separately and are never summed into one figure.',
      'VIIRS is Suomi-NPP only (from 2012-01-20); years before that have MODIS coverage only.',
      'Country labels come from the source archive filenames.',
    ];
    const summaryParts = Object.entries(totalsBySensor).map(
      ([s, t]) => `${s} ${t.detections.toLocaleString()}`
    );
    return {
      record: {
        name,
        ok: true,
        summary: `${startYear}-${endYear}${country ? ` ${country}` : ' global'}: ${summaryParts.join(', ') || 'no rows'} detections.`,
      },
      response: {
        ok: true,
        query: { start_year: startYear, end_year: endYear, country: country ?? 'GLOBAL', sensor: sensor ?? 'ALL' },
        per_year: rows,
        totals_by_sensor: totalsBySensor,
        notes,
      },
      dataNotes: notes.slice(0, 3),
    };
  }

  if (name === 'history_frp_extremes' || name === 'history_persistent_countries') {
    const history = await resolveHistory(deps.history);
    const status = await history.status().catch(() => null);
    if (!status?.available) {
      return {
        record: { name, ok: false, summary: 'Historical archive unavailable.' },
        response: { ok: false, error: 'The local historical archive is not available on this server.' },
        dataNotes: [],
      };
    }
    const sensor = args.sensor === 'MODIS' || args.sensor === 'VIIRS' ? args.sensor : undefined;
    const parseYear = (v: unknown): number | undefined => {
      if (v === undefined || v === null || v === '') return undefined;
      const n = Math.floor(Number(v));
      return Number.isInteger(n) && n >= 2000 && n <= 2025 ? n : undefined;
    };
    const startYear = parseYear(args.start_year);
    const endYear = parseYear(args.end_year);
    if ((args.start_year !== undefined && args.start_year !== null && args.start_year !== '' && startYear === undefined) ||
        (args.end_year !== undefined && args.end_year !== null && args.end_year !== '' && endYear === undefined)) {
      return {
        record: { name, ok: false, summary: 'Invalid year range.' },
        response: { ok: false, error: 'start_year/end_year must be integers between 2000 and 2025.' },
        dataNotes: [],
      };
    }
    const limit = Math.min(Math.max(Math.floor(Number(args.limit)) || (name === 'history_frp_extremes' ? 10 : 20), 1), 50);

    if (name === 'history_frp_extremes') {
      const country = typeof args.country === 'string' && args.country.trim() ? args.country.trim() : undefined;
      const rows = await history.frpExtremes({ sensor, country, startYear, endYear, limit }).catch(() => [] as FrpExtremeRow[]);
      const notes = [
        'FRP maxima are daily-aggregate maxima (max of per-day frp_max_mw) from the local FIRMS archive, not single-observation extremes.',
        'MODIS and VIIRS rows stay separate and are never merged; counts are satellite thermal anomalies, not confirmed wildfires.',
      ];
      const top = rows[0];
      return {
        record: {
          name,
          ok: true,
          summary: top ? `Top daily FRP max ${top.frp_max_mw} MW on ${top.period} (${top.country}, ${top.sensor}).` : 'No FRP rows in range.',
        },
        response: { ok: true, query: { sensor: sensor ?? 'ALL', country: country ?? 'GLOBAL', start_year: startYear ?? null, end_year: endYear ?? null }, rows, notes },
        dataNotes: notes.slice(0, 2),
      };
    }

    const rows = await history.persistence({ sensor, startYear, endYear, limit }).catch(() => [] as PersistenceRow[]);
    const notes = [
      'years_with_data counts distinct archive years with detections per country+sensor — a recurring-activity proxy.',
      'MODIS and VIIRS rows stay separate and are never merged; VIIRS is Suomi-NPP only from 2012-01-20.',
    ];
    const top = rows[0];
    return {
      record: {
        name,
        ok: true,
        summary: top ? `${top.country} (${top.sensor}): detections in ${top.years_with_data} distinct years.` : 'No persistence rows in range.',
      },
      response: { ok: true, query: { sensor: sensor ?? 'ALL', start_year: startYear ?? null, end_year: endYear ?? null }, rows, notes },
      dataNotes: notes.slice(0, 2),
    };
  }

  if (name === 'history_month_anomaly') {
    const history = await resolveHistory(deps.history);
    const status = await history.status().catch(() => null);
    if (!status?.available) {
      return {
        record: { name, ok: false, summary: 'Historical archive unavailable.' },
        response: { ok: false, error: 'The local historical archive is not available on this server.' },
        dataNotes: [],
      };
    }
    const year = Math.floor(Number(args.year));
    const month = Math.floor(Number(args.month));
    if (!Number.isInteger(year) || year < 2000 || year > 2025 || !Number.isInteger(month) || month < 1 || month > 12) {
      return {
        record: { name, ok: false, summary: 'Invalid year/month.' },
        response: { ok: false, error: 'year must be 2000-2025 and month 1-12.' },
        dataNotes: [],
      };
    }
    const sensor = args.sensor === 'MODIS' || args.sensor === 'VIIRS' ? args.sensor : undefined;
    const country = typeof args.country === 'string' && args.country.trim() ? args.country.trim() : undefined;
    const limit = Math.min(Math.max(Math.floor(Number(args.limit)) || 20, 1), 50);
    const rows = await history.monthAnomaly({ year, month, country, sensor, limit }).catch(() => [] as MonthAnomalyRow[]);
    const notes = [
      'Each ratio compares a country+sensor month against the median of the same calendar month in all other archive years.',
      'Anomalies are statistical variation only — not confirmed fires, fire perimeters, or forecasts. MODIS and VIIRS stay separate.',
    ];
    const top = rows[0];
    return {
      record: {
        name,
        ok: true,
        summary: top
          ? `${top.country} ${top.sensor}: ${top.detections.toLocaleString()} detections vs median ${top.other_years_median?.toLocaleString() ?? 'unavailable (fewer than five valid years)'} (ratio ${top.ratio ?? 'n/a'}).`
          : `No anomaly rows for ${year}-${String(month).padStart(2, '0')}.`,
      },
      response: { ok: true, query: { year, month, country: country ?? 'GLOBAL', sensor: sensor ?? 'ALL' }, rows, notes },
      dataNotes: notes.slice(0, 2),
    };
  }

  if (name === 'history_seasonal_profile' || name === 'history_seasonal_status') {
    const history = await resolveHistory(deps.history);
    const status = await history.status().catch(() => null);
    if (!status?.available) {
      return {
        record: { name, ok: false, summary: 'Historical archive unavailable.' },
        response: { ok: false, error: 'The local historical archive is not available on this server.' },
        dataNotes: [],
      };
    }
    const sensor = args.sensor === 'MODIS' || args.sensor === 'VIIRS' ? args.sensor : undefined;

    if (name === 'history_seasonal_profile') {
      const country = typeof args.country === 'string' && args.country.trim() ? args.country.trim() : undefined;
      let bbox: { west: number; south: number; east: number; north: number } | undefined;
      if (typeof args.bbox === 'string' && args.bbox.trim()) {
        const parts = args.bbox.split(',').map(Number);
        if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n)) || parts[0] >= parts[2] || parts[1] >= parts[3]) {
          return {
            record: { name, ok: false, summary: 'Invalid bbox.' },
            response: { ok: false, error: 'bbox must be west,south,east,north with west<east and south<north.' },
            dataNotes: [],
          };
        }
        bbox = { west: parts[0], south: parts[1], east: parts[2], north: parts[3] };
      }
      if (!country && !bbox) {
        return {
          record: { name, ok: false, summary: 'Missing scope.' },
          response: { ok: false, error: 'Provide a country or a bbox.' },
          dataNotes: [],
        };
      }
      const clim = await history.climatology({ country, bbox, sensor }).catch(() => null);
      if (!clim || !clim.months.length) {
        return {
          record: { name, ok: false, summary: 'No climatology data for scope.' },
          response: { ok: false, error: 'No climatology rows for the requested scope (archive coverage or climate grid missing).' },
          dataNotes: [],
        };
      }
      const monthRows = clim.months.map((m) => ({
        month: m.month,
        class: m.activity_class,
        harmonized_equivalent_median: m.harmonized_equivalent_median,
        modis_median: m.sensors.MODIS?.median_detections ?? null,
        viirs_median: m.sensors.VIIRS?.median_detections ?? null,
      }));
      const notes = [
        'Seasonal climatology of the 2000-2025 archive — typical activity per calendar month, NOT a forecast.',
        'activity_class ranks each month against the scope\'s own seasonal range; MODIS and VIIRS medians stay separate.',
        'harmonized_equivalent_median uses the fixed 0.294 EXPLORATORY coefficient; it is not a validated calibration.',
      ];
      return {
        record: {
          name,
          ok: true,
          summary: `${country ?? 'bbox'}: peak months ${clim.season.peak_months.map((m) => String(m).padStart(2, '0')).join(', ') || 'none'}; classes ${[...new Set(clim.months.map((m) => m.activity_class))].join('/')}.`,
        },
        response: {
          ok: true,
          scope: clim.scope,
          year_range: clim.year_range,
          months: monthRows,
          peak_months: clim.season.peak_months,
          low_months: clim.season.low_months,
          notes,
        },
        dataNotes: notes.slice(0, 2),
      };
    }

    // history_seasonal_status
    const country = typeof args.country === 'string' && args.country.trim() ? args.country.trim() : '';
    if (!country) {
      return {
        record: { name, ok: false, summary: 'Missing country.' },
        response: { ok: false, error: 'country is required.' },
        dataNotes: [],
      };
    }
    const s = await history.seasonalStatus({ country, sensor }).catch(() => null);
    if (!s) {
      return {
        record: { name, ok: false, summary: 'No seasonal data for country.' },
        response: { ok: false, error: `No climatology data for "${country}".` },
        dataNotes: [],
      };
    }
    const notes = [
      'today_window is the historical distribution of detections for the same day-of-year window across archive years — climatology, not a forecast.',
      'upcoming_months classes describe historically typical activity for the next 3 calendar months.',
      'MODIS and VIIRS are reported separately; VIIRS is Suomi-NPP only.',
    ];
    return {
      record: {
        name,
        ok: true,
        summary: `${country} @ DOY ${s.day_of_year}: ${Object.entries(s.today_window).map(([sen, w]) => `${sen} median ${w.median_detections}`).join(', ')}; next months ${s.upcoming_months.map((u) => `${u.month}:${u.activity_class}`).join(', ')}.`,
      },
      response: {
        ok: true,
        country: s.country,
        date: s.date,
        day_of_year: s.day_of_year,
        window_days: s.window_days,
        today_window: s.today_window,
        upcoming_months: s.upcoming_months,
        notes,
      },
      dataNotes: notes.slice(0, 2),
    };
  }

  if (name === 'history_daily_series' || name === 'history_year_summary') {
    const year = Math.floor(Number(args.year));
    if (!Number.isInteger(year) || year < 2000 || year > 2025) {
      return {
        record: { name, ok: false, summary: 'Invalid year.' },
        response: { ok: false, error: 'year must be an integer between 2000 and 2025 (archive coverage).' },
        dataNotes: [],
      };
    }
    const history = await resolveHistory(deps.history);
    const status = await history.status().catch(() => null);
    if (!status?.available) {
      return {
        record: { name, ok: false, summary: 'Historical archive unavailable.' },
        response: { ok: false, error: 'The local historical archive is not available on this server.' },
        dataNotes: [],
      };
    }

    if (name === 'history_year_summary') {
      const sensorArg = args.sensor === 'MODIS' || args.sensor === 'VIIRS' ? args.sensor : 'ALL';
      const targets = sensorArg === 'ALL' ? (['MODIS', 'VIIRS'] as const) : ([sensorArg] as const);
      const perSensor: Record<string, unknown> = {};
      const notes = [
        'Local FIRMS historical archive; counts are satellite thermal anomalies, not confirmed wildfires.',
        'MODIS covers 2000-11-01 onward (Terra + Aqua); VIIRS covers 2012-01-20 onward and is Suomi-NPP only in this archive. MODIS and VIIRS are reported separately and never summed.',
        'A sensor with no rows for this year means the archive holds none for that period, not confirmed zero activity.',
      ];
      for (const sensor of targets) {
        const meta = status.sensors[sensor];
        const covered = meta?.years.includes(year) ?? false;
        const totals = covered ? await history.yearTotals(sensor, year).catch(() => null) : null;
        perSensor[sensor] = {
          archive_covers_year: covered,
          archive_year_range: meta ? `${meta.years[0]}-${meta.years[meta.years.length - 1]}` : null,
          detections: totals?.detections ?? null,
          frp_sum_mw: totals?.frp_sum_mw ?? null,
          days_with_data: totals?.days_with_data ?? null,
        };
        if (!covered) notes.push(`${sensor} archive does not cover ${year}.`);
      }
      const summaryParts = targets.map((s) => {
        const p = perSensor[s] as { detections?: number | null } | undefined;
        return `${s} ${p?.detections != null ? p.detections.toLocaleString() : 'n/a'}`;
      });
      return {
        record: { name, ok: true, summary: `Archive ${year}: ${summaryParts.join(', ')} detections.` },
        response: { ok: true, year, per_sensor: perSensor, notes },
        dataNotes: notes.slice(0, 3),
      };
    }

    // history_daily_series
    const sensor = args.sensor === 'MODIS' || args.sensor === 'VIIRS' ? args.sensor : undefined;
    const month = Number.isInteger(Number(args.month)) ? Math.floor(Number(args.month)) : undefined;
    if (month !== undefined && (month < 1 || month > 12)) {
      return {
        record: { name, ok: false, summary: 'Invalid month.' },
        response: { ok: false, error: 'month must be an integer between 1 and 12.' },
        dataNotes: [],
      };
    }
    const country = typeof args.country === 'string' && args.country.trim() ? args.country.trim() : undefined;
    const level = args.level === 'daily' ? 'daily' : args.level === 'monthly' ? 'monthly' : month ? 'daily' : 'monthly';
    const startDate = typeof args.start_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(args.start_date) ? args.start_date : undefined;
    const endDate = typeof args.end_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(args.end_date) ? args.end_date : undefined;
    if ((args.start_date && !startDate) || (args.end_date && !endDate)) {
      return {
        record: { name, ok: false, summary: 'Invalid date range.' },
        response: { ok: false, error: 'start_date and end_date must be real YYYY-MM-DD dates.' },
        dataNotes: [],
      };
    }
    if (startDate && endDate && startDate > endDate) {
      return {
        record: { name, ok: false, summary: 'Invalid date range.' },
        response: { ok: false, error: 'start_date must not be after end_date.' },
        dataNotes: [],
      };
    }
    const result = await history.daily({
      year,
      month,
      startDate,
      endDate,
      sensor,
      country,
      level,
      global: !country,
      limit: level === 'daily' ? 400 : 24,
    });
    const notes = [
      'Rows come from the local FIRMS historical archive; MODIS and VIIRS rows stay separate and are never summed.',
      'Periods absent from the result have no archive rows for the selected scope; that is missing coverage, not confirmed zero activity.',
      'VIIRS is Suomi-NPP only (from 2012-01-20); MODIS-only years are expected before that.',
    ];
    if (result.truncated) notes.push('Result was capped; totals may be incomplete.');
    return {
      record: {
        name,
        ok: true,
        summary: `${result.rows.length} ${level} rows for ${year}${country ? ` (${country})` : ' (global)'}${sensor ? ` ${sensor}` : ''}.`,
      },
      response: {
        ok: true,
        query: { year, month: month ?? null, sensor: sensor ?? 'ALL', country: country ?? 'GLOBAL', level },
        rows: result.rows,
        truncated: result.truncated,
        notes,
      },
      dataNotes: notes.slice(0, 3),
    };
  }

  if (name === 'official_incidents') {
    const rawDays = Math.floor(Number(args.days));
    const days = Number.isFinite(rawDays) ? Math.min(Math.max(rawDays, 1), 60) : 14;
    const state = typeof args.state === 'string' ? args.state.trim().toUpperCase().slice(0, 10) : undefined;
    const incidents = await resolveIncidents(deps.incidents);
    // Corroboration uses the same NRT observation window other tools load.
    const payload = await load({ days: clampDays(days), bbox: null });
    const result = await incidents.verify(payload.observations, { days, state }).catch((e: unknown) => ({
      error: e instanceof Error ? e.message : 'Incident source unavailable.',
    }));
    if ('error' in result) {
      return {
        record: { name, ok: false, summary: 'Official incident source unavailable.' },
        response: { ok: false, error: `Could not reach the official incident feed: ${result.error}` },
        dataNotes: [],
      };
    }
    const top = result.incidents
      .filter((i) => i.match === 'satellite_corroborated')
      .sort((a, b) => b.nearby_detections - a.nearby_detections)
      .slice(0, 10);
    return {
      record: {
        name,
        ok: true,
        summary: `${result.summary.total} official US incidents (${days}d): ${result.summary.satellite_corroborated} with nearby satellite detections.`,
      },
      response: {
        ok: true,
        query: { days, state: state ?? null },
        summary: result.summary,
        parameters: result.parameters,
        source: result.source,
        incidents: top.length === result.incidents.length ? result.incidents : [...top, ...result.incidents.filter((i) => i.match !== 'satellite_corroborated').slice(0, 10)],
        legend: result.legend,
        note: result.note,
      },
      dataNotes: [
        'Official incidents are US-only IRWIN/WFIGS records — not global coverage.',
        'satellite_corroborated = detections within radius/time of discovery; never a confirmed wildfire.',
        'RX entries are prescribed fires.',
      ],
    };
  }

  if (name === 'agnicalendar_series' || name === 'agnicalendar_calendar' || name === 'agnicalendar_cells') {
    const agni = await resolveAgni(deps.agni);
    const status = await agni.status().catch(() => null);
    if (!status?.available) {
      return {
        record: { name, ok: false, summary: 'AgniCalendar dataset unavailable.' },
        response: { ok: false, error: 'The AgniCalendar harmonized dataset is not available on this server.' },
        dataNotes: [],
      };
    }

    const layer = args.layer === 'snpp' || args.layer === 'harmonized' ? args.layer : 'aqua';
    const daynight =
      args.daynight === 'day' || args.daynight === 'night' || args.daynight === 'unknown' || args.daynight === 'known'
        ? args.daynight
        : 'known';
    const fireType =
      args.fire_type === '1' || args.fire_type === '2' || args.fire_type === '3' || args.fire_type === 'UNKNOWN' || args.fire_type === 'all'
        ? args.fire_type
        : '0';

    let bbox: { west: number; south: number; east: number; north: number } | undefined;
    if (typeof args.bbox === 'string' && args.bbox.trim()) {
      const parts = args.bbox.split(',').map(Number);
      if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n)) || parts[0] >= parts[2] || parts[1] >= parts[3]) {
        return {
          record: { name, ok: false, summary: 'Invalid bbox.' },
          response: { ok: false, error: 'bbox must be west,south,east,north with west<east and south<north.' },
          dataNotes: [],
        };
      }
      bbox = { west: parts[0], south: parts[1], east: parts[2], north: parts[3] };
    }
    const country = typeof args.country === 'string' ? args.country.trim().slice(0, 120) : '';
    // Country (majority-vote cell mapping) takes precedence over a bbox scope.
    const scope = !country && bbox ? ({ kind: 'bbox' as const, bbox }) : ({ kind: 'global' as const });

    const yearOf = (v: unknown, fallback: number) => {
      const n = Math.floor(Number(v));
      return Number.isInteger(n) && n >= 2002 && n <= 2025 ? n : fallback;
    };
    const startYear = yearOf(args.start_year, status.min_year ?? 2002);
    const endYear = Math.max(startYear, yearOf(args.end_year, status.max_year ?? 2025));

    const notes = [
      'AgniCalendar dataset: 10 km EPSG:8857 cells x UTC month, 2002-2025 — separate from the FIRMS country archive.',
      'Detections are satellite thermal anomalies, not unique fires or burned area; missing cell-months are unavailable data, never zero.',
      layer === 'harmonized'
        ? 'Harmonized values are RF-B model estimates on APPROVED_CONDITIONAL_JOINT_POSITIVE support only — not a complete corrected VIIRS series.'
        : 'Sensor layers keep original counts; Aqua counts and harmonized estimates are never added together.',
      'DAY/NIGHT/UNKNOWN-DN are separate; fire_type 0 is source-reported presumed vegetation.',
    ];

    if (name === 'agnicalendar_cells') {
      const year = Math.floor(Number(args.year));
      const month = Math.floor(Number(args.month));
      if (!Number.isInteger(year) || year < 2002 || year > 2025 || !Number.isInteger(month) || month < 1 || month > 12) {
        return {
          record: { name, ok: false, summary: 'Invalid year/month.' },
          response: { ok: false, error: 'year must be 2002-2025 and month 1-12.' },
          dataNotes: [],
        };
      }
      const limit = Math.min(Math.max(Math.floor(Number(args.limit)) || 15, 1), 50);
      const cellsRaw = await agni.cells({ scope, country: country || undefined, layer, daynight, fireType, year, month, limit }).catch(() => [] as never[]);
      const cells = Array.isArray(cellsRaw) ? cellsRaw : ([] as never[]);
      const top = cells[0];
      return {
        record: {
          name,
          ok: true,
          summary: top
            ? `Top cell ${top.cell_id} (${top.lat.toFixed(2)},${top.lon.toFixed(2)}): ${top.value} detections.`
            : `No cells with data for ${year}-${String(month).padStart(2, '0')} in scope.`,
        },
        response: {
          ok: true,
          query: { year, month, layer, daynight, fire_type: fireType, country: country || null, scope: country ? 'country' : bbox ? 'bbox' : 'global' },
          cells,
          notes,
        },
        dataNotes: notes.slice(0, 3),
      };
    }

    const rowsRaw = await agni.series({ scope, country: country || undefined, layer, daynight, fireType, startYear, endYear }).catch(() => [] as never[]);
    const rows = Array.isArray(rowsRaw) ? rowsRaw : ([] as never[]);

    if (name === 'agnicalendar_calendar') {
      const byMonth = new Map<number, { detections: number; years_with_data: number; partial_months: number }>();
      for (let m = 1; m <= 12; m++) byMonth.set(m, { detections: 0, years_with_data: 0, partial_months: 0 });
      for (const r of rows) {
        const agg = byMonth.get(r.month);
        if (!agg || r.detections == null) continue;
        agg.detections += r.detections;
        agg.years_with_data += 1;
        if (r.partial_coverage) agg.partial_months += 1;
      }
      const months = Array.from(byMonth.entries())
        .map(([month, a]) => ({ month, total_detections: Math.round(a.detections * 100) / 100, months_with_data: a.years_with_data, partial_months: a.partial_months }))
        .sort((a, b) => b.total_detections - a.total_detections);
      const peak = months.filter((m) => m.total_detections > 0).slice(0, 3).map((m) => m.month);
      return {
        record: {
          name,
          ok: true,
          summary: `AgniCalendar ${layer}/${daynight} calendar: peak months ${peak.map((m) => String(m).padStart(2, '0')).join(', ') || 'none'} across ${startYear}-${endYear}.`,
        },
        response: {
          ok: true,
          query: { layer, daynight, fire_type: fireType, country: country || null, scope: country ? 'country' : bbox ? 'bbox' : 'global', start_year: startYear, end_year: endYear },
          months_by_activity: months,
          notes,
        },
        dataNotes: notes.slice(0, 3),
      };
    }

    // agnicalendar_series
    const byYear = new Map<number, number>();
    let total = 0;
    let monthsWithData = 0;
    for (const r of rows) {
      if (r.detections == null) continue;
      byYear.set(r.year, (byYear.get(r.year) ?? 0) + r.detections);
      total += r.detections;
      monthsWithData += 1;
    }
    const yearly = Array.from(byYear.entries())
      .map(([year, detections]) => ({ year, detections: Math.round(detections * 100) / 100 }))
      .sort((a, b) => a.year - b.year);
    const peakMonths = rows
      .filter((r) => r.detections != null)
      .sort((a, b) => (b.detections ?? 0) - (a.detections ?? 0))
      .slice(0, 6)
      .map((r) => ({ year: r.year, month: r.month, detections: Math.round((r.detections ?? 0) * 100) / 100, partial_coverage: r.partial_coverage }));
    return {
      record: {
        name,
        ok: true,
        summary: `AgniCalendar ${layer}/${daynight}: ${Math.round(total * 100) / 100} detections across ${monthsWithData} months (${startYear}-${endYear}).`,
      },
      response: {
        ok: true,
        query: { layer, daynight, fire_type: fireType, country: country || null, scope: country ? 'country' : bbox ? 'bbox' : 'global', start_year: startYear, end_year: endYear },
        yearly_totals: yearly,
        peak_months: peakMonths,
        months_with_data: monthsWithData,
        notes,
      },
      dataNotes: notes.slice(0, 3),
    };
  }

  return {
    record: { name, ok: false, summary: 'Unknown tool.' },
    response: { ok: false, error: `Unknown tool "${name}".` },
    dataNotes: [],
  };
}

/** Bound the declarative tool list to what is actually enabled in this request. */
export function enabledToolDeclarations(): ToolDeclaration[] {
  return AI_TOOL_DECLARATIONS;
}

// ---------------------------------------------------------------- fast path

/**
 * Narrow intent match for "which area/region has the most hotspots" style questions. These are
 * answered deterministically by rank_regions without a model call; anything ambiguous falls
 * through to the Groq chat loop.
 */
const REGION_WORDS = /\b(which|what)\b[\s\S]{0,80}?\b(area|region|place|location|country|zone)\b[\s\S]{0,80}?\b(most|highest|top|largest|biggest|leading)\b/i;
const MOST_ACTIVITY = /\bmost\b[\s\S]{0,50}?\b(fire\s*hot\s*spots?|hotspots?|fire\s*detections?|detections?|anomalies|activity)\b/i;
const NOT_RANKING = /\b(recent|latest|newest|show|list|where|when|why|how|compare|versus|vs\.?|filter|only|explain)\b/i;
// Any explicit past period must go to the model+history tools, never the live fast path.
// Covers absolute years, "years ago", "between", plus relative periods that
// exceed the live NRT window: "past 6 years", "last 2 months", "previous year",
// "the 2010s", "this year", "decade". "last N days" stays live-eligible (N<=5).
const PAST_PERIOD =
  /\b(19|20)\d{2}\b|\b(19|20)\d{2}\s*[-–—]\s*((19|20)\d{2})?\b|\bhistorical(?:ly)?\b|\barchive\b|\byears?\s+ago\b|\bbetween\b|\bpast\b|\bprevious\b|\blast\s+\d+\s*(?:-|–|to\s+)?\s*(?:years?|yrs?|months?)\b|\b(?:last|past|previous)\s+(?:month|year|week)\b|\bthis\s+year\b|\bytd\b|\bdecade\b|\b(19|20)\d0s\b|\bsince\s+(?:19|20)\d{2}\b/i;

export function isRegionRankingQuestion(message: string): boolean {
  const text = message.trim();
  if (!text || NOT_RANKING.test(text) || PAST_PERIOD.test(text)) return false;
  return REGION_WORDS.test(text) || MOST_ACTIVITY.test(text);
}

/** Days for a fast-path question: explicit "N days" (1-5), otherwise the last day. */
export function windowDaysFromMessage(message: string): number {
  const match = /(\d{1,2})\s*(?:-|\s)?days?\b/i.exec(message);
  if (match) {
    const n = Number(match[1]);
    if (n > MAX_DAYS) return MAX_DAYS;
    if (n >= 1) return n;
  }
  return 1;
}

interface RankingRegion {
  id: string;
  name: string;
  country?: string;
  modis_detections: number;
  viirs_detections: number;
  exploratory_detection_total: number;
}

/** Deterministic reply for a rank_regions result. No model text is involved. */
export function buildRegionRankingReply(ranking: {
  window_days: number;
  regions: RankingRegion[];
}): string {
  const { window_days: days, regions } = ranking;
  const window = days === 1 ? 'today (last 1 day)' : `the last ${days} days`;
  const top = regions[0];
  if (!top || top.exploratory_detection_total === 0) {
    return (
      `No satellite detections were recorded in any study region ${window}. ` +
      'Missing observations mean "no observation record", not confirmed zero fire activity. ' +
      'Satellite thermal anomalies, not confirmed wildfires or burned area.'
    );
  }
  const others = regions.slice(1, 3).map(
    (r) => `${r.name} (MODIS ${r.modis_detections}, VIIRS ${r.viirs_detections})`
  );
  const runnerUp = others.length > 0 ? ` Next highest: ${others.join('; ')}.` : '';
  return (
    `Over ${window} of live NASA FIRMS NRT data, the study region with the most satellite detections is ` +
    `${top.name}${top.country ? ` (${top.country})` : ''}: MODIS ${top.modis_detections}, VIIRS ${top.viirs_detections} ` +
    `(EXPLORATORY combined total ${top.exploratory_detection_total}).${runnerUp} ` +
    'MODIS and VIIRS are reported separately and never added into a fire count; the combined figure is an ' +
    'EXPLORATORY ranking score only. This covers only the four built-in study regions, not every country. ' +
    'Satellite thermal anomalies, not confirmed wildfires or burned area.'
  );
}

// ------------------------------------------------------- additional fast-path intents

/** Questions that need explanation, judgement or non-count data always go to Groq. */
const FAST_PATH_EXCLUDE =
  /\b(why|explain|predict|forecast|caus\w*|recommend|should|danger|risk|evacuat\w*|affect\w*|impact\w*|damage|perimeter|spread|weather|population|injur\w*|historic\w*|last year|trend)\b/i;

const COUNT_QUESTION =
  /\b(how many|number of|count of|total)\b[\s\S]{0,50}?\b(hot\s*spots?|hotspots?|fire\s*detections?|detections?|anomalies)\b|\b(hotspots?|detections?)\s+(today|this week|in the last|over the last|during)\b/i;

const SENSOR_COMPARISON_QUESTION =
  /\b(modis|viirs)\b[\s\S]{0,40}?\b(vs\.?|versus|and|or|compared)\b[\s\S]{0,40}?\b(modis|viirs)\b|\bwhich sensor\b[\s\S]{0,50}?\b(more|most|detect|see|better|higher|worse)\b|\bcompare\b[\s\S]{0,40}?\b(modis|viirs|sensors?)\b/i;

const FRP_QUESTION =
  /\b(highest|biggest|largest|strongest|hottest|most intense|max|top|peak)\b[\s\S]{0,50}?\b(frp|hot\s*spots?|hotspots?|fire|detections?|anomalies)\b|\bfrp\b[\s\S]{0,40}?\b(max|highest|top|most|biggest)\b/i;

export function isCountQuestion(message: string): boolean {
  return COUNT_QUESTION.test(message);
}

export function isSensorComparisonQuestion(message: string): boolean {
  return SENSOR_COMPARISON_QUESTION.test(message);
}

export function isFrpQuestion(message: string): boolean {
  return FRP_QUESTION.test(message);
}

interface CountSummaryShape {
  window_days: number;
  bbox_used: string;
  total_matching: number;
  by_sensor: { MODIS: number; VIIRS: number };
  frp_mw: { MODIS: number; VIIRS: number };
  active_1km_cells: number;
  first_detection_utc: string | null;
  last_detection_utc: string | null;
}

export function buildCountReply(summary: CountSummaryShape, days: number, bbox: string | null): string {
  const window = days === 1 ? 'today (last 1 day)' : `the last ${days} days`;
  const area = bbox ? `in the selected area (${bbox})` : 'worldwide';
  const parts = [
    `Over ${window} ${area}: MODIS ${summary.by_sensor.MODIS} detections, VIIRS ${summary.by_sensor.VIIRS} detections ` +
      `(total matching records ${summary.total_matching}; sensors are reported separately and never summed into a fire count).`,
    `FRP sums: MODIS ${summary.frp_mw.MODIS} MW, VIIRS ${summary.frp_mw.VIIRS} MW; active 1 km cells: ${summary.active_1km_cells}.`,
  ];
  if (summary.first_detection_utc && summary.last_detection_utc) {
    parts.push(`First detection ${summary.first_detection_utc}, last ${summary.last_detection_utc} (UTC).`);
  }
  parts.push('Satellite thermal anomalies, not confirmed wildfires or burned area.');
  return parts.join(' ');
}

interface ComparisonShape {
  window_days: number;
  bbox_used: string;
  modis_detections: number;
  viirs_detections: number;
  viirs_to_modis_ratio: number | null;
  paired_1km_cells: number;
  active_1km_cells: number;
}

export function buildSensorComparisonReply(comparison: ComparisonShape, days: number): string {
  const window = days === 1 ? 'today (last 1 day)' : `the last ${days} days`;
  const ratio =
    comparison.viirs_to_modis_ratio === null
      ? 'ratio not defined (no MODIS detections)'
      : `VIIRS/MODIS ratio ${comparison.viirs_to_modis_ratio}`;
  return (
    `Over ${window} ${comparison.bbox_used === 'world' ? 'worldwide' : `in ${comparison.bbox_used}`}: ` +
    `MODIS ${comparison.modis_detections} detections, VIIRS ${comparison.viirs_detections} detections (${ratio}). ` +
    `${comparison.paired_1km_cells} of ${comparison.active_1km_cells} active 1 km cells were detected by both sensors. ` +
    'Differences reflect pixel size (~1 km MODIS vs ~375 m VIIRS), overpass timing, saturation and cloud cover; ' +
    'neither sensor is "wrong" and the counts are never merged into a unique fire total. ' +
    'Satellite thermal anomalies, not confirmed wildfires or burned area.'
  );
}

interface HottestShape {
  window_days: number;
  bbox_used: string;
  top_per_sensor: Record<'MODIS' | 'VIIRS', AiDetectionEvidence[]>;
}

function frpRecordLine(o: AiDetectionEvidence): string {
  return `${o.sensor} ${o.satellite} at ${o.latitude.toFixed(3)},${o.longitude.toFixed(3)} on ${o.acq_date} ${o.acq_time} UTC, FRP ${o.frp_mw} MW, confidence ${o.confidence}, product ${o.product}`;
}

export function buildFrpReply(hottest: HottestShape, days: number): string {
  const window = days === 1 ? 'today (last 1 day)' : `the last ${days} days`;
  const area = hottest.bbox_used === 'world' ? 'worldwide' : `in ${hottest.bbox_used}`;
  const lines: string[] = [];
  for (const sensor of ['MODIS', 'VIIRS'] as const) {
    const top = hottest.top_per_sensor[sensor]?.[0];
    if (top) lines.push(`${sensor}: ${frpRecordLine(top)}`);
  }
  if (lines.length === 0) {
    return (
      `No satellite detections with FRP were recorded ${window} ${area}. ` +
      'Missing observations mean "no observation record", not zero fire. ' +
      'Satellite thermal anomalies, not confirmed wildfires or burned area.'
    );
  }
  return (
    `The highest-FRP detections ${window} ${area} (per sensor, FRP in MW): ${lines.join('; ')}. ` +
    'FRP is fire radiative power; MODIS and VIIRS tops are reported separately because pixel size and overpass timing differ. ' +
    'Satellite thermal anomalies, not confirmed wildfires or burned area.'
  );
}

export interface FastPathResult {
  record: AiToolCallRecord;
  reply: string;
  dataNotes: string[];
}

// ------------------------------------------------- deterministic history fast path
// Factual archive questions (counts, rankings, extremes, anomalies, climatology,
// seasonal status, persistence, coverage) are answered straight from the historical
// store — no model call, so they keep working even when the AI provider is
// rate-limited. Anything ambiguous or explanatory falls through to Groq + tools.

const LEGEND = 'Satellite thermal anomalies, not confirmed wildfires or burned area.';
const ARCHIVE_NOTE =
  'Local 2000-2025 FIRMS archive; MODIS and VIIRS are reported separately and never summed. ' +
  'VIIRS is Suomi-NPP only (from 2012-01-20). Missing coverage is unavailable data, not zero activity.';

const HISTORY_COUNT_QUESTION =
  /\b(how many|number of|count of|total)\b[\s\S]{0,60}?\b(hot\s*spots?|hotspots?|fire\s*(alerts?|detections?|anomalies)|detections?|anomalies|burns?)\b|\b(hotspots?|detections?|fire alerts?)\s+(in|for|during|over|across)\b/i;
const HISTORY_RANK_YEARS =
  /\b(which|what)\s+years?\b[\s\S]{0,50}?\b(most|highest|peak|top|largest|biggest)\b|\byears?\s+with\s+the\s+(most|highest)\b|\bhighest\s+years?\b/i;
/** Explanatory/judgement phrasing never gets a canned history answer. */
const HISTORY_EXCLUDE =
  /\b(predict|forecast|why|explain|recommend|should|risk|danger|caus\w*|weather|impact\w*|perimeter|spread|compare|versus|vs\.?|model|train|machine learning)\b/i;

const HISTORY_STATUS_Q =
  /\b(archive|historical (?:data|archive)|coverage|how far back|what years? (?:does|do) (?:the )?(?:archive|data)|available years?|data (?:available|coverage|range))\b/i;
const HISTORY_ANOMALY_Q =
  /\b(anomal\w*|unusual\w*|abnormal\w*|outlier\w*|above normal|below normal|higher than (?:usual|normal|typical)|lower than (?:usual|normal|typical)|more active than usual|less active than usual)\b/i;
const HISTORY_SEASONAL_NOW_Q =
  /\b(?:fire|burning|burn) season\b[\s\S]{0,40}\b(?:now|currently|today|right now|this (?:month|season|time))\b|\b(?:now|currently|today|right now)\b[\s\S]{0,40}\b(?:fire|burning) season\b|\babove normal\b|\bbelow normal\b|\bwhat'?s coming up\b|\bcoming up\b[\s\S]{0,20}season/i;
const HISTORY_CLIMATOLOGY_Q =
  /\b(?:fire|burning) season\b|\bclimatolog\w*\b|\btypical(?:ly)?\b[\s\S]{0,30}\b(?:active|activity|detections?|season)\b|\bwhich months? (?:are|is|were|was) (?:usually |typically )?(?:the )?(?:most|least|peak|low|busy|quiet)\b|\bwhen (?:is|are|does|do)\b[\s\S]{0,30}\b(?:peak|most active|busy|fire season)/i;
const HISTORY_FRP_Q =
  /\b(?:highest|strongest|biggest|maximum|max|record|top)\b[\s\S]{0,30}\bfrp\b|\bfrp\b[\s\S]{0,30}\b(?:highest|strongest|biggest|maximum|record)\b/i;
const HISTORY_PERSIST_Q =
  /\b(?:every year|each year|almost every year|year after year|persistent|recurring|long[- ]term|regularly|consistently)\b/i;
const HISTORY_RANK_COUNTRY_Q =
  /\b(?:which|what)\s+(?:countries|country|regions?|nations?)\b[\s\S]{0,40}?\b(?:most|highest|top|largest|biggest|leading|worst)\b|\b(?:top|ranking)\s+(?:countries|country)\b|\bcountries?\s+(?:with|having)\s+the\s+(?:most|highest|largest)\b|\b(?:by|per|for each)\s+countr(?:y|ies)\b/i;
const HISTORY_DAILY_Q =
  /\b(?:which|what)\s+(?:days?|dates?)\b[\s\S]{0,40}?\b(?:most|highest|peak|top|busy|active)\b|\b(?:which|what)\s+months?\b[\s\S]{0,40}?\b(?:most|highest|peak|top|busy|active)\b|\bby month\b|\bdaily (?:detections|counts|series|data)\b|\bday[- ]to[- ]day\b|\bmonthly totals?\b/i;
const HISTORY_ALL_TIME_Q = /\b(?:ever|archive|historical|all[- ]time|record|since 2000)\b/i;

const MONTH_NAMES: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
};
const MONTH_LABEL = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Month from a name ("June") or an ISO-ish YYYY-MM(-DD) fragment; null otherwise. */
function parseHistoryMonth(text: string): number | null {
  const iso = /\b(19|20)\d{2}-(\d{2})\b/.exec(text);
  if (iso) {
    const m = Number(iso[2]);
    if (m >= 1 && m <= 12) return m;
  }
  const m = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i.exec(text);
  if (!m) return null;
  return MONTH_NAMES[m[1].toLowerCase()] ?? null;
}

const COUNTRY_ALIASES: Record<string, string> = {
  usa: 'United States',
  'u.s.': 'United States',
  'u.s.a.': 'United States',
  america: 'United States',
  uk: 'United Kingdom',
  'u.k.': 'United Kingdom',
  britain: 'United Kingdom',
  'great britain': 'United Kingdom',
  england: 'United Kingdom',
  scotland: 'United Kingdom',
  wales: 'United Kingdom',
  'northern ireland': 'United Kingdom',
  russia: 'Russian Federation',
  'north korea': 'Dem Rep Korea',
  'south korea': 'Republic of Korea',
  'ivory coast': 'Cote d Ivoire',
  laos: 'Lao PDR',
  'east timor': 'Timor-Leste',
  burma: 'Myanmar',
  holland: 'Netherlands',
  eswatini: 'Swaziland',
  czechia: 'Czech Republic',
  turkiye: 'Turkey',
  'cabo verde': 'Cape Verde',
  bahamas: 'Bahamas',
  faroe: 'Faeroe Islands',
  falklands: 'Falkland Islands',
  'falkland islands': 'Falkland Islands',
  'palestinian territories': 'Palestine',
  drc: 'Democratic Republic of the Congo',
  'congo kinshasa': 'Democratic Republic of the Congo',
  'congo brazzaville': 'Republic of Congo',
  'st lucia': 'Saint Lucia',
  'st kitts': 'Saint Kitts and Nevis',
  'st kitts and nevis': 'Saint Kitts and Nevis',
  'st vincent': 'Saint Vincent and the Grenadines',
  'st barthelemy': 'Saint-Barthelemy',
  'st martin': 'Saint-Martin',
  'st pierre': 'Saint Pierre and Miquelon',
  'st helena': 'Saint Helena',
};

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Longest-name-first match so "Democratic Republic of the Congo" beats "Congo". */
async function matchArchiveCountry(
  text: string,
  countries: () => Promise<string[]>
): Promise<string | undefined> {
  const lower = text.toLowerCase();
  for (const [alias, name] of Object.entries(COUNTRY_ALIASES)) {
    // Alnum lookarounds so dotted aliases ("u.s.") still match before punctuation/space.
    if (new RegExp(`(?<![A-Za-z0-9])${escapeRe(alias)}(?![A-Za-z0-9])`, 'i').test(text)) return name;
  }
  const list = await countries().catch(() => [] as string[]);
  const sorted = [...list].sort((a, b) => b.length - a.length);
  for (const c of sorted) {
    if (new RegExp(`\\b${escapeRe(c.toLowerCase())}\\b`, 'i').test(lower)) return c;
  }
  // Single-word fallback: match the first word of multi-word names too
  // ("congo" -> "Congo" only when no longer name matched).
  for (const c of sorted) {
    const first = c.split(/\s+/)[0];
    if (first.length > 3 && new RegExp(`\\b${escapeRe(first.toLowerCase())}\\b`, 'i').test(lower)) return c;
  }
  return undefined;
}

interface ParsedYearRange {
  startYear: number;
  endYear: number;
}

/** Parse absolute or relative year ranges; clamps to the archive window. */
function parseHistoryYearRange(text: string, maxArchiveYear: number): ParsedYearRange | null {
  const ARCHIVE_MIN = 2000;
  const clampY = (y: number) => Math.min(Math.max(y, ARCHIVE_MIN), 2025);

  // "between 2019 and 2021", "2019-2025", "2019 to 2021"
  let m = /\bbetween\s+((?:19|20)\d{2})\s+and\s+((?:19|20)\d{2})\b/i.exec(text)
    ?? /\b((?:19|20)\d{2})\s*(?:-|–|—|\bto\b)\s*((?:19|20)\d{2})\b/i.exec(text);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    return { startYear: clampY(Math.min(a, b)), endYear: clampY(Math.max(a, b)) };
  }
  // "since 2015" / "since 2015 until now" -> through the latest archive year
  m = /\bsince\s+((?:19|20)\d{2})\b/i.exec(text);
  if (m) {
    const y = Number(m[1]);
    if (y <= maxArchiveYear) return { startYear: clampY(y), endYear: maxArchiveYear };
    return null;
  }
  // "past/last N years" -> trailing N archive years ending at maxArchiveYear
  m = /\b(?:past|last|previous)\s+(\d{1,2})\s*(?:-|–)?\s*years?\b/i.exec(text);
  if (m) {
    const n = Number(m[1]);
    if (n >= 1 && n <= 26) return { startYear: clampY(maxArchiveYear - n + 1), endYear: maxArchiveYear };
    return null;
  }
  // "last year" / "previous year" -> most recent archive year
  if (/\b(?:last|previous|past)\s+year\b/i.test(text)) {
    return { startYear: maxArchiveYear, endYear: maxArchiveYear };
  }
  // single explicit year "in 2019", "during 2020"
  m = /\b((?:19|20)\d{2})\b/.exec(text);
  if (m) {
    const y = Number(m[1]);
    if (y >= ARCHIVE_MIN && y <= maxArchiveYear) return { startYear: y, endYear: y };
    return null;
  }
  // "this year" -> current year, almost certainly outside the archive
  if (/\bthis\s+year\b/i.test(text)) {
    return { startYear: new Date().getUTCFullYear(), endYear: new Date().getUTCFullYear() };
  }
  return null;
}

function buildHistoryPeriodReply(
  rows: PeriodYearRow[],
  q: { startYear: number; endYear: number; country?: string; sensor?: string }
): string {
  const scope = `${q.country ?? 'globally'} ${q.startYear}-${q.endYear}`;
  const legend = 'Satellite thermal anomalies, not confirmed wildfires or burned area.';
  if (rows.length === 0) {
    return (
      `The historical archive (2000-2025, MODIS and VIIRS kept separate) has no detection rows for ${scope}. ` +
      'Missing archive coverage is unavailable data, not confirmed zero activity. ' + legend
    );
  }
  const parts: string[] = [];
  for (const sensor of ['MODIS', 'VIIRS'] as const) {
    if (q.sensor && q.sensor !== sensor) continue;
    const mine = rows.filter((r) => r.sensor === sensor);
    if (!mine.length) continue;
    const total = mine.reduce((a, r) => a + r.detections, 0);
    const byYear = [...mine].sort((a, b) => b.detections - a.detections);
    const top = byYear.slice(0, 3).map((r) => `${r.year} (${r.detections.toLocaleString()})`);
    const yearly = [...mine].sort((a, b) => a.year - b.year)
      .map((r) => `${r.year}: ${r.detections.toLocaleString()}`)
      .join(', ');
    parts.push(
      `${sensor}: ${total.toLocaleString()} detections ${scope}` +
      (top.length ? `; highest year(s): ${top.join(', ')}` : '') +
      `. Per year — ${yearly}.`
    );
  }
  if (parts.length === 0) {
    return `No archive rows for ${scope}. Missing coverage is unavailable data, not zero fire. ${legend}`;
  }
  return (
    parts.join(' ') +
    ' Counts come from the local 2000-2025 FIRMS archive; MODIS and VIIRS are never summed together. ' +
    'VIIRS is Suomi-NPP only (from 2012). ' + legend
  );
}

function fmtMw(v: number | null): string {
  return v == null ? 'n/a' : `${v.toLocaleString(undefined, { maximumFractionDigits: 1 })} MW`;
}

function perSensor<T>(rows: T[], sensorOf: (r: T) => string, wanted?: string): [string, T[]][] {
  return (['MODIS', 'VIIRS'] as const)
    .filter((s) => !wanted || s === wanted)
    .map((s) => [s, rows.filter((r) => sensorOf(r) === s)] as [string, T[]])
    .filter(([, rs]) => rs.length > 0);
}

function buildStatusReply(status: {
  sensors: Record<string, { years: number[]; min_date: string | null; max_date: string | null; rows: number | null }>;
}): string {
  const parts = Object.entries(status.sensors).map(([sensor, s]) => {
    const years = s.years ?? [];
    const span = years.length ? `${Math.min(...years)}-${Math.max(...years)}` : 'no years';
    const rows = s.rows != null ? `${s.rows.toLocaleString()} rows` : 'row count unavailable';
    return `${sensor}: ${span} (${s.min_date ?? '?'} to ${s.max_date ?? '?'}), ${rows}`;
  });
  return (
    `Historical archive coverage — ${parts.join('; ') || 'no sensors available'}. ` +
    'MODIS and VIIRS are separate archives; coverage gaps are unavailable data, not zero activity. ' + LEGEND
  );
}

function buildAnomalyReply(
  rows: MonthAnomalyRow[],
  q: { year: number; month: number; country?: string; sensor?: string }
): string {
  const scope = `${q.country ?? 'all countries'} — ${MONTH_LABEL[q.month]} ${q.year}`;
  if (!rows.length) {
    return `No anomaly rows for ${scope}. Missing coverage is unavailable data, not zero. ${LEGEND}`;
  }
  const parts = perSensor(rows, (r) => r.sensor, q.sensor).map(([sensor, rs]) => {
    const top = rs.slice(0, 5).map((r) => {
      const ratio = r.ratio == null ? 'no baseline' : `${r.ratio}× typical`;
      return `${r.country} (${r.detections.toLocaleString()} vs median ${r.other_years_median?.toLocaleString() ?? 'unavailable (fewer than five valid years)'}, ${ratio})`;
    });
    return `${sensor}: ${top.join('; ')}`;
  });
  return (
    `${MONTH_LABEL[q.month]} ${q.year} vs the median of the same calendar month across other archive years, ${scope}. ` +
    parts.join(' ') +
    ' Ratios are statistical variation only — not confirmed fires or forecasts. ' + ARCHIVE_NOTE + ' ' + LEGEND
  );
}

function buildSeasonalNowReply(s: {
  country: string;
  date: string;
  today_window: Record<string, { median_detections: number; p25_detections: number; p75_detections: number; years_with_data: number; years_total: number; period_status?: string }>;
  upcoming_months: { month: number; activity_class: string; harmonized_equivalent_median: number | null }[];
  climatology: { season: { peak_months: number[]; low_months: number[] } };
}): string {
  const win = Object.entries(s.today_window).map(([sensor, w]) => {
    const status = w.period_status ? `, current-vs-typical: ${w.period_status.replace(/_/g, ' ')}` : '';
    return `${sensor}: median ${w.median_detections.toLocaleString()} detections in the same calendar window across ${w.years_with_data}/${w.years_total} archive years (p25–p75 ${w.p25_detections.toLocaleString()}–${w.p75_detections.toLocaleString()})${status}`;
  });
  const peak = s.climatology.season.peak_months.map((m) => MONTH_LABEL[m]).join(', ');
  const upcoming = s.upcoming_months
    .map((u) => `${MONTH_LABEL[u.month]} (${u.activity_class})`)
    .join(', ');
  return (
    `Seasonal status for ${s.country} as of ${s.date}: ${win.join('; ') || 'no window data'}. ` +
    `Typical peak months: ${peak || 'n/a'}; upcoming months: ${upcoming || 'n/a'}. ` +
    'This is climatology of the 2000-2025 archive — not a forecast. ' + LEGEND
  );
}

function buildClimatologyReply(c: {
  scope: { country: string | null };
  months: Array<{ month: number; sensors: Record<string, { median_detections: number }>; activity_class: string }>;
  season: { peak_months: number[]; low_months: number[] };
}): string {
  const scope = c.scope.country ?? 'the selected area';
  const cls = c.months.map((m) => `${MONTH_LABEL[m.month]}:${m.activity_class}`).join(' ');
  const peakM = c.season.peak_months[0];
  const peakDetail = peakM
    ? c.months
        .find((m) => m.month === peakM)
        ?.sensors &&
      Object.entries(c.months.find((m) => m.month === peakM)!.sensors)
        .map(([s, v]) => `${s} median ${v.median_detections.toLocaleString()}`)
        .join(', ')
    : '';
  return (
    `Typical seasonal pattern for ${scope} (2000-2025 archive): peak months ${c.season.peak_months.map((m) => MONTH_LABEL[m]).join(', ') || 'n/a'}, ` +
    `lowest ${c.season.low_months.map((m) => MONTH_LABEL[m]).join(', ') || 'n/a'}. ` +
    (peakDetail ? `Peak-month medians — ${peakDetail}. ` : '') +
    `Monthly activity classes — ${cls || 'no data'}. ` +
    'Climatology describes what was typical, not what will happen. ' + LEGEND
  );
}

function buildHistoryFrpReply(rows: FrpExtremeRow[], q: { country?: string; sensor?: string; startYear?: number; endYear?: number }): string {
  const scope = [q.country, q.startYear || q.endYear ? `${q.startYear ?? '2000'}-${q.endYear ?? '2025'}` : 'all years'].filter(Boolean).join(' ');
  if (!rows.length) return `No FRP records found for ${scope || 'the archive'}. ${LEGEND}`;
  const parts = perSensor(rows, (r) => r.sensor, q.sensor).map(([sensor, rs]) => {
    const top = rs.slice(0, 5).map((r) => `${r.period} ${r.country} (${fmtMw(r.frp_max_mw)}, ${r.detections.toLocaleString()} detections)`);
    return `${sensor}: ${top.join('; ')}`;
  });
  return (
    `Highest daily FRP maxima ${scope ? `for ${scope}` : 'in the archive'} — daily-aggregate maxima, not single-observation extremes. ` +
    parts.join(' ') + ' ' + ARCHIVE_NOTE + ' ' + LEGEND
  );
}

function buildPersistenceReply(rows: PersistenceRow[], q: { startYear?: number; endYear?: number; sensor?: string }): string {
  const scope = q.startYear || q.endYear ? ` ${q.startYear ?? '2000'}-${q.endYear ?? '2025'}` : ' across the whole archive';
  if (!rows.length) return `No persistence rows${scope}. ${LEGEND}`;
  const parts = perSensor(rows, (r) => r.sensor, q.sensor).map(([sensor, rs]) => {
    const top = rs.slice(0, 8).map((r) => `${r.country} (${r.years_with_data} yrs, ${r.detections.toLocaleString()} detections)`);
    return `${sensor}: ${top.join('; ')}`;
  });
  return (
    `Countries with the most recurring archive years${scope} (years-with-data is a persistence proxy, not fire frequency): ` +
    parts.join(' ') + ' ' + ARCHIVE_NOTE + ' ' + LEGEND
  );
}

function buildCountryRankReply(rows: CountryTotal[], year: number, sensor?: string): string {
  if (!rows.length) return `No country totals for ${year}. Missing coverage is unavailable data, not zero. ${LEGEND}`;
  const parts = perSensor(rows, (r) => r.sensor, sensor).map(([s, rs]) => {
    const top = rs.slice(0, 10).map((r, i) => `${i + 1}. ${r.country} (${r.detections.toLocaleString()})`);
    return `${s}:\n${top.join('\n')}`;
  });
  return (
    `Top countries by detections in ${year} — MODIS and VIIRS ranked separately, never summed:\n\n${parts.join('\n\n')}\n\n` +
    ARCHIVE_NOTE + ' ' + LEGEND
  );
}

function buildDailyReply(
  rows: DailyRow[],
  q: { year: number; month?: number | null; level: 'daily' | 'monthly'; country?: string; sensor?: string }
): string {
  const scope = `${q.country ?? 'globally'} ${q.month ? `${MONTH_LABEL[q.month]} ` : ''}${q.year}`;
  if (!rows.length) return `No archive rows for ${scope}. Missing coverage is unavailable data, not zero. ${LEGEND}`;
  const parts = perSensor(rows, (r) => r.sensor, q.sensor).map(([sensor, rs]) => {
    const total = rs.reduce((a, r) => a + r.detections, 0);
    const top = [...rs].sort((a, b) => b.detections - a.detections).slice(0, 5)
      .map((r) => `${r.period} (${r.detections.toLocaleString()})`);
    const coverage = q.level === 'monthly' ? `${rs.length} months` : `${rs.length} days`;
    return `${sensor}: ${total.toLocaleString()} detections across ${coverage}; peak periods — ${top.join(', ')}`;
  });
  return (
    `Archive activity for ${scope}: ` + parts.join('. ') + '. ' +
    'A missing period means no archive rows, not confirmed zero activity. ' + ARCHIVE_NOTE + ' ' + LEGEND
  );
}

function historyResult(record: string, summary: string, reply: string): FastPathResult {
  return {
    record: { name: record, ok: true, summary },
    reply,
    dataNotes: [
      'Answered deterministically from the local 2000-2025 archive; no AI model call was made.',
      'MODIS and VIIRS reported separately; missing periods are unavailable data, not zero.',
    ],
  };
}

async function runHistoryFastPath(
  text: string,
  deps: { history?: HistoryToolDeps; today: string }
): Promise<FastPathResult | null> {
  if (HISTORY_EXCLUDE.test(text)) return null;
  // Cheap regex gate first — live-window questions must not pay for archive I/O.
  const maybeHistory =
    HISTORY_STATUS_Q.test(text) ||
    HISTORY_ANOMALY_Q.test(text) ||
    HISTORY_SEASONAL_NOW_Q.test(text) ||
    HISTORY_CLIMATOLOGY_Q.test(text) ||
    HISTORY_FRP_Q.test(text) ||
    HISTORY_PERSIST_Q.test(text) ||
    HISTORY_RANK_COUNTRY_Q.test(text) ||
    HISTORY_DAILY_Q.test(text) ||
    ((HISTORY_COUNT_QUESTION.test(text) || HISTORY_RANK_YEARS.test(text)) &&
      parseHistoryYearRange(text, 2025) !== null);
  if (!maybeHistory) return null;

  const history = await resolveHistory(deps.history);
  const status = await history.status().catch(() => null);
  if (!status?.available) return null;

  const maxYear = Math.max(
    2000,
    ...Object.values(status.sensors ?? {}).flatMap((s) => s.years ?? []),
    2025
  );
  const range = parseHistoryYearRange(text, maxYear);
  const hasPeriod = range !== null || PAST_PERIOD.test(text);
  const country = await matchArchiveCountry(text, history.countries);
  const sensor = /\bmodis\b/i.test(text) ? 'MODIS' : /\bviirs\b/i.test(text) ? 'VIIRS' : undefined;
  const month = parseHistoryMonth(text);

  // 1. Coverage / availability questions — no period needed.
  if (HISTORY_STATUS_Q.test(text)) {
    return historyResult('history_status', 'Archive coverage summary.', buildStatusReply(status));
  }

  // 2. Month-vs-other-years anomaly — needs an explicit single year AND month.
  if (
    HISTORY_ANOMALY_Q.test(text) &&
    range && range.startYear === range.endYear && month != null
  ) {
    const rows = await history
      .monthAnomaly({ year: range.startYear, month, country, sensor, limit: 10 })
      .catch(() => [] as MonthAnomalyRow[]);
    return historyResult(
      'history_month_anomaly',
      `Anomaly ${MONTH_LABEL[month]} ${range.startYear}: ${rows.length} rows.`,
      buildAnomalyReply(rows, { year: range.startYear, month, country, sensor })
    );
  }

  // 3. "Is it fire season now / above normal right now" — needs a country.
  if (HISTORY_SEASONAL_NOW_Q.test(text) && country && history.seasonalStatus) {
    const s = await history.seasonalStatus({ country, sensor, date: deps.today }).catch(() => null);
    if (s) {
      return historyResult('history_seasonal_status', `Seasonal status ${country} @ ${deps.today}.`, buildSeasonalNowReply(s));
    }
  }

  // 4. Typical seasonal climatology — needs a country; skipped when a specific
  //    year was named (that is a daily/period question instead).
  if (HISTORY_CLIMATOLOGY_Q.test(text) && !range && country && history.climatology) {
    const c = await history.climatology({ country, sensor }).catch(() => null);
    if (!c || !c.months.length) return null;
    return historyResult('history_seasonal_profile', `Climatology ${country}.`, buildClimatologyReply(c));
  }

  // 5. FRP extremes — needs a period or an all-time phrasing so "today" stays live.
  if (HISTORY_FRP_Q.test(text) && (hasPeriod || HISTORY_ALL_TIME_Q.test(text))) {
    const rows = await history
      .frpExtremes({
        sensor, country,
        startYear: range?.startYear, endYear: range?.endYear,
        limit: 10,
      })
      .catch(() => [] as FrpExtremeRow[]);
    return historyResult(
      'history_frp_extremes',
      `FRP extremes ${country ?? 'global'} ${range ? `${range.startYear}-${range.endYear}` : 'all years'}.`,
      buildHistoryFrpReply(rows, { country, sensor, startYear: range?.startYear, endYear: range?.endYear })
    );
  }

  // 6. Recurring/persistent activity — the tool has no country filter.
  if (HISTORY_PERSIST_Q.test(text) && !country && history.persistence) {
    const rows = await history
      .persistence({
        sensor,
        startYear: range?.startYear, endYear: range?.endYear,
        limit: 20,
      })
      .catch(() => [] as PersistenceRow[]);
    return historyResult(
      'history_persistent_countries',
      `Persistence ${range ? `${range.startYear}-${range.endYear}` : 'all years'}.`,
      buildPersistenceReply(rows, { startYear: range?.startYear, endYear: range?.endYear, sensor })
    );
  }

  // 7. Country rankings — one archive year (explicit or via range endpoints).
  const rankYear = range && range.startYear === range.endYear ? range.startYear : null;
  if (HISTORY_RANK_COUNTRY_Q.test(text) && rankYear != null && history.countryTotals) {
    const rows = await history.countryTotals(rankYear).catch(() => [] as CountryTotal[]);
    return historyResult(
      'history_country_rankings',
      `Country rankings ${rankYear}: ${rows.length} rows.`,
      buildCountryRankReply(rows.filter((r) => !sensor || r.sensor === sensor), rankYear, sensor)
    );
  }

  // 8. Daily/monthly series for one year — "which days/months were most active".
  if (HISTORY_DAILY_Q.test(text) && rankYear != null && history.daily) {
    const level: 'daily' | 'monthly' = month != null ? 'daily' : 'monthly';
    const res = await history
      .daily({
        year: rankYear, month: level === 'daily' ? month ?? undefined : undefined,
        sensor, country,
        level, global: !country, limit: level === 'daily' ? 60 : 50,
      })
      .catch(() => ({ rows: [] as DailyRow[], truncated: false }));
    return historyResult(
      'history_daily_series',
      `Daily series ${country ?? 'global'} ${rankYear}${month ? `-${String(month).padStart(2, '0')}` : ''}: ${res.rows.length} rows.`,
      buildDailyReply(res.rows, { year: rankYear, month, level, country, sensor })
    );
  }

  // 9. Count / per-year / highest-year questions — the original period path.
  if (!range) return null;
  if (!HISTORY_COUNT_QUESTION.test(text) && !HISTORY_RANK_YEARS.test(text)) return null;
  if (!history.periodTotals || !history.countries) return null;
  const rows = await history
    .periodTotals({ startYear: range.startYear, endYear: range.endYear, country, sensor })
    .catch(() => [] as PeriodYearRow[]);
  const scope = `${country ?? 'global'} ${range.startYear}-${range.endYear}`;
  return historyResult(
    'history_period_summary',
    `Archive ${scope}: ${rows.length} year-rows.`,
    buildHistoryPeriodReply(rows, { ...range, country, sensor })
  );
}

// ------------------------------------------------- deterministic AgniCalendar fast path
// Questions that explicitly name the harmonized grid / AgniCalendar product are
// answered straight from the cell-month dataset — no model call.

const AGNI_Q =
  /\b(agni|harmoniz\w*|harmonis\w*|cell[- ]?months?|10\s*km grid|fire calendar)\b/i;
/** Live-window phrasing can never be answered from the 2002-2025 grid archive. */
const AGNI_LIVE_Q = /\b(today|right now|currently|this (?:week|month)|last \d+ days?|past \d+ days?|last night|overnight)\b/i;
const AGNI_CELLS_Q =
  /\b(?:which|what|where|top|hottest|most active)\b[\s\S]{0,40}?\b(?:cells?|grid cells?|hotspots?)\b[\s\S]{0,30}?\b(20\d{2}|month|january|february|march|april|may|june|july|august|september|october|november|december)\b|\bcells?\b[\s\S]{0,30}?\b(20\d{2})\b/i;
const AGNI_CALENDAR_Q =
  /\b(?:which|what)\s+months?\b[\s\S]{0,40}?\b(?:most|least|peak|low|busy|active|quiet)\b|\bseasonal\b|\busually\b|\btypical\b|\bcalendar\b|\bclimatolog\w*\b/i;

interface AgniSeriesExec {
  yearly_totals?: Array<{ year: number; detections: number }>;
  peak_months?: Array<{ year: number; month: number; detections: number; partial_coverage: boolean }>;
  months_with_data?: number;
}
interface AgniCalendarExec {
  months_by_activity?: Array<{ month: number; total_detections: number; months_with_data: number; partial_months: number }>;
}
interface AgniCellsExec {
  cells?: Array<{ cell_id: string; lat: number; lon: number; value: number | null; frp_sum_mw: number | null }>;
}

function agniUnit(layer: string): string {
  return layer === 'harmonized' ? 'estimates' : 'detections';
}

function buildAgniSeriesReply(e: AgniSeriesExec, layer: string, scope: string): string {
  const unit = agniUnit(layer);
  const total = (e.yearly_totals ?? []).reduce((a, r) => a + r.detections, 0);
  const peak = (e.peak_months ?? []).slice(0, 5)
    .map((p) => `${MONTH_LABEL[p.month]} ${p.year} (${Math.round(p.detections).toLocaleString()}${p.partial_coverage ? ', partial' : ''})`)
    .join(', ');
  const yearly = (e.yearly_totals ?? []).map((r) => `${r.year}: ${Math.round(r.detections).toLocaleString()}`).join(', ');
  return (
    `AgniCalendar ${layer} series for ${scope}: ~${Math.round(total).toLocaleString()} ${unit} across ${e.months_with_data ?? '?'} cell-months. ` +
    `Peak months — ${peak || 'none'}. Per year — ${yearly || 'no data'}. ` +
    '10 km grid cells x UTC month, 2002-2025; satellite thermal anomalies, not confirmed wildfires or burned area. ' +
    'Missing cell-months are unavailable data, never zero; harmonized values are approved-support model estimates only.'
  );
}

function buildAgniCalendarReply(e: AgniCalendarExec, layer: string, scope: string): string {
  const unit = agniUnit(layer);
  const months = e.months_by_activity ?? [];
  const top = months.filter((m) => m.total_detections > 0).slice(0, 5)
    .map((m) => `${MONTH_LABEL[m.month]} (${Math.round(m.total_detections).toLocaleString()} ${unit}, ${m.months_with_data} yrs${m.partial_months ? `, ${m.partial_months} partial` : ''})`)
    .join(', ');
  const low = [...months].filter((m) => m.total_detections > 0).sort((a, b) => a.total_detections - b.total_detections).slice(0, 3)
    .map((m) => MONTH_LABEL[m.month]).join(', ');
  return (
    `AgniCalendar ${layer} seasonal calendar for ${scope}: most active months — ${top || 'none'}; quietest — ${low || 'n/a'}. ` +
    `Observed cell-month ${unit} only; missing months are unavailable data, not zero. Descriptive calendar of satellite-detected activity — not a forecast. ` + LEGEND
  );
}

function buildAgniCellsReply(e: AgniCellsExec, ym: string, layer: string, scope: string): string {
  const unit = agniUnit(layer);
  const cells = e.cells ?? [];
  if (!cells.length) return `No AgniCalendar cells with data for ${ym} in ${scope}. Missing coverage is unavailable data, not zero. ${LEGEND}`;
  const top = cells.slice(0, 5)
    .map((c, i) => `${i + 1}. ${c.cell_id} (${c.lat.toFixed(2)}, ${c.lon.toFixed(2)}): ${c.value == null ? 'n/a' : Math.round(c.value * 100) / 100} ${unit}${c.frp_sum_mw != null ? `, FRP sum ${Math.round(c.frp_sum_mw).toLocaleString()} MW` : ''}`)
    .join('\n');
  return (
    `Top AgniCalendar ${layer} cells for ${ym} in ${scope}:\n${top}\n\n` +
    'Cell aggregates are detection counts on the 10 km grid — not fire perimeters or confirmed fires. ' + LEGEND
  );
}

async function runAgniFastPath(
  text: string,
  deps: { load: AiObservationLoader; today: string; agni?: AgniToolDeps }
): Promise<FastPathResult | null> {
  if (HISTORY_EXCLUDE.test(text) || !AGNI_Q.test(text) || AGNI_LIVE_Q.test(text)) return null;

  const agni = await resolveAgni(deps.agni);
  const status = await agni.status().catch(() => null);
  if (!status?.available) return null;

  const maxYear = status.max_year ?? 2025;
  const minYear = status.min_year ?? 2002;
  const range = parseHistoryYearRange(text, maxYear);
  const startYear = range ? Math.max(range.startYear, minYear) : minYear;
  const endYear = range ? Math.min(range.endYear, maxYear) : maxYear;
  const year = range && range.startYear === range.endYear ? range.startYear : null;
  const month = parseHistoryMonth(text);

  const layer = /\bsnpp\b|\bviirs\b/i.test(text) ? 'snpp' : /\bharmoniz|\brf-?b\b/i.test(text) ? 'harmonized' : 'aqua';
  const daynight = /\bnight(?:time|[- ]pass| detections?)?\b/i.test(text) && !/\bday\b/i.test(text)
    ? 'night'
    : /\b(?:day(?:time|[- ]pass)?|day detections?)\b/i.test(text) && !/\bnight\b/i.test(text)
      ? 'day'
      : /\bunknown\b/i.test(text) ? 'unknown' : 'known';
  const fireType = /\ball (?:fire )?types?\b|\bnon[- ]vegetation\b/i.test(text) ? 'all' : '0';

  const country = agni.countries
    ? await matchArchiveCountry(text, agni.countries).catch(() => undefined)
    : undefined;
  const scope = country ?? 'global';
  const execDeps = { load: deps.load, today: deps.today, agni: deps.agni };

  // Top cells for one explicit year+month.
  if (year != null && year >= minYear && year <= maxYear && month != null && AGNI_CELLS_Q.test(text)) {
    const exec = await executeAiTool(
      'agnicalendar_cells',
      { year, month, layer, daynight, fire_type: fireType, country, limit: 10 },
      execDeps
    );
    const cells = exec.response.cells as AgniCellsExec['cells'];
    if (exec.record.ok) {
      return {
        record: exec.record,
        reply: buildAgniCellsReply({ cells }, `${MONTH_LABEL[month]} ${year}`, layer, scope),
        dataNotes: exec.dataNotes,
      };
    }
    return null;
  }

  // Seasonal month-profile questions.
  if (AGNI_CALENDAR_Q.test(text)) {
    const exec = await executeAiTool(
      'agnicalendar_calendar',
      { layer, daynight, fire_type: fireType, country, start_year: startYear, end_year: endYear },
      execDeps
    );
    const cal = exec.response.months_by_activity as AgniCalendarExec['months_by_activity'];
    if (exec.record.ok) {
      return {
        record: exec.record,
        reply: buildAgniCalendarReply({ months_by_activity: cal }, layer, `${scope} ${startYear}-${endYear}`),
        dataNotes: exec.dataNotes,
      };
    }
    return null;
  }

  // Default: monthly series with yearly totals and peak months.
  const exec = await executeAiTool(
    'agnicalendar_series',
    { layer, daynight, fire_type: fireType, country, start_year: startYear, end_year: endYear },
    execDeps
  );
  const series = exec.response as AgniSeriesExec & { ok?: boolean };
  if (exec.record.ok) {
    return {
      record: exec.record,
      reply: buildAgniSeriesReply(series, layer, `${scope} ${startYear}-${endYear}`),
      dataNotes: exec.dataNotes,
    };
  }
  return null;
}

// ------------------------------------------------- deterministic incident fast path
// "Are there official/verified fires ..." questions hit the IRWIN/WFIGS
// corroboration tool directly — no model call.

const INCIDENT_Q =
  /\b(?:official|verified|confirmed|irwin|wfigs)\b[\s\S]{0,40}\b(?:fires?|wildfires?|incidents?|burns?|reports?)\b|\b(?:fires?|wildfires?|incidents?)\b[\s\S]{0,40}\b(?:official|verified|confirmed)\b|\bofficial incidents?\b|\breal[- ]world (?:fires?|incidents?)\b/i;

const US_STATE_CODES: Record<string, string> = {
  alabama: 'US-AL', alaska: 'US-AK', arizona: 'US-AZ', arkansas: 'US-AR', california: 'US-CA',
  colorado: 'US-CO', connecticut: 'US-CT', delaware: 'US-DE', 'district of columbia': 'US-DC',
  florida: 'US-FL', georgia: 'US-GA', hawaii: 'US-HI', idaho: 'US-ID', illinois: 'US-IL',
  indiana: 'US-IN', iowa: 'US-IA', kansas: 'US-KS', kentucky: 'US-KY', louisiana: 'US-LA',
  maine: 'US-ME', maryland: 'US-MD', massachusetts: 'US-MA', michigan: 'US-MI', minnesota: 'US-MN',
  mississippi: 'US-MS', missouri: 'US-MO', montana: 'US-MT', nebraska: 'US-NE', nevada: 'US-NV',
  'new hampshire': 'US-NH', 'new jersey': 'US-NJ', 'new mexico': 'US-NM', 'new york': 'US-NY',
  'north carolina': 'US-NC', 'north dakota': 'US-ND', ohio: 'US-OH', oklahoma: 'US-OK',
  oregon: 'US-OR', pennsylvania: 'US-PA', 'rhode island': 'US-RI', 'south carolina': 'US-SC',
  'south dakota': 'US-SD', tennessee: 'US-TN', texas: 'US-TX', utah: 'US-UT', vermont: 'US-VT',
  virginia: 'US-VA', washington: 'US-WA', 'west virginia': 'US-WV', wisconsin: 'US-WI', wyoming: 'US-WY',
};

function matchUsState(text: string): string | undefined {
  const m = /\bUS-([A-Z]{2})\b/.exec(text.toUpperCase());
  if (m) return `US-${m[1]}`;
  const lower = text.toLowerCase();
  const names = Object.keys(US_STATE_CODES).sort((a, b) => b.length - a.length);
  for (const name of names) {
    if (new RegExp(`\\b${escapeRe(name)}\\b`, 'i').test(lower)) return US_STATE_CODES[name];
  }
  return undefined;
}

function incidentDaysFromMessage(text: string): number {
  const m = /\b(?:past|last|previous)\s+(\d{1,3})\s+days?\b/i.exec(text);
  if (m) return Math.min(Math.max(Number(m[1]), 1), 60);
  if (/\b(?:today|right now|currently|tonight)\b/i.test(text)) return 3;
  if (/\b(?:this|past|last)\s+week\b/i.test(text)) return 7;
  if (/\b(?:this|past|last)\s+month\b/i.test(text)) return 30;
  return 14;
}

interface IncidentExecShape {
  summary?: { total: number; satellite_corroborated: number; no_nearby_detections: number; unmatchable: number; observations_checked: number };
  incidents?: Array<{
    name: string; state: string | null; type_category: string | null; size_acres: number | null;
    percent_contained: number | null; nearby_detections: number; nearest_detection_km: number | null;
    match: string; discovered_at: string | null; cause: string | null;
  }>;
  source?: { name?: string };
  legend?: string;
  note?: string;
}

function buildIncidentReply(e: IncidentExecShape, days: number, state?: string): string {
  const s = e.summary;
  if (!s) return 'Official incident data unavailable.';
  const scope = state ? ` in ${state.replace('US-', '')}` : ' (US only)';
  const head =
    `Official US wildland-fire incidents discovered in the last ${days} days${scope}: ` +
    `${s.total} total — ${s.satellite_corroborated} with nearby satellite detections, ` +
    `${s.no_nearby_detections} without, ${s.unmatchable} unmatchable ` +
    `(${s.observations_checked.toLocaleString()} satellite observations checked).`;
  const corr = (e.incidents ?? []).filter((i) => i.match === 'satellite_corroborated').slice(0, 8);
  const lines = corr.map((i) => {
    const bits = [
      i.state ?? 'US',
      i.size_acres != null ? `${Math.round(i.size_acres).toLocaleString()} acres` : null,
      i.percent_contained != null ? `${i.percent_contained}% contained` : null,
      `${i.nearby_detections} nearby detections`,
      i.nearest_detection_km != null ? `nearest ${i.nearest_detection_km.toFixed(1)} km` : null,
      i.type_category === 'RX' ? 'prescribed fire' : null,
    ].filter(Boolean).join(', ');
    return `- ${i.name}: ${bits}`;
  });
  return (
    head + (lines.length ? `\nCorroborated incidents:\n${lines.join('\n')}` : '\nNo corroborated incidents in this window.') +
    '\n\nCorroboration means satellite detections occurred near the incident in time and space — consistent with, not proof of, the reported fire. ' +
    (e.legend ?? LEGEND)
  );
}

async function runIncidentFastPath(
  text: string,
  deps: { load: AiObservationLoader; today: string; incidents?: IncidentToolDeps }
): Promise<FastPathResult | null> {
  if (HISTORY_EXCLUDE.test(text) || !INCIDENT_Q.test(text)) return null;
  // Explicit historical years belong to the archive path, not the live incident feed.
  if (parseHistoryYearRange(text, 2025)) return null;
  const days = incidentDaysFromMessage(text);
  const state = matchUsState(text);
  const exec = await executeAiTool('official_incidents', { days, state }, { load: deps.load, today: deps.today, incidents: deps.incidents });
  const shape = exec.response as IncidentExecShape;
  if (!exec.record.ok || !shape.summary) return null;
  return {
    record: exec.record,
    reply: buildIncidentReply(shape, days, state),
    dataNotes: exec.dataNotes,
  };
}

export interface FastPathContext {
  area_name?: string;
  bbox?: string;
  sensors?: 'ALL' | 'MODIS' | 'VIIRS';
  active_view?: string;
  start_date?: string;
  end_date?: string;
}

/**
 * Answer simple factual questions deterministically, with no model call. Returns null when the
 * message is not a confident fast-path intent so the caller falls through to Groq.
 */
export async function runDeterministicFastPath(
  message: string,
  deps: {
    load: AiObservationLoader;
    today: string;
    contextBbox?: string | null;
    context?: FastPathContext | null;
    history?: HistoryToolDeps;
    agni?: AgniToolDeps;
    incidents?: IncidentToolDeps;
  }
): Promise<FastPathResult | null> {
  const text = message.trim();
  if (!text) return null;
  // Deterministic archive intents run first for every message — each intent
  // self-guards on parsed parameters and returns null when unsure. Past-period
  // phrasing that no history intent claims must NOT fall through to live NRT.
  const agniResult = await runAgniFastPath(text, deps);
  if (agniResult) return agniResult;
  const historyResult = await runHistoryFastPath(text, deps);
  if (historyResult) return historyResult;
  const incidentResult = await runIncidentFastPath(text, deps);
  if (incidentResult) return incidentResult;
  if (PAST_PERIOD.test(text)) return null;
  if (FAST_PATH_EXCLUDE.test(text)) return null;

  // F61 fix: use the complete context window (start_date/end_date) and sensors as defaults
  // unless the user's message explicitly requests a different scope.
  const hasExplicitDays = /(\d{1,2})\s*(?:-|\s)?days?\b/i.test(text);
  const contextDays = deps.context?.start_date && deps.context?.end_date
    ? Math.min(Math.max(Math.round((Date.parse(`${deps.context.end_date}T00:00:00Z`) - Date.parse(`${deps.context.start_date}T00:00:00Z`)) / 86_400_000) + 1, 1), MAX_DAYS)
    : 1;
  const days = hasExplicitDays ? windowDaysFromMessage(text) : contextDays;
  const bbox = (deps.context?.bbox && isValidBbox(deps.context.bbox))
    ? deps.context.bbox
    : (deps.contextBbox && isValidBbox(deps.contextBbox) ? deps.contextBbox : null);
  const sensors = deps.context?.sensors ?? 'ALL';

  const finish = (exec: AiToolExecution, reply: string): FastPathResult | null =>
    exec.record.ok ? { record: exec.record, reply, dataNotes: exec.dataNotes } : null;

  if (isRegionRankingQuestion(text)) {
    const exec = await executeAiTool('rank_regions', { days }, { load: deps.load, today: deps.today });
    const ranking = exec.response.ranking as { window_days: number; regions: RankingRegion[] } | undefined;
    return ranking ? finish(exec, buildRegionRankingReply(ranking)) : null;
  }
  if (isFrpQuestion(text)) {
    const exec = await executeAiTool('hottest_detections', { days, ...(bbox ? { bbox } : {}), ...(sensors !== 'ALL' ? { sensors } : {}) }, { load: deps.load, today: deps.today });
    const hottest = exec.response.hottest as HottestShape | undefined;
    return hottest ? finish(exec, buildFrpReply(hottest, days)) : null;
  }
  if (isSensorComparisonQuestion(text)) {
    const exec = await executeAiTool('sensor_comparison', { days, ...(bbox ? { bbox } : {}) }, { load: deps.load, today: deps.today });
    const comparison = exec.response.comparison as ComparisonShape | undefined;
    return comparison ? finish(exec, buildSensorComparisonReply(comparison, days)) : null;
  }
  if (isCountQuestion(text)) {
    const exec = await executeAiTool('query_hotspots', { days, ...(bbox ? { bbox } : {}), ...(sensors !== 'ALL' ? { sensors } : {}), limit: 1 }, { load: deps.load, today: deps.today });
    const summary = exec.response.summary as CountSummaryShape | undefined;
    return summary ? finish(exec, buildCountReply(summary, days, bbox)) : null;
  }
  return null;
}

export const AI_TOOL_LIMITS = { maxDays: MAX_DAYS, maxToolCalls: AI_LIMITS.maxToolCalls } as const;

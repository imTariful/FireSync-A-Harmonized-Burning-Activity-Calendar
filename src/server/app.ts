/**
 * FireSync Express application factory.
 *
 * Express is the ONE application API. All routes are created here so they can be
 * integration-tested without starting Vite or binding a port. No route invents records, checksums, calibration metrics or availability.
 */

import express, { type NextFunction, type Request, type Response } from 'express';
import { once } from 'node:events';
import { NASA_DATASET_METADATA } from '../data/nasa_products';
import type {
  CalibrationModelMetrics,
  CanonicalObservation,
  DailyActivitySummary,
  IngestionJob,
  ProvenanceStatus,
} from '../types/fire';
import {
  aggregateToSpatialTemporalGrid,
  buildDailySummariesFromCells,
  evaluateCalibrationModel,
  evaluateTemporalHoldout,
  HARMONIZATION_CONSTANTS,
} from '../utils/harmonization';
import { applyHistoricalBaselines } from '../utils/anomaly';
import {
  calendarSummariesToCsv,
  cellsToCsv,
  matchedPairsToCsv,
  observationsToCsv,
  sanitizeCsvCell,
  validationResultsToCsv,
} from '../utils/csv_export';
import { isPointInBbox, STUDY_REGIONS } from '../utils/spatial';
import { decodePolygon, filterByPolygon, type PolygonValidation } from '../utils/polygon';
import { matchModisViirs } from '../utils/matching';
import { createFiresHandler } from './firmsHandler';
import { FIRMS_DEFAULT_BASE_URL, FIRMS_SOURCES, validateArea } from '../utils/firms';
import { IngestionService, validateIngestionRequest } from './ingestion';
import { LiveFiresError, LiveFiresService, type LiveFiresPayload } from './liveFires';
import { createStoreFromEnv, type ObservationStore } from './store';
import type {
  AiChatResponse,
  AiDetectionExplanationResponse,
  AiMapAction,
  AiObservationLoader,
  AiObservationPayload,
  AiToolCallRecord,
} from '../types/ai';
import { AI_GUARDRAILS, AI_LIMITS, aiStatus, readAiConfig } from './ai/config';
import { FixedWindowRateLimiter } from './ai/rateLimit';
import { createGroqClient, ProviderError, runModelChat, type ModelGenerateFn } from './ai/groq';
import {
  historicalClimatology,
  historicalCountries,
  historicalCountryTotals,
  historicalCoverage,
  historicalDaily,
  historicalFrpExtremes,
  historicalMonthAnomaly,
  historicalObservations,
  historicalPeriodTotals,
  historicalPersistence,
  historicalSeasonalStatus,
  historicalStatus,
  historicalYearTotals,
  isRealIsoDate,
} from './historical';
import {
  agniCalendar,
  agniCellMonthCsv,
  agniCellsGeoJSON,
  agniCountries,
  agniMonthlySeries,
  agniIntelligence,
  agniProvenance,
  agniSensorComparison,
  agniSeriesCsv,
  agniStatus,
  agniTopCells,
  type AgniDayNight,
  type AgniFireType,
  type AgniLayer,
  type AgniQuery,
} from './agnicalendar';
import { verifyIncidents } from './incidents';
import {
  AI_TOOL_DECLARATIONS,
  executeAiTool,
  runDeterministicFastPath,
} from './ai/tools';
import {
  ASSISTANT_SYSTEM_INSTRUCTION,
  contextBlock,
  detectionExplanationInstruction,
} from './ai/prompts';
import {
  parseChatRequest,
  parseDetectionExplanationRequest,
  parseEvidence,
} from './ai/schema';
import { auditDataset, clusterObservations } from '../utils/fireIntelligence';
import { buildReport } from './ai/report';
import {
  coverageFor,
  densityFor,
  parseBboxString,
  proximityFor,
  regionDensities,
  type ProximityFeature,
} from './geo/compute';
import { buildScenarioAssessment, parseScenarioRequest } from './scenario';
import { dataset as geoDataset, geoDatasetStatus, unavailableDatasetResult } from './geo/datasets';
import { parseCompareRequest, runComparison } from './geo/compare';
import { addDaysIso, parseAnalysisRequest, type AnalysisRequest } from './geo/requests';
import {
  AUDIT_INSTRUCTION,
  CLUSTER_INSTRUCTION,
  GEOGRAPHIC_INSTRUCTION,
  REPORT_INSTRUCTION,
  SENSOR_INSTRUCTION,
  SCENARIO_INSTRUCTION,
  scenarioPrompt,
  WEATHER_INSTRUCTION,
  auditPrompt,
  clusterPrompt,
  geographicPrompt,
  reportPrompt,
  sensorPrompt,
  watchlistPrompt,
  weatherPrompt,
  WATCHLIST_INSTRUCTION,
} from './ai/prompts';
import {
  buildWeatherFireAnalysis,
  fetchWeatherDays,
  weatherPointForBbox,
} from './geo/weather';
import {
  createWatchlistScheduler,
  createWatchlistStoreFromEnv,
  parseWatchlistCreate,
  recordWatchlistEvaluation,
  publicWatchlist,
  WATCHLIST_MAX_LISTS,
  type Watchlist,
  type WatchlistStore,
} from './watchlists';
import { existsSync, readdirSync } from 'node:fs';

export interface CreateAppOptions {
  store?: ObservationStore;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  fetchImpl?: typeof fetch;
  dataDir?: string;
  /** Mount the live FIRMS handler (disable in unit tests that do not stub fetch). */
  enableLiveFires?: boolean;
  /** Test seam for the Groq transport. Production omits this and uses the real Groq client. */
  ai?: { generate?: ModelGenerateFn };
  /** Watchlist persistence; tests inject MemoryWatchlistStore. */
  watchlistStore?: WatchlistStore;
  /** Disable the watchlist scheduler (tests). Default: started with FIRESYNC_WATCHLIST_INTERVAL_MINUTES or 30. */
  watchlistScheduler?: boolean;
}

export interface AppBundle {
  app: express.Express;
  store: ObservationStore;
  ingestion: IngestionService;
}

export const PROCESSING_VERSION = 'firesync-2.0.0';
export const LIVE_MAX_DAYS = 5;

export interface LocalProvenance {
  status: ProvenanceStatus;
  reason: string;
  raw_source_files_present: boolean;
  checksum_note: string;
}

/**
 * Provenance of records in the local store. The store starts empty; records only arrive through
 * a completed real ingestion job, and each parsed record carries provenance_status VERIFIED.
 * A mixed or fixture-only store stays UNVERIFIED rather than being promoted by association.
 */
export function localStoreProvenance(observations: CanonicalObservation[], dataDir?: string): LocalProvenance {
  const allVerified =
    observations.length > 0 && observations.every((o) => o.provenance_status === 'VERIFIED');
  // F08 fix: check the actual metadata directory for ingestion audit files rather than
  // inferring file presence from the VERIFIED flag on in-memory records. The flag proves
  // row-level provenance but cannot confirm the raw source files still exist on disk.
  let raw_source_files_present = false;
  if (allVerified && dataDir) {
    const metaDir = `${dataDir}/metadata`;
    try {
      raw_source_files_present = existsSync(metaDir) && readdirSync(metaDir).some((f) => f.endsWith('.json'));
    } catch {
      raw_source_files_present = false;
    }
  }
  return {
    status: allVerified ? 'VERIFIED' : 'UNVERIFIED',
    reason: allVerified
      ? 'Every record in the local store was imported by a completed NASA FIRMS ingestion job. Raw files and SHA-256 checksums are recorded in data/metadata.'
      : observations.length === 0
        ? 'The local store is empty. No observation, archive or placeholder record is pre-seeded.'
        : 'The local store contains records without verified NASA provenance. They are preserved but labelled UNVERIFIED.',
    raw_source_files_present,
    checksum_note: 'A SHA-256 checksum verifies file integrity, not NASA authenticity.',
  };
}

interface BaseObservations {
  observations: CanonicalObservation[];
  source: 'live' | 'store';
  provenance: ProvenanceStatus;
  retrieved_at: string | null;
  cached: boolean;
  errors: string[];
  truncated: boolean;
  live: LiveFiresPayload | null;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** Express 4 does not catch rejected promises; route every async handler through this. */
function asyncRoute(
  fn: (req: Request, res: Response) => Promise<unknown>
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysBetween(start: string, end: string): number {
  const a = Date.parse(`${start}T00:00:00Z`);
  const b = Date.parse(`${end}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000) + 1;
}

interface ParsedFilters {
  observations: CanonicalObservation[];
  startDate?: string;
  endDate?: string;
  bbox?: { west: number; south: number; east: number; north: number };
  polygon?: [number, number][];
  sensors: ('MODIS' | 'VIIRS')[];
}

type FilterParse =
  | { ok: true; filters: ParsedFilters }
  | { ok: false; status: number; error: string };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isRealDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function parseBbox(raw: unknown): { west: number; south: number; east: number; north: number } | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const parts = raw.split(',').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [west, south, east, north] = parts;
  if (west < -180 || east > 180 || south < -90 || north > 90 || west >= east || south >= north) return null;
  return { west, south, east, north };
}

function parsePolygonQuery(raw: unknown): PolygonValidation | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') return { ok: false, reason: 'aoi must be a string.' };
  // Accept either compact `lon,lat;...` or a JSON array.
  if (raw.trim().startsWith('[')) {
    try {
      const parsed = JSON.parse(raw);
      // JSON may be [[lon,lat],...]
      const points = Array.isArray(parsed) ? parsed : null;
      if (!points) return { ok: false, reason: 'aoi JSON must be an array of [lon,lat].' };
      const polygon = decodePolygon(points.map((p: unknown) => (Array.isArray(p) ? p.join(',') : '')).join(';'));
      return polygon ? { ok: true, polygon } : { ok: false, reason: 'Invalid polygon geometry.' };
    } catch {
      return { ok: false, reason: 'aoi JSON could not be parsed.' };
    }
  }
  const polygon = decodePolygon(raw);
  return polygon ? { ok: true, polygon } : { ok: false, reason: 'Invalid polygon geometry.' };
}

function parseFilters(req: Request, base: CanonicalObservation[]): FilterParse {
  const startRaw = req.query.start_date;
  const endRaw = req.query.end_date;
  if (startRaw !== undefined && (typeof startRaw !== 'string' || !isRealDate(startRaw))) {
    return { ok: false, status: 400, error: 'start_date must be a real YYYY-MM-DD date.' };
  }
  if (endRaw !== undefined && (typeof endRaw !== 'string' || !isRealDate(endRaw))) {
    return { ok: false, status: 400, error: 'end_date must be a real YYYY-MM-DD date.' };
  }
  if (typeof startRaw === 'string' && typeof endRaw === 'string' && startRaw > endRaw) {
    return { ok: false, status: 400, error: 'start_date must be on or before end_date.' };
  }

  let bbox: ParsedFilters['bbox'];
  if (req.query.bbox !== undefined && req.query.bbox !== '') {
    const parsed = parseBbox(req.query.bbox);
    if (!parsed) {
      return {
        ok: false,
        status: 400,
        error: 'bbox must be west,south,east,north with west<east, south<north and valid ranges.',
      };
    }
    bbox = parsed;
  }

  const polygonResult = parsePolygonQuery(req.query.aoi ?? req.query.polygon);
  if (polygonResult && !polygonResult.ok) {
    return { ok: false, status: 400, error: `Invalid AOI: ${polygonResult.reason}` };
  }
  const polygon = polygonResult && polygonResult.ok ? polygonResult.polygon : undefined;

  let sensors: ('MODIS' | 'VIIRS')[] = [];
  if (req.query.sensors !== undefined && req.query.sensors !== '') {
    if (typeof req.query.sensors !== 'string') {
      return { ok: false, status: 400, error: 'sensors must be a comma-separated string.' };
    }
    const tokens = req.query.sensors.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    if (tokens.includes('ALL')) sensors = ['MODIS', 'VIIRS'];
    else {
      const invalid = tokens.filter((t) => t !== 'MODIS' && t !== 'VIIRS');
      if (invalid.length > 0) {
        return { ok: false, status: 400, error: `Unknown sensor value(s): ${invalid.join(', ')}. Use MODIS, VIIRS or ALL.` };
      }
      sensors = tokens as ('MODIS' | 'VIIRS')[];
    }
  }

  let observations = [...base];
  if (typeof startRaw === 'string') observations = observations.filter((o) => o.acq_date >= startRaw);
  if (typeof endRaw === 'string') observations = observations.filter((o) => o.acq_date <= endRaw);
  if (bbox) observations = observations.filter((o) => isPointInBbox(o.latitude, o.longitude, bbox));
  if (sensors.length > 0) observations = observations.filter((o) => sensors.includes(o.sensor));

  const satellitesRaw = req.query.satellites;
  if (typeof satellitesRaw === 'string' && satellitesRaw && satellitesRaw !== 'ALL') {
    const list = satellitesRaw.split(',').map((s) => s.trim());
    observations = observations.filter((o) => list.includes(o.satellite));
  }

  const minConf = Number(req.query.min_confidence);
  if (Number.isFinite(minConf) && req.query.min_confidence !== undefined) {
    observations = observations.filter((o) => {
      // F56 fix: normalize confidence once using the canonical category field so
      // VIIRS raw values ('h','n','l') and MODIS numeric values are both handled correctly.
      if (typeof o.confidence === 'number') return o.confidence >= minConf;
      // Use the canonical category when available (set during CSV parsing).
      // Cast to string to allow comparison with raw VIIRS single-letter codes ('h','n','l').
      const cat: string = String(o.confidence_category ?? o.confidence);
      if (cat === 'high' || cat === 'h') return minConf <= 80;
      if (cat === 'nominal' || cat === 'n') return minConf <= 50;
      if (cat === 'low' || cat === 'l') return minConf <= 30;
      return true;
    });
  }
  const minFrp = Number(req.query.min_frp);
  if (Number.isFinite(minFrp) && req.query.min_frp !== undefined) {
    observations = observations.filter((o) => o.frp_mw >= minFrp);
  }

  if (polygon) observations = filterByPolygon(observations, polygon);

  return {
    ok: true,
    filters: {
      observations,
      startDate: typeof startRaw === 'string' ? startRaw : undefined,
      endDate: typeof endRaw === 'string' ? endRaw : undefined,
      bbox: bbox ?? undefined,
      polygon,
      sensors,
    },
  };
}

function csvMetadata(base: BaseObservations, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    exported_at: new Date().toISOString(),
    processing_version: PROCESSING_VERSION,
    data_source: base.source,
    provenance_status: base.provenance,
    retrieved_at: base.retrieved_at,
    cached: base.cached,
    source_errors: base.errors.join(' | '),
    truncated: base.truncated,
    harmonization_status: 'EXPLORATORY',
    // The layer is exploratory; the calibration evidence itself is INSUFFICIENT.
    // Both are exported so neither can be mistaken for a validated model.
    calibration_status: 'INSUFFICIENT',
    harmonization_model: 'cal-modis-viirs-v1 (fixed 0.294 exploratory coefficient)',
    bau_definition:
      'BAU = 0.5*MODIS_count + 0.5*(0.294*VIIRS_count) + 0.005*ln(1+FRP_total) for co-detected 1-km cells; sensor-only cells use a count plus log-FRP term. Exploratory, not validated.',
    coverage_status: 'observed days only; missing dates are NOT zero fire',
    ...extra,
  };
}

function filteredDaily(
  filters: ParsedFilters,
  range: { start: string; end: string },
  now: () => Date
): DailyActivitySummary[] {
  const cells = Array.from(aggregateToSpatialTemporalGrid(filters.observations, 1.0).values());
  return buildDailySummariesFromCells(cells, range, { today: now().toISOString().slice(0, 10) });
}

function calibrationFor(filters: ParsedFilters): CalibrationModelMetrics {
  const cells = Array.from(aggregateToSpatialTemporalGrid(filters.observations, 1.0).values());
  const paired = cells
    .filter((c) => c.modis_count > 0 && c.viirs_count > 0)
    .map((c) => ({ modis: c.modis_count, viirs: c.viirs_count, date: c.date }));
  return evaluateCalibrationModel(paired);
}

function sendCsv(res: Response, filename: string, csv: string): void {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
}

export function createApp(options: CreateAppOptions = {}): AppBundle {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  // The runtime store starts empty. Only a completed real NASA FIRMS ingestion job adds records.
  const store = options.store ?? createStoreFromEnv([], env);
  const dataDir = options.dataDir ?? 'data';
  const ingestion = new IngestionService({
    store,
    getKey: () => env.FIRMS_MAP_KEY,
    getBaseUrl: () => env.FIRMS_BASE_URL || FIRMS_DEFAULT_BASE_URL,
    fetchImpl: options.fetchImpl,
    now,
    dataDir,
  });

  const liveService =
    options.enableLiveFires === false
      ? null
      : new LiveFiresService({
          getKey: () => env.FIRMS_MAP_KEY,
          getBaseUrl: () => env.FIRMS_BASE_URL || FIRMS_DEFAULT_BASE_URL,
          fetchImpl: options.fetchImpl,
          now: () => now().getTime(),
        });

  // ---------------------------------------------------------------- watchlists
  // Durable when FIRESYNC_WATCHLIST_PATH is set (JSON file); otherwise in-memory and the API
  // reports durable:false. Alerts are delivered in-app only — no push or email channel exists.
  const watchlistStore = options.watchlistStore ?? createWatchlistStoreFromEnv(env);

  /** Observations for one watchlist's own window, filtered to its date range. */
  const loadWatchlistObservations = async (watchlist: Watchlist) => {
    const payload = await loadAiObservations({
      days: Math.min(Math.max(watchlist.condition.days, 1), LIVE_MAX_DAYS),
      bbox: watchlist.bbox,
    });
    if (payload.source !== 'live' || payload.errors.length || payload.truncated) {
      throw new Error('Monitoring requires a complete successful live response; data unavailable or capped. Narrow the area or retry.');
    }
    const end = now().toISOString().slice(0, 10);
    const start = addDaysIso(end, -(watchlist.condition.days - 1));
    return payload.observations.filter((o) => o.acq_date >= start && o.acq_date <= end);
  };

  const watchlistScheduler =
    options.watchlistScheduler === false
      ? null
      : createWatchlistScheduler({
          store: watchlistStore,
          load: loadWatchlistObservations,
          now,
          onError: (watchlistId, error) => {
            console.error(`Watchlist ${watchlistId} evaluation failed:`, error);
          },
        });
  if (watchlistScheduler) {
    const minutes = Number(env.FIRESYNC_WATCHLIST_INTERVAL_MINUTES);
    watchlistScheduler.start(Number.isFinite(minutes) && minutes >= 1 ? minutes : 30);
  }

  // ---------------------------------------------------------------- AI (Groq)
  // Server-only: the key stays in this process. With AI disabled or unkeyed, every AI route
  // answers 503 and no provider request is made.
  const aiConfig = readAiConfig(env);
  const aiLimiter = new FixedWindowRateLimiter(AI_LIMITS.requestsPerMinute);
  const aiGenerate: ModelGenerateFn = options.ai?.generate ?? createGroqClient(aiConfig).generate;

  /** Observations the AI tools may read: live NRT when available, otherwise the local store. */
  const loadAiObservations: AiObservationLoader = async ({ days, bbox }) => {
    if (!liveService) {
      const observations = store.getObservations();
      return {
        observations,
        source: 'store',
        provenance: localStoreProvenance(observations, dataDir).status,
        retrieved_at: null,
        errors: [],
        truncated: false,
      };
    }
    const payload = await liveService.get({ area: bbox ?? 'world', days, cap: 100_000 });
    const provenance: ProvenanceStatus =
      payload.observations.length > 0 &&
      payload.observations.every((o) => o.provenance_status === 'VERIFIED')
        ? 'VERIFIED'
        : 'UNVERIFIED';
    return {
      observations: payload.observations,
      source: 'live',
      provenance,
      retrieved_at: payload.retrieved_at,
      errors: payload.errors,
      truncated: payload.truncated,
    };
  };

  /** Truthful guard: disabled/unconfigured -> 503, over budget -> 429. Returns false after answering. */
  const aiAllowed = (req: Request, res: Response): boolean => {
    if (!aiConfig.enabled || !aiConfig.configured) {
      res.status(503).json({ error: aiStatus(aiConfig).note, code: 'AI_NOT_CONFIGURED' });
      return false;
    }
    const decision = aiLimiter.check(req.ip ?? 'unknown');
    if (!decision.allowed) {
      res.setHeader('Retry-After', String(decision.retryAfterSeconds));
      res.status(429).json({
        error: `Too many AI requests. Try again in ${decision.retryAfterSeconds}s.`,
        code: 'AI_RATE_LIMITED',
      });
      return false;
    }
    return true;
  };

  const rethrowAiError = (err: unknown): never => {
    if (err instanceof ProviderError) {
      throw new HttpError(err.status, err.message, err.code);
    }
    throw err;
  };

  /** `source=live` reads the official FIRMS NRT Area API; `source=store` reads only ingested records. */
  const sourceFromQuery = (req: Request): 'live' | 'store' => {
    const raw = req.query.source;
    if (raw === undefined || raw === '') return 'store';
    if (typeof raw !== 'string') {
      throw new HttpError(400, "source must be 'live' or 'store'.", 'INVALID_SOURCE');
    }
    const normalized = raw.trim().toLowerCase();
    if (normalized === 'live') return 'live';
    if (normalized === 'store' || normalized === 'local') return 'store';
    throw new HttpError(400, "source must be 'live' or 'store'.", 'INVALID_SOURCE');
  };

  const liveAreaFromQuery = (req: Request): string => {
    const rawArea = req.query.area;
    const rawBbox = req.query.bbox;
    let area: string | undefined;
    if (rawArea !== undefined) {
      if (typeof rawArea !== 'string') {
        throw new HttpError(400, 'area must be world or west,south,east,north.', 'INVALID_AREA');
      }
      if (rawArea.trim()) area = rawArea.trim();
    }
    if (!area && rawBbox !== undefined) {
      if (typeof rawBbox !== 'string') {
        throw new HttpError(400, 'bbox must be west,south,east,north.', 'INVALID_AREA');
      }
      if (rawBbox.trim()) area = rawBbox.trim();
    }
    if (!area) return 'world';
    const check = validateArea(area);
    if (!check.ok) {
      throw new HttpError(
        400,
        `Invalid live area (${check.reason}). Use world or west,south,east,north with west<east and south<north.`,
        'INVALID_AREA'
      );
    }
    // One canonical string for the whole globe, so map and page requests share the cache entry.
    return check.area === '-180,-90,180,90' ? 'world' : check.area;
  };

  const liveDaysFromQuery = (req: Request, today: string): number => {
    const startRaw = req.query.start_date;
    const endRaw = req.query.end_date;
    if (startRaw !== undefined && (typeof startRaw !== 'string' || !isRealDate(startRaw))) {
      throw new HttpError(400, 'start_date must be a real YYYY-MM-DD date.');
    }
    if (endRaw !== undefined && (typeof endRaw !== 'string' || !isRealDate(endRaw))) {
      throw new HttpError(400, 'end_date must be a real YYYY-MM-DD date.');
    }
    if (typeof startRaw === 'string' && typeof endRaw === 'string' && startRaw > endRaw) {
      throw new HttpError(400, 'start_date must be on or before end_date.');
    }

    const earliest = addDays(today, -(LIVE_MAX_DAYS - 1));
    if (typeof startRaw === 'string' && startRaw < earliest) {
      throw new HttpError(
        400,
        `Live NASA FIRMS NRT data covers only the last ${LIVE_MAX_DAYS} days (${earliest} to ${today}). Historical dates require a standard-science archive ingestion, which is not available in this deployment.`,
        'LIVE_WINDOW'
      );
    }
    if (typeof startRaw === 'string' && startRaw > today) {
      throw new HttpError(400, 'Live data cannot start in the future.', 'LIVE_WINDOW');
    }
    if (typeof endRaw === 'string' && endRaw > today) {
      throw new HttpError(400, 'Live data cannot include future dates.', 'LIVE_WINDOW');
    }

    let days: number;
    if (typeof startRaw === 'string') days = daysBetween(startRaw, today);
    else if (typeof endRaw === 'string') days = daysBetween(endRaw, today);
    else {
      const rawDays = Number(req.query.days);
      days = Number.isFinite(rawDays) && rawDays > 0 ? Math.floor(rawDays) : 1;
    }
    if (days > LIVE_MAX_DAYS) {
      throw new HttpError(
        400,
        `Live NASA FIRMS NRT data covers only the last ${LIVE_MAX_DAYS} days (${earliest} to ${today}).`,
        'LIVE_WINDOW'
      );
    }
    return Math.min(Math.max(days, 1), LIVE_MAX_DAYS);
  };

  const resolveBaseObservations = async (req: Request): Promise<BaseObservations> => {
    const source = sourceFromQuery(req);
    if (source === 'store') {
      const observations = store.getObservations();
      const provenance = localStoreProvenance(observations, dataDir);
      return {
        observations,
        source: 'store',
        provenance: provenance.status,
        retrieved_at: null,
        cached: false,
        errors: [],
        truncated: false,
        live: null,
      };
    }

    if (!liveService) {
      throw new HttpError(503, 'Live NASA FIRMS routes are disabled in this deployment.', 'LIVE_DISABLED');
    }
    const today = now().toISOString().slice(0, 10);
    const area = liveAreaFromQuery(req);
    const days = liveDaysFromQuery(req, today);
    // Aggregates need the full response; 100,000 is the service ceiling and above the measured
    // global 1-day total (~95k), so world-wide aggregates are not silently truncated.
    const payload = await liveService.get({ area, days, cap: 100_000 });
    const provenance: ProvenanceStatus =
      payload.observations.length > 0 &&
      payload.observations.every((o) => o.provenance_status === 'VERIFIED')
        ? 'VERIFIED'
        : 'UNVERIFIED';
    return {
      observations: payload.observations,
      source: 'live',
      provenance,
      retrieved_at: payload.retrieved_at,
      cached: payload.cached,
      errors: payload.errors,
      truncated: payload.truncated,
      live: payload,
    };
  };

  /** Default range for a response: live NRT defaults to the fetched window, never to an invented archive. */
  const effectiveRange = (
    parsed: ParsedFilters,
    base: BaseObservations
  ): { start: string; end: string } => {
    const today = now().toISOString().slice(0, 10);
    const liveStart = base.live ? addDays(today, -(base.live.days - 1)) : '2000-01-01';
    return {
      start: parsed.startDate ?? liveStart,
      end: parsed.endDate ?? today,
    };
  };

  const sourceMeta = (base: BaseObservations) => ({
    data_source: base.source,
    provenance_status: base.provenance,
    retrieved_at: base.retrieved_at,
    cached: base.cached,
    source_errors: base.errors,
    truncated: base.truncated,
  });

  const app = express();
  app.use(express.json({ limit: '256kb' }));

  // ---------------------------------------------------------------- health
  app.get('/api/v1/health', (_req, res) => {
    const local = localStoreProvenance(store.getObservations(), dataDir);
    res.json({
      status: 'healthy',
      timestamp: now().toISOString(),
      service: 'FireSync Harmonization Platform',
      version: '2.0.0',
      database: {
        // Truthful: memory is not a database, and JSON is not PostgreSQL/PostGIS.
        status: store.durable ? 'persistent_adapter' : 'in_memory',
        storage_type: store.kind,
        durable: store.durable,
        location: store.location,
        records_count: store.getObservations().length,
        postgres_configured: Boolean(env.DATABASE_URL),
        postgis_active: false,
      },
      firms_integration: {
        api_configured: ingestion.isConfigured(),
        endpoint: 'https://firms.modaps.eosdis.nasa.gov/api/area/csv',
        supported_products: FIRMS_SOURCES.map((s) => s.source),
        live_nrt_max_days: LIVE_MAX_DAYS,
      },
      provenance: {
        local_store_status: local.status,
        raw_source_files_present: local.raw_source_files_present,
        reason: local.reason,
        checksum_note: local.checksum_note,
      },
      calibration: {
        // The layer is exploratory, but the available evidence is insufficient for any
        // calibration claim. Keep both facts visible and consistent with /analytics/calibration.
        status: 'INSUFFICIENT',
        harmonization_status: 'EXPLORATORY',
        note: 'This is not a validated calibration. The 0.294 VIIRS scale factor is a fixed exploratory assumption, not a fitted coefficient; the available evidence is insufficient for a validated model.',
      },
    });
  });

  // -------------------------------------------------------------- metadata
  app.get('/api/v1/metadata', (_req, res) => {
    const local = localStoreProvenance(store.getObservations(), dataDir);
    res.json({
      project: 'FireSync — Harmonized Fire Activity Intelligence',
      team: 'BOT Battalion (NASA Space Apps Challenge 2026)',
      study_regions: STUDY_REGIONS,
      dataset_metadata: {
        ...NASA_DATASET_METADATA,
        local_store_provenance_status: local.status,
        local_store_provenance_reason: local.reason,
      },
      available_sensors: ['MODIS', 'VIIRS'],
      available_satellites: ['Terra', 'Aqua', 'Suomi-NPP', 'NOAA-20', 'NOAA-21'],
      live_products: FIRMS_SOURCES.map((s) => s.source),
      live_nrt: {
        max_days: LIVE_MAX_DAYS,
        endpoint: '/api/v1/fires?area=world&days=1',
        note: 'Near Real-Time detections for the rolling last 1–5 days. Historical standard-science data requires a separate archive ingestion.',
      },
      metrics: [
        { id: 'harmonized', name: 'Harmonized Activity Index (EXPLORATORY)' },
        { id: 'raw_detections', name: 'Raw Detection Count (per sensor, never summed across sensors)' },
        { id: 'frp_mw', name: 'Fire Radiative Power (MW)' },
      ],
      processing_version: PROCESSING_VERSION,
      storage: { kind: store.kind, durable: store.durable },
    });
  });

  // ------------------------------------------------------- data availability
  app.get('/api/v1/data-availability', (_req, res) => {
    const observations = store.getObservations();
    const dates = observations.map((o) => o.acq_date).sort();
    const local = localStoreProvenance(observations, dataDir);
    res.json({
      local_store: {
        total_records: observations.length,
        first_observation_date: dates[0] ?? null,
        last_observation_date: dates[dates.length - 1] ?? null,
        modis_count: observations.filter((o) => o.sensor === 'MODIS').length,
        viirs_count: observations.filter((o) => o.sensor === 'VIIRS').length,
        data_status: observations.length > 0 ? 'locally_ingested_records' : 'empty',
        provenance_status: local.status,
        raw_source_files_present: local.raw_source_files_present,
        reason: local.reason,
      },
      live_nrt: {
        available: ingestion.isConfigured(),
        max_days: LIVE_MAX_DAYS,
        endpoint: '/api/v1/fires?area=world&days=1',
        products: FIRMS_SOURCES.map((s) => s.source),
        note: 'Real NASA FIRMS Near Real-Time detections for the rolling last 1–5 days. The server fetches them on demand and never substitutes a bundled archive.',
      },
      official_nasa_firms: {
        products: [
          { product: 'MODIS_NRT', availability: 'near-real-time area API', status: 'live_source' },
          { product: 'VIIRS_NOAA20_NRT', availability: 'near-real-time area API', status: 'live_source' },
          { product: 'VIIRS_NOAA21_NRT', availability: 'near-real-time area API', status: 'live_source' },
          { product: 'MODIS_C6_1 / VNP14IMG', availability: 'historical archive via FIRMS download/Earthdata', status: 'archive_source_not_ingested_here' },
        ],
        api_key_configured: ingestion.isConfigured(),
        registration_url: 'https://firms.modaps.eosdis.nasa.gov/api/map_key',
      },
      storage: { kind: store.kind, durable: store.durable },
      calibration_status: 'INSUFFICIENT',
      calibration_note:
        'The harmonization layer is EXPLORATORY; no calibration is validated. The fixed 0.294 factor is not fitted.',
    });
  });

  // ------------------------------------------------------------ live fires
  if (liveService) {
    app.get(
      '/api/v1/fires',
      createFiresHandler({
        getKey: () => env.FIRMS_MAP_KEY,
        getBaseUrl: () => env.FIRMS_BASE_URL || FIRMS_DEFAULT_BASE_URL,
        service: liveService,
      })
    );
  }

  // -------------------------------------------------------------- hotspots
  app.get(
    '/api/v1/hotspots',
    asyncRoute(async (req, res) => {
      const base = await resolveBaseObservations(req);
      const parsed = parseFilters(req, base.observations);
      if (!parsed.ok) return res.status(parsed.status).json({ error: parsed.error });
      const filtered = parsed.filters.observations;
      const rawLimit = Number(req.query.limit);
      const rawOffset = Number(req.query.offset);
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 2000) : 500;
      const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;
      res.json({
        total: filtered.length,
        limit,
        offset,
        has_more: offset + limit < filtered.length,
        observations: filtered.slice(offset, offset + limit),
        ...sourceMeta(base),
        filters_applied: {
          bbox: parsed.filters.bbox ?? null,
          aoi_vertices: parsed.filters.polygon?.length ?? 0,
          sensors: parsed.filters.sensors,
          live_area: base.live?.area ?? null,
          live_days: base.live?.days ?? null,
        },
      });
    })
  );

  // -------------------------------------------------------------- calendar
  app.get(
    '/api/v1/calendar',
    asyncRoute(async (req, res) => {
      const base = await resolveBaseObservations(req);
      const parsed = parseFilters(req, base.observations);
      if (!parsed.ok) return res.status(parsed.status).json({ error: parsed.error });
      const { start, end } = effectiveRange(parsed.filters, base);
      const daily = filteredDaily(parsed.filters, { start, end }, now);
      const annotated = applyHistoricalBaselines(daily, daily, { today: now().toISOString().slice(0, 10) });
      const observedDays = annotated.length;
      const activeDays = annotated.filter((d) => d.total_raw_detections > 0).length;
      res.json({
        period: { start_date: start, end_date: end },
        total_days: observedDays,
        observed_days: observedDays,
        active_days: activeDays,
        missing_days: null,
        coverage_status: 'observed_days_only',
        coverage_note:
          base.source === 'live'
            ? `Live NRT only covers the rolling last ${LIVE_MAX_DAYS} days. Only dates with observations are returned; absent dates are NOT zero-fire days.`
            : 'Only dates with observations are returned. Absent dates are NOT zero-fire days; per-day observation opportunity is unknown.',
        ...sourceMeta(base),
        daily_summaries: annotated,
      });
    })
  );

  // ----------------------------------------------------- analytics summary
  app.get(
    '/api/v1/analytics/summary',
    asyncRoute(async (req, res) => {
      const base = await resolveBaseObservations(req);
      const parsed = parseFilters(req, base.observations);
      if (!parsed.ok) return res.status(parsed.status).json({ error: parsed.error });
      const filtered = parsed.filters.observations;
      const cells = Array.from(aggregateToSpatialTemporalGrid(filtered, 1.0).values());
      const modisObs = filtered.filter((o) => o.sensor === 'MODIS');
      const viirsObs = filtered.filter((o) => o.sensor === 'VIIRS');
      const modisFrp = modisObs.reduce((s, o) => s + o.frp_mw, 0);
      const viirsFrp = viirsObs.reduce((s, o) => s + o.frp_mw, 0);
      const harmonized = cells.reduce((s, c) => s + c.harmonized_activity_index, 0);
      const lastJob = store
        .getJobs()
        .filter((j) => j.status === 'completed')
        .map((j) => j.completed_at ?? j.retrieved_at)
        .sort()
        .pop();
      res.json({
        kpis: {
          total_modis_detections: modisObs.length,
          total_viirs_detections: viirsObs.length,
          total_raw_detections: filtered.length,
          active_spatial_temporal_bins: cells.length,
          harmonized_activity_units: Number(harmonized.toFixed(2)),
          total_frp_mw: Number((modisFrp + viirsFrp).toFixed(1)),
          modis_frp_mw: Number(modisFrp.toFixed(1)),
          viirs_frp_mw: Number(viirsFrp.toFixed(1)),
          data_coverage_completeness_pct: null,
          active_days: new Set(filtered.map((o) => o.acq_date)).size,
          most_recent_successful_ingestion: lastJob ?? null,
        },
        ...sourceMeta(base),
        filter_record_count: filtered.length,
      });
    })
  );

  // ---------------------------------------------------- historical archive
  // Local FIRMS year archives (2000-2025) in Parquet; completely separate from the
  // live NRT store. MODIS and VIIRS counts are always reported separately.
  app.get('/api/v1/history/status', asyncRoute(async (_req, res) => {
    res.json(await historicalStatus());
  }));

  app.get(
    '/api/v1/history/daily',
    asyncRoute(async (req, res) => {
      const year = req.query.year ? Number(req.query.year) : undefined;
      const month = req.query.month ? Number(req.query.month) : undefined;
      if (year !== undefined && (!Number.isInteger(year) || year < 1990 || year > 2100)) {
        return res.status(400).json({ error: 'year must be an integer between 1990 and 2100.' });
      }
      if (month !== undefined && (!Number.isInteger(month) || month < 1 || month > 12)) {
        return res.status(400).json({ error: 'month must be an integer between 1 and 12.' });
      }
      const sensor = typeof req.query.sensor === 'string' ? req.query.sensor : undefined;
      const country = typeof req.query.country === 'string' ? req.query.country : undefined;
      const level = req.query.level === 'monthly' ? 'monthly' : 'daily';
      const global = req.query.global === 'true' || req.query.global === '1';
      // F32 fix: validate limit as a finite integer before it reaches SQL LIMIT.
      let limit: number | undefined;
      if (req.query.limit !== undefined && req.query.limit !== '') {
        const rawLimit = Number(req.query.limit);
        if (!Number.isFinite(rawLimit) || !Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 100000) {
          return res.status(400).json({ error: 'limit must be a finite positive integer (max 100000).' });
        }
        limit = rawLimit;
      }
      const startDate = typeof req.query.start_date === 'string' ? req.query.start_date : undefined;
      const endDate = typeof req.query.end_date === 'string' ? req.query.end_date : undefined;
      if (startDate && !isRealIsoDate(startDate)) {
        return res.status(400).json({ error: 'start_date must be a real YYYY-MM-DD calendar date.' });
      }
      if (endDate && !isRealIsoDate(endDate)) {
        return res.status(400).json({ error: 'end_date must be a real YYYY-MM-DD calendar date.' });
      }
      if (startDate && endDate && startDate > endDate) {
        return res.status(400).json({ error: 'start_date must not be after end_date.' });
      }
      const result = await historicalDaily({ year, month, startDate, endDate, sensor, country, level, global, limit });
      res.json({
        level,
        scope: global ? 'GLOBAL' : (country ?? 'ALL_COUNTRIES'),
        sensor: sensor ?? 'ALL',
        country: country ?? null,
        start_date: startDate ?? null,
        end_date: endDate ?? null,
        legend: 'Satellite thermal anomalies, not confirmed wildfires or burned area.',
        rows: result.rows,
        truncated: result.truncated,
      });
    })
  );

  app.get(
    '/api/v1/history/observations',
    asyncRoute(async (req, res) => {
      const date = typeof req.query.date === 'string' ? req.query.date : '';
      if (!isRealIsoDate(date)) {
        return res.status(400).json({ error: 'date must be a real YYYY-MM-DD calendar date.' });
      }
      let bbox: { west: number; south: number; east: number; north: number } | undefined;
      if (typeof req.query.bbox === 'string' && req.query.bbox.trim()) {
        const parsed = parseBbox(req.query.bbox);
        if (!parsed) {
          return res.status(400).json({ error: 'bbox must be west,south,east,north with valid geographic bounds (lat ±90, lon ±180, west<east, south<north).' });
        }
        bbox = parsed;
      }
      const num = (v: unknown): number | undefined => {
        if (typeof v !== 'string' || !v.trim()) return undefined;
        const n = Number(v);
        return Number.isFinite(n) ? n : undefined;
      };
      const sensor = typeof req.query.sensor === 'string' ? req.query.sensor : undefined;
      const result = await historicalObservations({
        date,
        sensor,
        bbox,
        country: typeof req.query.country === 'string' ? req.query.country : undefined,
        satellite: typeof req.query.satellite === 'string' ? req.query.satellite : undefined,
        daynight: req.query.daynight === 'D' || req.query.daynight === 'N' ? req.query.daynight : undefined,
        minFrp: num(req.query.min_frp),
        limit: num(req.query.limit),
      });
      res.json({
        date,
        sensor: sensor ?? 'ALL',
        legend: 'Satellite thermal anomalies, not confirmed wildfires or burned area.',
        rows: result.rows,
        count: result.rows.length,
        truncated: result.truncated,
      });
    })
  );

  app.get(
    '/api/v1/history/coverage',
    asyncRoute(async (req, res) => {
      const sensor = typeof req.query.sensor === 'string' ? req.query.sensor : undefined;
      const rows = await historicalCoverage(sensor);
      res.json({
        sensor: sensor ?? 'ALL',
        note: 'A date absent here means the archive holds no rows for that sensor-day; it is not proof of zero fire activity.',
        days_with_data: rows.length,
        rows,
      });
    })
  );

  app.get(
    '/api/v1/history/year/:sensor/:year',
    asyncRoute(async (req, res) => {
      const sensor = String(req.params.sensor).toUpperCase();
      const year = Number(req.params.year);
      if (!['MODIS', 'VIIRS'].includes(sensor) || !Number.isInteger(year) || year < 1990 || year > 2100) {
        return res.status(400).json({ error: 'sensor must be MODIS or VIIRS; year must be 1990-2100.' });
      }
      const totals = await historicalYearTotals(sensor, year);
      if (!totals) return res.status(404).json({ error: `No ${sensor} data for ${year}.` });
      res.json({ sensor, year, ...totals, legend: 'Satellite thermal anomalies, not confirmed wildfires or burned area.' });
    })
  );

  // Historical CSV exports — bounded, sanitized, same filters as the JSON routes.
  const sendCsv = (res: Response, filename: string, body: string) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(body);
  };

  app.get(
    '/api/v1/history/rankings',
    asyncRoute(async (req, res) => {
      const year = req.query.year ? Number(req.query.year) : NaN;
      if (!Number.isInteger(year) || year < 1990 || year > 2100) {
        return res.status(400).json({ error: 'year must be an integer between 1990 and 2100.' });
      }
      const sensor = typeof req.query.sensor === 'string' ? req.query.sensor.toUpperCase() : undefined;
      let rows = await historicalCountryTotals(year);
      if (sensor) rows = rows.filter((r) => r.sensor === sensor);
      res.json({
        year,
        sensor: sensor ?? 'ALL',
        legend: 'Satellite thermal anomalies, not confirmed wildfires or burned area.',
        note: 'Country labels come from the source ZIP filenames; MODIS and VIIRS rows are never summed.',
        rows,
      });
    })
  );

  const yearRange = (req: { query: Record<string, unknown> }): { startYear?: number; endYear?: number; bad: boolean; reversed: boolean } => {
    const parse = (v: unknown): number | undefined => {
      if (typeof v !== 'string' || !v.trim()) return undefined;
      const n = Number(v);
      return Number.isInteger(n) && n >= 1990 && n <= 2100 ? n : undefined;
    };
    const startYear = parse(req.query.start_year);
    const endYear = parse(req.query.end_year);
    const bad = Boolean((req.query.start_year && startYear === undefined) || (req.query.end_year && endYear === undefined));
    // F33 fix: also flag reversed ranges so callers can return 400.
    const reversed = !bad && startYear !== undefined && endYear !== undefined && startYear > endYear;
    return { startYear, endYear, bad, reversed };
  };

  app.get(
    '/api/v1/history/frp-extremes',
    asyncRoute(async (req, res) => {
      const range = yearRange(req);
      if (range.bad) return res.status(400).json({ error: 'start_year/end_year must be integers between 1990 and 2100.' });
      // F33 fix: reject reversed year ranges explicitly.
      if (range.reversed) return res.status(400).json({ error: 'start_year must not be greater than end_year.' });
      // F33 fix: reject reversed year ranges explicitly.
      if (range.reversed) return res.status(400).json({ error: 'start_year must not be greater than end_year.' });
      const sensor = typeof req.query.sensor === 'string' ? req.query.sensor.toUpperCase() : undefined;
      const rows = await historicalFrpExtremes({
        sensor,
        country: typeof req.query.country === 'string' ? req.query.country : undefined,
        startYear: range.startYear,
        endYear: range.endYear,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      });
      res.json({
        sensor: sensor ?? 'ALL',
        legend: 'Satellite thermal anomalies, not confirmed wildfires or burned area.',
        note: 'FRP maxima are daily-aggregate maxima (max of per-day frp_max_mw), not single-observation extremes.',
        rows,
      });
    })
  );

  app.get(
    '/api/v1/history/persistence',
    asyncRoute(async (req, res) => {
      const range = yearRange(req);
      if (range.bad) return res.status(400).json({ error: 'start_year/end_year must be integers between 1990 and 2100.' });
      // F33 fix: reject reversed year ranges explicitly.
      if (range.reversed) return res.status(400).json({ error: 'start_year must not be greater than end_year.' });
      const sensor = typeof req.query.sensor === 'string' ? req.query.sensor.toUpperCase() : undefined;
      const rows = await historicalPersistence({
        sensor,
        startYear: range.startYear,
        endYear: range.endYear, limit: req.query.limit ? Number(req.query.limit) : undefined });
      res.json({
        sensor: sensor ?? 'ALL',
        legend: 'Satellite thermal anomalies, not confirmed wildfires or burned area.',
        note: 'years_with_data counts distinct archive years with detections per country+sensor — a recurring-activity proxy, MODIS and VIIRS never summed.',
        rows,
      });
    })
  );

  app.get(
    '/api/v1/history/month-anomaly',
    asyncRoute(async (req, res) => {
      const year = req.query.year ? Number(req.query.year) : NaN;
      const month = req.query.month ? Number(req.query.month) : NaN;
      if (!Number.isInteger(year) || year < 1990 || year > 2100) {
        return res.status(400).json({ error: 'year must be an integer between 1990 and 2100.' });
      }
      if (!Number.isInteger(month) || month < 1 || month > 12) {
        return res.status(400).json({ error: 'month must be an integer between 1 and 12.' });
      }
      const sensor = typeof req.query.sensor === 'string' ? req.query.sensor.toUpperCase() : undefined;
      const rows = await historicalMonthAnomaly({
        year,
        month,
        country: typeof req.query.country === 'string' ? req.query.country : undefined,
        sensor,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      });
      res.json({
        year,
        month,
        sensor: sensor ?? 'ALL',
        legend: 'Satellite thermal anomalies, not confirmed wildfires or burned area.',
        note: 'EXPLORATORY archive diagnostic, not the Round 2 RF-B population. Median requires five other non-partial years; valid_years and baseline_years are reported. MODIS mixes Aqua/Terra; version and exposure comparability are not established. Use AgniCalendar intelligence for version-matched comparisons. Not a forecast or confirmed event.',
        rows,
      });
    })
  );

  // Seasonal climatology — "what was typical", never a forecast.
  const parseBboxParam = (v: unknown): { west: number; south: number; east: number; north: number } | null | 'bad' => {
    if (typeof v !== 'string' || !v.trim()) return null;
    const parts = v.split(',').map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return 'bad';
    const [west, south, east, north] = parts;
    if (west < -180 || east > 180 || south < -90 || north > 90 || west >= east || south >= north) return 'bad';
    return { west, south, east, north };
  };

  app.get(
    '/api/v1/history/countries',
    asyncRoute(async (_req, res) => {
      const rows = await historicalCountries();
      res.json({ legend: 'Satellite thermal anomalies, not confirmed wildfires or burned area.', note: 'Country labels come from source archive ZIP filenames.', rows });
    })
  );

  app.get(
    '/api/v1/history/climatology',
    asyncRoute(async (req, res) => {
      const country = typeof req.query.country === 'string' && req.query.country.trim() ? req.query.country.trim() : undefined;
      const bbox = parseBboxParam(req.query.bbox);
      if (bbox === 'bad') return res.status(400).json({ error: 'bbox must be west,south,east,north with west<east, south<north, within +-180/+-90.' });
      if (country && bbox) return res.status(400).json({ error: 'Provide either country or bbox, not both.' });
      if (!country && !bbox) return res.status(400).json({ error: 'Provide country or bbox.' });
      const range = yearRange(req);
      if (range.bad) return res.status(400).json({ error: 'start_year/end_year must be integers between 1990 and 2100.' });
      // F33 fix: reject reversed year ranges explicitly.
      if (range.reversed) return res.status(400).json({ error: 'start_year must not be greater than end_year.' });
      const sensor = typeof req.query.sensor === 'string' ? req.query.sensor.toUpperCase() : undefined;
      const result = await historicalClimatology({ country, bbox: bbox ?? undefined, sensor, startYear: range.startYear, endYear: range.endYear });
      res.json(result);
    })
  );

  app.get(
    '/api/v1/history/seasonal-status',
    asyncRoute(async (req, res) => {
      const country = typeof req.query.country === 'string' ? req.query.country.trim() : '';
      if (!country) return res.status(400).json({ error: 'country is required.' });
      const sensor = typeof req.query.sensor === 'string' ? req.query.sensor.toUpperCase() : undefined;
      const date = typeof req.query.date === 'string' ? req.query.date : undefined;
      const windowDays = req.query.window_days ? Number(req.query.window_days) : undefined;
      const num = (v: unknown): number | undefined => {
        if (typeof v !== 'string' || !v.trim()) return undefined;
        const n = Number(v);
        return Number.isFinite(n) && n >= 0 ? n : undefined;
      };
      const observed = {
        MODIS: num(req.query.observed_modis),
        VIIRS: num(req.query.observed_viirs),
      };
      const result = await historicalSeasonalStatus({
        country,
        sensor,
        date,
        windowDays: Number.isFinite(windowDays) ? windowDays : undefined,
        observed: observed.MODIS != null || observed.VIIRS != null ? observed : undefined,
      });
      if (!result) return res.status(404).json({ error: `No climatology data for "${country}".` });
      res.json(result);
    })
  );

  app.get(
    '/api/v1/history/export/climatology.csv',
    asyncRoute(async (req, res) => {
      const country = typeof req.query.country === 'string' && req.query.country.trim() ? req.query.country.trim() : undefined;
      const bbox = parseBboxParam(req.query.bbox);
      if (bbox === 'bad') return res.status(400).json({ error: 'bbox must be west,south,east,north.' });
      if (!country && !bbox) return res.status(400).json({ error: 'Provide country or bbox.' });
      const range = yearRange(req);
      if (range.bad) return res.status(400).json({ error: 'start_year/end_year must be integers between 1990 and 2100.' });
      // F33 fix: reject reversed year ranges explicitly.
      if (range.reversed) return res.status(400).json({ error: 'start_year must not be greater than end_year.' });
      const result = await historicalClimatology({ country, bbox: bbox ?? undefined, sensor: typeof req.query.sensor === 'string' ? req.query.sensor.toUpperCase() : undefined, startYear: range.startYear, endYear: range.endYear });
      const header = 'month,sensor,median_detections,p25_detections,p75_detections,years_with_data,years_total,median_frp_sum_mw,harmonized_equivalent_median,activity_class';
      const lines: string[] = [];
      for (const m of result.months) {
        const sensors = Object.keys(m.sensors);
        if (!sensors.length) {
          lines.push([m.month, '', '', '', '', '', '', '', m.harmonized_equivalent_median ?? '', m.activity_class].map((v) => sanitizeCsvCell(v)).join(','));
          continue;
        }
        for (const s of sensors) {
          const st = m.sensors[s];
          lines.push(
            [m.month, s, st.median_detections, st.p25_detections, st.p75_detections, st.years_with_data, st.years_total, st.median_frp_sum_mw ?? '', m.harmonized_equivalent_median ?? '', m.activity_class]
              .map((v) => sanitizeCsvCell(v))
              .join(',')
          );
        }
      }
      sendCsv(res, `firesync-history-climatology-${country ?? 'bbox'}-${result.scope.sensor.toLowerCase()}.csv`, [header, ...lines].join('\r\n'));
    })
  );

  app.get(
    '/api/v1/history/export/daily.csv',
    asyncRoute(async (req, res) => {
      const year = req.query.year ? Number(req.query.year) : undefined;
      const month = req.query.month ? Number(req.query.month) : undefined;
      if (year !== undefined && (!Number.isInteger(year) || year < 1990 || year > 2100)) {
        return res.status(400).json({ error: 'year must be an integer between 1990 and 2100.' });
      }
      if (month !== undefined && (!Number.isInteger(month) || month < 1 || month > 12)) {
        return res.status(400).json({ error: 'month must be an integer between 1 and 12.' });
      }
      const sensor = typeof req.query.sensor === 'string' ? req.query.sensor : undefined;
      const country = typeof req.query.country === 'string' ? req.query.country : undefined;
      const level = req.query.level === 'monthly' ? 'monthly' : 'daily';
      const global = req.query.global === 'true' || req.query.global === '1';
      let limit: number | undefined;
      if (req.query.limit !== undefined && req.query.limit !== '') {
        const rawLimit = Number(req.query.limit);
        if (!Number.isFinite(rawLimit) || !Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 100000) {
          return res.status(400).json({ error: 'limit must be a finite positive integer (max 100000).' });
        }
        limit = rawLimit;
      }
      const startDate = typeof req.query.start_date === 'string' ? req.query.start_date : undefined;
      const endDate = typeof req.query.end_date === 'string' ? req.query.end_date : undefined;
      if (startDate && !isRealIsoDate(startDate)) {
        return res.status(400).json({ error: 'start_date must be a real YYYY-MM-DD calendar date.' });
      }
      if (endDate && !isRealIsoDate(endDate)) {
        return res.status(400).json({ error: 'end_date must be a real YYYY-MM-DD calendar date.' });
      }
      if (startDate && endDate && startDate > endDate) {
        return res.status(400).json({ error: 'start_date must not be after end_date.' });
      }
      const result = await historicalDaily({ year, month, startDate, endDate, sensor, country, level, global, limit });
      const metaLines = [
        '# FireSync historical daily activity export',
        `# Scope: ${global ? 'GLOBAL' : (country ?? 'ALL_COUNTRIES')}`,
        `# Sensor: ${sensor ?? 'ALL'}`,
        `# Truncated: ${result.truncated}`,
        `# Row limit: ${limit ?? 10000}`,
      ];
      if (startDate) metaLines.push(`# Start date: ${startDate}`);
      if (endDate) metaLines.push(`# End date: ${endDate}`);
      const header = 'period,country,sensor,detections,frp_sum_mw,frp_max_mw,day_count,night_count';
      const lines = result.rows.map((r) =>
        [r.period, r.country, r.sensor, r.detections, r.frp_sum_mw ?? '', r.frp_max_mw ?? '', r.day_count ?? '', r.night_count ?? '']
          .map((v) => sanitizeCsvCell(v))
          .join(',')
      );
      sendCsv(res, `firesync-history-daily-${year ?? 'all'}-${sensor ?? 'all'}.csv`, [...metaLines, header, ...lines].join('\r\n'));
    })
  );

  app.get(
    '/api/v1/history/export/observations.csv',
    asyncRoute(async (req, res) => {
      const date = typeof req.query.date === 'string' ? req.query.date : '';
      if (!isRealIsoDate(date)) {
        return res.status(400).json({ error: 'date must be a real YYYY-MM-DD calendar date.' });
      }
      let bbox: { west: number; south: number; east: number; north: number } | undefined;
      if (typeof req.query.bbox === 'string' && req.query.bbox.trim()) {
        const parsed = parseBbox(req.query.bbox);
        if (!parsed) {
          return res.status(400).json({ error: 'bbox must be west,south,east,north with valid geographic bounds (lat ±90, lon ±180, west<east, south<north).' });
        }
        bbox = parsed;
      }
      const num = (v: unknown): number | undefined => {
        if (typeof v !== 'string' || !v.trim()) return undefined;
        const n = Number(v);
        return Number.isFinite(n) ? n : undefined;
      };
      const sensor = typeof req.query.sensor === 'string' ? req.query.sensor : undefined;
      const minFrp = num(req.query.min_frp);
      const limit = num(req.query.limit) ?? 100000;
      const result = await historicalObservations({
        date,
        sensor,
        bbox,
        country: typeof req.query.country === 'string' ? req.query.country : undefined,
        satellite: typeof req.query.satellite === 'string' ? req.query.satellite : undefined,
        daynight: req.query.daynight === 'D' || req.query.daynight === 'N' ? req.query.daynight : undefined,
        minFrp,
        limit,
      });
      sendCsv(
        res,
        `firesync-history-obs-${date}${sensor ? `-${sensor.toLowerCase()}` : ''}.csv`,
        observationsToCsv(result.rows, {
          dataset: 'FIRMS_HISTORICAL_LOCAL_ARCHIVE',
          generated_at: new Date().toISOString(),
          filters: { date, sensor: sensor ?? 'ALL', ...(bbox ? { bbox } : {}), ...(minFrp ? { min_frp: minFrp } : {}) },
          row_count: result.rows.length,
          truncated: result.truncated,
          cap: limit,
        })
      );
    })
  );

  app.get(
    '/api/v1/history/export/coverage.csv',
    asyncRoute(async (req, res) => {
      const sensor = typeof req.query.sensor === 'string' ? req.query.sensor : undefined;
      const rows = await historicalCoverage(sensor);
      const header = 'date,sensor,global_rows';
      const lines = rows.map((r) => [r.date, r.sensor, r.global_rows].map((v) => sanitizeCsvCell(v)).join(','));
      sendCsv(res, `firesync-history-coverage-${sensor?.toLowerCase() ?? 'all'}.csv`, [header, ...lines].join('\r\n'));
    })
  );

  app.get(
    '/api/v1/history/export/frp-extremes.csv',
    asyncRoute(async (req, res) => {
      const range = yearRange(req);
      if (range.bad) return res.status(400).json({ error: 'start_year/end_year must be integers between 1990 and 2100.' });
      // F33 fix: reject reversed year ranges explicitly.
      if (range.reversed) return res.status(400).json({ error: 'start_year must not be greater than end_year.' });
      // F33 fix: reject reversed year ranges explicitly.
      if (range.reversed) return res.status(400).json({ error: 'start_year must not be greater than end_year.' });
      const sensor = typeof req.query.sensor === 'string' ? req.query.sensor.toUpperCase() : undefined;
      const rows = await historicalFrpExtremes({
        sensor,
        country: typeof req.query.country === 'string' ? req.query.country : undefined,
        startYear: range.startYear,
        endYear: range.endYear,
        limit: 100,
      });
      const header = 'period,country,sensor,frp_max_mw,detections';
      const lines = rows.map((r) =>
        [r.period, r.country, r.sensor, r.frp_max_mw, r.detections].map((v) => sanitizeCsvCell(v)).join(',')
      );
      sendCsv(res, `firesync-history-frp-extremes-${sensor?.toLowerCase() ?? 'all'}.csv`, [header, ...lines].join('\r\n'));
    })
  );

  app.get(
    '/api/v1/history/export/persistence.csv',
    asyncRoute(async (req, res) => {
      const range = yearRange(req);
      if (range.bad) return res.status(400).json({ error: 'start_year/end_year must be integers between 1990 and 2100.' });
      // F33 fix: reject reversed year ranges explicitly.
      if (range.reversed) return res.status(400).json({ error: 'start_year must not be greater than end_year.' });
      const sensor = typeof req.query.sensor === 'string' ? req.query.sensor.toUpperCase() : undefined;
      const rows = await historicalPersistence({
        sensor,
        startYear: range.startYear,
        endYear: range.endYear,
        limit: 200,
      });
      const header = 'country,sensor,years_with_data,detections';
      const lines = rows.map((r) =>
        [r.country, r.sensor, r.years_with_data, r.detections].map((v) => sanitizeCsvCell(v)).join(',')
      );
      sendCsv(res, `firesync-history-persistence-${sensor?.toLowerCase() ?? 'all'}.csv`, [header, ...lines].join('\r\n'));
    })
  );

  app.get(
    '/api/v1/history/export/month-anomaly.csv',
    asyncRoute(async (req, res) => {
      const year = req.query.year ? Number(req.query.year) : NaN;
      const month = req.query.month ? Number(req.query.month) : NaN;
      if (!Number.isInteger(year) || year < 1990 || year > 2100) {
        return res.status(400).json({ error: 'year must be an integer between 1990 and 2100.' });
      }
      if (!Number.isInteger(month) || month < 1 || month > 12) {
        return res.status(400).json({ error: 'month must be an integer between 1 and 12.' });
      }
      const sensor = typeof req.query.sensor === 'string' ? req.query.sensor.toUpperCase() : undefined;
      const rows = await historicalMonthAnomaly({
        year,
        month,
        country: typeof req.query.country === 'string' ? req.query.country : undefined,
        sensor,
        limit: 200,
      });
      const header = 'country,sensor,year,detections,other_years_median,ratio';
      const lines = rows.map((r) =>
        [r.country, r.sensor, r.year, r.detections, r.other_years_median, r.ratio ?? ''].map((v) => sanitizeCsvCell(v)).join(',')
      );
      sendCsv(res, `firesync-history-month-anomaly-${year}-${String(month).padStart(2, '0')}${sensor ? `-${sensor.toLowerCase()}` : ''}.csv`, [header, ...lines].join('\r\n'));
    })
  );

  // ---------------------------------------------------- AgniCalendar harmonized dataset
  // Separate 10 km cell x UTC-month product (2002-2025); see docs/agnicalendar.md.
  const parseAgniQuery = (req: { query: Record<string, unknown> }): { query: AgniQuery; error?: string } => {
    const q: AgniQuery = {};
    const layer = typeof req.query.layer === 'string' ? req.query.layer : undefined;
    if (layer && !['aqua', 'snpp', 'harmonized'].includes(layer)) {
      return { query: q, error: 'layer must be aqua, snpp or harmonized.' };
    }
    q.layer = layer as AgniLayer | undefined;
    const daynight = typeof req.query.daynight === 'string' ? req.query.daynight : undefined;
    if (daynight && !['day', 'night', 'unknown', 'known'].includes(daynight)) {
      return { query: q, error: 'daynight must be day, night, unknown or known (DAY+NIGHT).' };
    }
    q.daynight = daynight as AgniDayNight | undefined;
    const fireType = typeof req.query.fire_type === 'string' ? req.query.fire_type : undefined;
    if (fireType && !['0', '1', '2', '3', 'UNKNOWN', 'all'].includes(fireType)) {
      return { query: q, error: "fire_type must be '0','1','2','3','UNKNOWN' or 'all'." };
    }
    q.fireType = fireType as AgniFireType | undefined;

    const bbox = parseBboxParam(req.query.bbox);
    if (bbox === 'bad') return { query: q, error: 'bbox must be west,south,east,north.' };
    q.scope = bbox ? { kind: 'bbox', bbox } : { kind: 'global' };

    if (req.query.aoi !== undefined) {
      const polygon = decodePolygon(String(req.query.aoi));
      if (!polygon) return { query: q, error: 'Invalid AOI polygon.' };
      if (polygon.length > 100) return { query: q, error: 'AOI is limited to 100 vertices.' };
      q.polygon = polygon;
    }

    const country = typeof req.query.country === 'string' ? req.query.country.trim() : '';
    if (country.length > 0) q.country = country.slice(0, 120);

    const range = yearRange(req);
    if (range.bad) return { query: q, error: 'start_year/end_year must be integers between 1990 and 2100.' };
    // F33 fix: reject reversed year ranges explicitly.
    if (range.reversed) return { query: q, error: 'start_year must not be greater than end_year.' };
    q.startYear = range.startYear;
    q.endYear = range.endYear;
    const year = req.query.year ? Number(req.query.year) : undefined;
    const month = req.query.month ? Number(req.query.month) : undefined;
    if (year !== undefined && (!Number.isInteger(year) || year < 1990 || year > 2100)) {
      return { query: q, error: 'year must be an integer between 1990 and 2100.' };
    }
    if (month !== undefined && (!Number.isInteger(month) || month < 1 || month > 12)) {
      return { query: q, error: 'month must be an integer between 1 and 12.' };
    }
    q.year = year;
    q.month = month;
    if (q.startYear && q.endYear && q.startYear > q.endYear) return { query: q, error: 'start_year must not exceed end_year.' };
    return { query: q };
  };

  app.get('/api/v1/agnicalendar/provenance', (_req, res) => res.json(agniProvenance()));
  app.get('/api/v1/agnicalendar/export/cell-months.csv', asyncRoute(async (req, res) => {
    const { query, error } = parseAgniQuery(req);
    if (error) return res.status(400).json({ error });
    if (!query.year || !query.month) return res.status(400).json({ error: 'year and month are required for streaming grid-cell export.' });
    res.type('text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="agnicalendar-cell-months-${query.year}-${query.month}.csv"`);
    const abort = new AbortController();
    res.once('close', () => abort.abort());
    try {
      for await (const chunk of agniCellMonthCsv(query)) {
        if (res.destroyed) break;
        if (!res.write(chunk)) await once(res, 'drain', { signal: abort.signal });
      }
      res.end();
    } catch (e) {
      if (res.destroyed) return;
      if (res.headersSent) res.destroy();
      else throw e;
    }
  }));
  app.get('/api/v1/agnicalendar/intelligence', asyncRoute(async (req, res) => {
    const { query, error } = parseAgniQuery(req);
    if (error) return res.status(400).json({ error });
    if (query.year === undefined) return res.status(400).json({ error: 'year is required.' });
    res.json(await agniIntelligence({ ...query, year: query.year }));
  }));
  app.get('/api/v1/agnicalendar/comparison', asyncRoute(async (req, res) => {
    const { query, error } = parseAgniQuery(req);
    if (error) return res.status(400).json({ error });
    if (query.year === undefined || query.month === undefined) return res.status(400).json({ error: 'year and month are required.' });
    res.json({ rows: await agniSensorComparison(query), note: 'Supported columns use the same conditional joint-positive population. All-observed columns have different support. Never sum sensors. EXPLORATORY model estimates, not detections.' });
  }));

  app.get('/api/v1/agnicalendar/status', asyncRoute(async (_req, res) => {
    res.json(await agniStatus());
  }));

  // Countries available via the cell->country majority-vote lookup.
  app.get('/api/v1/agnicalendar/countries', asyncRoute(async (_req, res) => {
    res.json({ countries: await agniCountries() });
  }));

  app.get(
    '/api/v1/agnicalendar/series',
    asyncRoute(async (req, res) => {
      const { query, error } = parseAgniQuery(req);
      if (error) return res.status(400).json({ error });
      const rows = await agniMonthlySeries(query);
      res.json({
        scope: query.scope?.kind ?? 'global',
        country: query.country ?? null,
        layer: query.layer ?? 'aqua',
        daynight: query.daynight ?? 'known',
        fire_type: query.fireType ?? '0',
        legend: 'Satellite thermal anomalies, not confirmed wildfires or burned area.',
        note: 'Monthly detection sums per 10 km cell aggregate. NULL/missing months are unavailable, not zero fire activity. DAY/NIGHT/UNKNOWN-DN stay separate; harmonized values are model estimates on approved support only.',
        rows,
      });
    })
  );

  app.get(
    '/api/v1/agnicalendar/calendar',
    asyncRoute(async (req, res) => {
      const { query, error } = parseAgniQuery(req);
      if (error) return res.status(400).json({ error });
      const rows = await agniCalendar(query);
      res.json({
        scope: query.scope?.kind ?? 'global',
        country: query.country ?? null,
        layer: query.layer ?? 'aqua',
        daynight: query.daynight ?? 'known',
        fire_type: query.fireType ?? '0',
        legend: 'Satellite thermal anomalies, not confirmed wildfires or burned area.',
        note: 'Descriptive calendar of satellite-detected activity — not a forecast. Grey/missing cells are unavailable data, not confirmed fire-free months. January 2012 SNPP/harmonized rows are partial coverage.',
        rows,
      });
    })
  );

  app.get(
    '/api/v1/agnicalendar/cells',
    asyncRoute(async (req, res) => {
      const { query, error } = parseAgniQuery(req);
      if (error) return res.status(400).json({ error });
      if (query.year === undefined || query.month === undefined) {
        return res.status(400).json({ error: 'year and month are required for cells.' });
      }
      const limit = req.query.limit ? Number(req.query.limit) : 200;
      const rows = await agniTopCells({ ...query, limit });
      res.json({
        year: query.year,
        month: query.month,
        country: query.country ?? null,
        layer: query.layer ?? 'aqua',
        daynight: query.daynight ?? 'known',
        fire_type: query.fireType ?? '0',
        grid: 'EPSG:8857 10 km cells; lon/lat are cell-centre coordinates.',
        legend: 'Satellite thermal anomalies, not confirmed wildfires or burned area.',
        rows,
      });
    })
  );

  // GeoJSON polygons for the top cells of one month — map overlay source.
  app.get(
    '/api/v1/agnicalendar/cells.geojson',
    asyncRoute(async (req, res) => {
      const { query, error } = parseAgniQuery(req);
      if (error) return res.status(400).json({ error });
      if (query.year === undefined || query.month === undefined) {
        return res.status(400).json({ error: 'year and month are required for cells.geojson.' });
      }
      const limit = req.query.limit ? Number(req.query.limit) : 1000;
      const data = await agniCellsGeoJSON({ ...query, limit });
      res.json({
        ...data,
        year: query.year,
        month: query.month,
        layer: query.layer ?? 'aqua',
        daynight: query.daynight ?? 'known',
        fire_type: query.fireType ?? '0',
        grid: 'EPSG:8857 10 km cells; polygons approximate cell boundaries.',
        legend: 'Satellite thermal anomalies, not confirmed wildfires or burned area.',
        note: 'Top cells only (limit-capped); cell polygons are grid approximations, not fire perimeters.',
      });
    })
  );

  app.get(
    '/api/v1/agnicalendar/export/series.csv',
    asyncRoute(async (req, res) => {
      const { query, error } = parseAgniQuery(req);
      if (error) return res.status(400).json({ error });
      const rows = await agniMonthlySeries(query);
      if (!Array.isArray(rows)) return res.status(503).json({ error: rows.error, scope: rows.scope });
      const layer = query.layer ?? 'aqua';
      const daynight = query.daynight ?? 'known';
      sendCsv(
        res,
        `firesync-agnicalendar-series-${layer}-${daynight}-${query.country ?? query.scope?.kind ?? 'global'}.csv`,
        agniSeriesCsv(rows, query)
      );
    })
  );

  // ------------------------------------------- official incident verification
  // WFIGS/IRWIN current US wildland-fire incidents corroborated against
  // satellite detections. US-only official records; never a fire confirmation.
  app.get(
    '/api/v1/incidents',
    asyncRoute(async (req, res) => {
      const daysRaw = req.query.days !== undefined ? Number(req.query.days) : 14;
      const days = Number.isFinite(daysRaw) ? Math.min(Math.max(Math.floor(daysRaw), 1), 60) : 14;
      const state = typeof req.query.state === 'string' ? req.query.state : undefined;
      const base = await resolveBaseObservations(req);
      const result = await verifyIncidents(base.observations, {
        days,
        state,
        radiusKm: req.query.radius_km !== undefined ? Number(req.query.radius_km) : undefined,
      });
      res.json(result);
    })
  );

  // ---------------------------------------------------- sensor comparison
  app.get(
    '/api/v1/analytics/sensors',
    asyncRoute(async (req, res) => {
    const base = await resolveBaseObservations(req);
    const parsed = parseFilters(req, base.observations);
    if (!parsed.ok) return res.status(parsed.status).json({ error: parsed.error });
    const filtered = parsed.filters.observations;
    const cells = Array.from(aggregateToSpatialTemporalGrid(filtered, 1.0).values());
    const pairedCells = cells.filter((c) => c.modis_count > 0 && c.viirs_count > 0);
    const paired = pairedCells.map((c) => ({ modis: c.modis_count, viirs: c.viirs_count, date: c.date }));
    const metrics = evaluateCalibrationModel(paired);
    const matching = matchModisViirs(filtered);
    const modis = filtered.filter((o) => o.sensor === 'MODIS');
    const viirs = filtered.filter((o) => o.sensor === 'VIIRS');
    const modisFrp = modis.reduce((s, o) => s + o.frp_mw, 0);
    const viirsFrp = viirs.reduce((s, o) => s + o.frp_mw, 0);
    res.json({
      comparison: {
        modis_total_detections: modis.length,
        viirs_total_detections: viirs.length,
        ratio_viirs_to_modis: modis.length > 0 ? Number((viirs.length / modis.length).toFixed(2)) : null,
        paired_1km_cells_count: paired.length,
        calibration_metrics: metrics,
        frp: {
          modis_total_mw: Number(modisFrp.toFixed(1)),
          viirs_total_mw: Number(viirsFrp.toFixed(1)),
          note: 'Per-sensor sums. They are never added together to represent one harmonized quantity.',
        },
        matched_points: matching.point.matched.map((p) => ({
          modis: p.modis.id,
          viirs: p.viirs.id,
          distance_km: Number(p.distanceKm.toFixed(3)),
          time_diff_minutes: Number(p.timeDiffMinutes.toFixed(1)),
          modis_frp_mw: p.modis.frp_mw,
          viirs_frp_mw: p.viirs.frp_mw,
          date: p.modis.acq_date,
        })),
        paired_cells: pairedCells.map((c) => ({
          cell_id: c.cell_id,
          date: c.date,
          modis_count: c.modis_count,
          viirs_count: c.viirs_count,
        })),
        matching_summary: {
          method: matching.method,
          label: matching.label,
          point_pairs: matching.point.matched.length,
          co_detected_cells: matching.cell.cells.length,
          detection_ratio: matching.detectionRatio.overall.ratio,
          limitations: matching.limitations,
        },
        ...sourceMeta(base),
        calibration_status: metrics.status,
      },
      sensor_specifications: [
        {
          sensor: 'MODIS (Moderate Resolution Imaging Spectroradiometer)',
          satellites: ['Terra (~10:30 local)', 'Aqua (~13:30 local)'],
          nadir_pixel_resolution: '1.0 km',
          edge_pixel_resolution: 'up to ~2.0 x 4.8 km (bow-tie)',
          bands_used: 'B21/B22 (3.9 µm) and B31 (11 µm)',
          detection_characteristics:
            'Less sensitive to small/low-FRP fires than VIIRS. A hotspot is a thermal anomaly, not a unique fire.',
        },
        {
          sensor: 'VIIRS (Visible Infrared Imaging Radiometer Suite)',
          satellites: ['NOAA-20 (~12:40 local)', 'NOAA-21'],
          nadir_pixel_resolution: '375 m (I-bands)',
          edge_pixel_resolution: '~750–800 m (onboard aggregation)',
          bands_used: 'I4 (3.74 µm) and I5 (11.45 µm)',
          detection_characteristics:
            'Typically registers more hotspot pixels than MODIS for the same burning area. Counts are not directly comparable without calibration.',
        },
      ],
      data_note:
        'No comparison value is invented. Empty arrays and null metrics mean the selected area/date range has no paired evidence.',
    });
    })
  );

  // --------------------------------------------------------- anomalies
  app.get(
    '/api/v1/analytics/anomalies',
    asyncRoute(async (req, res) => {
      const base = await resolveBaseObservations(req);
      const parsed = parseFilters(req, base.observations);
      if (!parsed.ok) return res.status(parsed.status).json({ error: parsed.error });
      const { start, end } = effectiveRange(parsed.filters, base);
      const daily = filteredDaily(parsed.filters, { start, end }, now);
      const annotated = applyHistoricalBaselines(daily, daily, { today: now().toISOString().slice(0, 10) });
      const anomalies = annotated.filter(
        (d) => d.anomaly_category !== 'normal' && d.anomaly_category !== 'insufficient_data'
      );
      res.json({
        total_anomalies_detected: anomalies.length,
        methodology: 'Seasonal median + Median Absolute Deviation (MAD) robust z-score',
        thresholds: {
          moderate_anomaly: 'Z >= 1.5',
          high_anomaly: 'Z >= 2.5',
          extreme_anomaly: 'Z >= 3.5',
          minimum_history: `>= ${3} other years with observations`,
        },
        notice:
          'Anomalies describe unusual observed activity relative to available historical observations. They are NOT wildfire predictions, forecasts, or a complete fire record.',
        coverage_status: 'observed_days_only',
        ...sourceMeta(base),
        anomalies,
      });
    })
  );

  // -------------------------------------------------------- calibration
  app.get(
    '/api/v1/analytics/calibration',
    asyncRoute(async (req, res) => {
      const base = await resolveBaseObservations(req);
      const parsed = parseFilters(req, base.observations);
      if (!parsed.ok) return res.status(parsed.status).json({ error: parsed.error });
      const metrics = calibrationFor(parsed.filters);
      res.json({
        ...metrics,
        status_definitions: {
          INSUFFICIENT: 'The explicit validation criteria are not met, including in-sample-only evidence or undefined R².',
          EXPLORATORY: 'The harmonization layer is exploratory; no calibration result uses this label.',
          CALIBRATED: 'A model was fitted and its uncertainty is reported, but independent validation is incomplete.',
          VALIDATED: 'All explicit holdout, sample-size and uncertainty criteria were met.',
        },
        fixed_exploratory_factor: HARMONIZATION_CONSTANTS.VIIRS_COUNT_SCALE_FACTOR,
        observation_count: parsed.filters.observations.length,
        ...sourceMeta(base),
      });
    })
  );

  app.get(
    '/api/v1/analytics/calibration/holdout',
    asyncRoute(async (req, res) => {
      const base = await resolveBaseObservations(req);
      const parsed = parseFilters(req, base.observations);
      if (!parsed.ok) return res.status(parsed.status).json({ error: parsed.error });
      const cells = Array.from(aggregateToSpatialTemporalGrid(parsed.filters.observations, 1.0).values());
      const paired = cells
        .filter((c) => c.modis_count > 0 && c.viirs_count > 0)
        .map((c) => ({ modis: c.modis_count, viirs: c.viirs_count, date: c.date }));
      res.json({
        ...evaluateTemporalHoldout(paired),
        observation_count: parsed.filters.observations.length,
        ...sourceMeta(base),
      });
    })
  );

  // --------------------------------------------------------- timeseries
  app.get(
    '/api/v1/analytics/timeseries',
    asyncRoute(async (req, res) => {
      const base = await resolveBaseObservations(req);
      const parsed = parseFilters(req, base.observations);
      if (!parsed.ok) return res.status(parsed.status).json({ error: parsed.error });
      const { start, end } = effectiveRange(parsed.filters, base);
      const daily = filteredDaily(parsed.filters, { start, end }, now);
      res.json({
        start_date: start,
        end_date: end,
        coverage_status: 'observed_days_only',
        ...sourceMeta(base),
        series: daily.map((d) => ({
          date: d.date,
          modis_count: d.modis_detections,
          viirs_count: d.viirs_detections,
          harmonized_units: d.harmonized_activity_units,
          total_frp_mw: d.total_frp_mw,
        })),
      });
    })
  );

  // ------------------------------------------------------------- exports
  const metadataFrom = (
    req: Request,
    base: BaseObservations,
    filters: ParsedFilters,
    extra: Record<string, unknown> = {}
  ) =>
    csvMetadata(base, {
      aoi_geometry: filters.polygon ?? null,
      bbox: filters.bbox ?? null,
      start_date: filters.startDate ?? null,
      end_date: filters.endDate ?? null,
      sensors: filters.sensors,
      confidence_threshold: req.query.min_confidence ?? null,
      live_area: base.live?.area ?? null,
      live_days: base.live?.days ?? null,
      ...extra,
    });

  app.get(
    '/api/v1/export/csv',
    asyncRoute(async (req, res) => {
      const base = await resolveBaseObservations(req);
      const parsed = parseFilters(req, base.observations);
      if (!parsed.ok) return res.status(parsed.status).json({ error: parsed.error });
      const dataset = String(req.query.dataset ?? 'all').toLowerCase();
      if (!['all', 'modis', 'viirs', 'raw'].includes(dataset)) {
        return res.status(400).json({ error: 'dataset must be all, raw, modis or viirs.' });
      }
      let rows = parsed.filters.observations;
      if (dataset === 'modis') rows = rows.filter((o) => o.sensor === 'MODIS');
      if (dataset === 'viirs') rows = rows.filter((o) => o.sensor === 'VIIRS');
      sendCsv(
        res,
        `firesync_${dataset}_${now().toISOString().slice(0, 10)}.csv`,
        observationsToCsv(rows, metadataFrom(req, base, parsed.filters, { dataset, row_count: rows.length }))
      );
    })
  );

  app.get(
    '/api/v1/export/matched.csv',
    asyncRoute(async (req, res) => {
      const base = await resolveBaseObservations(req);
      const parsed = parseFilters(req, base.observations);
      if (!parsed.ok) return res.status(parsed.status).json({ error: parsed.error });
      const matching = matchModisViirs(parsed.filters.observations);
      sendCsv(
        res,
        'firesync_matched_pairs.csv',
        matchedPairsToCsv(
          matching.point.matched,
          metadataFrom(req, base, parsed.filters, {
            dataset: 'matched',
            pair_count: matching.point.matched.length,
            matching_method: matching.method,
            matching_label: matching.label,
          })
        )
      );
    })
  );

  app.get(
    '/api/v1/export/harmonized.csv',
    asyncRoute(async (req, res) => {
      const base = await resolveBaseObservations(req);
      const parsed = parseFilters(req, base.observations);
      if (!parsed.ok) return res.status(parsed.status).json({ error: parsed.error });
      const cells = Array.from(aggregateToSpatialTemporalGrid(parsed.filters.observations, 1.0).values());
      sendCsv(
        res,
        'firesync_harmonized_activity.csv',
        cellsToCsv(
          cells,
          metadataFrom(req, base, parsed.filters, {
            dataset: 'harmonized',
            cell_count: cells.length,
            status: 'EXPLORATORY',
          })
        )
      );
    })
  );

  app.get(
    '/api/v1/export/calendar.csv',
    asyncRoute(async (req, res) => {
      const base = await resolveBaseObservations(req);
      const parsed = parseFilters(req, base.observations);
      if (!parsed.ok) return res.status(parsed.status).json({ error: parsed.error });
      const { start, end } = effectiveRange(parsed.filters, base);
      const daily = filteredDaily(parsed.filters, { start, end }, now);
      const annotated = applyHistoricalBaselines(daily, daily, { today: now().toISOString().slice(0, 10) });
      sendCsv(
        res,
        `firesync_calendar_${start}_to_${end}.csv`,
        calendarSummariesToCsv(
          annotated,
          metadataFrom(req, base, parsed.filters, {
            dataset: 'calendar',
            observed_days: annotated.length,
            missing_dates: 'not emitted; missing is not zero',
          })
        )
      );
    })
  );

  app.get(
    '/api/v1/export/validation.csv',
    asyncRoute(async (req, res) => {
      const base = await resolveBaseObservations(req);
      const parsed = parseFilters(req, base.observations);
      if (!parsed.ok) return res.status(parsed.status).json({ error: parsed.error });
      const metrics = calibrationFor(parsed.filters);
      sendCsv(
        res,
        'firesync_calibration_validation.csv',
        validationResultsToCsv(metrics, metadataFrom(req, base, parsed.filters, { dataset: 'validation' }))
      );
    })
  );

  app.get(
    '/api/v1/export/provenance.csv',
    asyncRoute(async (req, res) => {
      const base = await resolveBaseObservations(req);
      const parsed = parseFilters(req, base.observations);
      if (!parsed.ok) return res.status(parsed.status).json({ error: parsed.error });
      const local = localStoreProvenance(store.getObservations(), dataDir);
      const rows: [string, unknown][] = [
        ['data_source', base.source],
        ['provenance_status', base.provenance],
        ['retrieved_at', base.retrieved_at],
        ['cached', base.cached],
        ['source_errors', base.errors.join(' | ')],
        ['truncated', base.truncated],
        ['live_area', base.live?.area ?? null],
        ['live_days', base.live?.days ?? null],
        ['local_store_provenance_status', local.status],
        ['local_store_reason', local.reason],
        ['raw_source_files_present', local.raw_source_files_present],
        ['checksum_note', local.checksum_note],
        ['processing_version', PROCESSING_VERSION],
        ['storage_kind', store.kind],
        ['storage_durable', store.durable],
        ['observation_count', parsed.filters.observations.length],
        ['firms_products', FIRMS_SOURCES.map((s) => s.source).join('|')],
      ];
      const meta = csvMetadata(base, { dataset: 'provenance' });
      const header = 'key,value';
      const lines = Object.entries(meta).map(([k, v]) => `${k},${JSON.stringify(v)}`);
      const body = rows.map(([k, v]) => `${k},${JSON.stringify(v)}`);
      sendCsv(res, 'firesync_provenance.csv', ['# FireSync provenance manifest', ...lines, header, ...body].join('\r\n'));
    })
  );

  // ------------------------------------------------------------ ingestion
  app.get('/api/v1/ingestion/jobs', (_req, res) => {
    const jobs = store.getJobs();
    res.json({
      total_jobs: jobs.length,
      jobs,
      configured: ingestion.isConfigured(),
      supported_products: FIRMS_SOURCES.map((s) => s.source),
      note: 'Only real execution records are listed. No seed or placeholder jobs are created.',
    });
  });

  app.get('/api/v1/ingestion/jobs/:id', (req, res) => {
    const job = store.getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Ingestion job not found.' });
    res.json(job);
  });

  app.post('/api/v1/ingestion/jobs/:id/cancel', (req, res) => {
    const job = store.getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Ingestion job not found.' });
    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
      return res.status(409).json({ error: `Job is already ${job.status}.`, job });
    }
    const cancelled: IngestionJob = {
      ...job,
      status: 'cancelled',
      completed_at: now().toISOString(),
      error_message: 'Cancelled by the user. Any in-flight HTTP request may still finish on the network; no partial result is reported as success.',
    };
    store.saveJob(cancelled);
    res.json(cancelled);
  });

  app.post('/api/v1/ingestion/test-key', async (_req, res) => {
    const key = env.FIRMS_MAP_KEY?.trim();
    if (!key) {
      return res.status(400).json({
        valid: false,
        message: 'FIRMS_MAP_KEY is not configured on the server. Set it in the server environment (never in browser code).',
      });
    }
    try {
      const url = `${(env.FIRMS_BASE_URL || FIRMS_DEFAULT_BASE_URL).replace(/\/$/, '')}/api/data_availability/csv/${encodeURIComponent(key)}/MODIS_NRT`;
      const response = await (options.fetchImpl ?? fetch)(url);
      const text = await response.text();
      if (response.ok && !/bad\s*map_?key/i.test(text)) {
        return res.json({ valid: true, message: 'The server-configured NASA FIRMS MAP_KEY was accepted.' });
      }
      return res.json({
        valid: false,
        message: 'NASA FIRMS rejected the server-configured key or returned an authentication error.',
      });
    } catch {
      return res.json({ valid: false, message: 'Could not reach NASA FIRMS. The key was not verified.' });
    }
  });

  app.post('/api/v1/ingestion/trigger', (req, res) => {
    const parsed = validateIngestionRequest(req.body);
    if (!parsed.ok) return res.status(parsed.status).json({ error: parsed.error, code: 'INVALID_REQUEST' });
    if (!ingestion.isConfigured()) {
      return res.status(503).json({
        error:
          'Ingestion is not configured: FIRMS_MAP_KEY is missing on the server. The server never simulates a successful import.',
        code: 'FIRMS_KEY_NOT_CONFIGURED',
      });
    }
    const job = ingestion.start(parsed.value);
    res.status(202).json({
      message: 'Ingestion job accepted. Poll /api/v1/ingestion/jobs/{id} for the real result.',
      job,
    });
  });

  // -------------------------------------------------------------- API 404
  // Without this, an unknown /api path falls through to the SPA/static middleware
  // and returns index.html with HTTP 200. API clients must get a real JSON 404.
  // ---------------------------------------------------------------- AI routes
  /** Availability is public so the UI can disable itself instead of failing mid-question. */
  // ---------------------------------------------------------------- watchlist routes
  const watchlistMeta = () => ({
    storage: watchlistStore.kind,
    durable: watchlistStore.durable,
    location: watchlistStore.location,
    scheduler: watchlistScheduler
      ? { running: watchlistScheduler.running, interval_minutes: Number(env.FIRESYNC_WATCHLIST_INTERVAL_MINUTES) || 30 }
      : { running: false, interval_minutes: null },
    delivery: 'in_app_only',
    note: 'Alerts are evaluated deterministically and shown in this API and the AI Investigator Watch tab. There is no email or push delivery; the scheduler runs only while the server runs.',
  });

  app.get('/api/v1/watchlists', (_req, res) => {
    res.json({
      watchlists: watchlistStore.listWatchlists().map(publicWatchlist),
      alerts: watchlistStore.listAlerts(50),
      meta: watchlistMeta(),
    });
  });

  app.post('/api/v1/watchlists', (req, res) => {
    const parsed = parseWatchlistCreate(req.body);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error, code: 'INVALID_REQUEST' });
    if (watchlistStore.listWatchlists().length >= WATCHLIST_MAX_LISTS) {
      return res.status(409).json({ error: `At most ${WATCHLIST_MAX_LISTS} watchlists.`, code: 'WATCHLIST_LIMIT' });
    }
    const watchlist: Watchlist = {
      id: `watch-${now().getTime()}-${Math.random().toString(36).slice(2, 8)}`,
      name: parsed.value.name,
      bbox: parsed.value.bbox,
      condition: parsed.value.condition,
      created_at: now().toISOString(),
      paused: false,
      last_evaluated_at: null,
      last_counts: null,
    };
    watchlistStore.saveWatchlist(watchlist);
    res.status(201).json({ watchlist, meta: watchlistMeta() });
  });

  app.post('/api/v1/watchlists/:id/pause', (req, res) => {
    const watchlist = watchlistStore.getWatchlist(req.params.id);
    if (!watchlist) return res.status(404).json({ error: 'Watchlist not found.', code: 'NOT_FOUND' });
    const paused = (req.body as Record<string, unknown> | undefined)?.paused !== false;
    const updated = { ...watchlist, paused };
    watchlistStore.saveWatchlist(updated);
    res.json({ watchlist: publicWatchlist(updated) });
  });

  app.delete('/api/v1/watchlists/:id', (req, res) => {
    if (!watchlistStore.deleteWatchlist(req.params.id)) {
      return res.status(404).json({ error: 'Watchlist not found.', code: 'NOT_FOUND' });
    }
    res.json({ deleted: true });
  });

  app.post('/api/v1/watchlists/:id/check', asyncRoute(async (req, res) => {
    const watchlist = watchlistStore.getWatchlist(req.params.id);
    if (!watchlist) return res.status(404).json({ error: 'Watchlist not found.', code: 'NOT_FOUND' });
    const observations = await loadWatchlistObservations(watchlist);
    const record = recordWatchlistEvaluation(watchlistStore, watchlist, observations, now);
    res.json({ ...record, watchlist: publicWatchlist(record.watchlist), meta: watchlistMeta() });
  }));

  app.post('/api/v1/watchlists/alerts/:id/acknowledge', (req, res) => {
    if (!watchlistStore.acknowledgeAlert(req.params.id)) {
      return res.status(404).json({ error: 'Alert not found.', code: 'NOT_FOUND' });
    }
    res.json({ acknowledged: true });
  });

  // AI explanation for one stored alert; the deterministic record is never altered by the model.
  app.post(
    '/api/v1/ai/watchlist-alert',
    asyncRoute(async (req, res) => {
      const raw = (req.body ?? {}) as Record<string, unknown>;
      const alertId = typeof raw.alert_id === 'string' ? raw.alert_id : '';
      const alert = alertId ? watchlistStore.getAlert(alertId) : undefined;
      if (!alert) return res.status(404).json({ error: 'Alert not found.', code: 'NOT_FOUND' });
      const watchlist = watchlistStore.getWatchlist(alert.watchlist_id);
      const narrative = await aiNarrative(req, WATCHLIST_INSTRUCTION, watchlistPrompt({ watchlist, alert }));
      res.json({
        alert_id: alert.id,
        explanation: narrative.text,
        ai: { status: narrative.status, model: narrative.model, reason: narrative.reason },
      });
    })
  );

  /**
   * Scenario Laboratory: deterministic qualitative assessment of hypothetical environmental
   * inputs. The route never produces quantitative fire-spread output; the optional AI narrative
   * is explanatory only and is told so by its system instruction.
   */
  app.post(
    '/api/v1/scenario/analyze',
    asyncRoute(async (req, res) => {
      const parsed = parseScenarioRequest(req.body);
      if (!parsed.ok) return res.status(400).json({ error: parsed.error, code: 'INVALID_REQUEST' });
      const assessment = buildScenarioAssessment(parsed.value);
      const narrative = await aiNarrative(
        req,
        SCENARIO_INSTRUCTION,
        scenarioPrompt({ scenario: parsed.value, assessment })
      );
      res.json({
        scenario: parsed.value,
        assessment,
        explanation: narrative.text,
        ai: { status: narrative.status, model: narrative.model, reason: narrative.reason },
        guardrails: AI_GUARDRAILS,
      });
    })
  );

  app.get('/api/v1/ai/status', (_req, res) => {
    res.json(aiStatus(aiConfig));
  });

  app.post(
    '/api/v1/ai/chat',
    asyncRoute(async (req, res) => {
      if (!aiAllowed(req, res)) return;
      const parsed = parseChatRequest(req.body, AI_LIMITS.maxMessageChars);
      if (!parsed.ok) return res.status(400).json({ error: parsed.error, code: 'INVALID_REQUEST' });

      const today = now().toISOString().slice(0, 10);
      const actions: AiMapAction[] = [];
      const toolCalls: AiToolCallRecord[] = [];
      const dataNotes: string[] = [];

      // Deterministic fast path: simple factual questions (region ranking, counts, sensor
      // comparison, FRP extremes) are answered directly with no model call or tool round trips.
      try {
        const fast = await runDeterministicFastPath(parsed.value.message, {
          load: loadAiObservations,
          today,
          contextBbox: parsed.value.context?.bbox ?? null,
          context: parsed.value.context,
          history: {
            status: () => historicalStatus(),
            periodTotals: (q) => historicalPeriodTotals(q),
            countries: () => historicalCountries(),
          },
          agni: {},
          incidents: {},
        });
        if (fast) {
          res.json({
            reply: fast.reply,
            actions: [],
            tool_calls: [fast.record],
            model: 'deterministic',
            guardrails: AI_GUARDRAILS,
            data_notes: [
              ...fast.dataNotes,
              'Answered by the deterministic fast path; no AI model call was made.',
            ],
          });
          return;
        }
      } catch (err) {
        res.json({
          reply:
            'The hotspot data could not be loaded right now' +
            (err instanceof Error ? `: ${err.message.slice(0, 200)}` : '.') +
            ' Satellite thermal anomalies, not confirmed wildfires or burned area.',
          actions: [],
          tool_calls: [],
          model: 'deterministic',
          guardrails: AI_GUARDRAILS,
          data_notes: ['Fast-path data load failed; no AI model call was made.'],
        });
        return;
      }

      try {
        const result = await runModelChat({
          generate: aiGenerate,
          model: aiConfig.model,
          systemInstruction: [
            ASSISTANT_SYSTEM_INSTRUCTION,
            contextBlock(parsed.value.context),
            `Today (UTC) is ${today}. Live NRT covers at most the last ${LIVE_MAX_DAYS} days.`,
          ].join('\n'),
          turns: [{ role: 'user', parts: [{ text: parsed.value.message }] }],
          toolDeclarations: AI_TOOL_DECLARATIONS,
          executeTool: async (name, args) => {
            const execution = await executeAiTool(name, args, { load: loadAiObservations, today });
            toolCalls.push(execution.record);
            if (execution.action) actions.push(execution.action);
            dataNotes.push(...execution.dataNotes);
            return execution.response;
          },
        });

        const body: AiChatResponse = {
          reply: result.text,
          actions,
          tool_calls: toolCalls,
          model: aiConfig.model,
          guardrails: AI_GUARDRAILS,
          data_notes: [...new Set(dataNotes)],
        };
        res.json(body);
      } catch (err) {
        rethrowAiError(err);
      }
    })
  );

  app.post(
    '/api/v1/ai/detection-explanation',
    asyncRoute(async (req, res) => {
      if (!aiAllowed(req, res)) return;
      const parsedRequest = parseDetectionExplanationRequest(req.body);
      if (!parsedRequest.ok) {
        return res.status(400).json({ error: parsedRequest.error, code: 'INVALID_REQUEST' });
      }
      const parsedEvidence = parseEvidence(parsedRequest.value.observation);
      if (!parsedEvidence.ok) {
        return res.status(400).json({ error: parsedEvidence.error, code: 'INVALID_OBSERVATION' });
      }

      const { evidence, fieldsProvided, fieldsMissing } = parsedEvidence.value;
      try {
        const result = await runModelChat({
          generate: aiGenerate,
          model: aiConfig.model,
          systemInstruction: detectionExplanationInstruction(evidence as unknown as Record<string, unknown>),
          turns: [
            {
              role: 'user',
              parts: [
                {
                  text: 'Explain this satellite detection using only the record fields in your instructions.',
                },
              ],
            },
          ],
        });
        const body: AiDetectionExplanationResponse = {
          explanation: result.text,
          model: aiConfig.model,
          guardrails: AI_GUARDRAILS,
          evidence,
          fields_provided: fieldsProvided,
          fields_missing: fieldsMissing,
          data_notes: [
            `Source: ${evidence.provenance_status ?? 'UNVERIFIED'} record supplied by the map.`,
            'Explanation is generated text; the measurement fields are the record itself.',
          ],
        };
        res.json(body);
      } catch (err) {
        rethrowAiError(err);
      }
    })
  );

  // ---------------------------------------------------------------- analysis routes (Phase 2)
  type Narrative = {
    text: string | null;
    status: 'enabled' | 'disabled' | 'not_configured';
    model: string | null;
    reason: string | null;
  };

  /**
   * Optional AI enrichment for a deterministic result. Disabled, unconfigured or rate-limited
   * providers return text null with a reason, so the underlying analysis is still usable.
   */
  const aiNarrative = async (req: Request, systemInstruction: string, prompt: string): Promise<Narrative> => {
    const status = aiStatus(aiConfig);
    if (!aiConfig.enabled || !aiConfig.configured) {
      return { text: null, status: status.status, model: null, reason: status.note };
    }
    const decision = aiLimiter.check(req.ip ?? 'unknown');
    if (!decision.allowed) {
      return {
        text: null,
        status: 'enabled',
        model: aiConfig.model,
        reason: `AI rate limit reached; retry in ${decision.retryAfterSeconds}s. The deterministic result below is unaffected.`,
      };
    }
    try {
      const result = await runModelChat({
        generate: aiGenerate,
        model: aiConfig.model,
        systemInstruction,
        turns: [{ role: 'user', parts: [{ text: prompt }] }],
      });
      return { text: result.text, status: 'enabled', model: aiConfig.model, reason: null };
    } catch (err) {
      return {
        text: null,
        status: 'enabled',
        model: aiConfig.model,
        reason: err instanceof ProviderError ? err.message : 'The AI provider failed.',
      };
    }
  };

  const analysisBody = (req: Request) => parseAnalysisRequest(req.body, now().toISOString().slice(0, 10), LIVE_MAX_DAYS);

  const loadAnalysis = async (parsed: AnalysisRequest) => {
    const payload = await loadAiObservations({
      days: parsed.days,
      bbox: parsed.bbox === '-180,-90,180,90' ? null : parsed.bbox,
    });
    let observations = payload.observations;
    if (parsed.sensors !== 'ALL') observations = observations.filter((o) => o.sensor === parsed.sensors);
    observations = observations.filter((o) => o.acq_date >= parsed.start_date && o.acq_date <= parsed.end_date);
    return { observations, payload };
  };

  const sourceMetaFor = (payload: AiObservationPayload) => ({
    data_source: payload.source,
    provenance_status: payload.provenance,
    retrieved_at: payload.retrieved_at,
    source_errors: payload.errors.slice(0, 5),
    truncated: payload.truncated,
  });

  app.post(
    '/api/v1/ai/cluster-investigation',
    asyncRoute(async (req, res) => {
      const parsed = analysisBody(req);
      if (!parsed.ok) return res.status(400).json({ error: parsed.error, code: 'INVALID_REQUEST' });
      const { observations, payload } = await loadAnalysis(parsed.value);
      const raw = (req.body ?? {}) as Record<string, unknown>;
      const linkKm = Number(raw.link_km);
      const linkHours = Number(raw.link_hours);
      const clusters = clusterObservations(observations, {
        linkKm: Number.isFinite(linkKm) && linkKm > 0 ? linkKm : undefined,
        linkHours: Number.isFinite(linkHours) && linkHours > 0 ? linkHours : undefined,
      });
      const requestedId = typeof raw.cluster_id === 'string' ? raw.cluster_id : null;
      const cluster = requestedId ? clusters.clusters.find((c) => c.id === requestedId) : clusters.clusters[0];
      if (requestedId && !cluster) {
        return res.status(404).json({ error: 'No candidate cluster with that id in this window.', code: 'CLUSTER_NOT_FOUND' });
      }

      const narrative = cluster
        ? await aiNarrative(req, CLUSTER_INSTRUCTION, clusterPrompt(cluster, {
            start_date: parsed.value.start_date,
            end_date: parsed.value.end_date,
            bbox: parsed.value.bbox,
          }))
        : { text: null, status: aiStatus(aiConfig).status, model: null, reason: 'No candidate cluster was found in this window.' };

      res.json({
        window: { start_date: parsed.value.start_date, end_date: parsed.value.end_date, days: parsed.value.days },
        area: { bbox: parsed.value.bbox },
        sensors: parsed.value.sensors,
        total_clusters: clusters.found_clusters,
        analysed_detections: clusters.analysed_detections,
        cluster: cluster ?? null,
        clusters: clusters.clusters.slice(0, 10),
        report: narrative.text,
        ai: { status: narrative.status, model: narrative.model, reason: narrative.reason },
        guardrails: AI_GUARDRAILS,
        notes: clusters.notes,
        source: sourceMetaFor(payload),
      });
    })
  );

  app.post(
    '/api/v1/ai/sensor-explanation',
    asyncRoute(async (req, res) => {
      const parsed = analysisBody(req);
      if (!parsed.ok) return res.status(400).json({ error: parsed.error, code: 'INVALID_REQUEST' });
      const { observations, payload } = await loadAnalysis({ ...parsed.value, sensors: 'ALL' });
      const modis = observations.filter((o) => o.sensor === 'MODIS');
      const viirs = observations.filter((o) => o.sensor === 'VIIRS');
      const cells = Array.from(aggregateToSpatialTemporalGrid(observations, 1.0).values());
      const paired = cells.filter((c) => c.modis_count > 0 && c.viirs_count > 0).length;
      const mean = (values: number[]): number | null =>
        values.length > 0 ? Number((values.reduce((s, v) => s + v, 0) / values.length).toFixed(2)) : null;
      const numericConfidenceMean = (values: Array<number | string>): number | null =>
        mean(values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value)));
      const hours = (list: CanonicalObservation[]) => {
        const buckets = new Map<string, number>();
        for (const o of list) buckets.set(o.acq_time.slice(0, 2), (buckets.get(o.acq_time.slice(0, 2)) ?? 0) + 1);
        return [...buckets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([hour, count]) => ({ hour_utc: hour, count }));
      };
      const comparison = {
        window: { start_date: parsed.value.start_date, end_date: parsed.value.end_date, days: parsed.value.days },
        bbox: parsed.value.bbox,
        MODIS: {
          detections: modis.length,
          frp_total_mw: Number(modis.reduce((s, o) => s + o.frp_mw, 0).toFixed(1)),
          frp_mean_mw: mean(modis.map((o) => o.frp_mw)),
          mean_confidence: numericConfidenceMean(modis.map((o) => o.confidence)),
          peak_hours_utc: hours(modis),
          satellites: [...new Set(modis.map((o) => o.satellite))].sort(),
        },
        VIIRS: {
          detections: viirs.length,
          frp_total_mw: Number(viirs.reduce((s, o) => s + o.frp_mw, 0).toFixed(1)),
          frp_mean_mw: mean(viirs.map((o) => o.frp_mw)),
          mean_confidence: numericConfidenceMean(viirs.map((o) => o.confidence)),
          peak_hours_utc: hours(viirs),
          satellites: [...new Set(viirs.map((o) => o.satellite))].sort(),
        },
        cells: { total: cells.length, paired, modis_only: cells.filter((c) => c.modis_count > 0 && c.viirs_count === 0).length, viirs_only: cells.filter((c) => c.viirs_count > 0 && c.modis_count === 0).length },
        sensor_only_note: 'MODIS-only/VIIRS-only cells mean no counterpart was found on the shared 1 km grid; they are not non-detections.',
      };
      const narrative = await aiNarrative(
        req,
        SENSOR_INSTRUCTION,
        sensorPrompt(comparison as unknown as Record<string, unknown>)
      );
      res.json({
        comparison,
        explanation: narrative.text,
        ai: { status: narrative.status, model: narrative.model, reason: narrative.reason },
        guardrails: AI_GUARDRAILS,
        source: sourceMetaFor(payload),
        notes: [
          'Raw MODIS and VIIRS detections stay separate and are never added into a fire count.',
          'Pixel size differs (MODIS ~1 km, VIIRS ~375 m), so VIIRS usually detects more pixels for the same burning area.',
        ],
      });
    })
  );

  app.post(
    '/api/v1/ai/scientific-audit',
    asyncRoute(async (req, res) => {
      const parsed = analysisBody(req);
      if (!parsed.ok) return res.status(400).json({ error: parsed.error, code: 'INVALID_REQUEST' });
      const { observations, payload } = await loadAnalysis(parsed.value);
      const today = now().toISOString().slice(0, 10);
      const audit = auditDataset(observations, today);
      const narrative = await aiNarrative(req, AUDIT_INSTRUCTION, auditPrompt(audit as unknown as Record<string, unknown>));
      res.json({
        audit,
        summary_text: narrative.text,
        ai: { status: narrative.status, model: narrative.model, reason: narrative.reason },
        source: sourceMetaFor(payload),
      });
    })
  );

  app.post(
    '/api/v1/ai/report',
    asyncRoute(async (req, res) => {
      const parsed = analysisBody(req);
      if (!parsed.ok) return res.status(400).json({ error: parsed.error, code: 'INVALID_REQUEST' });
      const raw = (req.body ?? {}) as Record<string, unknown>;
      const language = raw.language === 'bn' ? 'bn' : 'en';
      const { observations, payload } = await loadAnalysis(parsed.value);
      const bbox = parseBboxString(parsed.value.bbox);
      if (!bbox) return res.status(400).json({ error: 'bbox is invalid.', code: 'INVALID_REQUEST' });

      const density = densityFor(observations, bbox, { topN: 10 });
      const clusters = clusterObservations(observations);
      const audit = auditDataset(observations, now().toISOString().slice(0, 10));
      const stats = {
        modis_detections: density.by_sensor.MODIS,
        viirs_detections: density.by_sensor.VIIRS,
        modis_frp_mw: Number(observations.filter((o) => o.sensor === 'MODIS').reduce((s, o) => s + o.frp_mw, 0).toFixed(1)),
        viirs_frp_mw: Number(observations.filter((o) => o.sensor === 'VIIRS').reduce((s, o) => s + o.frp_mw, 0).toFixed(1)),
        active_1km_cells: density.active_cells,
        active_days: new Set(observations.map((o) => o.acq_date)).size,
      };

      const narrative = await aiNarrative(
        req,
        REPORT_INSTRUCTION,
        reportPrompt({
          window: { start_date: parsed.value.start_date, end_date: parsed.value.end_date },
          bbox: parsed.value.bbox,
          stats,
          clusters: clusters.clusters.slice(0, 5).map((c) => ({ id: c.id, detections: c.detection_count, modis: c.by_sensor.MODIS, viirs: c.by_sensor.VIIRS })),
          audit: audit.summary,
          language,
        })
      );

      const report = buildReport({
        generated_at: now().toISOString(),
        area: { bbox: parsed.value.bbox, area_km2: density.area_km2 },
        window: { start_date: parsed.value.start_date, end_date: parsed.value.end_date, days: parsed.value.days },
        sensors: parsed.value.sensors,
        stats,
        density,
        clusters,
        audit,
        source: sourceMetaFor(payload),
        interpretation: narrative.text,
        interpretation_note: narrative.reason,
        language,
      });

      res.json({
        report,
        stats,
        audit,
        ai: { status: narrative.status, model: narrative.model, reason: narrative.reason },
        source: sourceMetaFor(payload),
      });
    })
  );

  app.post(
    '/api/v1/ai/geographic-analysis',
    asyncRoute(async (req, res) => {
      const parsed = analysisBody(req);
      if (!parsed.ok) return res.status(400).json({ error: parsed.error, code: 'INVALID_REQUEST' });
      const raw = (req.body ?? {}) as Record<string, unknown>;
      const topic = raw.topic === 'clusters' || raw.topic === 'coverage' ? raw.topic : 'density';
      const { observations, payload } = await loadAnalysis(parsed.value);
      const bbox = parseBboxString(parsed.value.bbox);
      if (!bbox) return res.status(400).json({ error: 'bbox is invalid.', code: 'INVALID_REQUEST' });
      const result =
        topic === 'clusters'
          ? clusterObservations(observations)
          : topic === 'coverage'
            ? coverageFor(observations, parsed.value.start_date, parsed.value.end_date, payload.errors)
            : densityFor(observations, bbox);
      const narrative = await aiNarrative(
        req,
        GEOGRAPHIC_INSTRUCTION,
        geographicPrompt(topic, result as unknown as Record<string, unknown>, {
          bbox: parsed.value.bbox,
          start_date: parsed.value.start_date,
          end_date: parsed.value.end_date,
        })
      );
      res.json({
        topic,
        result,
        explanation: narrative.text,
        ai: { status: narrative.status, model: narrative.model, reason: narrative.reason },
        datasets: geoDatasetStatus(),
        source: sourceMetaFor(payload),
      });
    })
  );

  // ---------------------------------------------------------------- geographic routes (Phase 3)
  app.get('/api/v1/geo/datasets/status', (_req, res) => {
    res.json(geoDatasetStatus());
  });

  app.post(
    '/api/v1/geo/density',
    asyncRoute(async (req, res) => {
      const parsed = analysisBody(req);
      if (!parsed.ok) return res.status(400).json({ error: parsed.error, code: 'INVALID_REQUEST' });
      const bbox = parseBboxString(parsed.value.bbox);
      if (!bbox) return res.status(400).json({ error: 'bbox is invalid.', code: 'INVALID_REQUEST' });
      const { observations, payload } = await loadAnalysis(parsed.value);
      const raw = (req.body ?? {}) as Record<string, unknown>;
      const cellKm = Number(raw.cell_km);
      const density = densityFor(observations, bbox, { cellKm: Number.isFinite(cellKm) ? cellKm : undefined });
      res.json({
        window: { start_date: parsed.value.start_date, end_date: parsed.value.end_date, days: parsed.value.days },
        bbox: parsed.value.bbox,
        sensors: parsed.value.sensors,
        density,
        dataset: geoDataset('firms_nrt'),
        source: sourceMetaFor(payload),
      });
    })
  );

  app.post(
    '/api/v1/geo/clusters',
    asyncRoute(async (req, res) => {
      const parsed = analysisBody(req);
      if (!parsed.ok) return res.status(400).json({ error: parsed.error, code: 'INVALID_REQUEST' });
      const { observations, payload } = await loadAnalysis(parsed.value);
      const raw = (req.body ?? {}) as Record<string, unknown>;
      const linkKm = Number(raw.link_km);
      const linkHours = Number(raw.link_hours);
      const clusters = clusterObservations(observations, {
        linkKm: Number.isFinite(linkKm) && linkKm > 0 ? linkKm : undefined,
        linkHours: Number.isFinite(linkHours) && linkHours > 0 ? linkHours : undefined,
      });
      res.json({
        window: { start_date: parsed.value.start_date, end_date: parsed.value.end_date, days: parsed.value.days },
        bbox: parsed.value.bbox,
        sensors: parsed.value.sensors,
        clusters,
        source: sourceMetaFor(payload),
      });
    })
  );

  app.post(
    '/api/v1/geo/compare',
    asyncRoute(async (req, res) => {
      const parsed = parseCompareRequest(req.body, now().toISOString().slice(0, 10), LIVE_MAX_DAYS);
      if (!parsed.ok) {
        return res.status(400).json({ error: parsed.error, code: parsed.code ?? 'INVALID_REQUEST' });
      }
      const result = await runComparison(loadAiObservations, parsed.value);
      res.json(result);
    })
  );

  app.post(
    '/api/v1/geo/proximity',
    asyncRoute(async (req, res) => {
      const parsed = analysisBody(req);
      if (!parsed.ok) return res.status(400).json({ error: parsed.error, code: 'INVALID_REQUEST' });
      const raw = (req.body ?? {}) as Record<string, unknown>;
      const rawFeatures = Array.isArray(raw.features) ? raw.features : [];
      if (rawFeatures.length > 50) return res.status(400).json({ error: 'At most 50 features per request.', code: 'TOO_MANY_FEATURES' });
      const features: ProximityFeature[] = [];
      for (const item of rawFeatures) {
        const f = (item ?? {}) as Record<string, unknown>;
        const lat = Number(f.latitude);
        const lon = Number(f.longitude);
        if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) {
          return res.status(400).json({ error: 'Each feature needs valid latitude and longitude.', code: 'INVALID_FEATURE' });
        }
        features.push({
          id: typeof f.id === 'string' && f.id ? f.id.slice(0, 60) : `feature-${features.length + 1}`,
          name: typeof f.name === 'string' && f.name ? f.name.slice(0, 120) : 'Unnamed feature',
          type: typeof f.type === 'string' && f.type ? f.type.slice(0, 40) : 'unspecified',
          latitude: lat,
          longitude: lon,
        });
      }
      const bufferKm = Number(raw.buffer_km);
      const { observations, payload } = await loadAnalysis(parsed.value);
      const proximity = proximityFor(observations, features, { bufferKm: Number.isFinite(bufferKm) ? bufferKm : undefined });
      res.json({ window: { start_date: parsed.value.start_date, end_date: parsed.value.end_date }, bbox: parsed.value.bbox, proximity, source: sourceMetaFor(payload) });
    })
  );

  app.post(
    '/api/v1/geo/regions/compare',
    asyncRoute(async (req, res) => {
      const parsed = analysisBody(req);
      if (!parsed.ok) return res.status(400).json({ error: parsed.error, code: 'INVALID_REQUEST' });
      const raw = (req.body ?? {}) as Record<string, unknown>;
      const rawRegions = Array.isArray(raw.regions) ? raw.regions.slice(0, 4) : [];
      if (rawRegions.length === 0) {
        return res.status(400).json({
          error: 'regions must contain 1-4 entries of { id, name, bbox }. Country-level analysis needs a boundary dataset that is not configured.',
          code: 'INVALID_REQUEST',
        });
      }
      const regions: Array<{ id: string; name: string; bbox: string; observations: CanonicalObservation[] }> = [];
      for (const item of rawRegions) {
        const r = (item ?? {}) as Record<string, unknown>;
        if (typeof r.bbox !== 'string' || !parseBboxString(r.bbox)) {
          return res.status(400).json({ error: 'Each region needs a valid bbox string.', code: 'INVALID_REQUEST' });
        }
        const id = typeof r.id === 'string' && r.id ? r.id.slice(0, 40) : `region-${regions.length + 1}`;
        const loaded = await loadAnalysis({ ...parsed.value, bbox: r.bbox });
        regions.push({
          id,
          name: typeof r.name === 'string' && r.name ? r.name.slice(0, 120) : id,
          bbox: r.bbox,
          observations: loaded.observations,
        });
      }
      const comparison = regionDensities(regions);
      res.json({
        window: { start_date: parsed.value.start_date, end_date: parsed.value.end_date },
        regions: comparison,
        dataset: geoDataset('admin_boundaries'),
        notes: [
          'Region extents are the bounding boxes supplied in the request, not official administrative boundaries.',
          'Counts are normalised per 1000 km² so a large region does not look more active only because it is larger.',
        ],
      });
    })
  );

  app.post(
    '/api/v1/geo/weather',
    asyncRoute(async (req, res) => {
      const parsed = analysisBody(req);
      if (!parsed.ok) return res.status(400).json({ error: parsed.error, code: 'INVALID_REQUEST' });
      const { observations, payload } = await loadAnalysis({ ...parsed.value, sensors: 'ALL' });
      const bbox = parseBboxString(parsed.value.bbox);
      if (!bbox) return res.status(400).json({ error: 'bbox is invalid.', code: 'INVALID_REQUEST' });

      const point = weatherPointForBbox(bbox);
      const weather = point.ok
        ? await fetchWeatherDays({
            latitude: point.latitude,
            longitude: point.longitude,
            startDate: parsed.value.start_date,
            endDate: parsed.value.end_date,
            fetchImpl: options.fetchImpl,
            now,
          })
        : {
            available: false as const,
            reason: point.reason,
            point: null,
            days: [],
            provider: 'Open-Meteo',
            api: 'forecast',
            retrieved_at: null,
          };

      const analysis = buildWeatherFireAnalysis({
        observations,
        bboxString: parsed.value.bbox,
        startDate: parsed.value.start_date,
        endDate: parsed.value.end_date,
        sourceErrors: payload.errors,
        weather,
      });

      const narrative = await aiNarrative(
        req,
        WEATHER_INSTRUCTION,
        weatherPrompt({
          window: {
            start_date: parsed.value.start_date,
            end_date: parsed.value.end_date,
            bbox: parsed.value.bbox,
          },
          weather: analysis.weather.days,
          correlations: analysis.correlations,
          paired_days: analysis.paired_days,
        })
      );

      res.json({
        window: { start_date: parsed.value.start_date, end_date: parsed.value.end_date, days: parsed.value.days },
        bbox: parsed.value.bbox,
        analysis,
        explanation: narrative.text,
        ai: { status: narrative.status, model: narrative.model, reason: narrative.reason },
        source: sourceMetaFor(payload),
      });
    })
  );

  app.post('/api/v1/geo/landcover', (_req, res) => res.status(200).json(unavailableDatasetResult('landcover')));
  app.post('/api/v1/geo/terrain', (_req, res) => res.status(200).json(unavailableDatasetResult('terrain')));
  app.post('/api/v1/geo/population', (_req, res) => res.status(200).json(unavailableDatasetResult('population')));
  app.post('/api/v1/geo/cross-border', (_req, res) =>
    res.status(200).json(unavailableDatasetResult('admin_boundaries'))
  );

  app.post(
    '/api/v1/geo/coverage',
    asyncRoute(async (req, res) => {
      const parsed = analysisBody(req);
      if (!parsed.ok) return res.status(400).json({ error: parsed.error, code: 'INVALID_REQUEST' });
      const { observations, payload } = await loadAnalysis({ ...parsed.value, sensors: 'ALL' });
      const coverage = coverageFor(observations, parsed.value.start_date, parsed.value.end_date, payload.errors);
      // Blind-spot context: durable ingestion job records show which source products were actually
      // retrieved, when, and which failed. Absence of a job is not proof of coverage either way.
      const allJobs = store.getJobs();
      const jobCounts = { completed: 0, failed: 0, running: 0, pending: 0, cancelled: 0 };
      for (const job of allJobs) {
        if (job.status in jobCounts) jobCounts[job.status as keyof typeof jobCounts] += 1;
      }
      const recentJobs = allJobs.slice(0, 10).map((job) => ({
        id: job.id,
        status: job.status,
        source_products: job.source_products ?? null,
        bbox: job.bbox ?? null,
        retrieved_at: job.retrieved_at ?? null,
        completed_at: job.completed_at ?? null,
        records_imported: job.records_imported ?? null,
        error_message: job.error_message ?? null,
      }));
      res.json({
        bbox: parsed.value.bbox,
        coverage,
        ingestion: {
          storage: store.kind,
          durable: store.durable,
          job_counts: jobCounts,
          recent_jobs: recentJobs,
          note: 'Ingestion jobs are the durable record of real FIRMS retrievals. A missing job does not prove a coverage gap, and a completed job covers only its own bbox, products and day range.',
        },
        source: sourceMetaFor(payload),
      });
    })
  );

  app.use('/api', (req, res) => {
    res.status(404).json({
      error: 'API endpoint not found.',
      path: req.originalUrl,
    });
  });

  // ---------------------------------------------------------- error handler
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      return res.status(err.status).json({
        error: err.message,
        ...(err.code ? { code: err.code } : {}),
      });
    }
    if (err instanceof LiveFiresError) {
      for (const [header, value] of Object.entries(err.options.headers ?? {})) {
        res.setHeader(header, value);
      }
      return res.status(err.status).json({
        error: err.message,
        ...(err.options.errors ? { errors: err.options.errors } : {}),
      });
    }
    // F36 fix: Express JSON-parser errors carry a trusted HTTP status (400/413).
    // Preserve that status code instead of overriding it with 500. Keep internal
    // SQL or filesystem details out of the response body.
    const errAny = err as Error & { status?: number; statusCode?: number; type?: string };
    const parserStatus = errAny.status ?? errAny.statusCode;
    if (parserStatus === 400 || parserStatus === 413 || errAny.type === 'entity.parse.failed') {
      const safeStatus = parserStatus === 413 ? 413 : 400;
      return res.status(safeStatus).json({ error: safeStatus === 413 ? 'Request body too large.' : 'Invalid JSON in request body.' });
    }
    res.status(500).json({ error: 'Internal server error.' });
  });

  return { app, store, ingestion };
}

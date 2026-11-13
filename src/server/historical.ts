/**
 * Historical archive query service.
 *
 * Reads the Parquet store built by `data_pipeline/build_historical_db.py`
 * (`data/historical/parquet/{obs,agg}`) through an in-process DuckDB connection.
 * The 376M-row observation table is never loaded into memory: every query is a
 * server-side scan with explicit filters and row limits.
 *
 * MODIS and VIIRS are always reported separately; no endpoint merges them into a
 * single "fire count".
 */

import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import duckdb from 'duckdb';
import { compareAgniMonth } from '../utils/agniBaseline';
import { parquetSqlPath } from './dataPaths';
import type { CanonicalObservation, ConfidenceCategory, SensorType, SatelliteType } from '../types/fire';
import {
  activityThresholds,
  classifyActivity,
  classifyVsClimatology,
  doyInWindow,
  doyWindow,
  harmonizedEquivalent,
  quantile,
  seasonSummary,
  type ActivityClass,
  type MonthlyClimatology,
  type PeriodStatus,
  type SeasonSummary,
} from '../utils/seasonalClimatology';

export interface HistoricalStatus {
  available: boolean;
  root: string;
  sensors: Record<string, { years: number[]; min_date: string | null; max_date: string | null; rows: number | null }>;
  note: string;
}

export interface DailyRow {
  period: string;
  country: string;
  sensor: string;
  detections: number;
  frp_sum_mw: number | null;
  frp_max_mw: number | null;
  day_count: number;
  night_count: number;
  /** Distinct satellites per country-day; null for global aggregates (not derivable). */
  satellites_seen: number | null;
}

const PARQUET_ROOT = process.env.FIRESYNC_HISTORICAL_PARQUET?.trim() || 'data/historical/parquet';
const OBS_GLOB = path.join(PARQUET_ROOT, 'obs', 'sensor=*', 'year=*', 'data_*.parquet').replace(/\\/g, '/');
const AGG_GLOB = path.join(PARQUET_ROOT, 'agg', '*.parquet').replace(/\\/g, '/');

let db: duckdb.Database | null = null;
let conn: duckdb.Connection | null = null;

function getConnection(): duckdb.Connection {
  if (!conn) {
    db = new duckdb.Database(':memory:');
    conn = db.connect();
    conn.run('SET threads TO 2');
    conn.run("SET memory_limit='2GB'");
  }
  return conn;
}

function all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return new Promise((resolve, reject) => {
    getConnection().all(sql, ...params, (err: Error | null, rows: unknown) => {
      if (err) reject(err);
      else resolve(deepBigIntToNumber((rows ?? []) as T[]));
    });
  });
}

export function isRealIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** DuckDB BIGINT/HUGEINT arrive as BigInt, which JSON.stringify cannot serialize. */
function deepBigIntToNumber<T>(value: T): T {
  if (typeof value === 'bigint') return Number(value) as T;
  if (Array.isArray(value)) return value.map((v) => deepBigIntToNumber(v)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = deepBigIntToNumber(v);
    return out as T;
  }
  return value;
}

function one<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  return all<T>(sql, params).then((rows) => rows[0]);
}

function storeExists(): boolean {
  return fs.existsSync(path.join(PARQUET_ROOT, 'obs'));
}

function aggGlobFor(level: 'daily' | 'monthly', sensor?: string, year?: number): string {
  const parts: string[] = [];
  const aggDir = path.join(PARQUET_ROOT, 'agg');
  if (!fs.existsSync(aggDir)) return '';
  for (const f of fs.readdirSync(aggDir)) {
    if (!f.endsWith('.parquet')) continue;
    if (level === 'daily' && !f.startsWith('daily_')) continue;
    if (level === 'monthly' && !f.startsWith('monthly_')) continue;
    const m = f.match(/^(daily|monthly)_([A-Z]+)_(\d{4})\.parquet$/);
    if (!m) continue;
    if (sensor && m[2] !== sensor.toUpperCase()) continue;
    if (year && Number(m[3]) !== year) continue;
    parts.push(path.join(PARQUET_ROOT, 'agg', f).replace(/\\/g, '/'));
  }
  return parts.map(parquetSqlPath).join(', ');
}

function obsGlobFor(sensor?: string, year?: number): string | null {
  const base = path.join(PARQUET_ROOT, 'obs').replace(/\\/g, '/');
  if (sensor && year) {
    const p = path.join(base, `sensor=${sensor.toUpperCase()}`, `year=${year}`, 'data_*.parquet').replace(/\\/g, '/');
    return fs.existsSync(path.dirname(p).replace(/data_\*\.parquet$/, '')) ? parquetSqlPath(p) : null;
  }
  if (sensor) {
    const dir = path.join(base, `sensor=${sensor.toUpperCase()}`).replace(/\\/g, '/');
    return fs.existsSync(dir) ? parquetSqlPath(`${dir}/**/*.parquet`) : null;
  }
  return fs.existsSync(base) ? parquetSqlPath(`${base}/**/*.parquet`) : null;
}

export async function historicalStatus(): Promise<HistoricalStatus> {
  if (!storeExists()) {
    return {
      available: false,
      root: PARQUET_ROOT,
      sensors: {},
      note: 'No historical parquet store found. Run data_pipeline/import_historical.py then build_historical_db.py.',
    };
  }
  const sensors: HistoricalStatus['sensors'] = {};
  const aggDir = path.join(PARQUET_ROOT, 'agg');
  if (!fs.existsSync(aggDir)) {
    return {
      available: true,
      root: PARQUET_ROOT,
      sensors,
      note: 'Observation store present but no aggregate files found. Run build_historical_db.py.',
    };
  }
  for (const f of fs.readdirSync(aggDir)) {
    const m = f.match(/^daily_([A-Z]+)_(\d{4})\.parquet$/);
    if (!m) continue;
    const [, sensor, yearStr] = m;
    const year = Number(yearStr);
    const s = (sensors[sensor] ??= { years: [], min_date: null, max_date: null, rows: 0 });
    s.years.push(year);
    try {
      const row = await one<{ mn: string; mx: string; n: number }>(
        `SELECT min(period) mn, max(period) mx, sum(detections) n FROM read_parquet(${parquetSqlPath(path.join(aggDir, f))}, hive_partitioning=false)`
      );
      if (row?.mn && (!s.min_date || row.mn < s.min_date)) s.min_date = row.mn;
      if (row?.mx && (!s.max_date || row.mx > s.max_date)) s.max_date = row.mx;
      if (row?.n) s.rows = (s.rows ?? 0) + Number(row.n);
    } catch {
      // A single corrupt agg file must not take down status.
    }
  }
  for (const s of Object.values(sensors)) s.years.sort((a, b) => a - b);
  return {
    available: true,
    root: PARQUET_ROOT,
    sensors,
    note: 'Historical FIRMS archive (local). Detection counts are satellite thermal anomalies, not confirmed wildfires.',
  };
}

export interface DailyQuery {
  year?: number;
  month?: number;
  /** Optional inclusive ISO date range (applied to the period column). */
  startDate?: string;
  endDate?: string;
  sensor?: string;
  country?: string;
  level?: 'daily' | 'monthly';
  /** Aggregate across all countries: one row per period x sensor. */
  global?: boolean;
  limit?: number;
}

function periodRangeClauses(q: DailyQuery): { sql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const level = q.level === 'monthly' ? 'monthly' : 'daily';

  if (level === 'monthly') {
    // F29 fix: monthly `period` values are YYYY-MM strings; normalize start/end to the
    // same format so lexicographic comparison is consistent and January is not excluded.
    if (q.startDate && isRealIsoDate(q.startDate)) {
      clauses.push('period >= ?');
      params.push(q.startDate.slice(0, 7)); // "YYYY-MM-DD" → "YYYY-MM"
    }
    if (q.endDate && isRealIsoDate(q.endDate)) {
      clauses.push('period <= ?');
      params.push(q.endDate.slice(0, 7));
    }
    // F29 fix: honour month filtering in monthly mode too.
    if (q.month) {
      clauses.push("substr(period, 6, 2) = ?");
      params.push(String(q.month).padStart(2, '0'));
    }
  } else {
    if (q.startDate && isRealIsoDate(q.startDate)) {
      clauses.push('period >= ?');
      params.push(q.startDate);
    }
    if (q.endDate && isRealIsoDate(q.endDate)) {
      clauses.push('period <= ?');
      params.push(q.endDate);
    }
  }
  return { sql: clauses.length ? clauses.join(' AND ') : '', params };
}

export async function historicalDaily(q: DailyQuery): Promise<{ rows: DailyRow[]; truncated: boolean }> {
  const level = q.level === 'monthly' ? 'monthly' : 'daily';
  const glob = aggGlobFor(level, q.sensor, q.year);
  if (!glob) return { rows: [], truncated: false };
  const limit = Math.min(Math.max(q.limit ?? 10000, 1), 50000);

  if (q.global) {
    // Re-aggregate the per-country rows across the whole archive. frp_max_mw is the
    // max of daily maxima (still a real max); satellites_seen is not derivable -> null.
    const where: string[] = [];
    const params: unknown[] = [];
    if (level === 'daily' && q.month) {
      where.push("strftime(try_cast(period AS DATE), '%m') = ?");
      params.push(String(q.month).padStart(2, '0'));
    }
    const range = periodRangeClauses(q);
    if (range.sql) {
      where.push(range.sql);
      params.push(...range.params);
    }
    const rows = await all<DailyRow>(
      `SELECT period, 'GLOBAL' AS country, sensor,
              sum(detections) AS detections,
              sum(frp_sum_mw) AS frp_sum_mw,
              max(frp_max_mw) AS frp_max_mw,
              sum(day_count) AS day_count,
              sum(night_count) AS night_count,
              CAST(NULL AS INTEGER) AS satellites_seen
       FROM read_parquet([${glob}], hive_partitioning=false)
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       GROUP BY period, sensor
       ORDER BY period, sensor
       LIMIT ${limit + 1}`,
      params
    );
    return { rows: rows.slice(0, limit), truncated: rows.length > limit };
  }

  const where: string[] = [];
  const params: unknown[] = [];
  if (level === 'daily' && q.month) {
    where.push("strftime(try_cast(period AS DATE), '%m') = ?");
    params.push(String(q.month).padStart(2, '0'));
  }
  const range = periodRangeClauses(q);
  if (range.sql) {
    where.push(range.sql);
    params.push(...range.params);
  }
  if (q.country) {
    where.push('country = ?');
    params.push(q.country);
  }
  const sql = `
    SELECT period, country, sensor, detections, frp_sum_mw, frp_max_mw,
           day_count, night_count, satellites_seen
    FROM read_parquet([${glob}], hive_partitioning=false)
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY period, country
    LIMIT ${limit + 1}`;
  const rows = await all<DailyRow>(sql, params);
  return { rows: rows.slice(0, limit), truncated: rows.length > limit };
}

interface RawObsRow {
  acq_date: string;
  acq_time: string;
  latitude: number;
  longitude: number;
  sensor: string;
  satellite: string | null;
  confidence: string | null;
  frp: number | null;
  daynight: string | null;
  country: string;
  bright_ti4: number | null;
  bright_ti5: number | null;
  brightness: number | null;
  bright_t31: number | null;
  version: string | null;
  scan: number | null;
  track: number | null;
  source_zip: string | null;
}

function confidenceCategory(sensor: SensorType, raw: string | null): { confidence: number | string; category: ConfidenceCategory } {
  if (sensor === 'VIIRS') {
    const c = (raw ?? '').trim().toLowerCase();
    return {
      confidence: raw ?? '',
      category: c === 'h' ? 'high' : c === 'l' ? 'low' : 'nominal',
    };
  }
  const n = Number(raw);
  const confidence = Number.isFinite(n) ? n : 0;
  return { confidence, category: confidence >= 80 ? 'high' : confidence >= 30 ? 'nominal' : 'low' };
}

function satelliteType(sensor: SensorType, raw: string | null): SatelliteType {
  const s = (raw ?? '').trim();
  if (sensor === 'VIIRS') return 'Suomi-NPP'; // archive contains S-NPP only ('N')
  return s.toUpperCase().startsWith('A') ? 'Aqua' : 'Terra';
}

/** Map a parquet row to the canonical observation shape the map/UI already consume. */
function toCanonical(row: RawObsRow): CanonicalObservation {
  const sensor: SensorType = row.sensor === 'VIIRS' ? 'VIIRS' : 'MODIS';
  const satellite = satelliteType(sensor, row.satellite);
  const time = String(row.acq_time ?? '').padStart(4, '0');
  const conf = confidenceCategory(sensor, row.confidence);
  const key = [
    'hist', sensor, satellite, row.country, row.acq_date, time,
    row.latitude.toFixed(5), row.longitude.toFixed(5), row.source_zip ?? '',
  ].join('|');
  const hash = createHash('sha256').update(key).digest('hex');
  return {
    id: `hist-${hash.slice(0, 16)}`,
    source_record_id: key,
    latitude: row.latitude,
    longitude: row.longitude,
    acq_date: row.acq_date,
    acq_time: time,
    datetime_utc: `${row.acq_date}T${time.slice(0, 2)}:${time.slice(2)}:00Z`,
    sensor,
    satellite,
    product: sensor === 'MODIS' ? 'FIRMS_HISTORICAL_MODIS' : 'FIRMS_HISTORICAL_VIIRS_SNPP',
    processing_version: row.version ?? '',
    confidence: conf.confidence,
    confidence_category: conf.category,
    frp_mw: row.frp ?? 0,
    brightness: row.brightness ?? undefined,
    bright_ti4: sensor === 'VIIRS' ? (row.bright_ti4 ?? undefined) : undefined,
    bright_ti5: sensor === 'VIIRS' ? (row.bright_ti5 ?? undefined) : undefined,
    scan: row.scan ?? 0,
    track: row.track ?? 0,
    daynight: row.daynight === 'N' ? 'N' : 'D',
    source_file: row.source_zip ?? 'historical archive',
    retrieved_at: '',
    quality_flags: '',
    record_hash: hash,
    // User-supplied FIRMS export: real NASA-format rows, authenticity not independently verified.
    provenance_status: 'UNVERIFIED',
  };
}

export interface ObsQuery {
  date: string;
  sensor?: string;
  bbox?: { west: number; south: number; east: number; north: number };
  country?: string;
  satellite?: string;
  daynight?: 'D' | 'N';
  minFrp?: number;
  limit?: number;
}

export async function historicalObservations(q: ObsQuery): Promise<{ rows: CanonicalObservation[]; truncated: boolean }> {
  if (!isRealIsoDate(q.date)) {
    throw new Error('date must be a real YYYY-MM-DD calendar date');
  }
  const glob = obsGlobFor(q.sensor);
  if (!glob) return { rows: [], truncated: false };
  const where: string[] = ["acq_date = ?"];
  const params: unknown[] = [q.date];
  if (q.sensor) {
    where.push('sensor = ?');
    params.push(q.sensor.toUpperCase());
  }
  if (q.bbox) {
    where.push('longitude BETWEEN ? AND ?', 'latitude BETWEEN ? AND ?');
    params.push(q.bbox.west, q.bbox.east, q.bbox.south, q.bbox.north);
  }
  if (q.country) {
    where.push('country = ?');
    params.push(q.country);
  }
  if (q.satellite) {
    where.push('satellite = ?');
    params.push(q.satellite);
  }
  if (q.daynight === 'D' || q.daynight === 'N') {
    where.push('daynight = ?');
    params.push(q.daynight);
  }
  if (q.minFrp != null && Number.isFinite(q.minFrp)) {
    where.push('frp >= ?');
    params.push(q.minFrp);
  }
  const limit = Math.min(Math.max(q.limit ?? 20000, 1), 100000);
  const sql = `
    SELECT acq_date, acq_time, latitude, longitude, sensor, satellite,
           confidence, frp, daynight, country,
           bright_ti4, bright_ti5, brightness, bright_t31, version,
           scan, track, source_zip
    FROM read_parquet(${glob}, hive_partitioning=false)
    WHERE ${where.join(' AND ')}
    ORDER BY frp DESC NULLS LAST
    LIMIT ${limit + 1}`;
  const raw = await all<RawObsRow>(sql, params);
  const truncated = raw.length > limit;
  return { rows: raw.slice(0, limit).map(toCanonical), truncated };
}

export interface CoverageDay {
  date: string;
  sensor: string;
  global_rows: number;
}

/** Dates on which the archive holds ANY rows for a sensor (observation-present signal). */
export async function historicalCoverage(sensor?: string): Promise<CoverageDay[]> {
  const files: string[] = [];
  const aggDir = path.join(PARQUET_ROOT, 'agg');
  if (fs.existsSync(aggDir)) {
    for (const f of fs.readdirSync(aggDir)) {
      const m = f.match(/^coverage_([A-Z]+)_(\d{4})\.parquet$/);
      if (!m) continue;
      if (sensor && m[1] !== sensor.toUpperCase()) continue;
      files.push(parquetSqlPath(path.join(aggDir, f)));
    }
  }
  if (!files.length) return [];
  return all<CoverageDay>(
    `SELECT date, sensor, global_rows FROM read_parquet([${files.join(', ')}], hive_partitioning=false) ORDER BY date`
  );
}

export interface CountryTotal {
  country: string;
  sensor: string;
  detections: number;
  frp_sum_mw: number | null;
  days_with_data: number;
}

/**
 * Per-country totals for one archive year, grouped from the daily aggregate files.
 * MODIS and VIIRS stay in separate rows; the caller must never sum across sensors.
 */
export async function historicalCountryTotals(year: number): Promise<CountryTotal[]> {
  const files: string[] = [];
  const aggDir = path.join(PARQUET_ROOT, 'agg');
  if (fs.existsSync(aggDir)) {
    for (const f of fs.readdirSync(aggDir)) {
      const m = f.match(/^daily_([A-Z]+)_(\d{4})\.parquet$/);
      if (!m || Number(m[2]) !== year) continue;
      files.push(parquetSqlPath(path.join(aggDir, f)));
    }
  }
  if (!files.length) return [];
  return all<CountryTotal>(
    `SELECT country, sensor,
            sum(detections) AS detections,
            sum(frp_sum_mw) AS frp_sum_mw,
            -- F35 fix: count DISTINCT dates per country, not rows (which are country×date tuples).
            count(DISTINCT period) AS days_with_data
     FROM read_parquet([${files.join(', ')}], hive_partitioning=false)
     GROUP BY country, sensor
     ORDER BY detections DESC
     LIMIT 500`,
    []
  );
}

export interface PeriodYearRow {
  year: number;
  sensor: string;
  detections: number;
  frp_sum_mw: number | null;
  days_with_data: number;
  day_count: number;
  night_count: number;
}

/**
 * Per-year totals for a contiguous archive-year range, optionally restricted to one
 * country. MODIS and VIIRS stay in separate rows; callers must never sum across sensors.
 */
export async function historicalPeriodTotals(q: {
  startYear: number;
  endYear: number;
  country?: string;
  sensor?: string;
}): Promise<PeriodYearRow[]> {
  const files: string[] = [];
  const aggDir = path.join(PARQUET_ROOT, 'agg');
  if (fs.existsSync(aggDir)) {
    for (const f of fs.readdirSync(aggDir)) {
      const m = f.match(/^daily_([A-Z]+)_(\d{4})\.parquet$/);
      if (!m) continue;
      if (q.sensor && m[1] !== q.sensor.toUpperCase()) continue;
      const y = Number(m[2]);
      if (y < q.startYear || y > q.endYear) continue;
      files.push(parquetSqlPath(path.join(aggDir, f)));
    }
  }
  if (!files.length) return [];
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.country) {
    where.push('country = ?');
    params.push(q.country);
  }
  return all<PeriodYearRow>(
    `SELECT CAST(substr(period, 1, 4) AS INTEGER) AS year, sensor,
            sum(detections) AS detections,
            sum(frp_sum_mw) AS frp_sum_mw,
            -- F35 fix: count DISTINCT dates per year/sensor scope, not country-day rows.
            count(DISTINCT period) AS days_with_data,
            sum(day_count) AS day_count,
            sum(night_count) AS night_count
     FROM read_parquet([${files.join(', ')}], hive_partitioning=false)
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     GROUP BY year, sensor
     ORDER BY year, sensor
     LIMIT 200`,
    params
  );
}

export async function historicalYearTotals(sensor: string, year: number): Promise<{ detections: number; frp_sum_mw: number | null; days_with_data: number } | null> {
  const f = path.join(PARQUET_ROOT, 'agg', `daily_${sensor.toUpperCase()}_${year}.parquet`).replace(/\\/g, '/');
  if (!fs.existsSync(f)) return null;
  const row = await one<{ d: number; f: number | null; n_days: number }>(
    `SELECT sum(detections) d, sum(frp_sum_mw) f, count(*) AS n_days FROM read_parquet(${parquetSqlPath(f)})`
  );
  if (!row) return null;
  return { detections: Number(row.d ?? 0), frp_sum_mw: row.f == null ? null : Number(row.f), days_with_data: Number(row.n_days ?? 0) };
}

// ------------------------------------------------------- historical analytics

export interface FrpExtremeRow {
  period: string;
  country: string;
  sensor: string;
  frp_max_mw: number;
  detections: number;
}

/**
 * Highest daily FRP maxima in the archive (from daily aggregates — the true per-observation
 * maximum would require scanning 392M rows; this is the strongest daily-aggregate signal).
 */
export async function historicalFrpExtremes(q: {
  sensor?: string;
  country?: string;
  startYear?: number;
  endYear?: number;
  limit?: number;
}): Promise<FrpExtremeRow[]> {
  const files: string[] = [];
  const aggDir = path.join(PARQUET_ROOT, 'agg');
  if (fs.existsSync(aggDir)) {
    for (const f of fs.readdirSync(aggDir)) {
      const m = f.match(/^daily_([A-Z]+)_(\d{4})\.parquet$/);
      if (!m) continue;
      if (q.sensor && m[1] !== q.sensor.toUpperCase()) continue;
      const y = Number(m[2]);
      if (q.startYear && y < q.startYear) continue;
      if (q.endYear && y > q.endYear) continue;
      files.push(parquetSqlPath(path.join(aggDir, f)));
    }
  }
  if (!files.length) return [];
  const where: string[] = ['frp_max_mw IS NOT NULL'];
  const params: unknown[] = [];
  if (q.country) {
    where.push('country = ?');
    params.push(q.country);
  }
  const limit = Math.min(Math.max(q.limit ?? 20, 1), 100);
  return all<FrpExtremeRow>(
    `SELECT period, country, sensor, frp_max_mw, detections
     FROM read_parquet([${files.join(', ')}], hive_partitioning=false)
     WHERE ${where.join(' AND ')}
     ORDER BY frp_max_mw DESC
     LIMIT ${limit}`,
    params
  );
}

export interface PersistenceRow {
  country: string;
  sensor: string;
  years_with_data: number;
  detections: number;
}

/** Countries ranked by how many distinct years they have detections in — recurring-activity proxy. */
export async function historicalPersistence(q: {
  startYear?: number;
  endYear?: number;
  sensor?: string;
  limit?: number;
}): Promise<PersistenceRow[]> {
  const files: string[] = [];
  const aggDir = path.join(PARQUET_ROOT, 'agg');
  if (fs.existsSync(aggDir)) {
    for (const f of fs.readdirSync(aggDir)) {
      const m = f.match(/^daily_([A-Z]+)_(\d{4})\.parquet$/);
      if (!m) continue;
      if (q.sensor && m[1] !== q.sensor.toUpperCase()) continue;
      const y = Number(m[2]);
      if (q.startYear && y < q.startYear) continue;
      if (q.endYear && y > q.endYear) continue;
      files.push(parquetSqlPath(path.join(aggDir, f)));
    }
  }
  if (!files.length) return [];
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
  return all<PersistenceRow>(
    `SELECT country, sensor,
            count(DISTINCT substr(period, 1, 4)) AS years_with_data,
            sum(detections) AS detections
     FROM read_parquet([${files.join(', ')}], hive_partitioning=false)
     GROUP BY country, sensor
     ORDER BY years_with_data DESC, detections DESC
     LIMIT ${limit}`
  );
}

export interface MonthAnomalyRow {
  country: string;
  sensor: string;
  year: number;
  detections: number;
  /** Median detections for the same calendar month across the OTHER archive years. */
  other_years_median: number | null;
  valid_years?: number;
  baseline_years?: number[];
  /** detections / other_years_median; null when the median is 0. */
  ratio: number | null;
}

/**
 * For one calendar month, compare each country+sensor's detections against the median of the
 * same month in all other archive years. Statistical variation only — not a fire forecast.
 */
export async function historicalMonthAnomaly(q: {
  year: number;
  month: number;
  country?: string;
  sensor?: string;
  limit?: number;
}): Promise<MonthAnomalyRow[]> {
  const files: string[] = [];
  const aggDir = path.join(PARQUET_ROOT, 'agg');
  if (fs.existsSync(aggDir)) {
    for (const f of fs.readdirSync(aggDir)) {
      const m = f.match(/^daily_([A-Z]+)_(\d{4})\.parquet$/);
      if (!m) continue;
      if (q.sensor && m[1] !== q.sensor.toUpperCase()) continue;
      files.push(parquetSqlPath(path.join(aggDir, f)));
    }
  }
  if (!files.length) return [];
  const where: string[] = [`strftime(try_cast(period AS DATE), '%m') = ?`];
  const params: unknown[] = [String(q.month).padStart(2, '0')];
  if (q.country) {
    where.push('country = ?');
    params.push(q.country);
  }
  const raw = await all<{ y: number; country: string; sensor: string; d: number }>(
    `SELECT CAST(substr(period, 1, 4) AS INTEGER) AS y, country, sensor, sum(detections) AS d
     FROM read_parquet([${files.join(', ')}], hive_partitioning=false)
     WHERE ${where.join(' AND ')}
     GROUP BY y, country, sensor`,
    params
  );
  // Group by country+sensor, compute median of other years, keep target-year rows.
  const groups = new Map<string, { country: string; sensor: string; byYear: Map<number, number> }>();
  for (const r of raw) {
    const key = `${r.country}|${r.sensor}`;
    let g = groups.get(key);
    if (!g) {
      g = { country: r.country, sensor: r.sensor, byYear: new Map() };
      groups.set(key, g);
    }
    g.byYear.set(Number(r.y), (g.byYear.get(Number(r.y)) ?? 0) + Number(r.d));
  }
  const out: MonthAnomalyRow[] = [];
  for (const g of groups.values()) {
    const current = g.byYear.get(q.year);
    if (current == null) continue;
    const comparison = compareAgniMonth([...g.byYear].map(([year, detections]) => ({ year, month: q.month, detections, partial_coverage: g.sensor === 'VIIRS' && year === 2012 && q.month === 1 || g.sensor === 'MODIS' && year === 2000 && q.month === 11 })), q.year, q.month);
    const med = comparison.baseline_median;
    out.push({
      country: g.country,
      sensor: g.sensor,
      year: q.year,
      detections: current,
      other_years_median: med,
      valid_years: comparison.valid_years,
      baseline_years: comparison.baseline_years,
      ratio: comparison.ratio == null ? null : Number(comparison.ratio.toFixed(3)),
    });
  }
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
  // Rank by absolute deviation from the median; null ratios (no baseline) sort last.
  out.sort((a, b) => {
    const da = a.ratio == null ? -1 : Math.abs(a.ratio - 1);
    const db = b.ratio == null ? -1 : Math.abs(b.ratio - 1);
    return db - da;
  });
  return out.slice(0, limit);
}


// ------------------------------------------------------- seasonal climatology
//
// Everything below describes what was TYPICAL in the archive (climatology).
// It is never a forecast: "activity_class" ranks a calendar month against the
// scope's own 2000-2025 seasonal range, and "period_status" compares an observed
// value to the historical quartiles for the same calendar window.

export interface ClimatologyScope {
  country?: string;
  bbox?: { west: number; south: number; east: number; north: number };
  sensor?: string;
  startYear?: number;
  endYear?: number;
}

export interface ClimatologyResponse {
  scope: { country: string | null; bbox: ClimatologyScope['bbox'] | null; sensor: string };
  year_range: { start: number; end: number } | null;
  months: MonthlyClimatology[];
  season: SeasonSummary;
  legend: string;
  notes: string[];
}

interface MonthlyFileRef {
  sensor: string;
  year: number;
  file: string;
}

function monthlyFilesFor(sensor: string | undefined, startYear?: number, endYear?: number): MonthlyFileRef[] {
  const aggDir = path.join(PARQUET_ROOT, 'agg');
  const out: MonthlyFileRef[] = [];
  if (!fs.existsSync(aggDir)) return out;
  for (const f of fs.readdirSync(aggDir)) {
    const m = f.match(/^monthly_([A-Z]+)_(\d{4})\.parquet$/);
    if (!m) continue;
    if (sensor && m[1] !== sensor.toUpperCase()) continue;
    const y = Number(m[2]);
    if (startYear && y < startYear) continue;
    if (endYear && y > endYear) continue;
    out.push({ sensor: m[1], year: y, file: path.join(aggDir, f).replace(/\\/g, '/') });
  }
  return out;
}

function climateGridFile(sensor: string): string | null {
  const f = path.join(PARQUET_ROOT, 'agg', `climate_${sensor.toUpperCase()}.parquet`).replace(/\\/g, '/');
  return fs.existsSync(f) ? f : null;
}

function climateCountryFile(sensor: string): string | null {
  const f = path.join(PARQUET_ROOT, 'agg', `climate_country_${sensor.toUpperCase()}.parquet`).replace(/\\/g, '/');
  return fs.existsSync(f) ? f : null;
}

interface MonthlyAggRow {
  sensor: string;
  month: number;
  year: number;
  detections: number;
  frp_sum_mw: number | null;
}

const CLIMATOLOGY_NOTES = [
  'Climatology describes what was typical in the 2000-2025 archive; it is not a forecast or prediction.',
  'MODIS and VIIRS are reported separately; harmonized_equivalent_median applies the fixed 0.294 EXPLORATORY coefficient and is not a validated calibration.',
  'Months with no archive rows are missing coverage, not proven zero activity.',
];

function emptyClimatology(q: ClimatologyScope, extraNote?: string): ClimatologyResponse {
  return {
    scope: { country: q.country ?? null, bbox: q.bbox ?? null, sensor: q.sensor?.toUpperCase() ?? 'ALL' },
    year_range: null,
    months: [],
    season: { peak_months: [], low_months: [] },
    legend: 'Satellite thermal anomalies, not confirmed wildfires or burned area.',
    notes: [...CLIMATOLOGY_NOTES, ...(extraNote ? [extraNote] : [])],
  };
}

/**
 * Monthly seasonal climatology for one country OR one bounding box.
 * Country scope uses the monthly country aggregates; bbox scope uses the 1-degree
 * climate grid (cells whose center falls inside the box — a boundary approximation).
 */
export async function historicalClimatology(q: ClimatologyScope): Promise<ClimatologyResponse> {
  const sensor = q.sensor?.toUpperCase();
  const notes = [...CLIMATOLOGY_NOTES];
  if (q.bbox) notes.push('Bounding-box scope uses 1-degree grid cells whose centers fall inside the box; boundary cells are approximate.');

  const rows: MonthlyAggRow[] = [];
  const yearsTotalBySensor = new Map<string, number>();

  if (q.country) {
    const files = monthlyFilesFor(sensor, q.startYear, q.endYear);
    if (!files.length) {
      return emptyClimatology(q, 'No monthly aggregate files match the requested sensor/year range.');
    }
    for (const f of files) yearsTotalBySensor.set(f.sensor, (yearsTotalBySensor.get(f.sensor) ?? 0) + 1);
    const glist = files.map((f) => parquetSqlPath(f.file)).join(', ');
    const raw = await all<MonthlyAggRow>(
      `SELECT sensor, CAST(substr(period, 6, 2) AS INTEGER) AS month, CAST(substr(period, 1, 4) AS INTEGER) AS year,
              sum(detections) AS detections, sum(frp_sum_mw) AS frp_sum_mw
       FROM read_parquet([${glist}], hive_partitioning=false)
       WHERE country = ?
       GROUP BY sensor, month, year`,
      [q.country]
    );
    rows.push(...raw);
  } else if (q.bbox) {
    const { west, south, east, north } = q.bbox;
    for (const s of sensor ? [sensor] : ['MODIS', 'VIIRS']) {
      const f = climateGridFile(s);
      if (!f) continue;
      const params: unknown[] = [s, south, north, west, east];
      // F28 fix: build a single validated WHERE clause for both queries.
      // yearClause previously started with AND but the year-count query had no WHERE,
      // causing a DuckDB parser error. Now both queries use a consistent clause list.
      const yearConds: string[] = [];
      const yearParams: unknown[] = [];
      if (q.startYear) { yearConds.push('year >= ?'); yearParams.push(q.startYear); }
      if (q.endYear) { yearConds.push('year <= ?'); yearParams.push(q.endYear); }
      const yearWhereClause = yearConds.length ? ' AND ' + yearConds.join(' AND ') : '';
      const raw = await all<MonthlyAggRow>(
        `SELECT ? AS sensor, month::INTEGER AS month, year::INTEGER AS year,
                sum(detections) AS detections, sum(frp_sum_mw) AS frp_sum_mw
         FROM read_parquet(${parquetSqlPath(f)}, hive_partitioning=false)
         WHERE (glat + 0.5) BETWEEN ? AND ? AND (glon + 0.5) BETWEEN ? AND ?${yearWhereClause}
         GROUP BY month, year`,
        [...params, ...yearParams]
      );
      rows.push(...raw);
      const yr = await one<{ n: number }>(
        `SELECT count(DISTINCT year) AS n FROM read_parquet(${parquetSqlPath(f)}, hive_partitioning=false)${yearConds.length ? ' WHERE ' + yearConds.join(' AND ') : ''}`,
        yearParams
      );
      if (yr?.n) yearsTotalBySensor.set(s, Number(yr.n));
    }
    if (!rows.length) {
      return emptyClimatology(q, 'No climate grid files exist for the requested scope (run data_pipeline/build_climate.py).');
    }
  } else {
    return emptyClimatology(q, 'Provide either country or bbox.');
  }

  const byMonth = new Map<number, Map<string, { values: number[]; frp: number[]; years: Set<number> }>>();
  for (const r of rows) {
    let sensors = byMonth.get(r.month);
    if (!sensors) { sensors = new Map(); byMonth.set(r.month, sensors); }
    let s = sensors.get(r.sensor);
    if (!s) { s = { values: [], frp: [], years: new Set() }; sensors.set(r.sensor, s); }
    s.values.push(Number(r.detections));
    if (r.frp_sum_mw != null) s.frp.push(Number(r.frp_sum_mw));
    s.years.add(r.year);
  }

  const months: MonthlyClimatology[] = [];
  for (let m = 1; m <= 12; m++) {
    const sensors = byMonth.get(m) ?? new Map<string, { values: number[]; frp: number[]; years: Set<number> }>();
    const sensorStats: MonthlyClimatology['sensors'] = {};
    let modisMedian: number | null = null;
    let viirsMedian: number | null = null;
    for (const [sName, s] of sensors) {
      const sorted = [...s.values].sort((a, b) => a - b);
      const sortedFrp = [...s.frp].sort((a, b) => a - b);
      const st = {
        median_detections: sorted.length ? Number(quantile(sorted, 0.5).toFixed(2)) : 0,
        p25_detections: sorted.length ? Number(quantile(sorted, 0.25).toFixed(2)) : 0,
        p75_detections: sorted.length ? Number(quantile(sorted, 0.75).toFixed(2)) : 0,
        years_with_data: s.years.size,
        years_total: yearsTotalBySensor.get(sName) ?? s.years.size,
        median_frp_sum_mw: sortedFrp.length ? Number(quantile(sortedFrp, 0.5).toFixed(2)) : null,
      };
      sensorStats[sName] = st;
      if (sName === 'MODIS') modisMedian = st.median_detections;
      if (sName === 'VIIRS') viirsMedian = st.median_detections;
    }
    // F27 fix: when only VIIRS exists, scale it to MODIS-equivalent units using the
    // EXPLORATORY coefficient. Never return raw VIIRS under the same metric name as
    // the blended harmonized_equivalent_median — that changes the scale silently.
    // When only MODIS exists, return raw MODIS (reference scale). Otherwise blend both.
    const he =
      modisMedian != null && viirsMedian != null
        ? harmonizedEquivalent(modisMedian, viirsMedian)
        : modisMedian != null
        ? modisMedian
        : viirsMedian != null
        ? harmonizedEquivalent(0, viirsMedian)  // 0.294 × VIIRS to MODIS-scale
        : null;
    months.push({
      month: m,
      sensors: sensorStats,
      harmonized_equivalent_median: he == null ? null : Number(he.toFixed(2)),
      activity_class: 'low',
    });
  }
  // F26 fix: exclude null medians from thresholds; F26 fix applied in classifyActivity.
  const thresholds = activityThresholds(months.map((m) => m.harmonized_equivalent_median).filter((v): v is number => v !== null));
  for (const m of months) {
    m.activity_class = classifyActivity(m.harmonized_equivalent_median, thresholds);
  }
  const season = seasonSummary(months);
  const ys = rows.map((r) => r.year);
  const year_range = ys.length ? { start: Math.min(...ys), end: Math.max(...ys) } : null;

  return {
    scope: { country: q.country ?? null, bbox: q.bbox ?? null, sensor: sensor ?? 'ALL' },
    year_range,
    months,
    season,
    legend: 'Satellite thermal anomalies, not confirmed wildfires or burned area.',
    notes,
  };
}

export interface SeasonalStatusResponse {
  country: string;
  date: string;
  day_of_year: number;
  window_days: number;
  climatology: ClimatologyResponse;
  today_window: Record<
    string,
    {
      median_detections: number;
      p25_detections: number;
      p75_detections: number;
      years_with_data: number;
      years_total: number;
      /** Present only when the caller supplied an observed count for that sensor. */
      period_status?: PeriodStatus;
    }
  >;
  upcoming_months: { month: number; activity_class: ActivityClass; harmonized_equivalent_median: number | null }[];
  legend: string;
  notes: string[];
}

/**
 * Country-scoped seasonal status: monthly climatology plus a day-of-year window
 * distribution for "today" across archive years. When `observed` per-sensor
 * counts are supplied, each sensor's value is classified against that window's
 * quartiles ("current vs typical" — not a forecast).
 */
export async function historicalSeasonalStatus(q: {
  country: string;
  sensor?: string;
  date?: string;
  windowDays?: number;
  observed?: { MODIS?: number; VIIRS?: number };
}): Promise<SeasonalStatusResponse | null> {
  const climatology = await historicalClimatology({ country: q.country, sensor: q.sensor });
  if (!climatology.months.length) return null;

  const dateStr = q.date && isRealIsoDate(q.date) ? q.date : new Date().toISOString().slice(0, 10);
  const d = new Date(`${dateStr}T00:00:00Z`);
  const doy = Math.floor((d.getTime() - new Date(Date.UTC(d.getUTCFullYear(), 0, 0)).getTime()) / 86400000);
  const radius = Math.min(Math.max(q.windowDays ?? 7, 1), 30);
  const win = doyWindow(doy, radius);

  const sensor = q.sensor?.toUpperCase();
  const todayWindow: SeasonalStatusResponse['today_window'] = {};
  for (const s of sensor ? [sensor] : ['MODIS', 'VIIRS']) {
    const f = climateCountryFile(s);
    if (!f) continue;
    const cond = win.start <= win.end ? 'doy BETWEEN ? AND ?' : '(doy BETWEEN ? AND 366 OR doy BETWEEN 1 AND ?)';
    const params = [q.country, win.start, win.end];
    const raw = await all<{ year: number; d: number }>(
      `SELECT year, sum(detections) AS d
       FROM read_parquet(${parquetSqlPath(f)}, hive_partitioning=false)
       WHERE country = ? AND ${cond}
       GROUP BY year`,
      params
    );
    if (!raw.length) continue;
    const values = raw.map((r) => Number(r.d)).sort((a, b) => a - b);
    const p25 = quantile(values, 0.25);
    const p75 = quantile(values, 0.75);
    const med = quantile(values, 0.5);
    const yearsTotalRow = await one<{ n: number }>(
      `SELECT count(DISTINCT year) AS n FROM read_parquet(${parquetSqlPath(f)}, hive_partitioning=false) WHERE country = ?`,
      [q.country]
    );
    const observed = q.observed?.[s as 'MODIS' | 'VIIRS'];
    const entry: SeasonalStatusResponse['today_window'][string] = {
      median_detections: Number(med.toFixed(2)),
      p25_detections: Number(p25.toFixed(2)),
      p75_detections: Number(p75.toFixed(2)),
      years_with_data: raw.length,
      years_total: Number(yearsTotalRow?.n ?? raw.length),
    };
    if (observed != null && Number.isFinite(observed)) {
      entry.period_status = classifyVsClimatology(observed, med, p25, p75, raw.length);
    }
    todayWindow[s] = entry;
  }

  const curMonth = d.getUTCMonth() + 1;
  const upcoming = [1, 2, 3].map((k) => {
    const m = ((curMonth - 1 + k) % 12) + 1;
    const row = climatology.months.find((x) => x.month === m);
    return { month: m, activity_class: row?.activity_class ?? ('low' as ActivityClass), harmonized_equivalent_median: row?.harmonized_equivalent_median ?? null };
  });

  return {
    country: q.country,
    date: dateStr,
    day_of_year: doy,
    window_days: radius * 2 + 1,
    climatology,
    today_window: todayWindow,
    upcoming_months: upcoming,
    legend: 'Satellite thermal anomalies, not confirmed wildfires or burned area.',
    notes: [
      'today_window shows the historical distribution of detections for the same day-of-year window across archive years — a climatology range, not a forecast.',
      'period_status compares a caller-supplied observed count to that range; it describes the current period only.',
      'upcoming_months classes describe which calendar months are historically most/least active for this country.',
      'VIIRS is Suomi-NPP only; MODIS and VIIRS are never summed.',
    ],
  };
}

/** Distinct country labels present in the monthly aggregates (for pickers). */
export async function historicalCountries(): Promise<string[]> {
  const glob = aggGlobFor('monthly');
  if (!glob) return [];
  const rows = await all<{ country: string }>(
    `SELECT DISTINCT country FROM read_parquet([${glob}], hive_partitioning=false) ORDER BY country`
  );
  return rows.map((r) => r.country);
}

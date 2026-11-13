/**
 * AgniCalendar harmonized-dataset query service.
 *
 * Reads `AgniCalendar_Global_Harmonized_CellMonth` (30M rows, 10 km EPSG:8857
 * cells x UTC month x fire_type, 2002-2025) through an in-process DuckDB
 * connection. Server-side scans only; nothing is loaded into memory.
 *
 * Dataset rules encoded here (see docs/agnicalendar.md):
 * - NULL means missing, never zero; absent cell-months are unavailable, not
 *   fire-free.
 * - DAY / NIGHT / UNKNOWN-DN stay separate; "known" means DAY+NIGHT only when
 *   BOTH components are observed, otherwise NULL.
 * - Harmonized estimates are summed only on rows whose component
 *   prediction_support_status is APPROVED_CONDITIONAL_JOINT_POSITIVE.
 * - fire_type='0' is source-reported presumed vegetation, not corrected truth.
 * - No endpoint adds Aqua counts to harmonized estimates or merges sensors.
 */

import path from 'node:path';
import fs from 'node:fs';
import duckdb from 'duckdb';
import { compareAgniMonth, agniSeason } from '../utils/agniBaseline';
import { isPointInPolygon, polygonBbox } from '../utils/polygon';
import type { AoiPolygon } from '../types/fire';
import { sanitizeCsvCell } from '../utils/csv_export';
import { parquetDatasetDirectory, parquetSqlPath } from './dataPaths';
import { bboxToGridRange, cellCenterLatLon, cellCornersLatLon, type GridRange } from '../utils/equalEarth';

export type AgniLayer = 'aqua' | 'snpp' | 'harmonized';
export type AgniDayNight = 'day' | 'night' | 'unknown' | 'known';
export type AgniFireType = '0' | '1' | '2' | '3' | 'UNKNOWN' | 'all';

export interface AgniScope {
  kind: 'global' | 'bbox';
  bbox?: { west: number; south: number; east: number; north: number };
}

export interface AgniQuery {
  polygon?: AoiPolygon;
  scope?: AgniScope;
  /** Country from the cell->country majority-vote lookup (data/agnicalendar). */
  country?: string;
  layer?: AgniLayer;
  daynight?: AgniDayNight;
  fireType?: AgniFireType;
  startYear?: number;
  endYear?: number;
  year?: number;
  month?: number;
}

export interface AgniStatus {
  available: boolean;
  root: string;
  rows: number | null;
  min_year: number | null;
  max_year: number | null;
  min_month: string | null;
  max_month: string | null;
  fire_types: string[];
  grid: { crs: string; resolution_m: number; note: string };
  layers: Record<AgniLayer, { description: string; available_from: string | null }>;
  support_statuses: Array<{ status: string; rows: number }>;
  caveats: string[];
}

export interface AgniMonthRow {
  population_key?: string;
  year: number;
  month: number;
  detections: number | null;
  frp_sum_mw: number | null;
  cells_with_data: number;
  /** Jan 2012 SNPP/harmonized rows are partial-coverage months. */
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

const PARQUET_GLOB =
  process.env.FIRESYNC_AGNICALENDAR_PARQUET?.trim() ||
  'Harmonized Data Set/AgniCalendar_Global_Harmonized_CellMonth/year=*/part-*.parquet';
const DATASET_DIR = parquetDatasetDirectory(PARQUET_GLOB);
// cell -> majority country lookup built by data_pipeline/build_agni_country.py
const CELL_COUNTRY_PATH =
  process.env.FIRESYNC_AGNI_CELL_COUNTRY?.trim() || 'data/agnicalendar/cell_country.parquet';

const CAVEATS = [
  'Satellite thermal anomaly detection counts, not unique fires, burned area or ground truth.',
  'NULL means missing/unavailable, never a verified zero; absent cell-months are not fire-free proof.',
  'DAY, NIGHT and UNKNOWN-DN are reported separately; DAY+NIGHT totals require both components observed.',
  'Harmonized estimates are RF-B model outputs only on APPROVED_CONDITIONAL_JOINT_POSITIVE support; they are not a complete corrected VIIRS series.',
  "fire_type='0' is a source-reported presumed vegetation label with classification uncertainty.",
  'Aqua counts and harmonized estimates describe overlapping measurements and are never added together.',
  'This is a descriptive calendar of satellite-detected activity, not a forecast.',
];

let db: duckdb.Database | null = null;
let conn: duckdb.Connection | null = null;

/** Release native Parquet handles during shutdown or isolated tests. */
export async function closeAgniConnection(): Promise<void> {
  if (conn) await new Promise<void>((resolve, reject) => conn!.close((e: Error | null) => e ? reject(e) : resolve()));
  conn = null;
  if (db) await new Promise<void>((resolve, reject) => db!.close((e: Error | null) => e ? reject(e) : resolve()));
  db = null;
}

function getConnection(): duckdb.Connection {
  if (!conn) {
    db = new duckdb.Database(':memory:');
    conn = db.connect();
    conn.run('SET threads TO 2');
    conn.run("SET memory_limit='2GB'");
    conn.register_udf('agni_in_aoi', 'INTEGER', (row: number, col: number, polygon: string) => {
      const p = cellCenterLatLon(row, col);
      const selection = JSON.parse(polygon);
      if (selection.bbox) {
        const b = selection.bbox;
        return p.lon >= b.west && p.lon <= b.east && p.lat >= b.south && p.lat <= b.north ? 1 : 0;
      }
      return isPointInPolygon(p.lat, p.lon, selection) ? 1 : 0;
    });
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

function available(): boolean {
  return fs.existsSync(DATASET_DIR);
}

function cellCountryAvailable(): boolean {
  return fs.existsSync(CELL_COUNTRY_PATH);
}

/**
 * Correlated EXISTS predicate restricting rows to cells whose majority-voted
 * country matches. Requires the main table to be aliased `t`.
 */
function countryCond(): string {
  return `EXISTS (SELECT 1 FROM read_parquet(${parquetSqlPath(CELL_COUNTRY_PATH)}, hive_partitioning=false) cc WHERE cc.country = ? AND cc.grid_row = t.grid_row AND cc.grid_col = t.grid_col)`;
}

function globSql(): string {
  return parquetSqlPath(PARQUET_GLOB);
}

const SENSOR_PREFIX: Record<'aqua' | 'snpp', string> = {
  aqua: 'modis_aqua',
  snpp: 'viirs_snpp',
};

const DN_SUFFIX: Record<Exclude<AgniDayNight, 'known'>, string> = {
  day: 'day',
  night: 'night',
  unknown: 'unknown_dn',
};

/**
 * SQL expression for the detection count of a layer/daynight combination.
 * Returns { count, frp } expressions; frp is NULL for the harmonized layer
 * (estimates have no FRP counterpart).
 */
function measureExprs(layer: AgniLayer, daynight: AgniDayNight): { count: string; frp: string | null } {
  if (layer === 'harmonized') {
    const approved = "prediction_support_status_%s = 'APPROVED_CONDITIONAL_JOINT_POSITIVE'";
    switch (daynight) {
      case 'day':
        return {
          count: `CASE WHEN ${approved.replace('%s', 'day')} THEN harmonized_aqua_day_estimate END`,
          frp: null,
        };
      case 'night':
        return {
          count: `CASE WHEN ${approved.replace('%s', 'night')} THEN harmonized_aqua_night_estimate END`,
          frp: null,
        };
      case 'known':
        return {
          count: `CASE WHEN ${approved.replace('%s', 'day')} AND ${approved.replace('%s', 'night')} THEN harmonized_aqua_total_estimate END`,
          frp: null,
        };
      case 'unknown':
        // UNKNOWN-DN detections are never estimated by the model.
        return { count: 'NULL', frp: null };
    }
  }

  const prefix = SENSOR_PREFIX[layer];
  if (daynight === 'known') {
    // DAY+NIGHT only when BOTH components are observed; a missing component
    // keeps the total unavailable rather than fabricating a partial sum.
    return {
      count: `CASE WHEN ${prefix}_day_count IS NOT NULL AND ${prefix}_night_count IS NOT NULL THEN ${prefix}_day_count + ${prefix}_night_count END`,
      frp: null, // FRP across DN components is not combined (components stay separate).
    };
  }
  const sfx = DN_SUFFIX[daynight];
  return {
    count: `${prefix}_${sfx}_count`,
    frp: `${prefix}_${sfx}_frp_sum`,
  };
}

function gridRangeFor(scope: AgniScope | undefined): GridRange | null {
  if (!scope || scope.kind !== 'bbox' || !scope.bbox) return null;
  const { west, south, east, north } = scope.bbox;
  return bboxToGridRange(west, south, east, north);
}

/** Shared WHERE clause + params for year/month/scope/country/fire_type filters. */
function buildFilters(q: AgniQuery): { where: string; params: unknown[]; grid: GridRange | null; countryFiltered: boolean; countryUnavailable: boolean } {
  const conds: string[] = [];
  const params: unknown[] = [];

  // F30 fix: when q.year is provided alongside q.startYear/q.endYear (e.g. a cell
  // drill-down click), apply q.year as an EXACT match so the range doesn't absorb
  // values from other years under the same month label.
  if (q.year !== undefined) {
    // Exact year requested — ignore any contradictory start/end bounds.
    conds.push('t.year = ?');
    params.push(q.year);
  } else {
    const startYear = q.startYear ?? 2002;
    const endYear = q.endYear ?? 2025;
    conds.push('t.year BETWEEN ? AND ?');
    params.push(startYear, endYear);
  }
  if (q.month !== undefined) {
    conds.push('t.month = ?');
    params.push(q.month);
  }

  const fireType = q.fireType ?? '0';
  if (fireType !== 'all') {
    conds.push('t.fire_type = ?');
    params.push(fireType);
  }

  const grid = gridRangeFor(q.scope) ?? (q.polygon ? gridRangeFor({ kind: 'bbox', bbox: polygonBbox(q.polygon) }) : null);
  if (grid) {
    conds.push('t.grid_row BETWEEN ? AND ? AND t.grid_col BETWEEN ? AND ?');
    params.push(grid.rowMin, grid.rowMax, grid.colMin, grid.colMax);
  }

  if (q.scope?.bbox || q.polygon) {
    const b = q.scope?.bbox;
    conds.push('agni_in_aoi(t.grid_row, t.grid_col, ?) = 1');
    params.push(JSON.stringify(q.polygon ?? { bbox: b }));
  }

  const countryFiltered = Boolean(q.country && cellCountryAvailable());
  if (q.country && !cellCountryAvailable()) {
    // F31 fix: when the country lookup file is missing and a country was explicitly requested,
    // signal that the country scope is unavailable rather than silently returning global rows.
    // Callers should check countryFiltered and return an explicit error when it differs from intent.
    return { where: conds.join(' AND '), params, grid, countryFiltered: false, countryUnavailable: true };
  }
  if (countryFiltered) {
    conds.push(countryCond());
    params.push(q.country);
  }

  return { where: conds.join(' AND '), params, grid, countryFiltered, countryUnavailable: false };
}

/** Distinct country labels available in the cell->country lookup. */
export async function agniCountries(): Promise<string[]> {
  if (!cellCountryAvailable()) return [];
  const rows = await all<{ country: string }>(
    `SELECT DISTINCT country FROM read_parquet(${parquetSqlPath(CELL_COUNTRY_PATH)}, hive_partitioning=false) ORDER BY country`,
    []
  );
  return rows.map((r) => r.country);
}

function isPartialCoverage(layer: AgniLayer, year: number, month: number): boolean {
  // SNPP observations begin January 2012 and that month is partial; the
  // harmonized layer inherits the same coverage boundary via SNPP inputs.
  return (layer !== 'aqua' && year === 2012 && month === 1) || (layer === 'aqua' && year === 2002 && month === 7);
}

export async function agniStatus(): Promise<AgniStatus> {
  if (!available()) {
    return {
      available: false,
      root: PARQUET_GLOB,
      rows: null,
      min_year: null,
      max_year: null,
      min_month: null,
      max_month: null,
      fire_types: [],
      grid: { crs: 'EPSG:8857', resolution_m: 10_000, note: '10 km Equal Earth grid, origin (0,0).' },
      layers: {
        aqua: { description: 'Original MODIS Aqua detection counts.', available_from: null },
        snpp: { description: 'Original VIIRS Suomi-NPP detection counts.', available_from: null },
        harmonized: { description: 'RF-B harmonized estimates on approved support only.', available_from: null },
      },
      support_statuses: [],
      caveats: CAVEATS,
    };
  }

  const g = globSql();
  const totals = await all<{
    rows: number;
    min_year: number;
    max_year: number;
    min_month: string;
    max_month: string;
  }>(
    `SELECT count(*) AS rows, min(year) AS min_year, max(year) AS max_year,
            min(utc_month) AS min_month, max(utc_month) AS max_month
     FROM read_parquet(${g}, hive_partitioning=false)`,
    []
  );
  const t = totals[0] ?? { rows: 0, min_year: null, max_year: null, min_month: null, max_month: null };

  const fireTypes = await all<{ fire_type: string }>(
    `SELECT DISTINCT fire_type FROM read_parquet(${g}, hive_partitioning=false) ORDER BY fire_type`,
    []
  );

  const snppStart = await all<{ m: string | null }>(
    `SELECT min(utc_month) AS m FROM read_parquet(${g}, hive_partitioning=false)
     WHERE viirs_snpp_day_count IS NOT NULL OR viirs_snpp_night_count IS NOT NULL OR viirs_snpp_unknown_dn_count IS NOT NULL`,
    []
  );
  const harmStart = await all<{ m: string | null }>(
    `SELECT min(utc_month) AS m FROM read_parquet(${g}, hive_partitioning=false)
     WHERE harmonized_aqua_total_estimate IS NOT NULL`,
    []
  );

  const support = await all<{ status: string; rows: number }>(
    `SELECT coalesce(prediction_support_status, 'NULL') AS status, count(*) AS rows
     FROM read_parquet(${g}, hive_partitioning=false)
     GROUP BY 1 ORDER BY rows DESC LIMIT 12`,
    []
  );

  return {
    available: true,
    root: PARQUET_GLOB,
    rows: t.rows ?? null,
    min_year: t.min_year ?? null,
    max_year: t.max_year ?? null,
    min_month: t.min_month ?? null,
    max_month: t.max_month ?? null,
    fire_types: fireTypes.map((r) => r.fire_type),
    grid: { crs: 'EPSG:8857', resolution_m: 10_000, note: '10 km Equal Earth grid, origin (0,0); cells are detection aggregates, not fire perimeters.' },
    layers: {
      aqua: { description: 'Original MODIS Aqua detection counts (day/night/unknown-DN separate).', available_from: t.min_month ?? null },
      snpp: { description: 'Original VIIRS Suomi-NPP detection counts (day/night/unknown-DN separate).', available_from: snppStart[0]?.m ?? null },
      harmonized: { description: 'RF-B harmonized Aqua-scale estimates, approved joint-positive support only.', available_from: harmStart[0]?.m ?? null },
    },
    support_statuses: support,
    caveats: CAVEATS,
  };
}

export async function agniMonthlySeries(q: AgniQuery): Promise<AgniMonthRow[] | { error: string; scope: string }> {
  if (!available()) return [];
  const layer = q.layer ?? 'aqua';
  const daynight = q.daynight ?? 'known';
  if (layer === 'harmonized' && daynight === 'unknown') return [];

  const { count, frp } = measureExprs(layer, daynight);
  const { where, params, countryUnavailable } = buildFilters(q);
  // F31 fix: fail explicitly when the country mapping is missing; never return global rows.
  if (countryUnavailable) {
    return { error: 'Country lookup file is not available; cannot filter to the requested country scope.', scope: 'unavailable' };
  }
  const frpSelect = frp ? `sum(${frp}) AS frp_sum_mw,` : 'NULL AS frp_sum_mw,';

  const versionExpr = layer === 'aqua' ? "coalesce(aqua_version_day, 'UNKNOWN') || '/' || coalesce(aqua_version_night, 'UNKNOWN')"
    : layer === 'snpp' ? "coalesce(viirs_version_day, 'UNKNOWN') || '/' || coalesce(viirs_version_night, 'UNKNOWN')"
    : "coalesce(aqua_version_day, 'UNKNOWN') || '/' || coalesce(aqua_version_night, 'UNKNOWN') || '/' || coalesce(viirs_version_day, 'UNKNOWN') || '/' || coalesce(viirs_version_night, 'UNKNOWN') || '/' || coalesce(model_sha256, 'UNKNOWN')";
  const populationExpr = `(${versionExpr}) || '/' || coalesce(product_version_status, 'UNKNOWN')`;

  const rows = await all<{
    year: number;
    month: number;
    detections: number | null;
    frp_sum_mw: number | null;
    cells_with_data: number;
  }>(
    `SELECT year, month,
            sum(${count}) AS detections,
            string_agg(DISTINCT ${populationExpr}, ';' ORDER BY ${populationExpr}) FILTER (WHERE ${count} IS NOT NULL) AS population_key,
            ${frpSelect}
            count(DISTINCT cell_id) FILTER (WHERE ${count} IS NOT NULL) AS cells_with_data
     FROM read_parquet(${globSql()}, hive_partitioning=false) t
     WHERE ${where}
     GROUP BY year, month
     ORDER BY year, month`,
    params
  );

  return rows.map((r) => ({
    ...r,
    partial_coverage: isPartialCoverage(layer, r.year, r.month),
  }));
}

export async function agniTopCells(q: AgniQuery & { limit?: number }): Promise<AgniCellRow[] | { error: string; scope: string }> {
  if (!available()) return [];
  const layer = q.layer ?? 'aqua';
  const daynight = q.daynight ?? 'known';
  if (layer === 'harmonized' && daynight === 'unknown') return [];

  const { count, frp } = measureExprs(layer, daynight);
  const { where, params, countryUnavailable } = buildFilters(q);
  // F31 fix: same guard as agniMonthlySeries.
  if (countryUnavailable) {
    return { error: 'Country lookup file is not available; cannot filter to the requested country scope.', scope: 'unavailable' };
  }
  const limit = Math.min(Math.max(q.limit ?? 200, 1), 2000);
  const frpSelect = frp ? `sum(${frp}) AS frp_sum_mw,` : 'NULL AS frp_sum_mw,';

  const rows = await all<{
    cell_id: string;
    grid_row: number;
    grid_col: number;
    value: number | null;
    frp_sum_mw: number | null;
  }>(
    `SELECT cell_id, grid_row, grid_col,
            sum(${count}) AS value,
            ${frpSelect}
            count(*) AS n
     FROM read_parquet(${globSql()}, hive_partitioning=false) t
     WHERE ${where} AND ${count} IS NOT NULL
     GROUP BY cell_id, grid_row, grid_col
     ORDER BY value DESC NULLS LAST
     LIMIT ${limit}`,
    params
  );

  return rows.map((r) => {
    const ll = cellCenterLatLon(r.grid_row, r.grid_col);
    return { ...r, lon: ll.lon, lat: ll.lat };
  });
}

export interface AgniCellFeature {
  type: 'Feature';
  geometry: { type: 'Polygon'; coordinates: number[][][] };
  properties: Record<string, string | number | null>;
}

export interface AgniCellsGeoJSON {
  type: 'FeatureCollection';
  features: AgniCellFeature[];
  /** True when the cell list hit the limit — drawn cells are a top-N subset, not all activity. */
  truncated: boolean;
}

/**
 * GeoJSON polygons for the top cells of one month — for the map overlay.
 * Cell boundaries are approximated by the projected-grid corners; they are
 * detection aggregates, not fire perimeters.
 */
export async function agniCellsGeoJSON(q: AgniQuery & { limit?: number }): Promise<AgniCellsGeoJSON> {
  const limit = Math.min(Math.max(q.limit ?? 1000, 1), 2000);
  const rows = await agniTopCells({ ...q, limit });
  if (!Array.isArray(rows)) {
    return { type: 'FeatureCollection', features: [], truncated: false };
  }
  const features: AgniCellFeature[] = rows.map((r) => {
    const corners = cellCornersLatLon(r.grid_row, r.grid_col);
    const ring = [...corners.map((c) => [c.lon, c.lat]), [corners[0].lon, corners[0].lat]];
    return {
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [ring] },
      properties: {
        cell_id: r.cell_id,
        detections: r.value,
        frp_sum_mw: r.frp_sum_mw,
        center_lat: r.lat,
        center_lon: r.lon,
      },
    };
  });
  return { type: 'FeatureCollection', features, truncated: rows.length >= limit };
}

/** Month x year matrix for the calendar UI; same rows as the series, pivoted client-side. */
export async function agniCalendar(q: AgniQuery): Promise<AgniMonthRow[] | { error: string; scope: string }> {
  return agniMonthlySeries(q);
}

export async function agniIntelligence(q: AgniQuery & { year: number }) {
  const series = await agniMonthlySeries({ ...q, year: undefined, month: undefined });
  if (!Array.isArray(series)) return { error: series.error, scope: series.scope };
  const rows = series;
  return {
    target_year: q.year,
    comparisons: Array.from({ length: 12 }, (_, i) => compareAgniMonth(rows, q.year, i + 1)),
    season: agniSeason(rows, q.year),
    method: 'Same layer, DN, fire type, AOI and exact reported product-version population signature; target year excluded; >=5 non-null non-partial years; empirical percentile uses half weight for ties; unusual <=5th or >=95th percentile.',
    limitation: 'EXPLORATORY descriptive comparison. Product versions and sparse observed-cell populations can change across years. Exposure/complete coverage is not established; no forecast or validated anomaly claim.',
  };
}

/** Local policy evidence only; never load or alter serialized estimators. */
export function agniProvenance() {
  const file = path.join(DATASET_DIR, '..', 'deployment_policy.json');
  if (!fs.existsSync(file)) return { available: false, model_id: null, validation_metrics: null, reason: 'Deployment policy not available.' };
  const p = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { available: true, model_id: p.model_id, reference_sensor: p.reference_sensor, predictor_sensor: p.predictor_sensor,
    policy_id: p.policy_id, training_years: p.training_years, population: p.population, evaluated_version_pairs: p.evaluated_version_pairs,
    artifacts: p.artifacts.map((a: { day_night: string; sha256: string }) => ({ day_night: a.day_night, sha256: a.sha256 })),
    model_pair_sha256: p.model_pair_sha256, validation_metrics: null,
    reason: 'Original Phase C final registry and validation metrics are not bundled here. Integrity/reproduction checks do not establish accuracy.',
    product_status_policy: p.product_status_policy, missing_value_policy: p.missing_value_policy, floor_policy: p.floor_policy,
  };
}

/** Same approved support population for observations and estimates, DN kept separate. */
export async function agniSensorComparison(q: AgniQuery) {
  if (!available()) return [];
  const { where, params } = buildFilters(q);
  const out = [];
  for (const dn of ['day', 'night'] as const) {
    const approved = `prediction_support_status_${dn} = 'APPROVED_CONDITIONAL_JOINT_POSITIVE'`;
    const rows = await all<Record<string, unknown>>(`SELECT
      sum(modis_aqua_${dn}_count) AS aqua_all_observed,
      sum(viirs_snpp_${dn}_count) AS snpp_all_observed,
      sum(model_eligible_aqua_${dn}_count) FILTER (WHERE ${approved}) AS aqua_supported,
      sum(model_eligible_viirs_${dn}_count) FILTER (WHERE ${approved}) AS snpp_supported,
      sum(harmonized_aqua_${dn}_estimate) FILTER (WHERE ${approved}) AS aqua_equivalent_estimate,
      sum(modis_aqua_${dn}_frp_sum) AS aqua_frp_sum_mw,
      sum(viirs_snpp_${dn}_frp_sum) AS snpp_frp_sum_mw,
      count(*) FILTER (WHERE ${approved}) AS supported_cell_month_types,
      count(*) AS source_cell_month_types,
      string_agg(DISTINCT aqua_version_${dn}, '; ') AS aqua_versions,
      string_agg(DISTINCT viirs_version_${dn}, '; ') AS snpp_versions,
      string_agg(DISTINCT product_version_status, '; ') AS product_status,
      string_agg(DISTINCT source_quality_flags, '; ') AS quality_flags
      FROM read_parquet(${globSql()}, hive_partitioning=false) t WHERE ${where}`, params);
    out.push({ daynight: dn, ...rows[0] });
  }
  return out;
}

export function agniSeriesCsv(rows: AgniMonthRow[], q: AgniQuery = {}): string {
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [
    '# grain=regional UTC-month aggregates; not individual detections',
    `# layer=${q.layer ?? 'aqua'}; daynight=${q.daynight ?? 'known'}; fire_type=${q.fireType ?? '0'}; harmonized=EXPLORATORY supported estimates only`,
    `# scope=${JSON.stringify({ country: q.country ?? null, scope: q.scope ?? null, polygon: q.polygon ?? null }).replace(/[\r\n]/g, ' ')}`,
    '# source=Round2 frozen Parquet; null=unknown; no NRT; grid=EPSG:8857 10000m; country=majority-vote; AOI=cell centre',
    '# model=RANDOM_FOREST_B; predictions require APPROVED_CONDITIONAL_JOINT_POSITIVE per selected DN; cells_with_data is support, not exposure; raw sensors never added',
    `# exported_at=${new Date().toISOString()}`,
    'year,month,detections,frp_sum_mw,cells_with_data,partial_coverage,product_population',
    ...rows.map((r) =>
      [r.year, r.month, r.detections, r.frp_sum_mw, r.cells_with_data, r.partial_coverage, r.population_key]
        .map(esc)
        .join(',')
    ),
  ];
  return lines.join('\n') + '\n';
}

/** Stream one selected UTC month without materializing the grid-cell export. */
export async function* agniCellMonthCsv(q: AgniQuery): AsyncGenerator<string> {
  if (!available()) throw new Error('Round 2 dataset unavailable.');
  if (!q.year || !q.month) throw new Error('Select a year and month for grid-cell export.');
  const { count, frp } = measureExprs(q.layer ?? 'aqua', q.daynight ?? 'known');
  const { where, params } = buildFilters(q);
  const columns = ['cell_id', 'year', 'month', 'fire_type', 'value', 'frp_sum_mw', 'model_id', 'prediction_support_status_day', 'prediction_support_status_night', 'model_sha256', 'source_quality_flags', 'product_version_status'];
  const stream = getConnection().stream(`SELECT cell_id, year, month, fire_type, ${count} AS value, ${frp ?? 'NULL'} AS frp_sum_mw, model_id, prediction_support_status_day, prediction_support_status_night, model_sha256, source_quality_flags, product_version_status FROM read_parquet(${globSql()}, hive_partitioning=false) t WHERE ${where}`, ...params);
  yield agniSeriesCsv([], q).split('year,month,detections')[0] + '# grain=cell_id x UTC_month x fire_type; value is selected layer/DN; NULL stays blank; no observation-level hotspot claim\n' + columns.join(',') + '\n';
  let batch = '';
  for await (const raw of stream) {
    const row = deepBigIntToNumber(raw);
    batch += columns.map((key) => sanitizeCsvCell(row[key])).join(',') + '\n';
    if (batch.length >= 64 * 1024) { yield batch; batch = ''; }
  }
  if (batch) yield batch;
}

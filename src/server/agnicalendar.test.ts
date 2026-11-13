/** Isolated temporary Parquet fixtures, never production observations. */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parquetDatasetDirectory, parquetSqlPath } from './dataPaths';
import os from 'node:os';
import path from 'node:path';
import duckdb from 'duckdb';
const dir = mkdtempSync(path.join(os.tmpdir(), 'agni-unit-')).replaceAll('\\', '/');
process.env.FIRESYNC_AGNICALENDAR_PARQUET = `${dir}/*.parquet`;
process.env.FIRESYNC_AGNI_CELL_COUNTRY = `${dir}/absent-country.parquet`;
const db = new duckdb.Database(':memory:');
await new Promise<void>((resolve, reject) => db.run(`COPY (
  SELECT 2020+i::INTEGER AS year, 3 AS month, 'fixture' AS cell_id, 0 AS grid_row, 0 AS grid_col, '0' AS fire_type,
  10+i::BIGINT AS modis_aqua_day_count, 2::BIGINT AS modis_aqua_night_count,
  5.0 AS modis_aqua_day_frp_sum, '6.1' AS aqua_version_day, '6.1' AS aqua_version_night,
  'UNKNOWN' AS product_version_status FROM range(6) t(i)
) TO '${dir}/fixture.parquet' (FORMAT PARQUET)`, (e) => e ? reject(e) : resolve()));
db.close();
const { agniMonthlySeries, agniTopCells, agniSeriesCsv, agniIntelligence, agniProvenance, closeAgniConnection } = await import('./agnicalendar');
// Native DuckDB retains Windows Parquet handles until process exit. Keep the tiny
// fixture in OS temp; never delete input files while native queries may own them.
after(async () => { await closeAgniConnection(); });

test('explicit year overrides full calendar range in series and cell queries', async () => {
  const q = { year: 2025, month: 3, startYear: 2020, endYear: 2025, daynight: 'day' as const };
  const rowsRes = await agniMonthlySeries(q);
  if (!Array.isArray(rowsRes)) assert.fail('expected series rows');
  assert.equal(rowsRes.length, 1);
  assert.equal(rowsRes[0].detections, 15);
  const cellsRes = await agniTopCells(q);
  if (!Array.isArray(cellsRes)) assert.fail('expected cell rows');
  assert.equal(cellsRes[0].value, 15);
});
test('exact bbox and polygon use cell centre and fail closed on missing country lookup', async () => {
  const q = { year: 2025, month: 3, daynight: 'day' as const };
  const insideRes = await agniMonthlySeries({ ...q, scope: { kind: 'bbox', bbox: { west: -1, south: -1, east: 1, north: 1 } } });
  if (!Array.isArray(insideRes)) assert.fail('expected series rows');
  assert.equal(insideRes[0].detections, 15);
  const outsideRes = await agniMonthlySeries({ ...q, polygon: [[10, 10], [11, 10], [10, 11]] });
  if (!Array.isArray(outsideRes)) assert.fail('expected series rows');
  assert.equal(outsideRes.length, 0);
  const missing = await agniMonthlySeries({ ...q, country: 'Unavailable' });
  assert.ok(!Array.isArray(missing), 'missing country lookup must return an explicit error, not global rows');
  assert.match((missing as { error: string }).error, /Country lookup/);
});
test('intelligence uses five other years and exact version population', async () => {
  const result = await agniIntelligence({ year: 2025, startYear: 2020, endYear: 2025, daynight: 'day' });
  if ('error' in result) assert.fail('unexpected agnicalendar error');
  const c = result.comparisons[2];
  assert.equal(c.baseline_median, 12);
  assert.equal(c.valid_years, 5);
  assert.equal(c.percentile, 100);
});
test('CSV is monthly aggregates with scope and missing-value metadata; absent policy stays unavailable', () => {
  const csv = agniSeriesCsv([{ year: 2025, month: 3, detections: null, frp_sum_mw: null, cells_with_data: 0, partial_coverage: false }], { layer: 'aqua', country: 'Example' });
  assert.match(csv, /not individual detections/);
  assert.match(csv, /layer=aqua/);
  assert.match(csv, /null=unknown/);
  assert.match(csv, /2025,3,,,0,false/);
  assert.equal(agniProvenance().available, false);
});

test('dataset roots accept Windows separators and preserve relative or absolute scopes', () => {
  assert.equal(parquetDatasetDirectory("C:\\Team's data\\AgniCalendar\\year=*\\part-*.parquet"), "C:/Team's data/AgniCalendar");
  assert.equal(parquetDatasetDirectory('/mnt/fire data/year=*/part-*.parquet'), '/mnt/fire data');
  assert.equal(parquetDatasetDirectory('local/*.parquet'), 'local');
  assert.equal(parquetDatasetDirectory('part.parquet'), '.');
  assert.equal(parquetDatasetDirectory('year=*/part-*.parquet'), '.');
  assert.equal(parquetDatasetDirectory('/year=*/part-*.parquet'), '/');
  assert.equal(parquetDatasetDirectory('C:\\year=*\\part-*.parquet'), 'C:/');
});

test('SQL filenames preserve spaces and quote characters as literal path text', () => {
  assert.equal(parquetSqlPath("C:\\Team's data\\part.parquet"), "'C:/Team''s data/part.parquet'");
  assert.equal(parquetSqlPath("data/a';SELECT 1;--.parquet"), "'data/a'';SELECT 1;--.parquet'");
});

test('DuckDB reads a real isolated Parquet file in a quoted directory', async () => {
  const quotedDir = path.join(dir, "O'Neil data");
  mkdirSync(quotedDir);
  const filename = path.join(quotedDir, 'fixture.parquet');
  const localDb = new duckdb.Database(':memory:');
  const query = (sql: string) => new Promise<any[]>((resolve, reject) =>
    localDb.all(sql, (e: Error | null, rows: any[]) => e ? reject(e) : resolve(rows)));
  try {
    await query('COPY (SELECT 7::INTEGER AS value) TO ' + parquetSqlPath(filename) + ' (FORMAT PARQUET)');
    assert.equal(existsSync(filename), true);
    const rows = await query('SELECT value FROM read_parquet(' + parquetSqlPath(path.join(quotedDir, '*.parquet')) + ')');
    assert.equal(rows[0].value, 7);
  } finally {
    await new Promise<void>((resolve, reject) => localDb.close((e) => e ? reject(e) : resolve()));
  }
});

// Python and DuckDB are optional app prerequisites. The builder contract below
// uses a mock DuckDB connection and real temporary path discovery, never the
// team's archive or model files.
const pythonAvailable = spawnSync('python', ['--version'], { timeout: 5000 }).status === 0;
const countryPathCheck = `
import glob, importlib.util, os, sys, tempfile, types
from pathlib import Path
sys.dont_write_bytecode = True
source, mode = sys.argv[1:]
calls = []
class Connection:
    def execute(self, sql):
        calls.append(sql)
        return self
    def fetchone(self):
        return (1, 1, 0, 0, 0, 0)
sys.modules['duckdb'] = types.SimpleNamespace(connect=lambda: Connection())
previous = os.getcwd()
with tempfile.TemporaryDirectory(prefix='firesync-country-path-') as temp:
    try:
        os.chdir(temp)
        custom = Path(temp) / "O'Neil data"
        fixture = custom / 'obs' / 'sensor=MODIS' / 'year=2025' / 'data_fixture.parquet'
        fixture.parent.mkdir(parents=True)
        fixture.write_bytes(b'ISOLATED PATH TEST; NOT OBSERVATIONS')
        pattern = str(fixture.parent / 'data_*.parquet')
        os.environ['FIRESYNC_AGNI_CELL_COUNTRY'] = "country's lookup.parquet"
        os.environ.pop('FIRESYNC_HISTORICAL_OBS', None)
        os.environ['FIRESYNC_HISTORICAL_PARQUET'] = str(custom)
        if mode == 'override':
            os.environ['FIRESYNC_HISTORICAL_PARQUET'] = str(custom / 'wrong-root')
            os.environ['FIRESYNC_HISTORICAL_OBS'] = pattern
        if mode == 'missing':
            Path('data/historical/parquet/obs').mkdir(parents=True)
            os.environ['FIRESYNC_HISTORICAL_OBS'] = str(custom / 'absent' / '*.parquet')
        spec = importlib.util.spec_from_file_location('country_builder_path_test', source)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        result = module.main()
        if mode == 'missing':
            assert result == 1
            assert calls == [], 'missing configured data must not query a different store'
        else:
            assert result == 0
            assert "O''Neil data" in calls[2]
            assert "TO 'country''s lookup.parquet'" in calls[2]
            assert [Path(item) for item in glob.glob(module.OBS_GLOB)] == [fixture]
            if mode == 'override':
                assert pattern.replace(chr(92), '/') == module.OBS_GLOB
        print('path-contract-ok')
    finally:
        os.chdir(previous)
`;

for (const mode of ['override', 'derived', 'missing']) {
  test('country builder configured paths: ' + mode, { skip: !pythonAvailable }, () => {
    const result = spawnSync('python', ['-c', countryPathCheck,
      fileURLToPath(new URL('../../data_pipeline/build_agni_country.py', import.meta.url)), mode],
    { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stdout, /path-contract-ok/);
  });
}

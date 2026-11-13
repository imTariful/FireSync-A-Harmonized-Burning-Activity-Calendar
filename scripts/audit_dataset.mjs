// Read-only audit: no ingestion, duplicate detection, aggregation outputs or model loading.
import duckdb from 'duckdb';
import fs from 'node:fs';
import os from 'node:os';
import { createHash } from 'node:crypto';
const db = new duckdb.Database(':memory:');
const c = db.connect();
const query = (sql) => new Promise((resolve, reject) => c.all(sql, (e, r) => e ? reject(e) : resolve(r)));
const root = 'Harmonized Data Set';
const glob = `${root}/AgniCalendar_Global_Harmonized_CellMonth/year=*/part-*.parquet`;
const out = { date: '2026-11-12', hardware: { cpu: os.cpus()[0]?.model, logical_cpus: os.cpus().length, total_memory: os.totalmem(), free_memory: os.freemem(), os: os.release() }, checks: {} };
try {
  await query('SET threads=2');
  await query("SET memory_limit='1GB'");
  out.schema = await query(`DESCRIBE SELECT * FROM read_parquet('${glob}', hive_partitioning=false)`);
  out.partitions = await query(`SELECT file_name, num_rows, num_row_groups FROM parquet_file_metadata('${glob}')`);
  out.sample = await query(`SELECT cell_id, utc_month, grid_crs, grid_resolution_m, model_id, model_sha256, product_version_status, source_quality_flags, prediction_support_status_day FROM read_parquet('${root}/AgniCalendar_Global_Harmonized_CellMonth/year=2025/*.parquet', hive_partitioning=false) LIMIT 2`);
  const policy = JSON.parse(fs.readFileSync(`${root}/deployment_policy.json`, 'utf8'));
  out.model_artifacts = policy.artifacts.map((a) => {
    const local = `${root}/models/RANDOM_FOREST_B/${a.day_night}.joblib`;
    const hash = createHash('sha256').update(fs.readFileSync(local)).digest('hex');
    return { day_night: a.day_night, local, sha256: hash, matches: hash === a.sha256 };
  });
  out.benchmarks = [];
  for (const threads of [1, 2, 4]) {
    await query(`SET threads=${threads}`);
    const start = performance.now();
    const rows = await query(`SELECT year, month, sum(modis_aqua_day_count) AS detections FROM read_parquet('${glob}', hive_partitioning=false) WHERE year=2025 AND fire_type='0' GROUP BY year, month ORDER BY month`);
    out.benchmarks.push({ threads, ms: performance.now() - start, rows: rows.length, first: rows[0], memory: process.memoryUsage(), peak_rss_kb: process.resourceUsage().maxRSS });
  }
} finally {
  fs.mkdirSync('reports/audit', { recursive: true });
  fs.writeFileSync('reports/audit/dataset-inspection.json', JSON.stringify(out, (_, v) => typeof v === 'bigint' ? Number(v) : v, 2));
  c.close(); db.close();
}
console.log(JSON.stringify({ fields: out.schema?.length, partitions: out.partitions?.length, artifacts: out.model_artifacts, benchmarks: out.benchmarks }, (_, v) => typeof v === 'bigint' ? Number(v) : v));

#!/usr/bin/env python3
"""
Build the FireSync historical analytics store from staging CSV.gz files.

Reads every `data/historical/staging/*.csv.gz` produced by `import_historical.py`,
deduplicates on the natural FIRMS key, and writes:

  data/historical/parquet/obs/sensor=<S>/year=<Y>/data_<n>.parquet   raw observations
  data/historical/parquet/agg/daily_<S>_<Y>.parquet                  per-day x country x sensor
  data/historical/parquet/agg/monthly_<S>_<Y>.parquet                per-month x country x sensor
  data/historical/parquet/agg/coverage_<S>_<Y>.parquet               dates with any rows (sensor level)
  data/historical/build_report.json                                 per-file row counts + timing

MODIS and VIIRS stay in separate partitions; counts are never merged into one
"fire count". All processing is streaming/bounded-memory via DuckDB.

Usage:
    python data_pipeline/build_historical_db.py                # all staging files
    python data_pipeline/build_historical_db.py --sensor modis # one sensor
    python data_pipeline/build_historical_db.py --limit 2      # pilot
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import sys
import time
from typing import Any, Dict, List, Optional

import duckdb

STAGING_DIR = os.environ.get("FIRESYNC_HISTORICAL_STAGING", "data/historical/staging")
PARQUET_DIR = os.environ.get("FIRESYNC_HISTORICAL_PARQUET", "data/historical/parquet")
REPORT_PATH = os.path.join(PARQUET_DIR, "build_report.json")

OBS_DIR = os.path.join(PARQUET_DIR, "obs")
AGG_DIR = os.path.join(PARQUET_DIR, "agg")

# Explicit types: acq_time "0016" must stay a string, never become integer 16.
COLUMN_TYPES = {
    "country": "VARCHAR", "sensor": "VARCHAR", "year": "INTEGER", "month": "INTEGER",
    "source_zip": "VARCHAR", "source_record_number": "INTEGER",
    "latitude": "DOUBLE", "longitude": "DOUBLE",
    "brightness": "DOUBLE", "bright_t31": "DOUBLE",
    "bright_ti4": "DOUBLE", "bright_ti5": "DOUBLE",
    "scan": "DOUBLE", "track": "DOUBLE",
    "acq_date": "VARCHAR", "acq_time": "VARCHAR",
    "satellite": "VARCHAR", "instrument": "VARCHAR",
    "confidence": "VARCHAR", "version": "VARCHAR",
    "frp": "DOUBLE", "daynight": "VARCHAR", "firms_type": "VARCHAR",
}

# Read every column as VARCHAR first; empty strings become NULL during the cast
# below. This avoids DuckDB's CSV sniffer re-typing fields like acq_time "0016"
# into integers and keeps absent sensor-specific brightness columns as NULL.
VARCHAR_COLS = {k: "VARCHAR" for k in COLUMN_TYPES}

DOUBLE_COLS = ["latitude", "longitude", "brightness", "bright_t31", "bright_ti4",
               "bright_ti5", "scan", "track", "frp"]
INT_COLS = ["year", "month", "source_record_number"]


def staging_files(sensor: Optional[str]) -> List[str]:
    pattern = os.path.join(STAGING_DIR, "*.csv.gz")
    files = sorted(glob.glob(pattern))
    if sensor:
        prefix = f"{sensor.lower()}_"
        files = [f for f in files if os.path.basename(f).startswith(prefix)]
    return files


def staging_sensor_year(path: str) -> tuple[str, int]:
    base = os.path.basename(path)
    sensor, rest = base.split("_", 1)
    year = int(rest.split("__", 1)[0])
    return sensor.upper(), year


def build_one(con: duckdb.DuckDBPyConnection, path: str) -> Dict[str, Any]:
    """Build the parquet partition for a single staging file.

    NOTE: Call build_group() instead of this function when multiple staging
    files share the same (sensor, year) pair. Calling build_one() twice for
    the same sensor+year would overwrite data_0.parquet with only the second
    file's rows (F01). build_group() merges them before writing.
    """
    return build_group(con, [path])


def build_group(con: duckdb.DuckDBPyConnection, paths: List[str]) -> Dict[str, Any]:
    """F01 fix: build the parquet partition for ALL staging files sharing one (sensor, year).

    Reading all group members in a single UNION ALL before dedup ensures no
    file's rows are silently overwritten by a later file in the same partition.
    """
    if not paths:
        raise ValueError("build_group called with empty paths list")

    # All files in the group must share the same sensor and year.
    sensor, year = staging_sensor_year(paths[0])
    for p in paths[1:]:
        s, y = staging_sensor_year(p)
        if s != sensor or y != year:
            raise ValueError(f"build_group: mixed sensor/year in group: {paths}")

    t0 = time.time()
    cols = ", ".join(f"'{k}': '{v}'" for k, v in VARCHAR_COLS.items())

    cast_exprs = []
    for name in COLUMN_TYPES:
        col = f'"{name}"'
        if name in DOUBLE_COLS:
            cast_exprs.append(f"try_cast(nullif({col}, '') AS DOUBLE) AS {col}")
        elif name in INT_COLS:
            cast_exprs.append(f"try_cast(nullif({col}, '') AS INTEGER) AS {col}")
        else:
            cast_exprs.append(f"nullif({col}, '') AS {col}")
    cast_sql = ",\n            ".join(cast_exprs)

    # Build a UNION ALL of all files in the group so rows from every source
    # file are present before deduplication.
    union_parts = []
    all_params: List[str] = []
    for p in paths:
        union_parts.append(f"""
        SELECT {cast_sql}
        FROM read_csv(?,
            header=true, compression='gzip',
            columns={{{cols}}},
            ignore_errors=false
        )""")
        all_params.append(p)
    union_sql = "\nUNION ALL".join(union_parts)

    con.execute(f"""
        CREATE OR REPLACE TEMP TABLE staged AS
        {union_sql}
    """, all_params)

    rows_in = con.execute("SELECT count(*) FROM staged").fetchone()[0]

    # Natural-key dedupe: same sensor/satellite/position/date/time/country is one
    # observation; keep the lowest source_record_number deterministically.
    con.execute("""
        CREATE OR REPLACE TEMP TABLE dedup AS
        SELECT * EXCLUDE (_rn) FROM (
            SELECT *, row_number() OVER (
                PARTITION BY sensor, satellite, country, latitude, longitude,
                             acq_date, acq_time
                ORDER BY source_record_number NULLS LAST, source_zip
            ) AS _rn
            FROM staged
        ) WHERE _rn = 1
    """)
    rows_out = con.execute("SELECT count(*) FROM dedup").fetchone()[0]

    # Raw observations -> hive-partitioned parquet (sensor=, year=).
    obs_part = os.path.join(OBS_DIR, f"sensor={sensor}", f"year={year}")
    os.makedirs(obs_part, exist_ok=True)
    out_glob = os.path.join(obs_part, "data_*.parquet")
    for old in glob.glob(out_glob):
        os.remove(old)
    con.execute(f"""
        COPY (SELECT * FROM dedup) TO '{obs_part}/data_0.parquet' (FORMAT PARQUET, COMPRESSION ZSTD)
    """)

    # Aggregates: daily and monthly at country x sensor granularity.
    # Sensor is already the partition column; keep it in the row for portability.
    for period, col in (("daily", "acq_date"), ("monthly", "strftime(try_cast(acq_date AS DATE), '%Y-%m')")):
        agg_file = os.path.join(AGG_DIR, f"{period.lower()}_{sensor}_{year}.parquet")
        os.makedirs(AGG_DIR, exist_ok=True)
        con.execute(f"""
            COPY (
                SELECT
                    {col} AS period,
                    country,
                    sensor,
                    count(*) AS detections,
                    sum(frp) AS frp_sum_mw,
                    max(frp) AS frp_max_mw,
                    avg(frp) AS frp_mean_mw,
                    count(*) FILTER (WHERE daynight = 'D') AS day_count,
                    count(*) FILTER (WHERE daynight = 'N') AS night_count,
                    count(DISTINCT satellite) AS satellites_seen,
                    count(DISTINCT version) AS versions_seen,
                    min(acq_time) AS first_acq_time,
                    max(acq_time) AS last_acq_time
                FROM dedup
                GROUP BY 1, 2, 3
                ORDER BY 1, 2
            ) TO '{agg_file}' (FORMAT PARQUET, COMPRESSION ZSTD)
        """)

    # Coverage: which dates have ANY rows for this sensor-year (global, not per country).
    cov_file = os.path.join(AGG_DIR, f"coverage_{sensor}_{year}.parquet")
    con.execute(f"""
        COPY (
            SELECT acq_date AS date, sensor, count(*) AS global_rows
            FROM dedup GROUP BY 1, 2 ORDER BY 1
        ) TO '{cov_file}' (FORMAT PARQUET, COMPRESSION ZSTD)
    """)

    dt = time.time() - t0
    return {
        # Report the group as a list of staging paths; keeps backward compat
        # when the group has exactly one file (the common case).
        "staging": paths[0] if len(paths) == 1 else paths,
        "staging_files": paths,
        "sensor": sensor,
        "year": year,
        "rows_in": rows_in,
        "rows_deduped": rows_out,
        "duplicates_removed": rows_in - rows_out,
        "seconds": round(dt, 1),
        "obs_parquet": obs_part,
    }


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Build historical parquet + aggregates")
    parser.add_argument("--sensor", choices=["modis", "viirs"], default=None)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--only", default=None, help="substring filter on staging filename")
    args = parser.parse_args(argv)

    files = staging_files(args.sensor)
    if args.only:
        files = [f for f in files if args.only.lower() in os.path.basename(f).lower()]
    if args.limit:
        files = files[: args.limit]
    if not files:
        print("[build] no staging files found")
        return 1
    print(f"[build] {len(files)} staging files")

    con = duckdb.connect()
    con.execute("SET threads TO 4")
    con.execute("SET memory_limit='6GB'")

    # Merge with any prior report so partial/filtered rebuilds (--only, --sensor)
    # update their entries instead of erasing the record of the other files.
    prior_files: List[Dict[str, Any]] = []
    if os.path.exists(REPORT_PATH):
        try:
            with open(REPORT_PATH) as fh:
                prior_files = [f for f in json.load(fh).get("files", []) if isinstance(f, dict)]
        except Exception:
            prior_files = []
    report: Dict[str, Any] = {"files": prior_files, "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}

    # F01 fix: group staging files by (sensor, year) so all files for the same
    # partition are merged in one pass. Without grouping, the second file for
    # a sensor+year would overwrite the first file's data_0.parquet.
    from collections import defaultdict
    groups: Dict[tuple, List[str]] = defaultdict(list)
    for path in files:
        key = staging_sensor_year(path)  # (sensor, year)
        groups[key].append(path)
    # Sort groups deterministically so the build order is stable across runs.
    sorted_groups = sorted(groups.items())
    n_groups = len(sorted_groups)

    for i, ((_sensor, _year), group_paths) in enumerate(sorted_groups, 1):
        group_label = f"sensor={_sensor} year={_year} ({len(group_paths)} file(s))"
        rec = None
        # Windows file locks (e.g. a running server's DuckDB connection) can hold
        # an agg parquet for a few seconds; retry the whole group before failing.
        for attempt in range(3):
            try:
                rec = build_group(con, group_paths)
                break
            except Exception as exc:
                if attempt < 2:
                    print(f"[build] retry {attempt + 1}/2 {group_label}: {exc}", flush=True)
                    time.sleep(15)
                    continue
                rec = {"staging": group_paths, "staging_files": group_paths,
                       "sensor": _sensor, "year": _year,
                       "status": "failed", "error": str(exc)}
                print(f"[build] FAILED {group_label}: {exc}", flush=True)
        # Remove any prior entries for this group's files from the report, then append.
        prior_stagings = set(group_paths)
        report["files"] = [
            f for f in report["files"]
            if not (
                (isinstance(f.get("staging"), list) and set(f["staging"]) == prior_stagings)
                or f.get("staging") in prior_stagings
            )
        ]
        report["files"].append(rec)
        print(
            f"[build] {i}/{n_groups} {group_label}: "
            f"{rec.get('rows_deduped', 0):,} rows ({rec.get('duplicates_removed', 0):,} dup) "
            f"{rec.get('seconds', 0)}s",
            flush=True,
        )
        # Persist incremental progress so a crash does not lose the report.
        report["total_rows_in"] = sum(f.get("rows_in") or 0 for f in report["files"])
        report["total_rows_deduped"] = sum(f.get("rows_deduped") or 0 for f in report["files"])
        report["finished_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        os.makedirs(PARQUET_DIR, exist_ok=True)
        tmp = REPORT_PATH + ".tmp"
        with open(tmp, "w") as fh:
            json.dump(report, fh, indent=1)
        os.replace(tmp, REPORT_PATH)

    print(
        f"[build] done: {report['total_rows_deduped']:,} observations "
        f"from {report['total_rows_in']:,} rows"
    )
    # Return nonzero when any file failed so downstream CI/pipeline steps are blocked.
    any_failed = any(f.get("status") == "failed" for f in report["files"])
    return 1 if any_failed else 0


if __name__ == "__main__":
    sys.exit(main())

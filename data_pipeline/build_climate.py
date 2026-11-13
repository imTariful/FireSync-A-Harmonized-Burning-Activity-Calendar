#!/usr/bin/env python3
"""
Build FireSync climatology aggregates from the historical parquet store.

Reads the existing obs/ and agg/ parquet files (no re-scan of source ZIPs) and
writes two new aggregate families:

  data/historical/parquet/agg/climate_<SENSOR>.parquet
      1-degree grid cell x calendar month x year -> detections, frp_sum_mw
      Used for bounding-box (map region) seasonal climatology. Cells are
      assigned by floor(latitude/longitude); a bbox query includes cells whose
      center falls inside the box (boundary approximation, documented).

  data/historical/parquet/agg/climate_country_<SENSOR>.parquet
      country x day-of-year x year -> detections, frp_sum_mw
      Used for daily-resolution "current period vs typical" seasonal alerts
      at country scope (the archive is country-partitioned; arbitrary polygons
      cannot be resolved to countries).

MODIS and VIIRS are built as separate files and are never merged. All counts
are satellite thermal anomalies, not confirmed wildfires.

Usage:
    python data_pipeline/build_climate.py              # both sensors
    python data_pipeline/build_climate.py --sensor modis
"""

from __future__ import annotations

import argparse
import glob
import os
import sys
import time

import duckdb

PARQUET_DIR = os.environ.get("FIRESYNC_HISTORICAL_PARQUET", "data/historical/parquet")
OBS_DIR = os.path.join(PARQUET_DIR, "obs")
AGG_DIR = os.path.join(PARQUET_DIR, "agg")

SENSORS = ["MODIS", "VIIRS"]


def parquet_glob(pattern: str) -> str:
    files = sorted(glob.glob(pattern))
    if not files:
        raise FileNotFoundError(f"no parquet files match {pattern}")
    # DuckDB accepts a list literal; single quotes inside paths are escaped.
    return "[" + ", ".join("'" + f.replace("\\", "/").replace("'", "''") + "'" for f in files) + "]"


def build_grid(con: duckdb.DuckDBPyConnection, sensor: str) -> dict:
    """1-degree grid x month x year detection climatology from raw observations."""
    t0 = time.time()
    obs_glob = os.path.join(OBS_DIR, f"sensor={sensor}", "year=*", "data_*.parquet").replace("\\", "/")
    files = sorted(glob.glob(obs_glob.replace("/", os.sep)))
    if not files:
        return {"sensor": sensor, "kind": "grid", "status": "skipped", "reason": "no obs files"}
    lst = "[" + ", ".join("'" + f.replace("\\", "/") + "'" for f in files) + "]"
    out = os.path.join(AGG_DIR, f"climate_{sensor}.parquet")
    con.execute(f"""
        COPY (
            SELECT
                floor(latitude)::INTEGER  AS glat,
                floor(longitude)::INTEGER AS glon,
                month::INTEGER            AS month,
                year::INTEGER             AS year,
                count(*)                  AS detections,
                sum(frp)                  AS frp_sum_mw
            FROM read_parquet({lst}, hive_partitioning=false)
            WHERE latitude IS NOT NULL AND longitude IS NOT NULL
            GROUP BY 1, 2, 3, 4
        ) TO '{out.replace(chr(92), '/')}' (FORMAT PARQUET, COMPRESSION ZSTD)
    """)
    n = con.execute(f"SELECT count(*) FROM read_parquet('{out.replace(chr(92), '/')}')").fetchone()[0]
    return {"sensor": sensor, "kind": "grid", "rows": n, "seconds": round(time.time() - t0, 1), "out": out}


def build_country_doy(con: duckdb.DuckDBPyConnection, sensor: str) -> dict:
    """country x day-of-year x year climatology from the daily aggregates."""
    t0 = time.time()
    files = sorted(glob.glob(os.path.join(AGG_DIR, f"daily_{sensor}_*.parquet")))
    if not files:
        return {"sensor": sensor, "kind": "country_doy", "status": "skipped", "reason": "no daily agg files"}
    lst = "[" + ", ".join("'" + f.replace("\\", "/") + "'" for f in files) + "]"
    out = os.path.join(AGG_DIR, f"climate_country_{sensor}.parquet")
    con.execute(f"""
        COPY (
            SELECT
                country,
                dayofyear(try_cast(period AS DATE)) AS doy,
                CAST(substr(period, 1, 4) AS INTEGER) AS year,
                sum(detections) AS detections,
                sum(frp_sum_mw) AS frp_sum_mw
            FROM read_parquet({lst}, hive_partitioning=false)
            GROUP BY 1, 2, 3
        ) TO '{out.replace(chr(92), '/')}' (FORMAT PARQUET, COMPRESSION ZSTD)
    """)
    n = con.execute(f"SELECT count(*) FROM read_parquet('{out.replace(chr(92), '/')}')").fetchone()[0]
    return {"sensor": sensor, "kind": "country_doy", "rows": n, "seconds": round(time.time() - t0, 1), "out": out}


def main() -> int:
    parser = argparse.ArgumentParser(description="Build climatology aggregates")
    parser.add_argument("--sensor", choices=[s.lower() for s in SENSORS], default=None)
    args = parser.parse_args()

    sensors = [args.sensor.upper()] if args.sensor else SENSORS
    os.makedirs(AGG_DIR, exist_ok=True)
    con = duckdb.connect()
    con.execute("SET threads TO 4")
    con.execute("SET memory_limit='6GB'")

    results = []
    for sensor in sensors:
        for kind, fn in (("grid", build_grid), ("country_doy", build_country_doy)):
            try:
                rec = fn(con, sensor)
            except Exception as exc:
                rec = {"sensor": sensor, "kind": kind, "status": "failed", "error": str(exc)}
                print(f"[climate] FAILED {sensor} {kind}: {exc}", flush=True)
            print(f"[climate] {rec}", flush=True)
            results.append(rec)

    failed = [r for r in results if r.get("status") == "failed"]
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Build the AgniCalendar cell -> country lookup.

The harmonized dataset has no country column (10 km EPSG:8857 cells only).
This script forward-projects every historical FIRMS observation (lat/lon) onto
the same Equal Earth grid, groups by (grid_row, grid_col, country) and keeps
the majority country per cell with its share of observations.

Border cells are assigned to their dominant country; cells with no archive
observations get no mapping (they stay country-less, never guessed).

Output: data/agnicalendar/cell_country.parquet
    grid_row INT, grid_col INT, country VARCHAR, obs_count BIGINT,
    cell_obs_total BIGINT, country_share DOUBLE

Requires the obs parquet store built by build_historical_db.py.
"""

import glob
import os
import sys

import duckdb

PARQUET_ROOT = os.environ.get("FIRESYNC_HISTORICAL_PARQUET", "").strip() or "data/historical/parquet"
OBS_GLOB = (
    os.environ.get("FIRESYNC_HISTORICAL_OBS", "").strip()
    or os.path.join(PARQUET_ROOT, "obs", "sensor=*", "year=*", "data_*.parquet")
).replace("\\", "/")
OUT_PATH = (
    os.environ.get("FIRESYNC_AGNI_CELL_COUNTRY", "").strip()
    or "data/agnicalendar/cell_country.parquet"
)


def sql_path(value: str) -> str:
    """SQL literal only; retain the original value for filesystem operations."""
    return "'" + value.replace("\\", "/").replace("'", "''") + "'"

# WGS84 / Equal Earth (EPSG:8857, method 1078) constants — must match
# src/utils/equalEarth.ts exactly.
A = 6378137.0
E2 = 0.00669437999014
E = E2 ** 0.5
SQRT3_2 = (3 ** 0.5) / 2
A1, A2, A3, A4 = 1.340264, -0.081106, 0.000893, 0.003796


def authalic_q(phi_sql: str) -> str:
    s = "sin(" + phi_sql + ")"
    return (
        "(1 - " + str(E2) + ") * (" + s + " / (1 - " + str(E2) + " * " + s + " * " + s + ") "
        "- (1 / (2 * " + str(E) + ")) * ln((1 - " + str(E) + " * " + s + ") / (1 + " + str(E) + " * " + s + ")))"
    )


def _authalic_q_num(phi: float) -> float:
    s = __import__("math").sin(phi)
    return (1 - E2) * (s / (1 - E2 * s * s) - (1 / (2 * E)) * __import__("math").log((1 - E * s) / (1 + E * s)))


QP = _authalic_q_num(__import__("math").pi / 2)
RQ = A * (QP / 2) ** 0.5

# Forward projection as SQL expressions over latitude/longitude degrees.
LAT = "radians(latitude)"
LON = "radians(longitude)"
Q = authalic_q(LAT)
BETA = "asin(least(1.0, greatest(-1.0, " + Q + " / " + str(QP) + ")))"
THETA = "asin(least(1.0, greatest(-1.0, " + str(SQRT3_2) + " * sin(" + BETA + "))))"
T2 = "(" + THETA + ") * (" + THETA + ")"
T6 = "(" + T2 + ") * (" + T2 + ") * (" + T2 + ")"
DENOM = "(" + str(A1) + " + 3 * " + str(A2) + " * " + T2 + " + " + T6 + " * (7 * " + str(A3) + " + 9 * " + str(A4) + " * " + T2 + "))"
X_M = "(" + str(RQ) + " * 2 * " + LON + " * cos(" + THETA + ")) / (" + str(3 ** 0.5) + " * " + DENOM + ")"
Y_M = "(" + str(RQ) + " * " + THETA + " * (" + str(A1) + " + " + str(A2) + " * " + T2 + " + " + T6 + " * (" + str(A3) + " + " + str(A4) + " * " + T2 + ")))"
ROW = "floor(" + Y_M + " / 10000)::INTEGER"
COL = "floor(" + X_M + " / 10000)::INTEGER"


def main() -> int:
    if not glob.glob(OBS_GLOB):
        print("[agni-country] no observations match " + OBS_GLOB + "; run build_historical_db.py or check the configured path", file=sys.stderr)
        return 1

    os.makedirs(os.path.dirname(OUT_PATH) or ".", exist_ok=True)
    con = duckdb.connect()
    con.execute("SET threads TO 8")
    con.execute("SET memory_limit='10GB'")

    # Per-cell country vote, then keep the argmax with its share.
    sql = (
        "COPY ("
        "WITH cell_country AS ("
        "SELECT " + ROW + " AS grid_row, " + COL + " AS grid_col, country, count(*) AS n "
        "FROM read_parquet(" + sql_path(OBS_GLOB) + ", hive_partitioning=true) "
        "WHERE latitude IS NOT NULL AND longitude IS NOT NULL AND country IS NOT NULL "
        "GROUP BY 1, 2, 3"
        "),"
        "ranked AS ("
        "SELECT grid_row, grid_col, country, n, "
        "sum(n) OVER (PARTITION BY grid_row, grid_col) AS cell_obs_total, "
        "row_number() OVER (PARTITION BY grid_row, grid_col ORDER BY n DESC, country) AS rn "
        "FROM cell_country"
        ")"
        "SELECT grid_row, grid_col, country, n AS obs_count, cell_obs_total, "
        "round(n / cell_obs_total, 4) AS country_share "
        "FROM ranked WHERE rn = 1 ORDER BY grid_row, grid_col"
        ") TO " + sql_path(OUT_PATH) + " (FORMAT PARQUET, COMPRESSION ZSTD)"
    )
    print("[agni-country] projecting " + OBS_GLOB + " -> " + OUT_PATH, flush=True)
    con.execute(sql)
    stats = con.execute(
        "SELECT count(*), count(DISTINCT country), min(grid_row), max(grid_row), min(grid_col), max(grid_col) "
        "FROM read_parquet(" + sql_path(OUT_PATH) + ")"
    ).fetchone()
    print(
        "[agni-country] done: {:,} cells, {} countries, rows {}..{}, cols {}..{}".format(
            stats[0], stats[1], stats[2], stats[3], stats[4], stats[5]
        ),
        flush=True,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())

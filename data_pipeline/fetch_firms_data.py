#!/usr/bin/env python3
"""
Legacy entry point: FireSync NASA FIRMS data fetcher.

This file used to contain a second, independent implementation of FIRMS downloading
(based on the third-party `requests` package). It duplicated logic, used invalid 30-day
Area API windows and could drift from the maintained pipeline.

It is now a thin compatibility wrapper around `run_pipeline.py`, which is the single
supported implementation and uses only the Python standard library.

Old flags are translated:
  --date YYYY-MM-DD + --day-range N   ->  --start YYYY-MM-DD --end <start + N - 1>
  --output-dir DIR                    ->  --raw-dir DIR
  --products ...                      ->  --products ...

No request is made and no file is written unless `--download` is supplied (or the legacy
default applies, since this command historically downloaded). The MAP_KEY is read from
the server environment (`FIRMS_MAP_KEY`); it is never accepted as a command-line value.
"""

from __future__ import annotations

import argparse
import os
import sys
from datetime import date, datetime, timedelta

try:
    from .firms_api_client import FIRMSAPIClient, FIRMSClientError
    from .run_pipeline import PRODUCT_DEFINITIONS, STUDY_REGIONS, main as run_pipeline_main
except ImportError:  # direct script execution
    from firms_api_client import FIRMSAPIClient, FIRMSClientError
    from run_pipeline import PRODUCT_DEFINITIONS, STUDY_REGIONS, main as run_pipeline_main


def _iso(value: date) -> str:
    return value.isoformat()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Deprecated wrapper for data_pipeline/run_pipeline.py"
    )
    parser.add_argument("--region", default="bangladesh", choices=list(STUDY_REGIONS.keys()))
    parser.add_argument(
        "--products",
        nargs="+",
        default=["MODIS_SP", "VIIRS_NOAA20_SP"],
        help=f"Products: {', '.join(PRODUCT_DEFINITIONS)}",
    )
    parser.add_argument(
        "--day-range",
        type=int,
        default=5,
        help="Number of days to fetch (1..10; the Area API rejects longer windows).",
    )
    parser.add_argument("--date", default=None, help="Start date YYYY-MM-DD (default: most recent).")
    parser.add_argument("--output-dir", default="data/raw", help="Directory for preserved raw CSV files.")
    parser.add_argument(
        "--check-availability",
        action="store_true",
        help="Query the official FIRMS availability endpoint before fetching.",
    )
    parser.add_argument(
        "--report-path",
        default=None,
        help="Ignored. Reports now go to reports/data_pipeline/<run_id>/.",
    )
    parser.add_argument(
        "--no-download",
        action="store_true",
        help="Validate existing raw files instead of downloading (new, explicit option).",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Re-download even when a valid raw file already exists.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if not (1 <= args.day_range <= 10):
        print("ERROR: --day-range must be between 1 and 10 (FIRMS Area API limit).", file=sys.stderr)
        return 2

    if args.date:
        try:
            start = datetime.strptime(args.date, "%Y-%m-%d").date()
        except ValueError:
            print("ERROR: --date must be a real YYYY-MM-DD date.", file=sys.stderr)
            return 2
    else:
        start = date.today() - timedelta(days=args.day_range - 1)
    end = start + timedelta(days=args.day_range - 1)

    if args.report_path:
        print(
            "[deprecated] --report-path is ignored; reports are written under reports/data_pipeline/.",
            file=sys.stderr,
        )

    print(
        "[deprecated] fetch_firms_data.py now delegates to run_pipeline.py. "
        "Use run_pipeline.py directly for new work.",
        file=sys.stderr,
    )

    if args.check_availability:
        key = os.getenv("FIRMS_MAP_KEY", "").strip()
        if not key:
            print(
                "ERROR: --check-availability requires FIRMS_MAP_KEY in the environment. "
                "No availability result was fabricated.",
                file=sys.stderr,
            )
            return 2
        client = FIRMSAPIClient(key)
        try:
            rows = client.check_data_availability("all")
        except FIRMSClientError as err:
            print(f"ERROR: {err}", file=sys.stderr)
            return 1
        print(f"Availability rows: {len(rows)}")
        for row in rows:
            print(row)

    forwarded = [
        "--region",
        args.region,
        "--start",
        _iso(start),
        "--end",
        _iso(end),
        "--products",
        *args.products,
        "--raw-dir",
        args.output_dir,
    ]
    if args.force:
        forwarded.append("--force")
    if not args.no_download:
        forwarded.append("--download")

    return run_pipeline_main(forwarded)


if __name__ == "__main__":
    raise SystemExit(main())

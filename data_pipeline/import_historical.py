#!/usr/bin/env python3
"""
FireSync historical archive importer.

Streams the local FIRMS year-ZIP archives (`Modis and Virs Data/{modis,viirs_snpp}/*.zip`),
validates every row, and writes bounded-memory staging CSV.gz files — one per
(sensor, year) — plus a resumable manifest. A separate DuckDB step
(`build_historical_db.py`) converts staging into partitioned Parquet and aggregate
tables. The original ZIPs are never modified.

Usage (use the Python that has duckdb installed, e.g. Python313):
    python data_pipeline/import_historical.py                 # all pending archives
    python data_pipeline/import_historical.py --sensor modis  # one sensor only
    python data_pipeline/import_historical.py --zip 2005      # one archive substring
    python data_pipeline/import_historical.py --limit 2       # pilot: first N pending
"""

from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import json
import os
import re
import sys
import zipfile
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

ARCHIVE_ROOT = os.environ.get("FIRESYNC_HISTORICAL_ROOT", "Modis and Virs Data")
STAGING_DIR = os.environ.get("FIRESYNC_HISTORICAL_STAGING", "data/historical/staging")
MANIFEST_PATH = os.environ.get(
    "FIRESYNC_HISTORICAL_MANIFEST", "data/historical/import_manifest.json"
)

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
TIME_RE = re.compile(r"^\d{4}$")

# Unified staging schema. MODIS uses `brightness`/`bright_t31`; VIIRS uses
# `bright_ti4`/`bright_ti5`. All four brightness columns exist; absent stays empty.
STAGING_FIELDS = [
    "country", "sensor", "year", "month", "source_zip", "source_record_number",
    "latitude", "longitude", "brightness", "bright_t31", "bright_ti4", "bright_ti5",
    "scan", "track", "acq_date", "acq_time", "satellite", "instrument",
    "confidence", "version", "frp", "daynight", "firms_type",
]


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def is_real_date(s: str) -> bool:
    if not DATE_RE.match(s):
        return False
    try:
        datetime.strptime(s, "%Y-%m-%d")
        return True
    except ValueError:
        return False


def valid_time(s: str) -> bool:
    if not TIME_RE.match(s):
        return False
    return int(s[:2]) <= 23 and int(s[2:]) <= 59


def archive_sensor(path: str) -> Optional[str]:
    norm = path.replace("\\", "/")
    if "/modis/" in norm:
        return "MODIS"
    if "/viirs" in norm:
        return "VIIRS"
    return None


def archive_year(path: str) -> Optional[int]:
    m = re.search(r"_(\d{4})_all_countries\.zip$", os.path.basename(path))
    return int(m.group(1)) if m else None


def country_from_member(member: str) -> str:
    """`viirs-snpp/2012/viirs-snpp_2012_Australia.csv` -> `Australia`.

    Member filenames are `<sensor>_<year>_<Country_With_Underscores>.csv`.
    Strip the sensor/year prefix, then turn underscores back into spaces so
    multi-word countries keep their full name (previously `rsplit("_", 1)`
    kept only the last token: "United_States" -> "States", "Costa_Rica" -> "Rica").
    """
    base = os.path.basename(member)
    stem = re.sub(r"^[A-Za-z-]+_\d{4}_", "", base)
    if stem.endswith(".csv"):
        stem = stem[:-4]
    return stem.replace("_", " ")


import math as _math

def validate_row(row: Dict[str, str]) -> Tuple[Optional[Dict[str, str]], Optional[str]]:
    """Keep the raw FIRMS values; reject only structurally unusable rows.

    Rejects non-finite (NaN, ±Infinity) values for every numeric measurement
    to prevent poisoning aggregates or producing non-standard JSON.
    """
    try:
        lat = float((row.get("latitude") or "").strip())
        lon = float((row.get("longitude") or "").strip())
    except ValueError:
        return None, "bad lat/lon"
    if not _math.isfinite(lat) or not _math.isfinite(lon):
        return None, "non-finite lat/lon"
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        return None, "lat/lon out of range"
    acq_date = (row.get("acq_date") or "").strip()
    if not is_real_date(acq_date):
        return None, "bad acq_date"
    acq_time = (row.get("acq_time") or "").strip().zfill(4)
    if not valid_time(acq_time):
        return None, "bad acq_time"
    frp_raw = (row.get("frp") or "").strip()
    if frp_raw == "":
        return None, "missing frp"
    try:
        frp = float(frp_raw)
    except ValueError:
        return None, "bad frp"
    if not _math.isfinite(frp):
        return None, "non-finite frp"
    if frp < 0:
        return None, "negative frp"
    # Optional brightness columns: reject non-finite when present but accept absence.
    for col in ("brightness", "bright_t31", "bright_ti4", "bright_ti5", "scan", "track"):
        raw = (row.get(col) or "").strip()
        if raw:
            try:
                val = float(raw)
            except ValueError:
                return None, f"bad {col}"
            if not _math.isfinite(val):
                return None, f"non-finite {col}"
    return row, None


def staging_path(sensor: str, year: int, zip_name: str) -> str:
    # One staging file per archive: a failed archive can be retried without
    # duplicating rows already written by a sibling archive of the same year.
    stem = zip_name[:-4] if zip_name.lower().endswith(".zip") else zip_name
    return os.path.join(STAGING_DIR, f"{sensor.lower()}_{year}__{stem}.csv.gz")


def load_manifest() -> Dict[str, Any]:
    if os.path.exists(MANIFEST_PATH):
        with open(MANIFEST_PATH, encoding="utf-8") as fh:
            return json.load(fh)
    return {"version": 1, "archives": {}}


def save_manifest(manifest: Dict[str, Any]) -> None:
    os.makedirs(os.path.dirname(MANIFEST_PATH), exist_ok=True)
    tmp = MANIFEST_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=1)
    os.replace(tmp, MANIFEST_PATH)


def iter_zip_csvs(zpath: str):
    with zipfile.ZipFile(zpath) as z:
        for info in z.infolist():
            if info.filename.endswith(".csv"):
                yield info, z.open(info)


def import_archive(zpath: str, manifest: Dict[str, Any]) -> Dict[str, Any]:
    sensor = archive_sensor(zpath)
    year = archive_year(zpath)
    if not sensor or not year:
        raise ValueError(f"cannot derive sensor/year from {zpath}")

    rec: Dict[str, Any] = {
        "path": zpath,
        "sensor": sensor,
        "year": year,
        "status": "running",
        "started_at": utc_now(),
        "rows_read": 0,
        "rows_accepted": 0,
        "rows_rejected": 0,
        "rejections": {},
        "min_date": None,
        "max_date": None,
        "countries": set(),
        "satellites": {},
        "versions": {},
        "staging_file": staging_path(sensor, year, os.path.basename(zpath)),
        "zip_sha256": None,
    }

    # Hash the archive once for provenance (6.5 GB total across all zips).
    h = hashlib.sha256()
    with open(zpath, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 22), b""):
            h.update(chunk)
    rec["zip_sha256"] = h.hexdigest()

    os.makedirs(STAGING_DIR, exist_ok=True)
    # F03 fix: write to a .tmp staging file first; rename to the real path only on
    # success. If an exception interrupts the write, the partial file is removed so
    # the builder never consumes a half-written staging file.
    staging_final = rec["staging_file"]
    staging_tmp = staging_final + ".tmp"
    write_ok = False
    try:
        with gzip.open(staging_tmp, "wt", encoding="utf-8", newline="") as out:
            writer = csv.DictWriter(out, fieldnames=STAGING_FIELDS)
            writer.writeheader()
            for info, fh in iter_zip_csvs(zpath):
                country = country_from_member(info.filename)
                text = (line.decode("utf-8", "replace") for line in fh)
                reader = csv.DictReader(text)
                if reader.fieldnames is None:
                    continue
                for idx, row in enumerate(reader, start=2):
                    rec["rows_read"] += 1
                    clean, reason = validate_row(row)
                    if clean is None:
                        rec["rows_rejected"] += 1
                        rec["rejections"][reason or "unknown"] = rec["rejections"].get(reason or "unknown", 0) + 1
                        continue
                    acq_date = clean["acq_date"].strip()
                    month = acq_date[5:7]
                    rec["rows_accepted"] += 1
                    rec["countries"].add(country)
                    sat = (clean.get("satellite") or "").strip()
                    ver = (clean.get("version") or "").strip()
                    rec["satellites"][sat] = rec["satellites"].get(sat, 0) + 1
                    rec["versions"][ver] = rec["versions"].get(ver, 0) + 1
                    if rec["min_date"] is None or acq_date < rec["min_date"]:
                        rec["min_date"] = acq_date
                    if rec["max_date"] is None or acq_date > rec["max_date"]:
                        rec["max_date"] = acq_date
                    writer.writerow({
                        "country": country,
                        "sensor": sensor,
                        "year": str(year),
                        "month": month,
                        "source_zip": os.path.basename(zpath),
                        "source_record_number": idx,
                        "latitude": clean.get("latitude", "").strip(),
                        "longitude": clean.get("longitude", "").strip(),
                        "brightness": clean.get("brightness", "").strip(),
                        "bright_t31": clean.get("bright_t31", "").strip(),
                        "bright_ti4": clean.get("bright_ti4", "").strip(),
                        "bright_ti5": clean.get("bright_ti5", "").strip(),
                        "scan": clean.get("scan", "").strip(),
                        "track": clean.get("track", "").strip(),
                        "acq_date": acq_date,
                        "acq_time": clean["acq_time"].strip().zfill(4),
                        "satellite": sat,
                        "instrument": (clean.get("instrument") or "").strip(),
                        "confidence": (clean.get("confidence") or "").strip(),
                        "version": ver,
                        "frp": clean.get("frp", "").strip(),
                        # Preserve D/N explicitly; anything else (blank, unrecognised) stays UNKNOWN.
                        # Never invent a daylight classification for unknown overpasses.
                        "daynight": (lambda v: v if v in ("D", "N") else "UNKNOWN")(
                            (clean.get("daynight") or "").strip().upper()[:1]
                        ),
                        "firms_type": (clean.get("type") or "").strip(),
                    })
        write_ok = True
    finally:
        if write_ok:
            # Atomically promote the temp file to the final staging path.
            os.replace(staging_tmp, staging_final)
        else:
            # Partial write — remove the temp file so the builder never sees it.
            try:
                os.remove(staging_tmp)
            except OSError:
                pass

    rec["countries"] = sorted(rec["countries"])
    rec["status"] = "completed"
    rec["completed_at"] = utc_now()
    manifest["archives"][zpath] = rec
    save_manifest(manifest)
    return rec


def discover_archives(sensor_filter: Optional[str], needle: Optional[str]) -> List[str]:
    found = []
    for dirpath, _dirs, files in os.walk(ARCHIVE_ROOT):
        for name in files:
            if not name.lower().endswith(".zip"):
                continue
            full = os.path.join(dirpath, name)
            sensor = archive_sensor(full)
            if sensor_filter and sensor != sensor_filter.upper():
                continue
            if needle and needle.lower() not in name.lower():
                continue
            found.append(full)
    return sorted(found)


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Import historical FIRMS ZIPs to staging CSV.gz")
    parser.add_argument("--sensor", choices=["modis", "viirs"], default=None)
    parser.add_argument("--zip", default=None, help="substring filter on archive filename")
    parser.add_argument("--limit", type=int, default=0, help="max archives to process this run")
    parser.add_argument("--force", action="store_true", help="reprocess archives already marked completed")
    args = parser.parse_args(argv)

    manifest = load_manifest()
    archives = discover_archives(args.sensor, args.zip)
    pending = (
        archives
        if args.force
        else [
            p for p in archives
            if manifest["archives"].get(p, {}).get("status") != "completed"
            # F10 fix: even if status=completed, re-process when the staging file has
            # vanished — the builder cannot read a file that no longer exists.
            or not os.path.exists(manifest["archives"].get(p, {}).get("staging_file", ""))
        ]
    )
    if args.limit:
        pending = pending[: args.limit]
    print(f"[import] {len(archives)} archives found, {len(pending)} pending")
    for zpath in pending:
        t0 = datetime.now()
        try:
            rec = import_archive(zpath, manifest)
        except Exception as exc:  # keep going; record the failure honestly
            manifest["archives"][zpath] = {
                "path": zpath, "status": "failed", "error": str(exc), "failed_at": utc_now()
            }
            save_manifest(manifest)
            print(f"[import] FAILED {os.path.basename(zpath)}: {exc}", flush=True)
            continue
        dt = (datetime.now() - t0).total_seconds()
        print(
            f"[import] {os.path.basename(zpath)}: {rec['rows_accepted']:,} accepted "
            f"({rec['rows_rejected']} rejected) {rec['min_date']}..{rec['max_date']} "
            f"in {dt:.0f}s",
            flush=True,
        )
    done = sum(1 for a in manifest["archives"].values() if a.get("status") == "completed")
    failed = sum(1 for a in manifest["archives"].values() if a.get("status") == "failed")
    print(f"[import] finished; {done}/{len(archives)} archives completed, {failed} failed")
    # Return nonzero when any requested archive failed so CI/shell pipelines can detect it.
    return 1 if failed > 0 else 0


if __name__ == "__main__":
    sys.exit(main())

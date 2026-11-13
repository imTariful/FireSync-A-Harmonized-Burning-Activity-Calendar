#!/usr/bin/env python3
"""
FireSync historical / near-real-time FIRMS pipeline (Python standard library only).

What this script really does
----------------------------
1. Splits an inclusive date range into FIRMS Area API-safe windows (default 5 days).
2. Optionally downloads each product x window from the official NASA FIRMS Area API,
   preserving the raw CSV on disk and recording its SHA-256.
3. Normalizes the raw rows into the FireSync CanonicalObservation schema, rejecting
   malformed rows instead of inventing values.
4. Writes a run manifest, a machine-readable quality report and a human-readable report.
5. Resumes safely: completed product/window jobs are skipped when the raw file and its
   checksum still match; `--force` re-downloads.

What it does NOT do
-------------------
* It does not claim that zero downloaded files is a successful ingestion.
* It does not fabricate checksums, record counts, quality flags or idempotency.
* It does not use the FIRMS bulk archive/Earthdata download service. The Area API is
  limited to short windows; for multi-year bulk archives use the official FIRMS
  download service and place the resulting CSVs in --raw-dir, then run this script
  without --download to validate and normalize them.

Usage
-----
    export FIRMS_MAP_KEY="..."           # server-side only
    python data_pipeline/run_pipeline.py \
        --region bangladesh --start 2024-01-01 --end 2024-01-31 \
        --products MODIS_SP VIIRS_NOAA20_SP --download

    # Validate existing raw files without any network access:
    python data_pipeline/run_pipeline.py --start 2024-01-01 --end 2024-01-31 \
        --products MODIS_SP --raw-dir data/raw
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import re
import sys
import uuid
from dataclasses import asdict, dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

try:  # package import (python -m data_pipeline.run_pipeline)
    from .firms_api_client import FIRMSAPIClient, FIRMSClientError, mask_key
    from .job_queue import FileJobQueue, Job
    from .tile_window_generator import (
        ADVISORY_PRODUCT_RANGES,
        Window,
        WindowGenerator,
        advisory_range_note,
    )
except ImportError:  # direct script execution (python data_pipeline/run_pipeline.py)
    from firms_api_client import FIRMSAPIClient, FIRMSClientError, mask_key
    from job_queue import FileJobQueue, Job
    from tile_window_generator import (
        ADVISORY_PRODUCT_RANGES,
        Window,
        WindowGenerator,
        advisory_range_note,
    )

PROCESSING_VERSION = "firesync-pipeline-2.0.0"

STUDY_REGIONS: Dict[str, Dict[str, Any]] = {
    "bangladesh": {
        "name": "Bangladesh",
        "bbox": (88.0, 20.5, 92.8, 26.7),
        "country_code": "BGD",
    },
    "indochina": {
        "name": "Southeast Asia (Indochina)",
        "bbox": (92.0, 9.0, 109.5, 28.5),
        "country_code": None,
    },
    "amazon_arc": {
        "name": "Amazon Arc of Deforestation",
        "bbox": (-66.0, -15.0, -48.0, -3.0),
        "country_code": None,
    },
    "california": {
        "name": "Western North America (California)",
        "bbox": (-124.5, 32.5, -114.1, 42.0),
        "country_code": None,
    },
}

PRODUCT_DEFINITIONS: Dict[str, Dict[str, Any]] = {
    "MODIS_SP": {
        "sensor": "MODIS",
        "satellite": None,
        "processing_level": "standard_science",
        "description": "MODIS Collection 6.1 standard processing (Terra/Aqua)",
    },
    "VIIRS_SNPP_SP": {
        "sensor": "VIIRS",
        "satellite": "Suomi-NPP",
        "processing_level": "standard_science",
        "description": "VIIRS 375 m standard processing (Suomi-NPP)",
    },
    "VIIRS_NOAA20_SP": {
        "sensor": "VIIRS",
        "satellite": "NOAA-20",
        "processing_level": "standard_science",
        "description": "VIIRS 375 m standard processing (NOAA-20)",
    },
    "MODIS_NRT": {
        "sensor": "MODIS",
        "satellite": None,
        "processing_level": "near_real_time",
        "description": "MODIS near-real-time (Terra/Aqua)",
    },
    "VIIRS_NOAA20_NRT": {
        "sensor": "VIIRS",
        "satellite": "NOAA-20",
        "processing_level": "near_real_time",
        "description": "VIIRS 375 m near-real-time (NOAA-20)",
    },
    "VIIRS_NOAA21_NRT": {
        "sensor": "VIIRS",
        "satellite": "NOAA-21",
        "processing_level": "near_real_time",
        "description": "VIIRS 375 m near-real-time (NOAA-21)",
    },
}

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
TIME_RE = re.compile(r"^\d{4}$")

SATELLITE_ALIASES = {
    "TERRA": "Terra",
    "AQUA": "Aqua",
    "N20": "NOAA-20",
    "NOAA-20": "NOAA-20",
    "J1": "NOAA-20",
    "N21": "NOAA-21",
    "NOAA-21": "NOAA-21",
    "J2": "NOAA-21",
    "NPP": "Suomi-NPP",
    "SNPP": "Suomi-NPP",
    "S-NPP": "Suomi-NPP",
    "SUOMI-NPP": "Suomi-NPP",
    "SUOMI NPP": "Suomi-NPP",
}


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def is_real_date(value: str) -> bool:
    if not DATE_RE.match(value or ""):
        return False
    try:
        datetime.strptime(value, "%Y-%m-%d")
        return True
    except ValueError:
        return False


def parse_bbox(raw: str) -> Tuple[float, float, float, float]:
    parts = [part.strip() for part in raw.split(",")]
    if len(parts) != 4:
        raise ValueError("bbox must be 'west,south,east,north'.")
    try:
        west, south, east, north = (float(part) for part in parts)
    except ValueError as err:
        raise ValueError("bbox values must be numbers.") from err
    if not (-180 <= west < east <= 180 and -90 <= south < north <= 90):
        raise ValueError("bbox is outside valid ranges or not west<east / south<north.")
    return west, south, east, north


def bbox_to_string(bbox: Tuple[float, float, float, float]) -> str:
    return ",".join(str(value) for value in bbox)


def all_dates(start: str, end: str) -> List[str]:
    current = datetime.strptime(start, "%Y-%m-%d").date()
    last = datetime.strptime(end, "%Y-%m-%d").date()
    dates: List[str] = []
    while current <= last:
        dates.append(current.isoformat())
        current += timedelta(days=1)
    return dates


def normalize_satellite(raw: Optional[str], definition: Dict[str, Any]) -> Optional[str]:
    if raw:
        token = raw.strip().upper().replace("_", "-")
        if token in SATELLITE_ALIASES:
            return SATELLITE_ALIASES[token]
        # Accept already-normalized values from the canonical schema.
        for known in ("Terra", "Aqua", "NOAA-20", "NOAA-21", "Suomi-NPP"):
            if raw.strip().lower() == known.lower():
                return known
    return definition.get("satellite")


def confidence_fields(sensor: str, raw: str) -> Tuple[Optional[Any], Optional[str], Optional[str]]:
    """Return (confidence, category, error). Never guesses a category for an empty value."""
    value = (raw or "").strip()
    if not value:
        return None, None, "missing confidence"
    if sensor == "MODIS":
        try:
            number = int(float(value))
        except ValueError:
            return None, None, f"invalid MODIS confidence {value!r}"
        if not (0 <= number <= 100):
            return None, None, f"MODIS confidence out of range: {number}"
        category = "high" if number >= 80 else "nominal" if number >= 30 else "low"
        return number, category, None
    token = value.lower()
    if token in {"h", "high"}:
        return value, "high", None
    if token in {"n", "nominal"}:
        return value, "nominal", None
    if token in {"l", "low"}:
        return value, "low", None
    try:
        number = int(float(value))
    except ValueError:
        return value, "low", None
    if not (0 <= number <= 100):
        return None, None, f"VIIRS confidence out of range: {number}"
    category = "high" if number >= 80 else "nominal" if number >= 30 else "low"
    return number, category, None


@dataclass
class RawSource:
    product: str
    window: Window
    bbox: str
    path: Optional[str]
    status: str  # downloaded | reused | missing | failed
    checksum: Optional[str]
    bytes: Optional[int]
    records_raw: int
    error: Optional[str]
    retrieved_at: Optional[str]
    source_url: Optional[str]

    def to_dict(self) -> Dict[str, Any]:
        payload = asdict(self)
        payload["window"] = self.window.to_dict()
        return payload


def raw_path_for(raw_dir: str, product: str, window: Window, bbox: str = "") -> str:
    """F02 fix: include a normalized AOI hash in the filename so different bboxes
    never share a cache file for the same product+window combination."""
    if bbox:
        # Use a short hash of the normalized bbox string so filenames stay readable.
        aoi_hash = hashlib.sha256(bbox.encode()).hexdigest()[:8]
        filename = f"{window.start_date}_{window.end_date}_aoi_{aoi_hash}.csv"
    else:
        filename = f"{window.start_date}_{window.end_date}.csv"
    return os.path.join(raw_dir, product, filename)


def write_text_atomic(path: str, text: str) -> None:
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8", newline="") as handle:
        handle.write(text)
    os.replace(tmp, path)


def load_raw_manifest(path: str) -> Dict[str, Any]:
    if not os.path.exists(path):
        return {"version": 1, "files": {}}
    with open(path, "r", encoding="utf-8") as handle:
        payload = json.load(handle)
    if not isinstance(payload.get("files"), dict):
        payload["files"] = {}
    return payload


def save_raw_manifest(path: str, manifest: Dict[str, Any]) -> None:
    manifest["updated_at"] = utc_now_iso()
    write_text_atomic(path, json.dumps(manifest, indent=2))


def fetch_sources(
    client: FIRMSAPIClient,
    products: List[str],
    windows: List[Window],
    bbox: str,
    raw_dir: str,
    force: bool,
    queue: FileJobQueue,
) -> List[RawSource]:
    """Download or reuse each product/window raw file, recording only real outcomes."""
    manifest_path = os.path.join(raw_dir, "source_manifest.json")
    manifest = load_raw_manifest(manifest_path)
    files = manifest["files"]
    sources: List[RawSource] = []

    for product in products:
        for window in windows:
            key = f"{product}|{window.window_id}|{bbox}"
            path = raw_path_for(raw_dir, product, window, bbox)
            prior = files.get(key) or {}
            prior_checksum = prior.get("sha256")
            job = queue.find(product, window.window_id, bbox)

            if os.path.exists(path) and not force:
                checksum = sha256_file(path)
                if prior_checksum and checksum != prior_checksum:
                    sources.append(
                        RawSource(
                            product=product,
                            window=window,
                            bbox=bbox,
                            path=path,
                            status="failed",
                            checksum=checksum,
                            bytes=os.path.getsize(path),
                            records_raw=0,
                            error=(
                                "Existing raw file checksum does not match the source manifest; "
                                "refusing to use it. Re-download with --force."
                            ),
                            retrieved_at=prior.get("retrieved_at"),
                            source_url=prior.get("url"),
                        )
                    )
                    continue
                sources.append(
                    RawSource(
                        product=product,
                        window=window,
                        bbox=bbox,
                        path=path,
                        status="reused",
                        checksum=checksum,
                        bytes=os.path.getsize(path),
                        records_raw=0,
                        error=None,
                        retrieved_at=prior.get("retrieved_at"),
                        source_url=prior.get("url"),
                    )
                )
                if job and job.status == "completed" and job.checksum == checksum:
                    continue
                if job is None:
                    job = queue.enqueue(
                        Job(
                            product_id=product,
                            window_id=window.window_id,
                            start_date=window.start_date,
                            end_date=window.end_date,
                            bbox=bbox,
                        )
                    )
                elif job.status != "completed":
                    queue.reset_for_retry(job.job_id)
                queue.begin(job.job_id)
                queue.mark_completed(job, records_downloaded=0, checksum=checksum)
                continue

            if job and job.status == "completed" and not force:
                queue.reset_for_retry(job.job_id)
            if job is None:
                job = queue.enqueue(
                    Job(
                        product_id=product,
                        window_id=window.window_id,
                        start_date=window.start_date,
                        end_date=window.end_date,
                        bbox=bbox,
                    )
                )
            else:
                queue.reset_for_retry(job.job_id)
            job = queue.begin(job.job_id) or job

            result = client.fetch_area_csv(product, bbox, window.day_count, window.start_date)
            if result.ok and result.text is not None:
                write_text_atomic(path, result.text)
                actual_checksum = sha256_file(path)
                if actual_checksum != result.checksum:
                    queue.mark_failed(job, "Written file checksum does not match the response checksum.", retry=False)
                    sources.append(
                        RawSource(
                            product=product,
                            window=window,
                            bbox=bbox,
                            path=path,
                            status="failed",
                            checksum=actual_checksum,
                            bytes=os.path.getsize(path),
                            records_raw=0,
                            error="Written file checksum mismatch.",
                            retrieved_at=result.retrieved_at,
                            source_url=result.url,
                        )
                    )
                    continue
                files[key] = {
                    "product": product,
                    "window": window.to_dict(),
                    "bbox": bbox,
                    "path": path,
                    "sha256": actual_checksum,
                    "bytes": os.path.getsize(path),
                    "url": result.url,
                    "retrieved_at": result.retrieved_at,
                    "http_status": result.status_code,
                    "attempts": result.attempts,
                }
                save_raw_manifest(manifest_path, manifest)
                queue.mark_completed(job, records_downloaded=0, checksum=actual_checksum)
                sources.append(
                    RawSource(
                        product=product,
                        window=window,
                        bbox=bbox,
                        path=path,
                        status="downloaded",
                        checksum=actual_checksum,
                        bytes=os.path.getsize(path),
                        records_raw=0,
                        error=None,
                        retrieved_at=result.retrieved_at,
                        source_url=result.url,
                    )
                )
            else:
                queue.mark_failed(job, result.error or "unknown download error")
                sources.append(
                    RawSource(
                        product=product,
                        window=window,
                        bbox=bbox,
                        path=None,
                        status="failed",
                        checksum=None,
                        bytes=None,
                        records_raw=0,
                        error=result.error or "unknown download error",
                        retrieved_at=result.retrieved_at,
                        source_url=result.url,
                    )
                )
    return sources


def discover_sources(
    products: List[str],
    windows: List[Window],
    bbox: str,
    raw_dir: str,
) -> List[RawSource]:
    """No-network mode: use only raw files that already exist, with their real checksums."""
    manifest = load_raw_manifest(os.path.join(raw_dir, "source_manifest.json"))
    files = manifest["files"]
    sources: List[RawSource] = []
    for product in products:
        for window in windows:
            key = f"{product}|{window.window_id}|{bbox}"
            path = raw_path_for(raw_dir, product, window, bbox)
            prior = files.get(key) or {}
            if not os.path.exists(path):
                sources.append(
                    RawSource(
                        product=product,
                        window=window,
                        bbox=bbox,
                        path=None,
                        status="missing",
                        checksum=None,
                        bytes=None,
                        records_raw=0,
                        error="No raw file for this product/window. Run with --download or add the file.",
                        retrieved_at=None,
                        source_url=None,
                    )
                )
                continue
            checksum = sha256_file(path)
            prior_checksum = prior.get("sha256")
            if prior_checksum and checksum != prior_checksum:
                sources.append(
                    RawSource(
                        product=product,
                        window=window,
                        bbox=bbox,
                        path=path,
                        status="failed",
                        checksum=checksum,
                        bytes=os.path.getsize(path),
                        records_raw=0,
                        error="Raw file checksum does not match source_manifest.json.",
                        retrieved_at=prior.get("retrieved_at"),
                        source_url=prior.get("url"),
                    )
                )
                continue
            sources.append(
                RawSource(
                    product=product,
                    window=window,
                    bbox=bbox,
                    path=path,
                    status="reused",
                    checksum=checksum,
                    bytes=os.path.getsize(path),
                    records_raw=0,
                    error=None,
                    retrieved_at=prior.get("retrieved_at"),
                    source_url=prior.get("url"),
                )
            )
    return sources


def canonical_from_row(
    row: Dict[str, str],
    product: str,
    definition: Dict[str, Any],
    source: RawSource,
    region_bbox: Tuple[float, float, float, float],
    requested_start: str,
    requested_end: str,
    row_number: int,
) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    """Validate one raw row. Returns (canonical record, rejection reason)."""
    raw_lat = (row.get("latitude") or "").strip()
    raw_lon = (row.get("longitude") or "").strip()
    try:
        lat = float(raw_lat)
        lon = float(raw_lon)
    except ValueError:
        return None, "latitude/longitude are missing or not numeric"
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        return None, "latitude/longitude outside valid ranges"
    west, south, east, north = region_bbox
    if not (west <= lon <= east and south <= lat <= north):
        return None, "coordinates outside the requested bbox"

    acq_date = (row.get("acq_date") or "").strip()
    if not is_real_date(acq_date):
        return None, f"invalid acq_date {acq_date!r}"
    if not (requested_start <= acq_date <= requested_end):
        return None, "acq_date outside the requested date range"
    if not (source.window.start_date <= acq_date <= source.window.end_date):
        return None, "acq_date outside the downloaded window"

    raw_time = (row.get("acq_time") or "").strip().zfill(4)
    if not TIME_RE.match(raw_time):
        return None, f"invalid acq_time {raw_time!r}"
    hour, minute = int(raw_time[:2]), int(raw_time[2:])
    if hour > 23 or minute > 59:
        return None, f"invalid acq_time {raw_time!r}"

    raw_frp = (row.get("frp") or "").strip()
    try:
        frp = float(raw_frp)
    except ValueError:
        return None, "frp is missing or not numeric"
    if not (frp >= 0):
        return None, "frp is negative or not finite"

    sensor = definition["sensor"]
    confidence, category, conf_error = confidence_fields(sensor, row.get("confidence", ""))
    if conf_error:
        return None, conf_error

    satellite = normalize_satellite(row.get("satellite"), definition)
    if not satellite:
        return None, "satellite is missing and cannot be derived from the product"

    try:
        scan = float((row.get("scan") or "0").strip() or 0)
        track = float((row.get("track") or "0").strip() or 0)
    except ValueError:
        return None, "scan/track is not numeric"
    if scan < 0 or track < 0:
        return None, "scan/track is negative"

    def optional_float(name: str) -> Optional[float]:
        value = (row.get(name) or "").strip()
        if not value:
            return None
        try:
            return float(value)
        except ValueError:
            return None

    daynight = (row.get("daynight") or "D").strip().upper()
    if daynight not in {"D", "N"}:
        daynight = "D"

    record_hash = hashlib.sha256(
        f"{product}|{satellite}|{lat:.5f}|{lon:.5f}|{acq_date}|{raw_time}".encode("utf-8")
    ).hexdigest()
    source_record_id = f"{product}|{lat:.5f}|{lon:.5f}|{acq_date}|{raw_time}"

    record: Dict[str, Any] = {
        "id": f"firms-{sensor.lower()}-{acq_date.replace('-', '')}-{record_hash[:8]}",
        "source_record_id": source_record_id,
        "latitude": lat,
        "longitude": lon,
        "acq_date": acq_date,
        "acq_time": raw_time,
        "datetime_utc": f"{acq_date}T{raw_time[:2]}:{raw_time[2:]}:00Z",
        "sensor": sensor,
        "satellite": satellite,
        "product": product,
        "processing_version": (row.get("version") or "").strip() or definition["processing_level"],
        "confidence": confidence,
        "confidence_category": category,
        "frp_mw": frp,
        "brightness": optional_float("brightness"),
        "bright_ti4": optional_float("bright_ti4"),
        "bright_ti5": optional_float("bright_ti5"),
        "scan": scan,
        "track": track,
        "daynight": daynight,
        "source_file": source.path or "",
        "source_record_number": row_number,
        "source_url": source.source_url,
        "retrieved_at": source.retrieved_at or utc_now_iso(),
        "quality_flags": "",
        "record_hash": record_hash,
        # F07 fix: only records downloaded from the official NASA FIRMS API carry a
        # source_url proving their origin. Manually placed local files have no URL
        # and must stay UNVERIFIED — the checksum proves file integrity, not NASA authenticity.
        "provenance_status": "VERIFIED" if source.source_url else "UNVERIFIED",
    }
    return record, None


def normalize_sources(
    sources: List[RawSource],
    region_bbox: Tuple[float, float, float, float],
    requested_start: str,
    requested_end: str,
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]], int, List[Dict[str, Any]]]:
    """Read every usable raw file. Returns (accepted, rejected, duplicates, per_source)."""
    accepted: List[Dict[str, Any]] = []
    rejected: List[Dict[str, Any]] = []
    per_source: List[Dict[str, Any]] = []
    seen_hashes = set()
    duplicates = 0

    for source in sources:
        if source.status not in {"downloaded", "reused"} or not source.path:
            continue
        if not os.path.exists(source.path):
            source.status = "failed"
            source.error = "Raw file disappeared before normalization."
            continue

        actual_checksum = sha256_file(source.path)
        if source.checksum and actual_checksum != source.checksum:
            source.status = "failed"
            source.error = "Raw file checksum changed before normalization."
            continue
        source.checksum = actual_checksum
        source.bytes = os.path.getsize(source.path)

        accepted_before = len(accepted)
        duplicates_before = duplicates
        raw_rows = 0
        try:
            with open(source.path, "r", encoding="utf-8-sig", newline="") as handle:
                reader = csv.DictReader(handle)
                fieldnames = [name.strip() for name in (reader.fieldnames or [])]
                if "latitude" not in fieldnames or "longitude" not in fieldnames:
                    raise ValueError("CSV header has no latitude/longitude columns")
                for row_number, row in enumerate(reader, start=2):
                    raw_rows += 1
                    record, reason = canonical_from_row(
                        row,
                        source.product,
                        PRODUCT_DEFINITIONS[source.product],
                        source,
                        region_bbox,
                        requested_start,
                        requested_end,
                        row_number,
                    )
                    if record is None:
                        rejected.append(
                            {
                                "file": source.path,
                                "product": source.product,
                                "row": row_number,
                                "reason": reason,
                            }
                        )
                        continue
                    if record["record_hash"] in seen_hashes:
                        duplicates += 1
                        continue
                    seen_hashes.add(record["record_hash"])
                    accepted.append(record)
        except (OSError, UnicodeDecodeError, csv.Error, ValueError) as err:
            source.status = "failed"
            source.error = f"Could not normalize raw file: {err}"
            per_source.append(
                {
                    "product": source.product,
                    "window": source.window.to_dict(),
                    "path": source.path,
                    "accepted": len(accepted) - accepted_before,
                    "raw_rows": raw_rows,
                    "error": source.error,
                }
            )
            continue

        source.records_raw = raw_rows
        per_source.append(
            {
                "product": source.product,
                "window": source.window.to_dict(),
                "path": source.path,
                "accepted": len(accepted) - accepted_before,
                "raw_rows": raw_rows,
                "duplicates": duplicates - duplicates_before,
                "error": None,
            }
        )
    return accepted, rejected, duplicates, per_source


def build_report(
    *,
    run_id: str,
    region_id: str,
    region_name: str,
    region_bbox: Tuple[float, float, float, float],
    requested_start: str,
    requested_end: str,
    products: List[str],
    windows: List[Window],
    download_mode: bool,
    sources: List[RawSource],
    per_source: List[Dict[str, Any]],
    accepted: List[Dict[str, Any]],
    rejected: List[Dict[str, Any]],
    duplicates: int,
    outputs: Dict[str, Any],
    generated_at: str,
) -> Dict[str, Any]:
    usable = [source for source in sources if source.status in {"downloaded", "reused"}]
    failed = [source for source in sources if source.status == "failed"]
    missing = [source for source in sources if source.status == "missing"]

    if not sources:
        status = "failed"
    elif not usable:
        status = "failed"
    elif failed or missing:
        status = "partial"
    elif not accepted:
        status = "completed_empty"
    else:
        status = "completed"

    dates_with_records = sorted({record["acq_date"] for record in accepted})
    requested_dates = all_dates(requested_start, requested_end)
    missing_record_dates = [day for day in requested_dates if day not in set(dates_with_records)]

    per_sensor = {
        "MODIS": sum(1 for record in accepted if record["sensor"] == "MODIS"),
        "VIIRS": sum(1 for record in accepted if record["sensor"] == "VIIRS"),
    }
    per_product: Dict[str, int] = {}
    for record in accepted:
        per_product[record["product"]] = per_product.get(record["product"], 0) + 1

    rejection_reasons: Dict[str, int] = {}
    for item in rejected:
        reason = str(item["reason"])
        rejection_reasons[reason] = rejection_reasons.get(reason, 0) + 1

    return {
        "run_id": run_id,
        "processing_version": PROCESSING_VERSION,
        "generated_at": generated_at,
        "status": status,
        "download_mode": download_mode,
        "request": {
            "region_id": region_id,
            "region_name": region_name,
            "bbox": list(region_bbox),
            "bbox_string": bbox_to_string(region_bbox),
            "start_date": requested_start,
            "end_date": requested_end,
            "products": products,
            "product_definitions": {product: PRODUCT_DEFINITIONS[product] for product in products},
            "windows": [window.to_dict() for window in windows],
        },
        "sources": [source.to_dict() for source in sources],
        "source_normalization": per_source,
        "record_counts": {
            "total_raw_rows": sum(source.records_raw for source in sources),
            "accepted_records": len(accepted),
            "rejected_records": len(rejected),
            "duplicate_records": duplicates,
            "modis_records": per_sensor["MODIS"],
            "viirs_records": per_sensor["VIIRS"],
            "per_product": per_product,
        },
        "coverage": {
            "coverage_status": "observed_days_only",
            "requested_days": len(requested_dates),
            "days_with_records": len(dates_with_records),
            "first_observation_date": dates_with_records[0] if dates_with_records else None,
            "last_observation_date": dates_with_records[-1] if dates_with_records else None,
            "dates_without_records": missing_record_dates,
            "note": (
                "A date without a record is NOT a zero-fire day. It may reflect no overpass, cloud, "
                "processing latency, a failed download or a genuinely fire-free day; this pipeline "
                "cannot distinguish those causes."
            ),
        },
        "rejections": {
            "count": len(rejected),
            "by_reason": rejection_reasons,
            "items": rejected[:500],
            "truncated": len(rejected) > 500,
        },
        "source_summary": {
            "requested_sources": len(sources),
            "downloaded": sum(1 for source in sources if source.status == "downloaded"),
            "reused": sum(1 for source in sources if source.status == "reused"),
            "missing": len(missing),
            "failed": len(failed),
        },
        "provenance": {
            "status": "VERIFIED" if usable and not failed else "PARTIAL" if usable else "UNVERIFIED",
            "raw_files_preserved": bool(usable),
            "checksums": {
                source.path: source.checksum
                for source in usable
                if source.path and source.checksum
            },
            "note": (
                "SHA-256 checksums prove that the preserved files match the bytes recorded here. "
                "They do not by themselves prove NASA authenticity; use the official FIRMS source "
                "and publication metadata for that."
            ),
        },
        "outputs": outputs,
        "notes": [
            "MODIS and VIIRS counts are reported separately and are never summed into one fire count.",
            "Harmonization is not performed here; the server labels harmonized values EXPLORATORY.",
            "The FIRMS Area API serves short windows. For multi-year bulk archives use the official "
            "FIRMS download service / Earthdata and validate the files with this script.",
        ],
    }


def write_markdown_report(report: Dict[str, Any], path: str) -> None:
    counts = report["record_counts"]
    coverage = report["coverage"]
    summary = report["source_summary"]
    lines = [
        f"# FireSync pipeline run {report['run_id']}",
        "",
        f"**Status:** `{report['status']}`",
        f"**Generated:** {report['generated_at']}",
        f"**Processing version:** {report['processing_version']}",
        "",
        "## Request",
        "",
        f"- Region: {report['request']['region_name']} (`{report['request']['bbox_string']}`)",
        f"- Period: {report['request']['start_date']} to {report['request']['end_date']}",
        f"- Products: {', '.join(report['request']['products'])}",
        f"- Windows: {len(report['request']['windows'])}",
        f"- Download mode: {report['download_mode']}",
        "",
        "## Sources",
        "",
        f"- Requested: {summary['requested_sources']}",
        f"- Downloaded: {summary['downloaded']}",
        f"- Reused existing files: {summary['reused']}",
        f"- Missing: {summary['missing']}",
        f"- Failed: {summary['failed']}",
        "",
        "## Records",
        "",
        f"- Raw rows read: {counts['total_raw_rows']}",
        f"- Accepted: {counts['accepted_records']}",
        f"- Rejected: {counts['rejected_records']}",
        f"- Duplicates: {counts['duplicate_records']}",
        f"- MODIS: {counts['modis_records']}",
        f"- VIIRS: {counts['viirs_records']}",
        "",
        "## Coverage",
        "",
        f"- Days with records: {coverage['days_with_records']} / {coverage['requested_days']} requested",
        f"- First observation: {coverage['first_observation_date'] or 'none'}",
        f"- Last observation: {coverage['last_observation_date'] or 'none'}",
        "",
        f"> {coverage['note']}",
        "",
        "## Provenance",
        "",
        f"- Status: `{report['provenance']['status']}`",
        f"- Raw files preserved: {report['provenance']['raw_files_preserved']}",
        "",
        f"> {report['provenance']['note']}",
        "",
        "## Outputs",
        "",
    ]
    for key, value in report["outputs"].items():
        lines.append(f"- {key}: `{value}`")
    lines.append("")
    write_text_atomic(path, "\n".join(lines))


def run(args: argparse.Namespace) -> int:
    if args.region and args.bbox:
        raise ValueError("Use either --region or --bbox, not both.")
    if args.bbox:
        region_id = "custom"
        region_name = "Custom bbox"
        region_bbox = parse_bbox(args.bbox)
    else:
        region_id = args.region or "bangladesh"
        if region_id not in STUDY_REGIONS:
            raise ValueError(f"Unknown region {region_id!r}. Choose from: {', '.join(STUDY_REGIONS)}")
        region_name = STUDY_REGIONS[region_id]["name"]
        region_bbox = tuple(STUDY_REGIONS[region_id]["bbox"])  # type: ignore[assignment]

    if not is_real_date(args.start) or not is_real_date(args.end):
        raise ValueError("--start and --end must be real YYYY-MM-DD dates.")
    if args.start > args.end:
        raise ValueError("--start must be on or before --end.")

    unknown = [product for product in args.products if product not in PRODUCT_DEFINITIONS]
    if unknown:
        raise ValueError(f"Unknown product(s): {', '.join(unknown)}. Supported: {', '.join(PRODUCT_DEFINITIONS)}")

    windows = WindowGenerator(args.window_days).generate_windows(args.start, args.end)
    bbox = bbox_to_string(region_bbox)

    if args.dry_run:
        print(f"[dry-run] Region: {region_name} ({bbox})")
        print(f"[dry-run] Period: {args.start} to {args.end}")
        print(f"[dry-run] Products: {', '.join(args.products)}")
        print(f"[dry-run] Windows: {len(windows)} x {len(args.products)} product(s)")
        for window in windows:
            print(f"[dry-run]   {window.start_date} .. {window.end_date} ({window.day_count} day(s))")
        print("[dry-run] No request was made and no file was written.")
        return 0

    for product in args.products:
        note = advisory_range_note(product, args.start, args.end)
        if note:
            print(f"[advisory] {note}")

    os.makedirs(args.raw_dir, exist_ok=True)
    os.makedirs(args.output_dir, exist_ok=True)
    os.makedirs(args.reports_dir, exist_ok=True)

    queue = FileJobQueue(args.queue_path)
    generated_at = utc_now_iso()
    run_id = f"run-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}-{uuid.uuid4().hex[:6]}"

    if args.download:
        key = os.getenv(args.key_env, "").strip()
        if not key:
            print(
                f"ERROR: --download requires {args.key_env} in the server environment. "
                "No request was made and no report was fabricated.",
                file=sys.stderr,
            )
            return 2
        client = FIRMSAPIClient(
            key,
            timeout=args.timeout,
            max_retries=args.max_retries,
            min_interval_seconds=args.min_interval,
        )
        print(f"[FireSync] Run {run_id}: downloading {len(args.products) * len(windows)} source(s)")
        sources = fetch_sources(
            client,
            args.products,
            windows,
            bbox,
            args.raw_dir,
            args.force,
            queue,
        )
    else:
        print(f"[FireSync] Run {run_id}: validating existing raw files (no network)")
        sources = discover_sources(args.products, windows, bbox, args.raw_dir)

    accepted, rejected, duplicates, per_source = normalize_sources(
        sources, region_bbox, args.start, args.end
    )

    processed_path = os.path.join(args.output_dir, "canonical_observations.json")
    write_text_atomic(processed_path, json.dumps(accepted, indent=2))
    processed_checksum = sha256_file(processed_path)

    run_dir = os.path.join(args.reports_dir, run_id)
    os.makedirs(run_dir, exist_ok=True)
    manifest_path = os.path.join(run_dir, "manifest.json")
    quality_json_path = os.path.join(run_dir, "quality_report.json")
    quality_md_path = os.path.join(run_dir, "quality_report.md")

    outputs = {
        "canonical_observations_json": processed_path,
        "canonical_observations_sha256": processed_checksum,
        "run_manifest_json": manifest_path,
        "quality_report_json": quality_json_path,
        "quality_report_md": quality_md_path,
        "queue_state_json": args.queue_path,
        "raw_manifest_json": os.path.join(args.raw_dir, "source_manifest.json"),
    }

    report = build_report(
        run_id=run_id,
        region_id=region_id,
        region_name=region_name,
        region_bbox=region_bbox,
        requested_start=args.start,
        requested_end=args.end,
        products=args.products,
        windows=windows,
        download_mode=bool(args.download),
        sources=sources,
        per_source=per_source,
        accepted=accepted,
        rejected=rejected,
        duplicates=duplicates,
        outputs=outputs,
        generated_at=generated_at,
    )

    write_text_atomic(manifest_path, json.dumps(report, indent=2))
    write_text_atomic(quality_json_path, json.dumps(report, indent=2))
    write_markdown_report(report, quality_md_path)
    # Stable copies for dashboards and documentation.
    write_text_atomic(os.path.join(args.reports_dir, "latest_manifest.json"), json.dumps(report, indent=2))
    write_text_atomic(os.path.join(args.reports_dir, "latest_quality_report.json"), json.dumps(report, indent=2))
    write_text_atomic(os.path.join(args.reports_dir, "latest_quality_report.md"), open(quality_md_path, encoding="utf-8").read())

    print(f"[FireSync] Status: {report['status']}")
    print(
        f"[FireSync] Accepted {len(accepted)} record(s) "
        f"({report['record_counts']['modis_records']} MODIS, {report['record_counts']['viirs_records']} VIIRS); "
        f"rejected {len(rejected)}; duplicates {duplicates}."
    )
    print(f"[FireSync] Manifest: {manifest_path}")
    print(f"[FireSync] Quality report: {quality_md_path}")
    print(f"[FireSync] Canonical observations: {processed_path}")

    if report["status"] == "failed":
        return 1
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="FireSync FIRMS download + validation pipeline (stdlib only)"
    )
    parser.add_argument("--region", default="bangladesh", help="Study region id (default: bangladesh)")
    parser.add_argument("--bbox", default=None, help="Custom bbox 'west,south,east,north' (overrides --region)")
    parser.add_argument("--start", required=True, help="Start date YYYY-MM-DD")
    parser.add_argument("--end", required=True, help="End date YYYY-MM-DD (inclusive)")
    parser.add_argument(
        "--products",
        nargs="+",
        default=["MODIS_SP", "VIIRS_NOAA20_SP"],
        help=f"Products: {', '.join(PRODUCT_DEFINITIONS)}",
    )
    parser.add_argument("--window-days", type=int, default=5, help="Days per API request (1..10)")
    parser.add_argument("--raw-dir", default="data/raw", help="Preserved raw CSV directory")
    parser.add_argument("--output-dir", default="data/processed", help="Canonical output directory")
    parser.add_argument("--reports-dir", default="reports/data_pipeline", help="Report directory")
    parser.add_argument("--queue-path", default="data/pipeline_jobs.json", help="Durable JSON job queue")
    parser.add_argument("--download", action="store_true", help="Download missing windows from FIRMS")
    parser.add_argument("--force", action="store_true", help="Re-download even when a valid raw file exists")
    parser.add_argument("--key-env", default="FIRMS_MAP_KEY", help="Environment variable holding the MAP_KEY")
    parser.add_argument("--timeout", type=float, default=60.0, help="HTTP timeout seconds")
    parser.add_argument("--max-retries", type=int, default=4, help="HTTP attempts per window")
    parser.add_argument("--min-interval", type=float, default=0.2, help="Minimum seconds between requests")
    parser.add_argument("--dry-run", action="store_true", help="Print the plan; no network, no files")
    return parser


def main(argv: Optional[List[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return run(args)
    except (ValueError, FIRMSClientError) as err:
        print(f"ERROR: {err}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

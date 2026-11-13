#!/usr/bin/env python3
"""
FireSync NASA FIRMS Area API client (Python standard library only).

This client talks to the documented FIRMS Area API:
    https://firms.modaps.eosdis.nasa.gov/api/area/csv/{MAP_KEY}/{PRODUCT}/{BBOX}/{DAY_RANGE}/{DATE}

It never invents a successful download. Every result records the real HTTP status, the
number of attempts, the SHA-256 of the response body and an explicit error on failure.

Security: the MAP_KEY is a server-side secret. It is placed in the request URL (required by
NASA), but every URL stored in a result, log line or report is masked.
"""

from __future__ import annotations

import csv
import hashlib
import io
import json
import logging
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

FIRMS_DEFAULT_BASE_URL = "https://firms.modaps.eosdis.nasa.gov"

# Area API limits. NRT products accept up to 5 days per request; standard-processing
# products accept up to 10. Callers must still choose a conservative window.
NRT_MAX_DAYS = 5
SP_MAX_DAYS = 10


class FIRMSClientError(RuntimeError):
    """Raised for a request that could not produce a valid FIRMS CSV response."""


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def mask_key(text: str, key: Optional[str]) -> str:
    """Remove a MAP_KEY and any /csv/<key>/ URL segment from text."""
    out = str(text)
    if key:
        out = out.replace(key, "***")
    # Area and country endpoints both contain /csv/<key>/.
    parts = out.split("/csv/")
    if len(parts) > 1:
        rebuilt = [parts[0]]
        for part in parts[1:]:
            pieces = part.split("/", 1)
            rebuilt.append("/csv/***" + ("/" + pieces[1] if len(pieces) > 1 else ""))
        out = "".join(rebuilt)
    return out


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


@dataclass
class FetchResult:
    """The real outcome of one Area API request."""

    ok: bool
    product: str
    bbox: str
    day_range: int
    date: Optional[str]
    url: str  # masked
    status_code: Optional[int]
    attempts: int
    bytes_received: int
    checksum: Optional[str]
    text: Optional[str]
    error: Optional[str]
    retrieved_at: str

    def to_manifest(self) -> Dict[str, Any]:
        """A JSON-safe record with no CSV body and no key."""
        return {
            "product": self.product,
            "bbox": self.bbox,
            "day_range": self.day_range,
            "date": self.date,
            "url": self.url,
            "status_code": self.status_code,
            "attempts": self.attempts,
            "bytes": self.bytes_received,
            "sha256": self.checksum,
            "ok": self.ok,
            "error": self.error,
            "retrieved_at": self.retrieved_at,
        }


class FIRMSAPIClient:
    """Throttled, retrying FIRMS Area API client built on urllib."""

    def __init__(
        self,
        map_key: str,
        base_url: str = FIRMS_DEFAULT_BASE_URL,
        timeout: float = 60.0,
        max_retries: int = 4,
        initial_backoff: float = 1.0,
        max_backoff: float = 30.0,
        min_interval_seconds: float = 0.2,
        user_agent: str = "FireSync/2.0 (stdlib; scientific data pipeline)",
    ) -> None:
        if not map_key or not map_key.strip():
            raise ValueError("FIRMS_MAP_KEY is required for download mode.")
        self.map_key = map_key.strip()
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.max_retries = max(1, int(max_retries))
        self.initial_backoff = max(0.0, float(initial_backoff))
        self.max_backoff = max(self.initial_backoff, float(max_backoff))
        self.min_interval_seconds = max(0.0, float(min_interval_seconds))
        self.user_agent = user_agent
        self.requests_made = 0
        self._last_request_at = 0.0

    # ------------------------------------------------------------------ HTTP
    def _throttle(self) -> None:
        if self.min_interval_seconds <= 0:
            return
        wait = self.min_interval_seconds - (time.monotonic() - self._last_request_at)
        if wait > 0:
            time.sleep(wait)

    def _backoff(self, attempt: int) -> float:
        return min(self.initial_backoff * (2 ** attempt), self.max_backoff)

    def _request(self, url: str) -> tuple[int, str, int, Optional[str]]:
        """GET a URL with retries. Returns (status, body, attempts, error)."""
        last_error: Optional[str] = None
        attempts = 0
        for attempt in range(self.max_retries):
            attempts = attempt + 1
            self._throttle()
            request = urllib.request.Request(
                url,
                headers={
                    "User-Agent": self.user_agent,
                    "Accept": "text/csv,text/plain,*/*",
                },
            )
            try:
                self.requests_made += 1
                self._last_request_at = time.monotonic()
                with urllib.request.urlopen(request, timeout=self.timeout) as response:
                    status = int(getattr(response, "status", 200))
                    body = response.read().decode("utf-8", errors="replace")
                if 200 <= status < 300:
                    return status, body, attempts, None
                last_error = f"HTTP {status}: {body[:300]}"
            except urllib.error.HTTPError as err:
                status = int(err.code)
                try:
                    body = err.read().decode("utf-8", errors="replace")
                except Exception:  # pragma: no cover - defensive
                    body = ""
                # 4xx (except 429) is a permanent client error: retrying cannot help.
                if status == 429:
                    retry_after = err.headers.get("Retry-After") if err.headers else None
                    delay = self._backoff(attempt)
                    if retry_after and retry_after.isdigit():
                        delay = max(delay, min(float(retry_after), self.max_backoff))
                    last_error = f"HTTP 429 rate limited: {body[:200]}"
                    if attempt < self.max_retries - 1:
                        time.sleep(delay)
                    continue
                if 400 <= status < 500:
                    return status, body, attempts, f"HTTP {status}: {body[:300]}"
                last_error = f"HTTP {status}: {body[:300]}"
            except (urllib.error.URLError, TimeoutError, OSError) as err:
                last_error = f"{type(err).__name__}: {err}"

            if attempt < self.max_retries - 1:
                delay = self._backoff(attempt)
                logger.warning("FIRMS request failed (attempt %s/%s): %s; retrying in %.1fs",
                               attempts, self.max_retries, last_error, delay)
                time.sleep(delay)

        return 0, "", attempts, last_error or "unknown network error"

    # --------------------------------------------------------------- endpoints
    def fetch_area_csv(
        self,
        product: str,
        bbox: str,
        day_range: int,
        date: Optional[str] = None,
    ) -> FetchResult:
        """
        Fetch one Area API CSV response.

        `day_range` must be 1..5 for NRT products and 1..10 for standard-processing
        products. A response without a `latitude` column is a failure, never an empty
        successful dataset.
        """
        max_days = NRT_MAX_DAYS if product.endswith("_NRT") else SP_MAX_DAYS
        if not (1 <= int(day_range) <= max_days):
            raise ValueError(f"day_range for {product} must be 1..{max_days}.")
        if not bbox or len(bbox.split(",")) != 4:
            raise ValueError("bbox must be 'west,south,east,north'.")
        if date is not None:
            # Validate the date honestly rather than letting NASA return an error.
            datetime.strptime(date, "%Y-%m-%d")

        key = urllib.parse.quote(self.map_key, safe="")
        path = [
            "api",
            "area",
            "csv",
            key,
            product,
            bbox,
            str(int(day_range)),
        ]
        if date:
            path.append(date)
        url = f"{self.base_url}/" + "/".join(path)

        status, body, attempts, error = self._request(url)
        retrieved_at = utc_now_iso()

        if error is None:
            # The Area API returns CSV on success and a plain-text error otherwise.
            first_line = body.strip().splitlines()[0] if body.strip() else ""
            if "latitude" not in first_line:
                error = f"Response is not a FIRMS CSV (first line: {first_line[:200]!r})."
            elif not body.strip():
                error = "Empty response body."

        checksum = sha256_text(body) if error is None and body else None
        masked_url = mask_key(url, self.map_key)
        result = FetchResult(
            ok=error is None,
            product=product,
            bbox=bbox,
            day_range=int(day_range),
            date=date,
            url=masked_url,
            status_code=status or None,
            attempts=attempts,
            bytes_received=len(body.encode("utf-8")),
            checksum=checksum,
            text=body if error is None else None,
            error=mask_key(error, self.map_key) if error else None,
            retrieved_at=retrieved_at,
        )
        if not result.ok:
            logger.error("FIRMS download failed for %s %s: %s", product, bbox, result.error)
        return result

    def check_key_status(self) -> Dict[str, Any]:
        """Read the real MAP_KEY status. Raises FIRMSClientError on failure."""
        key = urllib.parse.quote(self.map_key, safe="")
        url = f"{self.base_url}/api/mapserver/mapkey_status/?MAP_KEY={key}"
        status, body, attempts, error = self._request(url)
        if error:
            raise FIRMSClientError(mask_key(error, self.map_key))
        try:
            payload = json.loads(body)
        except json.JSONDecodeError as err:
            raise FIRMSClientError(
                f"MAP_KEY status response was not JSON (HTTP {status}, {attempts} attempt(s))."
            ) from err
        return payload

    def check_data_availability(self, product: str = "all") -> List[Dict[str, str]]:
        """Read the real product availability table. Raises FIRMSClientError on failure."""
        key = urllib.parse.quote(self.map_key, safe="")
        url = f"{self.base_url}/api/data_availability/csv/{key}/{urllib.parse.quote(product, safe='')}"
        status, body, attempts, error = self._request(url)
        if error:
            raise FIRMSClientError(mask_key(error, self.map_key))
        reader = csv.DictReader(io.StringIO(body))
        rows = list(reader)
        if not rows:
            raise FIRMSClientError(
                f"Availability response contained no rows (HTTP {status}, {attempts} attempt(s))."
            )
        return rows


def main() -> int:
    """Small diagnostic CLI; never pretends to download data when the key is absent."""
    import argparse
    import os

    parser = argparse.ArgumentParser(description="Check a NASA FIRMS MAP_KEY (stdlib client)")
    parser.add_argument("--key-env", default="FIRMS_MAP_KEY")
    parser.add_argument("--product", default="MODIS_NRT")
    args = parser.parse_args()

    key = os.getenv(args.key_env, "").strip()
    if not key:
        print(f"ERROR: {args.key_env} is not set. No request was made.")
        return 2
    client = FIRMSAPIClient(key)
    try:
        status = client.check_key_status()
        print("MAP_KEY status:", json.dumps(status, indent=2))
        availability = client.check_data_availability(args.product)
        print(f"Availability rows for {args.product}: {len(availability)}")
        return 0
    except FIRMSClientError as err:
        print(f"ERROR: {err}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

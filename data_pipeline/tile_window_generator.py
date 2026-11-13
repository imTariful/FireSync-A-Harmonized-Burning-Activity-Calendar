#!/usr/bin/env python3
"""
FireSync tile and temporal-window helpers (pure standard library).

These helpers describe work; they do not create placeholder ingestion jobs and they do
not claim that any job ran. A real run is executed by run_pipeline.py, which records the
actual HTTP results and checksums.

FIRMS Area API windows:
  * NRT products: at most 5 days per request.
  * Standard-processing products: at most 10 days per request.

The previous 30-day window default was invalid for the Area API and has been removed.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)

MAX_WINDOW_DAYS = 10
DEFAULT_WINDOW_DAYS = 5


@dataclass(frozen=True)
class Window:
    """An inclusive date window: start_date..end_date."""

    window_id: str
    start_date: str
    end_date: str
    day_count: int

    def to_dict(self) -> Dict[str, object]:
        return {
            "window_id": self.window_id,
            "start_date": self.start_date,
            "end_date": self.end_date,
            "day_count": self.day_count,
        }


class WindowGenerator:
    """Splits an inclusive date range into API-safe windows."""

    def __init__(self, window_size_days: int = DEFAULT_WINDOW_DAYS) -> None:
        if not isinstance(window_size_days, int) or not (1 <= window_size_days <= MAX_WINDOW_DAYS):
            raise ValueError(f"window_size_days must be an integer between 1 and {MAX_WINDOW_DAYS}.")
        self.window_size_days = window_size_days

    def generate_windows(self, start_date: str, end_date: str) -> List[Window]:
        start = _parse_date(start_date)
        end = _parse_date(end_date)
        if start > end:
            raise ValueError("start_date must be on or before end_date.")

        windows: List[Window] = []
        current = start
        index = 0
        while current <= end:
            window_end = min(current + timedelta(days=self.window_size_days - 1), end)
            windows.append(
                Window(
                    window_id=f"{current.isoformat()}_{window_end.isoformat()}",
                    start_date=current.isoformat(),
                    end_date=window_end.isoformat(),
                    day_count=(window_end - current).days + 1,
                )
            )
            current = window_end + timedelta(days=1)
            index += 1
        logger.info("Generated %s window(s) from %s to %s", len(windows), start_date, end_date)
        return windows

    def generate_windows_for_year(self, year: int) -> List[Window]:
        return self.generate_windows(f"{year:04d}-01-01", f"{year:04d}-12-31")


# Advisory only. These ranges are NOT fetched from NASA and can change; the pipeline's
# availability check is the authoritative source. They are used only to warn a user who
# asks for a date that a product is unlikely to cover.
ADVISORY_PRODUCT_RANGES: Dict[str, Dict[str, Optional[str]]] = {
    "MODIS_SP": {"min_date": "2000-11-01", "max_date": None, "verified": False},
    "VIIRS_SNPP_SP": {"min_date": "2012-01-20", "max_date": "2026-11-01", "verified": False},
    "VIIRS_NOAA20_SP": {"min_date": "2018-04-01", "max_date": None, "verified": False},
    "MODIS_NRT": {"min_date": None, "max_date": None, "verified": False},
    "VIIRS_NOAA20_NRT": {"min_date": None, "max_date": None, "verified": False},
    "VIIRS_NOAA21_NRT": {"min_date": None, "max_date": None, "verified": False},
}


def advisory_range_note(product: str, start_date: str, end_date: str) -> Optional[str]:
    """Return a warning when the requested range is outside an advisory product range."""
    known = ADVISORY_PRODUCT_RANGES.get(product)
    if not known:
        return f"Unknown product {product!r}; no advisory range is available."
    notes: List[str] = []
    min_date = known.get("min_date")
    max_date = known.get("max_date")
    if min_date and start_date < str(min_date):
        notes.append(f"starts before the advisory minimum {min_date}")
    if max_date and end_date > str(max_date):
        notes.append(f"ends after the advisory maximum {max_date}")
    if notes:
        return (
            f"{product}: requested range {' and '.join(notes)}. This advisory is not a "
            "substitute for the NASA availability endpoint; verify before relying on the result."
        )
    return None


def _parse_date(value: str) -> date:
    try:
        return datetime.strptime(value, "%Y-%m-%d").date()
    except (TypeError, ValueError) as err:
        raise ValueError(f"Invalid date {value!r}; expected YYYY-MM-DD.") from err


# ---------------------------------------------------------------------------
# Optional geographic tiling for very large requests.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Tile:
    """A rectangular geographic tile. Purely a partitioning helper."""

    tile_id: str
    lat_index: int
    lon_index: int
    lat_min: float
    lat_max: float
    lon_min: float
    lon_max: float
    bbox: str

    def to_dict(self) -> Dict[str, object]:
        return {
            "tile_id": self.tile_id,
            "lat_index": self.lat_index,
            "lon_index": self.lon_index,
            "lat_min": self.lat_min,
            "lat_max": self.lat_max,
            "lon_min": self.lon_min,
            "lon_max": self.lon_max,
            "bbox": self.bbox,
        }


class TileGenerator:
    """Generates 10-degree tiles. No priorities are invented."""

    TILE_SIZE_DEG = 10.0

    def __init__(self, tile_size_deg: float = TILE_SIZE_DEG) -> None:
        if not (0 < tile_size_deg <= 90):
            raise ValueError("tile_size_deg must be in (0, 90].")
        self.tile_size_deg = float(tile_size_deg)

    def generate_all_tiles(self) -> List[Tile]:
        tiles: List[Tile] = []
        lat_steps = int(round(180 / self.tile_size_deg))
        lon_steps = int(round(360 / self.tile_size_deg))
        for lat_index in range(lat_steps):
            for lon_index in range(lon_steps):
                tiles.append(self._generate_tile(lat_index, lon_index))
        return tiles

    def _generate_tile(self, lat_index: int, lon_index: int) -> Tile:
        lat_min = -90 + lat_index * self.tile_size_deg
        lat_max = min(90.0, lat_min + self.tile_size_deg)
        lon_min = -180 + lon_index * self.tile_size_deg
        lon_max = min(180.0, lon_min + self.tile_size_deg)
        return Tile(
            tile_id=f"{lat_index}_{lon_index}",
            lat_index=lat_index,
            lon_index=lon_index,
            lat_min=lat_min,
            lat_max=lat_max,
            lon_min=lon_min,
            lon_max=lon_max,
            bbox=f"{lon_min},{lat_min},{lon_max},{lat_max}",
        )

    def get_tile_for_coordinates(self, lat: float, lon: float) -> Tile:
        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
            raise ValueError("lat must be -90..90 and lon -180..180.")
        lat_index = min(int((lat + 90) / self.tile_size_deg), int(round(180 / self.tile_size_deg)) - 1)
        lon_index = min(int((lon + 180) / self.tile_size_deg), int(round(360 / self.tile_size_deg)) - 1)
        return self._generate_tile(lat_index, lon_index)


def main() -> int:
    """Diagnostic CLI: prints windows only; downloads nothing."""
    import argparse

    parser = argparse.ArgumentParser(description="Show FIRMS-safe date windows (no downloads)")
    parser.add_argument("--start", required=True)
    parser.add_argument("--end", required=True)
    parser.add_argument("--window-days", type=int, default=DEFAULT_WINDOW_DAYS)
    args = parser.parse_args()
    windows = WindowGenerator(args.window_days).generate_windows(args.start, args.end)
    for window in windows:
        print(f"{window.start_date} .. {window.end_date} ({window.day_count} day(s))")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

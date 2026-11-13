# API Reference

**Base URL:** `http://localhost:3000/api/v1`
**API:** Express 4 — the only application server (`server.ts`).
**Content-Type:** `application/json` (CSV endpoints return `text/csv`)

All filters are optional unless stated. Date filters are real `YYYY-MM-DD` dates; invalid
dates, bboxes, AOIs, sources or live-window requests return `400` with an `error` message
rather than being ignored.

## Observation sources

Endpoints that return observations or analytics accept `source`:

| `source` | Meaning |
|---|---|
| `store` | **Default.** Reads only records in the local store. The store starts empty and only a completed real NASA FIRMS ingestion job adds records. |
| `live` | Reads the official NASA FIRMS NRT Area API on demand for the selected area. Only the rolling last 1–5 days exist. Nothing is archived or silently substituted. |

The React frontend explicitly sends `source=live`. API clients that omit `source` keep the
previous `store` default for backward compatibility.

`source=live` responses include `data_source`, `provenance_status`, `retrieved_at`,
`cached`, `source_errors` and `truncated`. Live data is cached briefly on the server and
shared by `/fires` and every `source=live` endpoint.

### Live window

Live NRT covers the last **1–5 days** only. A request whose date range starts before that
window returns:

```json
{
  "error": "Live NASA FIRMS NRT data covers only the last 5 days (YYYY-MM-DD to YYYY-MM-DD). Historical dates require a standard-science archive ingestion, which is not available in this deployment.",
  "code": "LIVE_WINDOW"
}
```

A historical request is never quietly converted into a 5-day request and never filled from
a bundled archive.

## Shared query parameters

| Parameter | Format | Notes |
|---|---|---|
| `source` | `store` or `live` | Default `store`. The frontend sends `live`. |
| `days` | integer 1–5 | Live NRT window. Ignored for `source=store`. |
| `start_date` / `end_date` | `YYYY-MM-DD` | Inclusive. `start_date > end_date` is rejected. For `source=live`, both must fall inside the rolling 5-day window. |
| `bbox` | `west,south,east,north` | Preliminary rectangular filter. |
| `aoi` or `polygon` | `lon,lat;lon,lat;...` or a JSON array | Actual point-in-polygon AOI in GeoJSON `[lon,lat]` order. Boundary points count as inside. |
| `sensors` | `MODIS`, `VIIRS`, `ALL` | Comma-separated. Unknown values are rejected. |
| `satellites` | e.g. `Terra,NOAA-20` | `ALL` disables the filter. |
| `min_confidence` | number | Applies to numeric MODIS confidence and categorical VIIRS confidence. |
| `min_frp` | MW | Minimum fire radiative power. |

---

## Health

### `GET /health`

Reports actual storage, provenance and integration state. It does not claim a database, a
non-empty store or a validated calibration.

```json
{
  "status": "healthy",
  "service": "FireSync Harmonization Platform",
  "version": "2.0.0",
  "database": {
    "status": "in_memory",
    "storage_type": "memory",
    "durable": false,
    "location": "process memory (not durable)",
    "records_count": 0,
    "postgres_configured": false,
    "postgis_active": false
  },
  "firms_integration": {
    "api_configured": true,
    "endpoint": "https://firms.modaps.eosdis.nasa.gov/api/area/csv",
    "supported_products": ["VIIRS_NOAA20_NRT", "VIIRS_NOAA21_NRT", "MODIS_NRT"],
    "live_nrt_max_days": 5
  },
  "provenance": {
    "local_store_status": "UNVERIFIED",
    "raw_source_files_present": false,
    "reason": "The local store is empty. No observation, archive or placeholder record is pre-seeded.",
    "checksum_note": "A SHA-256 checksum verifies file integrity, not NASA authenticity."
  },
  "calibration": {
    "status": "INSUFFICIENT",
    "note": "The harmonization layer is EXPLORATORY; no calibration is validated. The fixed 0.294 factor is not fitted."
  }
}
```

`storage_type` is `memory` or `json_file` (when `FIRESYNC_STORE_PATH` is set).
`postgis_active` is always `false`: PostGIS is not integrated.

---

## Metadata

### `GET /metadata`

Project metadata, study regions, dataset metadata (including `local_store_provenance_status`
and its reason), available sensors/satellites, live products, metric definitions, processing
version and storage kind.

---

## Data availability

### `GET /data-availability`

Returns the **local store** counts separately per sensor plus the official FIRMS source
description. It does not query NASA live.

```json
{
  "local_store": {
    "total_records": 0,
    "first_observation_date": null,
    "last_observation_date": null,
    "modis_count": 0,
    "viirs_count": 0,
    "data_status": "empty",
    "provenance_status": "UNVERIFIED",
    "raw_source_files_present": false,
    "reason": "The local store is empty. No observation, archive or placeholder record is pre-seeded."
  },
  "live_nrt": {
    "available": true,
    "max_days": 5,
    "endpoint": "/api/v1/fires?area=world&days=1",
    "products": ["VIIRS_NOAA20_NRT", "VIIRS_NOAA21_NRT", "MODIS_NRT"],
    "note": "Real NASA FIRMS Near Real-Time detections for the rolling last 1-5 days. The server fetches them on demand and never substitutes a bundled archive."
  },
  "official_nasa_firms": {
    "products": [
      { "product": "MODIS_NRT", "availability": "near-real-time area API", "status": "live_source" },
      { "product": "VIIRS_NOAA20_NRT", "availability": "near-real-time area API", "status": "live_source" },
      { "product": "VIIRS_NOAA21_NRT", "availability": "near-real-time area API", "status": "live_source" },
      { "product": "MODIS_C6_1 / VNP14IMG", "availability": "historical archive via FIRMS download/Earthdata", "status": "archive_source_not_ingested_here" }
    ],
    "api_key_configured": true,
    "registration_url": "https://firms.modaps.eosdis.nasa.gov/api/map_key"
  },
  "storage": { "kind": "memory", "durable": false },
  "calibration_status": "INSUFFICIENT",
  "calibration_note": "The harmonization layer is EXPLORATORY; no calibration is validated. The fixed 0.294 factor is not fitted."
}
```

`local_store.data_status` is `empty` when there are no records. It is not a coverage claim.

---

## Hotspots

### `GET /hotspots`

Returns observations after bbox prefiltering and **actual AOI polygon filtering**.

Additional parameters: `limit` (default 500, max 2000), `offset` (default 0).

Live world example (2026-11-09):

```json
{
  "total": 103131,
  "limit": 5,
  "offset": 0,
  "has_more": true,
  "observations": [ /* CanonicalObservation */ ],
  "data_source": "live",
  "provenance_status": "VERIFIED",
  "retrieved_at": "2026-11-09T19:27:27.321Z",
  "cached": true,
  "source_errors": [],
  "truncated": false,
  "filters_applied": {
    "bbox": { "west": -180, "south": -90, "east": 180, "north": 90 },
    "aoi_vertices": 0,
    "sensors": ["MODIS", "VIIRS"],
    "live_area": "world",
    "live_days": 1
  }
}
```

With `source=store` and an empty store, `total` is `0` and `observations` is empty. That is
an honest empty result, not a failed request and not a zero-fire claim.

---

## Calendar

### `GET /calendar`

Returns **observed days only**. Missing dates are omitted, never zero-filled.

```json
{
  "period": { "start_date": "2026-11-09", "end_date": "2026-11-09" },
  "total_days": 1,
  "observed_days": 1,
  "active_days": 1,
  "missing_days": null,
  "coverage_status": "observed_days_only",
  "coverage_note": "Live NRT only covers the rolling last 5 days. Only dates with observations are returned; absent dates are NOT zero-fire days.",
  "data_source": "live",
  "provenance_status": "VERIFIED",
  "cached": true,
  "source_errors": [],
  "truncated": false,
  "daily_summaries": [ /* DailyActivitySummary */ ]
}
```

---

## Analytics

All analytics endpoints accept `source=live` and share the live service cache.

### `GET /analytics/summary`

KPI values for the filtered observations. MODIS and VIIRS counts/FRP stay separate.
`data_coverage_completeness_pct` is `null` when unknown.

Live world example (2026-11-09): MODIS `7,073`, VIIRS `96,058`, total raw `103,131`,
`58,265` spatial-temporal bins, one active day, completeness `null`.

### `GET /analytics/sensors`

Real paired cells, matched points and matching diagnostics:

```json
{
  "comparison": {
    "modis_total_detections": 7073,
    "viirs_total_detections": 96058,
    "ratio_viirs_to_modis": 13.58,
    "paired_1km_cells_count": 2034,
    "calibration_metrics": { "status": "INSUFFICIENT", "r_squared": 0 },
    "matched_points": [ { "modis": "...", "viirs": "...", "distance_km": 0.42, "time_diff_minutes": 12.0 } ],
    "paired_cells": [ { "cell_id": "...", "date": "2026-11-09", "modis_count": 1, "viirs_count": 2 } ],
    "matching_summary": { "method": "...", "label": "...", "point_pairs": 4, "co_detected_cells": 2034 },
    "calibration_status": "INSUFFICIENT",
    "data_source": "live",
    "provenance_status": "VERIFIED"
  },
  "data_note": "No comparison value is invented. Empty arrays and null metrics mean the selected area/date range has no paired evidence."
}
```

`r_squared` is `null` when undefined. A numeric `0` means the model explains none of the
observed variance; it is not a validation claim.

### `GET /analytics/anomalies`

Robust seasonal median/MAD anomalies. Only dates with observations are scored, and only when
at least three other years of history exist for the month. Anomalies are not forecasts.
Live NRT has no multi-year history, so live anomaly results are normally empty and
`insufficient_data`.

### `GET /analytics/calibration`

Evaluates the **fixed** exploratory formula in-sample. Because this is not an independent
holdout, the status is `INSUFFICIENT`; it is never `EXPLORATORY` as a calibration result and
never `VALIDATED`.

Status definitions are included in the response:
- `INSUFFICIENT`: the explicit validation criteria are not met, including in-sample-only
  evidence or undefined R².
- `EXPLORATORY`: the harmonization layer is exploratory; no calibration result uses this label.
- `CALIBRATED`: a model was fitted with uncertainty, but independent validation is incomplete.
- `VALIDATED`: all explicit holdout/sample/uncertainty criteria were met.

`r_squared` is `null` when undefined, never `0` as a substitute.

### `GET /analytics/calibration/holdout`

Temporal holdout split of paired cells. `VALIDATED` is possible only when all criteria are
met (≥30 training cells, ≥10 independent validation cells, strict temporal separation,
finite metrics and non-zero reference variance). Without a real historical dataset the
expected status is `INSUFFICIENT`.

### `GET /analytics/timeseries`

Observed daily series only. Each point contains separate `modis_count`, `viirs_count`,
`harmonized_units` (exploratory) and `total_frp_mw`.

---

## Exports

All CSV exports include comment metadata rows (`# FireSync export metadata`) with
`data_source`, `provenance_status`, `retrieved_at`, `cached`, `source_errors`, `truncated`,
AOI/bbox/date/sensor scope, processing version, harmonization status and calibration status.
Cell values are sanitized against spreadsheet formula injection (CWE-1236).

| Endpoint | Contents |
|---|---|
| `GET /export/csv?dataset=all\|raw\|modis\|viirs` | Raw canonical observations, never mixing sensors in a single-sensor export |
| `GET /export/matched.csv` | Matched MODIS–VIIRS point pairs with distance/time difference |
| `GET /export/harmonized.csv` | 1 km daily cells with the exploratory harmonized index |
| `GET /export/calendar.csv` | Observed daily summaries; missing dates are not emitted |
| `GET /export/validation.csv` | Calibration diagnostic metrics (nullable fields) |
| `GET /export/provenance.csv` | Provenance manifest: data source, live cache state, local-store provenance, checksum note, storage and products |

The provenance export contains no `archive_provenance` field because no bundled archive is
used. It reports the live source and the local store separately.

---

## Live fires

### `GET /fires?area=west,south,east,north&days=1..5`

Enabled when the server has a FIRMS key. `area=world` is accepted for the full globe.
Requests are cached for 30 minutes, retried with backoff, rate-budgeted and the key is
masked in errors/logs. Products are NRT only.

The `cap` parameter limits detections **per source**, with a minimum of 1,000 per source.
When the cap is hit, `truncated: true` is returned. A world request with `cap=5` therefore
returns up to 3,000 detections (MODIS 1,000 + VIIRS 2,000) while `truncated` remains true.
Use the aggregate analytics endpoints for complete counts.

---

## Ingestion (server-side NRT Area API)

### `POST /ingestion/trigger`

Body:
```json
{
  "bbox": "88,20.5,92.8,26.7",
  "day_range": 3,
  "date": "2026-11-01",
  "products": ["MODIS_NRT", "VIIRS_NOAA20_NRT"]
}
```

- `day_range` must be 1–5.
- `products` may only contain `MODIS_NRT`, `VIIRS_NOAA20_NRT`, `VIIRS_NOAA21_NRT`.
- Without `FIRMS_MAP_KEY` the route returns `503` with `code: "FIRMS_KEY_NOT_CONFIGURED"`.
- On success it returns `202` with a real job. Poll the job endpoint for the outcome.

### `GET /ingestion/jobs`

Lists real execution records only. No seed or placeholder jobs are created.

### `GET /ingestion/jobs/:id`

Returns one job or `404`.

Job fields include `status` (`pending`, `running`, `completed`, `failed`, `cancelled`),
`records_imported` (nullable), `checksum` (nullable), `retrieved_at`, `completed_at`,
`provenance_status` and `error_message`. A failed download is never reported as success;
`records_imported` is the number actually added after deduplication.

### `POST /ingestion/jobs/:id/cancel`

Cancels a non-terminal job. A terminal job returns `409`.

### `POST /ingestion/test-key`

Tests the **server-configured** key against NASA. The browser never supplies a key. If no key
is configured the route returns `400` with `valid: false` and makes no NASA request.

---

## Historical archive (local Parquet, 2000–2025)

All `/history/*` routes read the local DuckDB/Parquet store built by
`data_pipeline/`. MODIS and VIIRS are always separate; missing periods are
unavailable data, never zero. Every response carries the legend
`Satellite thermal anomalies, not confirmed wildfires or burned area.`

| Route | Query parameters | Returns |
|---|---|---|
| `GET /history/status` | — | Per-sensor year ranges, min/max dates, row counts, availability |
| `GET /history/daily` | `year`, `month`, `start_date`, `end_date`, `sensor`, `country`, `level=daily\|monthly`, `global=true`, `limit` | Period × country × sensor rows (`detections`, `frp_sum_mw`, `frp_max_mw`, day/night counts) |
| `GET /history/observations` | `date` (required), `sensor`, `bbox`, `country`, `satellite`, `daynight=D\|N`, `min_frp`, `limit` | Canonical observations for one archive date, ordered by FRP |
| `GET /history/coverage` | `sensor` | Dates with any archive rows per sensor (absence ≠ zero fire) |
| `GET /history/year/:sensor/:year` | path params | One sensor-year aggregate totals |
| `GET /history/rankings` | `year` (required), `sensor` | Per-country detection totals for one year |
| `GET /history/frp-extremes` | `start_year`, `end_year`, `sensor`, `country`, `limit` | Highest daily `frp_max_mw` rows (daily maxima, not single-observation maxima) |
| `GET /history/persistence` | `start_year`, `end_year`, `sensor`, `limit` | Countries ranked by distinct years with data (recurring-activity proxy) |
| `GET /history/month-anomaly` | `year`, `month` (required), `sensor`, `country`, `limit` | Each country+sensor vs the median of the same month in other archive years; statistical variation only |
| `GET /history/countries` | — | Distinct country labels in the monthly aggregates |
| `GET /history/climatology` | `country` **or** `bbox`, `sensor`, `start_year`, `end_year` | Monthly climatology: per-sensor medians/quartiles, `harmonized_equivalent_median` (EXPLORATORY, fixed 0.294 coefficient), activity classes, season summary |
| `GET /history/seasonal-status` | `country` (required), `sensor`, `date`, `window_days`, `observed_modis`, `observed_viirs` | Today's day-of-year window distribution vs archive years + upcoming-month activity classes |

CSV exports mirror the analytics routes under `/history/export/*`
(`daily`, `observations`, `coverage`, `frp-extremes`, `month-anomaly`,
`persistence`, `climatology`).

## AgniCalendar (harmonized grid, 2002–2025)

Reads the local `AgniCalendar_Global_Harmonized_CellMonth` Parquet (10 km
EPSG:8857 cells × UTC month × fire_type). `layer=aqua|snpp|harmonized`,
`daynight=day|night|unknown|known` (known = DAY+NIGHT only when both observed),
`fire_type=0|1|2|3|UNKNOWN|all` (default `0`). Scope: `bbox=west,south,east,north`
or `country=` (majority-vote cell→country lookup; overrides bbox).
`start_year`/`end_year`/`year`/`month` filter the window (dataset 2002-07→2025-12).

| Route | Returns |
|---|---|
| `GET /agnicalendar/status` | Availability, row count, year/month range, per-layer coverage, support statuses, caveats |
| `GET /agnicalendar/countries` | Country labels available in the cell→country lookup |
| `GET /agnicalendar/series` | Monthly detection sums + cells-with-data per year/month |
| `GET /agnicalendar/calendar` | Same rows as series (month×year matrix for the UI) |
| `GET /agnicalendar/cells` | Top cells by value with cell-centre lon/lat |
| `GET /agnicalendar/cells.geojson` | Cell polygons for the map overlay (`truncated` when limit hit) |
| `GET /agnicalendar/export/series.csv` | CSV of the series |

Harmonized values are RF-B model estimates on
`APPROVED_CONDITIONAL_JOINT_POSITIVE` support only — never added to raw counts.

## Official incidents (US wildland fires)

### `GET /incidents?days=14&state=US-CA&source=live|store`

Current US incidents from WFIGS/IRWIN (public ArcGIS, no key, ~5-min server
cache). `days` 1–60 (default 14), `state` as `US-XX`, `source` chooses live
NRT or the local store for corroboration matching (10 km / ±72 h around
discovery). Each incident reports `satellite_corroborated`,
`no_nearby_detections` or `unmatchable` — corroboration is proximity evidence,
never confirmation. RX = prescribed fire.

## AI assistant

| Route | Purpose |
|---|---|
| `GET /ai/status` | Provider, model, capabilities, limits (no key material) |
| `POST /ai/chat` | Chat with tool calling; deterministic fast paths answer factual questions without a model call |
| `POST /ai/detection-explanation` | Explain a single detection (evidence card) |
| `POST /ai/cluster-investigation` | Investigate a spatial cluster |
| `POST /ai/sensor-explanation` | MODIS vs VIIRS sensor comparison text |
| `POST /ai/geographic-analysis` | Geographic intelligence summary |
| `POST /ai/scientific-audit` | Integrity audit of a result set |
| `POST /ai/report` | Explainable report generation |
| `POST /ai/watchlist-alert` | Watchlist alert evaluation |

AI routes require `GROQ_API_KEY` server-side (`FIRESYNC_AI_ENABLED`); without
it they return an explicit disabled response. All numeric output comes from
deterministic tools — the model only explains.

## Watchlists & scenario

| Route | Purpose |
|---|---|
| `GET/POST /watchlists`, `POST /watchlists/:id/pause`, `POST /watchlists/:id/check`, `POST /watchlists/alerts/:id/acknowledge` | User-defined area watchlists with scheduled checks and alerts (`FIRESYNC_WATCHLIST_PATH` for durability) |
| `POST /scenario/analyze` | Scenario Laboratory — qualitative what-if analysis; no predictive claims |

## Geo intelligence

`/geo/*` routes (`clusters`, `compare`, `coverage`, `cross-border`, `density`,
`proximity`, `regions/compare`, `weather`, `datasets/status`) plus
`landcover`/`terrain`/`population` which return honest `unavailable` results —
the required datasets are not bundled.

---

## Error behaviour

| Status | Meaning |
|---|---|
| `400` | Invalid date, bbox, AOI, sensor, dataset, ingestion payload or live-window request (`code: "LIVE_WINDOW"`) |
| `404` | Unknown job or unknown API route |
| `409` | Job already terminal |
| `502` | NASA FIRMS rejected the server key or all live sources failed |
| `503` | FIRMS key missing for ingestion/live routes |
| `500` | Unexpected server error |

No route fabricates records, checksums, availability or calibration metrics.

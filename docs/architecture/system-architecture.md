# FireSync System Architecture & Service Specification

**Project:** FireSync — Harmonized Fire Activity Intelligence  
**Competition:** NASA Space Apps Challenge 2026  
**Document:** System Architecture Specification (Option A: Full-Stack Express with Headless Python Data Pipeline)

---

## 1. System Overview Diagram

```
+-----------------------------------------------------------------------------------+
|                                 CLIENT TIER                                       |
|                                                                                   |
|  React 19 SPA (Vite + TypeScript + Tailwind CSS)                                  |
|  +------------------------+  +--------------------------+  +-------------------+  |
|  | MapLibre GL Explorer   |  | Burning Activity Calendar|  | Sensor Diagnostics|  |
|  +------------------------+  +--------------------------+  +-------------------+  |
+------------------------------------------+----------------------------------------+
                                           | HTTP / REST API (Port 3000)
                                           v
+-----------------------------------------------------------------------------------+
|                       FULL-STACK API LAYER (Express / Node.js)                    |
|                                                                                   |
|  server.ts                                                                        |
|  +-----------------------------------------------------------------------------+  |
|  | Routes: /api/v1/health, /api/v1/metadata, /api/v1/hotspots                  |  |
|  |         /api/v1/calendar, /api/v1/analytics/*, /api/v1/export/*            |  |
|  |         /api/v1/ingestion/*                                                 |  |
|  +-----------------------------------------------------------------------------+  |
|  | Core Geospatial & Harmonization Engine:                                     |  |
|  | - Cylindrical Equal-Area Projections (1-km cell indexing)                   |  |
|  | - Fixed-coefficient exploratory harmonization (not a fitted GLM)            |  |
|  | - Robust seasonal MAD anomaly detection & Z-scores                         |  |
|  | - Formula-sanitized CSV export generation (CWE-1236 defense)               |  |
|  +-----------------------------------------------------------------------------+  |
+----------------------+------------------------------------+-----------------------+
                       |                                    |
          In-Memory / Read-Through Cache         Subprocess / Direct Trigger
                       v                                    v
+----------------------------------+    +-------------------------------------------+
|    CANONICAL OBSERVATION STORE   |    |    PYTHON DATA PIPELINE & SCIENTIFIC CLI  |
|                                  |    |                                           |
| - Empty at startup; no seed      |    | data_pipeline/run_pipeline.py             |
| - Only completed real ingestion  |    | - NASA FIRMS API Client                   |
|   jobs add records               |    | - SHA-256 Checksum Calculation            |
| - Deduplicated Observation Hash  |    | - Schema Normalization & Quality Filters  |
| - In-memory + optional JSON file |    | - Raw CSV + manifest preservation         |
|   store; PostGIS not integrated  |    |                                           |
+----------------------------------+    +-------------------------------------------+
                                                            |
                                                            v
                                        +-------------------------------------------+
                                        |          OFFICIAL DATA SOURCES            |
                                        |                                           |
                                        | NASA FIRMS (MODAPS EOSDIS)                |
                                        | - MODIS C6.1 (Terra/Aqua)                 |
                                        | - VIIRS 375m (Suomi-NPP / NOAA-20 / 21)   |
                                        +-------------------------------------------+
```

---

## 2. Service Ownership & Responsibilities

### 2.1 Full-Stack Express Server (`server.ts`)
- **Port:** `3000` (serves both static Vite frontend and `/api/v1/*` endpoints).
- **Responsibilities:**
  - Global live NASA FIRMS NRT delivery through one shared `LiveFiresService` (cache,
    in-flight deduplication and rate budget), with a capped world overview for the map.
  - Server-side spatial filtering by bounding box ($W, S, E, N$), optional polygon AOI,
    and date ranges.
  - Server-side live aggregates for hotspots, calendars, summaries, anomalies, sensor
    comparison and exports, so ~100k world detections are not shipped to the browser on
    every page load.
  - Dynamic 1-km equal-area cell aggregation and real-time Burning Activity Unit (BAU) calculation.
  - Historical baseline median and MAD anomaly scoring when enough history exists.
  - Sanitized CSV exports for raw MODIS/VIIRS, matched pairs, harmonized cells, calendar,
    validation and provenance (`/api/v1/export/*`).
  - Server-side FIRMS key handling: the key is read from the environment and never
    returned to the browser.
  - Honest rejection of historical live requests with `400 LIVE_WINDOW`; no archive
    fallback exists.

### 2.2 Python Geospatial & Ingestion Pipeline (`data_pipeline/`)
- **Responsibilities:**
  - Batch retrieval of regional FIRMS data from the official Area API, split into
    supported windows (NRT ≤ 5 days, SP ≤ 10 days).
  - Raw CSV preservation, schema normalization into the Canonical Observation Schema.
  - Calculation of record hashes and SHA-256 file checksums for reproducibility.
  - Generation of run manifests, quality reports and coverage reports under
    `reports/data_pipeline/<run_id>/`.
  - Resume/retry through a durable local JSON job queue.
  - Offline diagnostic evaluation of calibration and temporal holdout (no validated
    model is produced).

---

## 3. Data Flow & Database Architecture

### 3.1 Request Flow
1. **Frontend to API:** The React frontend defaults to **World** and makes REST requests to `/api/v1/*` with `source=live` (e.g. `/api/v1/hotspots?source=live&days=1&bbox=-180,-90,180,90`). A polygon AOI is passed as `aoi=lon,lat;lon,lat;...`.
2. **Live Fetch:** Express asks the shared `LiveFiresService` for the official FIRMS NRT products. Identical requests share one cache entry and one upstream round-trip. A failed source is reported in `source_errors`; if every source fails, the request returns a classified `502`, never fake data.
3. **Server-Side Filtering and Gridding:** Express applies bbox as a preliminary filter, then point-in-polygon filtering when an AOI is present. It projects coordinates through `projectToEqualAreaKm`, assigns observations into 1-km cells, and computes the harmonized activity index.
4. **Response Computation:** Cell dictionaries are computed in memory. The map requests a capped world overview; non-map pages receive aggregates. No production latency benchmark has been recorded.

### 3.2 Database Ownership
- **Running application:** `src/server/store.ts` provides an in-memory store that starts **empty**, with optional JSON persistence via `FIRESYNC_STORE_PATH`. There is no bundled seed; `src/data/nasa_firms_archive.ts` was removed. Only a completed real ingestion job adds records, and a mixed or empty store remains `UNVERIFIED`.
- **Optional infrastructure:** `docker-compose.yml` defines PostgreSQL/PostGIS and Redis profiles, but they are not integrated with the Express runtime and are not required to run the app.
- **Schema:** the canonical observation shape lives in `src/types/fire.ts` (`CanonicalObservation`); there is no separate schema file or ORM model.
- **Indexes (future):**
  - `idx_obs_date_sensor` on `(acq_date, sensor)` for temporal queries.
  - `idx_obs_geo` on `(latitude, longitude)` for spatial bounding box scans.

---

## 4. Ingestion Workflow & Job Persistence

1. **Triggering:**
   - Ingestion jobs are triggered via `POST /api/v1/ingestion/trigger` or through the CLI
     `python data_pipeline/run_pipeline.py --region bangladesh --start 2024-01-01 --end 2024-01-10 --products MODIS_SP --download`.
2. **Job Tracking:**
   - Ingestion jobs record unique job IDs, sensor platform, target region, temporal range,
     status (`running`, `completed`, `failed`), imported record counts, and SHA-256 checksums
     of the preserved raw files.
3. **Idempotency:**
   - Each canonical observation includes a unique `record_hash` generated from `(sensor, satellite, acq_date, acq_time, lat, lon, frp)`. Duplicate records are skipped during ingestion.
4. **Failure Propagation:**
   - If NASA FIRMS returns an authentication or service error, the ingestion pipeline records the HTTP status, returns a structured error, and marks the job `failed` without corrupting existing stored observations.

## 5. Historical stores and integration boundaries

The live observation store is separate from two local DuckDB/Parquet products:
the [country observation archive](../historical-archive.md) and the
[monthly AgniCalendar grid](../agnicalendar.md). They have different populations,
grains and scope rules. The [model provenance](../data/model-provenance.md) records
the conditional RF-B policy; live BAU and monthly estimates are not one continuous series.
Windows data builders must use an interpreter with DuckDB installed, as documented in
the archive and pipeline guides. Large data files are supplied separately from Git.

AI explanations use deterministic data tools in `src/server/ai/`; they do not supply
missing observations. Provider model availability and quotas can delay explanations,
while deterministic APIs remain independent. Configuration belongs in the
[configuration guide](../guides/configuration.md), not in copied handoff prompts.

Official incident matching is US-only WFIGS/IRWIN corroboration, not global incident
confirmation. Keep `source=live` versus `source=store` explicit when inspecting it.
NOAA-20/21 live observations do not extend the frozen SNPP archive or RF-B population.

Scene-image analysis, historical weather, population/settlement exposure, terrain and
land-cover integrations require their own genuine datasets and supported processing.
The [feature catalog](../../src/utils/aiFeatureCatalog.ts) owns current availability;
qualitative scenarios do not establish validated spread predictions. Country labels
retain source provenance; name normalization must preserve that traceability.

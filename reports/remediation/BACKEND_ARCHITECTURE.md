# Backend Architecture

**Date:** 2026-11-10
**Primary application API:** Express 4 (`server.ts`, `src/server/app.ts`)
**Primary storage:** in-memory, **empty at startup**; optional JSON file adapter
**Live data:** shared `LiveFiresService` (`src/server/liveFires.ts`) for the official NASA
FIRMS NRT Area API
**Optional backend:** FastAPI skeleton (experimental, not the application API)
**Historical ingestion:** standalone Python pipeline (`data_pipeline/`)

---

## 1. Decision

Express remains the primary application API.

Reasons:

- It already serves the React application and owns every `/api/v1/*` route used by the UI.
- It is covered by 20 API/ingestion integration tests.
- Moving to FastAPI would duplicate routes, split the API contract and add a migration with
  no functional benefit for this submission.
- The Python pipeline is independently executable and does not need to be an HTTP service.

FastAPI is retained only as an optional, experimental skeleton. It is **not** the
application API, does **not** serve the React build, and does **not** read or write
PostgreSQL/PostGIS.

---

## 2. Runtime topology

```
Browser (React 19 + Vite build)
        |
        |  /api/v1/*            static / in production
        v
Express 4  (server.ts)
  ├─ src/server/app.ts        routes, source resolver, AOI, analytics, exports
  ├─ src/server/liveFires.ts  shared live FIRMS NRT service (cache, in-flight, budget)
  ├─ src/server/store.ts      empty-at-start memory or JSON-file observation store
  ├─ src/server/ingestion.ts  real FIRMS NRT Area API ingestion
  └─ src/utils/*              spatial, matching, harmonization, anomaly, CSV

Development: Vite middleware (HMR) mounted after API routes
Production:  express.static(dist/) + SPA fallback; no Vite at runtime
```

### 2.1 Development mode

`NODE_ENV !== 'production'`:

- `server.ts` creates the Express app.
- It dynamically imports Vite and mounts `vite.middlewares`.
- API routes are registered before Vite, so `/api/v1/*` is never handled by Vite.
- This mode is for local development only.

### 2.2 Production mode

`NODE_ENV === 'production'`:

- `server.ts` requires `dist/index.html`. If the build is absent, the process exits with
  an explicit error. It never falls back to Vite.
- `express.static(dist, { index: false, maxAge: '1h' })` serves assets.
- A GET fallback returns `dist/index.html` for client-side routes, except `/api/*`.
- This is the path used by the Docker image.

---

## 3. API surface

All routes are implemented in `src/server/app.ts` and tested through `createApp()`.

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/v1/health` | Truthful storage, provenance, FIRMS and calibration status |
| GET | `/api/v1/metadata` | Project, regions, products, metrics, processing version |
| GET | `/api/v1/data-availability` | Local **store** counts and official product status |
| GET | `/api/v1/fires` | Live FIRMS NRT proxy (when enabled and configured) |
| GET | `/api/v1/hotspots` | Filtered observations with bbox + polygon AOI |
| GET | `/api/v1/calendar` | Observed daily summaries with baselines |
| GET | `/api/v1/analytics/summary` | KPIs and sensor-separated counts |
| GET | `/api/v1/analytics/sensors` | Sensor comparison and matching diagnostics |
| GET | `/api/v1/analytics/anomalies` | Median/MAD anomaly evidence |
| GET | `/api/v1/analytics/calibration` | Fixed-coefficient in-sample diagnostic |
| GET | `/api/v1/analytics/calibration/holdout` | Temporal holdout criteria check |
| GET | `/api/v1/analytics/timeseries` | Daily series |
| GET | `/api/v1/export/csv` | Raw observations (sensor-scoped by query) |
| GET | `/api/v1/export/matched.csv` | Matched MODIS–VIIRS pairs |
| GET | `/api/v1/export/harmonized.csv` | Exploratory harmonized cells |
| GET | `/api/v1/export/calendar.csv` | Observed-day calendar statistics |
| GET | `/api/v1/export/validation.csv` | Calibration/validation evidence |
| GET | `/api/v1/export/provenance.csv` | Provenance manifest |
| GET | `/api/v1/ingestion/jobs` | Real job records only |
| GET | `/api/v1/ingestion/jobs/:id` | One real job |
| POST | `/api/v1/ingestion/jobs/:id/cancel` | Cancel a non-terminal job |
| POST | `/api/v1/ingestion/test-key` | Test the server-configured FIRMS key |
| POST | `/api/v1/ingestion/trigger` | Start a real NRT ingestion job |

### 3.1 Filter semantics

- `source` selects `store` (API default) or `live` (what the frontend sends).
- `bbox` is a preliminary filter: `west,south,east,north`.
- `aoi` is a polygon in `[lon,lat]` order: `lon,lat;lon,lat;...`.
- Polygon filtering is applied **after** the bbox filter.
- Boundary points are inside; antimeridian-crossing rings are handled.
- Invalid AOI geometry returns `400`.
- `sensors` accepts `MODIS`, `VIIRS` and `ALL`; unknown values are rejected.
- `start_date` / `end_date` must be real calendar dates and correctly ordered.
- `source=live` accepts only the rolling last 1–5 days; older dates return
  `400 LIVE_WINDOW`.
- `limit` is capped at 2000; `offset` is supported.

### 3.1.1 Shared live service

`src/server/liveFires.ts` is the only path to the FIRMS NRT Area API. `/api/v1/fires` and
every endpoint requested with `source=live` share:

- one 30-minute TTL cache keyed by area/window/cap;
- one in-flight request map, so identical concurrent requests do not duplicate NASA calls;
- one local rate budget;
- one error classifier, including `Invalid MAP_KEY` → `502` with a masked message.

Non-map pages use server-side aggregates (`cap = 100000` per source). The map requests a
capped world overview (`WORLD_OVERVIEW_CAP = 5000` per source) and reports
`truncated: true`. The full ~100k world response is never shipped to the browser on every
page load.

### 3.2 Status semantics

| Field | Honest value |
|---|---|
| `health.database.storage_type` | `memory` or `json_file` |
| `health.database.durable` | `false` or `true` |
| `health.database.postgis_active` | always `false` (not integrated) |
| `health.database.records_count` | `0` until a completed real ingestion job |
| `health.provenance.local_store_status` | `UNVERIFIED` while empty; `VERIFIED` only when every record came from a completed real job |
| `health.calibration.status` | `INSUFFICIENT` (actual evidence) |
| `health.calibration.harmonization_status` | `EXPLORATORY` (layer label) |
| `analytics/calibration.status` | `INSUFFICIENT` for every non-`VALIDATED` outcome, including in-sample |
| `analytics/calibration/holdout.status` | `VALIDATED` only when every explicit criterion is met |
| `ingestion.trigger` without key | `503` + `FIRMS_KEY_NOT_CONFIGURED` |
| `ingestion.trigger` invalid body | `400` + `INVALID_REQUEST` |
| Unknown job | `404` |
| Cancel terminal job | `409` |
| Historical `source=live` request | `400` + `LIVE_WINDOW` |

Exports carry `data_source`, `provenance_status`, `retrieved_at`, `cached`,
`source_errors`, `truncated`, `harmonization_status`, `calibration_status`,
`processing_version`, AOI/date/sensor scope, BAU definition, coverage status and export
timestamp. There is **no** `archive_provenance` field because no bundled archive exists.

---

## 4. Persistence

### 4.1 Default: memory

`MemoryObservationStore` is the default. It starts **empty** and is explicitly **not
durable**:

- no bundled seed, demo fixture or synthetic observation is pre-loaded;
- data is lost on restart;
- `kind: 'memory'`, `durable: false`;
- the API and UI must not describe it as a database;
- `/data-availability` reports `data_status: "empty"` and
  `provenance_status: "UNVERIFIED"` with an explicit reason.

### 4.2 Optional: JSON file

`JsonFileObservationStore` is selected with `FIRESYNC_STORE_PATH`:

- plain JSON file, written atomically through a temporary file;
- `kind: 'json_file'`, `durable: true`;
- stores observations and real ingestion jobs;
- starts empty unless the file already contains records from earlier completed jobs;
- deduplicates by canonical observation key;
- records SHA-256 where applicable.

It is **not** PostgreSQL/PostGIS:

- no spatial index;
- no SQL;
- no multi-process locking;
- no transactional guarantees beyond atomic file replacement.

PostgreSQL/PostGIS and Redis exist only as optional Docker Compose profiles. They are not
integrated into the application and must not be described as active.

---

## 5. Ingestion boundary

### 5.1 Server ingestion (NRT)

`src/server/ingestion.ts` uses the official FIRMS Area API:

- supported live products: `MODIS_NRT`, `VIIRS_NOAA20_NRT`, `VIIRS_NOAA21_NRT`;
- 1–5 day windows (default validated by `validateIngestionRequest`);
- `FIRMS_MAP_KEY` is read only from the server environment;
- raw CSV is preserved under `data/raw/<product>/`;
- SHA-256 is computed for the response and the written file; a mismatch fails the job;
- `source_manifest.json` and `checksums.json` are written;
- records are deduplicated and the real `records_imported` count is stored;
- jobs have real `pending`, `running`, `completed`, `failed`, `cancelled` states;
- errors are masked; the key never appears in job records or responses;
- missing key → `503`, no job, no simulated success.

The server does not perform multi-year historical downloads. The Area API is not a bulk
archive service.

### 5.2 Historical pipeline (Python)

`data_pipeline/run_pipeline.py` is a standalone, standard-library-only pipeline:

- configurable region/bbox/dates/products;
- 1–10 day windows (default 5; NRT 1–5);
- `--download` or validation-only mode;
- durable local JSON job queue;
- retries, resume and `--force`;
- raw preservation, source manifest, SHA-256, quality reports;
- canonical normalization with explicit rejection reasons;
- statuses `completed`, `completed_empty`, `partial`, `failed`;
- provenance `VERIFIED`, `PARTIAL`, `UNVERIFIED`.

The interface between the pipeline and the application is the data files and manifests,
not a shared database. This keeps the pipeline independently executable and avoids a
second HTTP API.

### 5.3 FastAPI skeleton

`backend/app/main.py` is optional and experimental:

- does not serve the React application;
- does not implement the application routes;
- `/api/v1/health` reports `"database": "not integrated"`;
- `DATABASE_URL` has no default credentials;
- CORS defaults to `http://localhost:3000`, not `*`.

It can be removed or developed independently without affecting the primary application.

---

## 6. Deployment

### 6.1 Docker image

`Dockerfile` is multi-stage:

1. build stage: `npm ci`, `npm run build`;
2. runtime stage: production dependencies, `dist/`, `src/`, `server.ts`, config, `data/`.

The runtime uses `npm start` (`tsx server.ts`) with `NODE_ENV=production`. It does not need
Vite.

### 6.2 Compose

`docker-compose.yml`:

- `app` is the only required service;
- `FIRMS_MAP_KEY` is optional; without it live/ingestion features stay disabled;
- `FIRESYNC_STORE_PATH=/app/data/store/firesync_store.json` enables JSON persistence;
- a named volume `firesync_data` persists `/app/data`;
- healthcheck hits `/api/v1/health`;
- `postgis` and `redis` are optional profiles and are **not** integrated;
- `POSTGRES_PASSWORD` is mandatory for the PostGIS profile and has no default.

### 6.3 Verification status

The production build and API were smoke-tested directly with `tsx` in production mode.
The Docker image build and container startup were **not** executed in this environment.
The documented Docker procedure must be tested before deployment.

---

## 7. API integrity and limitations

### 7.1 What is enforced

- No fabricated records, checksums, job IDs or success states.
- No random values in scientific responses.
- Missing observations are not zero.
- R² is `null` when undefined.
- Raw MODIS and VIIRS counts are never summed.
- Exports are sensor-separated and carry provenance/model metadata.
- CSV formula injection is sanitized (CWE-1236).
- Secrets are masked in logs, manifests, job records and errors.

### 7.2 Residual limitations

- No authentication or authorization; ingestion endpoints are reachable by anyone who can
  reach the server.
- No rate limiting or CSRF protection.
- The JSON store has no multi-process locking.
- PostGIS/Redis are not integrated.
- No real historical archive is present; only the rolling 1–5 day live NRT window exists.
- The local store is empty at startup and is `UNVERIFIED` until a completed real job adds
  records.
- Docker startup is untested here.
- Live FIRMS NRT was verified with a real key on 2026-11-10 (31 records, 3 raw CSVs,
  3/3 SHA-256 match) and the world 1-day aggregate returned 103,131 detections with zero
  source errors. The exposed key still needs rotation.

---

## 8. Summary

| Concern | Decision |
|---|---|
| Primary API | Express 4 |
| Duplicate API | None; FastAPI is optional/experimental |
| Default storage | Memory, empty at startup, explicitly not durable |
| Persistent adapter | Optional JSON file via `FIRESYNC_STORE_PATH` |
| Spatial database | Not integrated; PostGIS profile is optional only |
| Live data path | Shared `LiveFiresService`; rolling 1–5 day FIRMS NRT |
| Server ingestion | Real FIRMS NRT Area API, 1–5 day windows |
| Historical ingestion | Standalone Python pipeline, raw + manifests + checksums; not yet run |
| Production frontend | Static `dist/` + SPA fallback, no Vite |
| Fake success | Removed; missing configuration returns an explicit error |
| Archive fallback | None; historical live requests return `400 LIVE_WINDOW` |

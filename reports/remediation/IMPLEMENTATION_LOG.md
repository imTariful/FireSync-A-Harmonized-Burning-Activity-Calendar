# Implementation Log — FireSync Remediation

**Period:** 2026-11-09 to 2026-11-10
**Scope:** security, provenance, ingestion, calibration, AOI, analytics, exports, global
live NRT, docs, tests

This log records what was actually changed and what was actually run. It does not claim
external verification that could not be performed.

> **Post-log update (2026-11-10):** the NRT Area API was exercised with a valid NASA key:
> 31 records imported across three products, three raw CSVs preserved and all three
> SHA-256 values matched. The suite is now **422/422 across 36 files**. A later round
> removed the bundled archive, made World the default and added the shared live service
> (Phase 10). The historical standard-science/Earthdata archive download remains not run.
> See `FINAL_VERIFICATION_REPORT.md` §4.2. The key was shared in chat and must be rotated.

---

## Phase 0 — Baseline audit and safety

### Inspected
- Repository structure, README, `CHANGES.md`, docs, tests, `server.ts`, `src/server/`,
  `src/utils/`, `data_pipeline/`, `backend/`, Docker files.

### Baseline results
- `npm install`: completed
- `npm run lint`: pass
- `npm test`: 392/392 pass, 33 files
- `npm run build`: pass

### Security changes
- `.env.example` reduced to placeholders; no real key.
- `docker-compose.yml`: removed hardcoded password; `POSTGRES_PASSWORD` is now mandatory for
  the optional PostGIS profile; app service added with healthcheck; PostGIS/Redis are optional
  profiles.
- Added `Dockerfile` and `.dockerignore`; removed `.dockerignore` from `.gitignore`.
- Added server-side secret masking (`maskSecret`) and masked URLs in ingestion/manifests.
- Removed the default password-bearing `DATABASE_URL` from the FastAPI config.

### Reports created
`INITIAL_AUDIT.md`, `SECURITY_REMEDIATION.md`, `PROVENANCE_REPORT.md`.

---

## Phase 1 — Scientific correctness

### Files changed
- `src/utils/harmonization.ts`
  - `fitLinearModel` returns `r_squared: null` when n < 2 or reference variance is zero.
  - `evaluateCalibrationModel` evaluates the fixed coefficient in-sample and never returns
    `VALIDATED`; returns `INSUFFICIENT` for n = 0 or zero reference variance.
  - `evaluateTemporalHoldout` added with explicit criteria (≥30 training, ≥10 validation,
    temporal separation, finite metrics, non-zero reference variance).
  - `buildDailySummariesFromCells` emits observed dates only, with
    `coverage_status: 'observed'`.
- `src/types/fire.ts`
  - Nullable calibration metrics, uppercase `CalibrationStatus`, `ProvenanceStatus`,
    `CoverageStatus`, `AoiPolygon`, real ingestion job states.
- `src/data/validationEvidence.ts`
  - Normalises old evidence files: zero-variance R² becomes `null`, status becomes
    `INSUFFICIENT`; sentence says "null rather than 0".
- `src/components/charts/CalibrationDiagnosticChart.tsx`
  - Real paired points only; nullable metrics; honest status badge; no fake regression.
- `src/pages/SensorComparisonPage.tsx`
  - Renders `comparisonData`: paired cells, matched points, FRP, matching diagnostics,
    insufficient-data states.
- `src/pages/MethodologyPage.tsx`
  - Documents the real fixed formula, statuses, AOI, coverage and validation criteria.

### Tests
- `src/utils/harmonization.test.ts` updated for null R², insufficient data and holdout criteria.
- `src/data/validationEvidence.test.ts` and
  `src/components/harmonize/ValidationEvidenceSection.test.tsx` updated to assert the
  corrected nullable/uppercase semantics.

---

## Phase 2 — Provenance

### Files changed
- `src/server/store.ts`
  - Added `MemoryObservationStore`, `JsonFileObservationStore`, `observationKey`, `sha256`,
    `createStoreFromEnv`. The store starts **empty**; no seed is loaded.
- Exports include provenance metadata rows; `provenance.csv` added.
- `docs/pipeline.md` and `PROVENANCE_REPORT.md` explain checksum ≠ authenticity.

> **Superseded on 2026-11-10:** this phase originally added a bundled
> `src/data/nasa_firms_archive.ts` seed marked `UNVERIFIED`. That file was deleted and the
> seed was removed in Phase 10. The current store has no bundled or synthetic records.

### Tests
- `src/utils/csv_export.test.ts` (existing) plus API tests assert metadata and formula
  sanitization.

---

## Phase 3 — Historical ingestion

### Python pipeline rewritten (stdlib only)
- `data_pipeline/firms_api_client.py`
  - `urllib` HTTP with retries/backoff, 429 handling, real status/attempts/bytes/SHA-256,
    CSV header validation, masked key, key-status and availability checks.
- `data_pipeline/tile_window_generator.py`
  - 1–10 day windows (default 5); NRT 1–5; advisory product ranges only; no placeholder jobs.
- `data_pipeline/job_queue.py`
  - Durable JSON queue; real pending/running/completed/failed/cancelled states; retries,
    `begin`, `reset_for_retry`, `completed_keys`.
- `data_pipeline/run_pipeline.py`
  - Configurable region/bbox/dates/products; download or validation-only; raw preservation;
    source manifest + SHA-256; resume/force; canonical normalization with real rejections;
    quality reports JSON/MD; statuses `completed`, `completed_empty`, `partial`, `failed`.
- `data_pipeline/fetch_firms_data.py`
  - Now a deprecated thin wrapper delegating to `run_pipeline.py`; no `requests` dependency.

### Verified
- `python -m py_compile` all modules: pass.
- Dry-run 2024-01-01..2024-01-12: 3 windows, no files written.
- Empty raw dir: `failed`, exit 1.
- No key + `--download`: exit 2, no request.
- Synthetic fixture: 2 accepted, 2 rejected with reasons.

---

## Phase 4 — Harmonization and validation semantics

- Fixed 0.294 factor retained as explicitly exploratory.
- Added `evaluateTemporalHoldout`; only it can return `VALIDATED`.
- `scripts/evaluate_holdout_validation.ts` rewritten to run a fixed-coefficient diagnostic
  plus a holdout criteria check; reports honest `INSUFFICIENT` status and null R².
- Generated `reports/calibration_validation.{json,csv,md}`.

---

## Phase 5 — AOI and analytics

### Files added/changed
- `src/utils/polygon.ts`: validation, point-in-polygon (boundary inside), bbox, compact
  encoding, antimeridian-safe ray casting, filtering.
- `src/utils/polygon.test.ts`: 7 tests.
- `src/utils/area.ts`: polygon Area, `areaFromBbox`, `areaFromPolygon`, `AreaScope.aoi`.
- `src/utils/urlState.ts`, `src/utils/shareHelpers.ts`,
  `src/components/explorer/useUrlState.ts`: AOI encode/decode and share state.
- `src/App.tsx`: initializes area from URL AOI and passes `scope.aoi` to analytics/calendar/
  summary/calibration/coverage requests.
- `src/components/map/FireGlobe.tsx`: polygon draw/cancel/finish/clear, vertex capture,
  overlays, fire-click guard.
- `src/components/calendar/BurningCalendar.tsx`: missing days are dashed "no observation
  record", not zero.
- `src/components/calendar/MonthComparisonCard.tsx`, `MonthYearHeatmap.tsx`,
  `src/pages/CalendarPage.tsx`: observed-days-only wording and AOI in export scope.
- `src/server/app.ts`: AOI filtering after bbox; all analytics/export routes accept AOI.

### Tests
- `src/server/app.test.ts`: bbox-only vs AOI filtering, invalid AOI 400, observed-days-only
  calendar, null R², sensor comparison, CSV metadata, provenance, ingestion errors.

---

## Phase 6 — Backend and persistence

- `src/server/app.ts`: `createApp()` factory with all routes; truthful `/health`,
  `/data-availability`, `/metadata`; nullable metrics; separate exports.
- `src/server/ingestion.ts`: real FIRMS Area API fetch (1–5 day windows), retries, raw CSV
  preservation, SHA-256 manifest, dedupe, real job lifecycle, masked secrets.
- `src/server/store.ts`: memory + JSON file adapters (`FIRESYNC_STORE_PATH`); no PostGIS claim.
- `server.ts`: development Vite middleware; production static `dist/` + SPA fallback; explicit
  failure when `dist/` is missing.
- FastAPI skeleton: health no longer claims a database; config has no default password.
- Docker: added `Dockerfile`, healthcheck, optional profiles.

### Tests
- `src/server/ingestion.test.ts`: 8 tests covering validation, success, dedupe, missing key,
  failure, partial success, non-CSV response, key masking.
- Production smoke test: static index 200, health 200, CSV 200.

---

## Phase 7 — Exports and UI

- `src/utils/csv_export.ts`: metadata rows, nullable metrics, `cellsToCsv`,
  `matchedPairsToCsv`, RFC 4180 escaping, formula sanitization preserved.
- `src/server/app.ts`: 8 export endpoints (raw/all, MODIS, VIIRS, matched, harmonized,
  calendar, validation, provenance).
- `src/pages/ExportsPage.tsx`: 8 cards, nullable job fields, status badges, provenance banner.
- `src/pages/SettingsPage.tsx`: server-key status, server-side key test, real NRT ingestion
  with product checkboxes and 1–5 day window, job polling, honest storage notes.
- `src/api/client.ts`: AOI params, nullable comparison fields, new exports, ingestion job
  polling, `testFirmsKey()` with no browser key.

---

## Phase 8 — Documentation and verification

### Docs updated/created
- `README.md` rewritten.
- `CHANGES.md` new remediation section.
- `docs/api/api-reference.md` rewritten.
- `docs/pipeline.md` created.
- `docs/guides/docker.md` created.
- `docs/guides/configuration.md`, `installation.md`, `deployment.md` rewritten.
- `docs/data/ingestion-guide.md` rewritten.
- `docs/methodology/scientific-validation.md` rewritten.
- `docs/methodology/sensor-harmonization.md` corrected.
- Eight remediation reports created.

### Final commands and results
- `npm run lint`: pass.
- `npm test`: **421/421 pass, 36 test files**.
- `npm run build`: pass (large-chunk warning only).
- Production API smoke test: health/hotspots/calibration/holdout/invalid AOI/CSV/static all
  behaved as expected.
- Python compile/dry-run/empty-run/fixture run: pass as described above.
- Real NASA download: **blocked** (no key).
- Docker build/startup: **not tested**.

---

## Phase 9 — Documentation reconciliation (2026-11-10)

### Docs corrected
- `docs/architecture/global-audit.md`: reconciliation banner with current test count,
  API windows, storage, calibration and provenance corrections.
- `docs/architecture/system-architecture.md`: removed the false "Poisson-weighted GLM"
  label and active-PostGIS claim; documented the real store, AOI and pipeline.
- `docs/testing/test-results.md` and `docs/testing/testing-strategy.md`: rewritten with
  actual 421/36 results, smoke tests, Python checks and blockers.
- `docs/data/data-quality.md`, `data-sources.md`, `data-schema.md`: corrected checksum,
  provenance, storage and backup claims.
- `docs/methodology/anomaly-detection.md`, `limitations.md`, `fire-activity-metrics.md`:
  corrected missing-data, test-coverage and R² wording.
- `docs/guides/user-guide.md`, `docs/pitch/storyboard.md`, `docs/data/attributions.md`,
  `docs/methodology/geospatial-methodology.md`, `docs/DOCUMENTATION_SUMMARY.md`: corrected
  statuses, exports, GIBS attribution and AOI documentation.
- Historical reports (`scientific-validation-report.md`, `test_inventory.md`, others)
  carry superseded banners.

### Final commands after documentation-only edits
- `npm run lint`: pass.
- `npm test`: 422/422 pass, 36 files.
- `npm run build`: pass (large-chunk and `__dirname` warnings only).

---

## Phase 10 — Global live NRT, no mock/archive runtime (2026-11-10)

### Runtime and frontend
- `src/utils/area.ts`: added `WORLD_BBOX` and 10 quick regions with **World first**;
  removed the Bangladesh-only default, archive coverage helper and
  "No archive data for this area" message.
- `src/data/nasa_firms_archive.ts`: **deleted**. The runtime has no bundled seed.
- `src/server/store.ts`: default store is empty. Only a completed real FIRMS ingestion job
  adds records.
- `src/utils/dataSource.ts`: removed archive fallback decisions; the frontend explicitly
  requests `source=live`.
- Map and non-map pages request live data. Date presets are limited to the live 1/2/3/5-day
  window. A live failure shows an honest unavailable/error state.
- `src/api/client.ts`: sends `source=live` for live pages and uses server-side aggregates.

### Backend
- `src/server/liveFires.ts`: shared `LiveFiresService` with one TTL cache, one in-flight
  map, one rate budget and one error classifier for `/fires` and every `source=live`
  endpoint.
- `src/server/app.ts`: `resolveBaseObservations(req)` resolves `store` or `live`; live
  requests outside the rolling 5-day window return `400 LIVE_WINDOW`.
- Non-map live endpoints use `cap = 100000` per source; the map uses
  `WORLD_OVERVIEW_CAP = 5000` per source and reports `truncated`.
- `/health` and `/data-availability` now report `local_store` and `local_store_status`,
  not an archive.
- Exports no longer emit `archive_provenance`.

### Scientific semantics
- `evaluateCalibrationModel` is in-sample only and now always returns `INSUFFICIENT`;
  `EXPLORATORY` describes the harmonization layer, not a calibration result.
- `evaluateTemporalHoldout` returns `VALIDATED` only when every explicit criterion is met.
- R² is `null` when undefined, never `0` as a substitute.
- Offline evidence scripts require an explicit real observation path and exit with code
  `2` when none is supplied; there is no bundled fallback.
- Removed the hardcoded `60`-minute placeholder from the offline time-difference report;
  it now uses the observed MODIS–VIIRS difference or `null`.

### Verified
- `npm run lint`: pass.
- `npm test`: **422/422 pass, 36 files**, 0 failed, 0 skipped.
- `npm run build`: pass.
- Production server (`PORT=4173`, `NODE_ENV=production`) restarted after the calibration
  fix and smoke-tested:
  - `/api/v1/health` → empty store, `local_store_status: UNVERIFIED`, key configured,
    `live_nrt_max_days: 5`, calibration `INSUFFICIENT`, harmonization `EXPLORATORY`;
  - world 1-day live aggregate → 103,131 detections (MODIS 7,073; VIIRS 96,058),
    58,265 bins, 0 source errors;
  - `/api/v1/fires?area=world&days=1&cap=5` → 3,000 returned (per-source minimum cap),
    `truncated: true`;
  - in-sample calibration → `INSUFFICIENT`, R² `0`, 2,034 paired cells,
    `independent_validation: false`;
  - temporal holdout → `INSUFFICIENT`, R² `0.0127`, 1,423 training / 611 validation
    cells, `independent_validation: false` because all data is from one day;
  - historical live request → `400 LIVE_WINDOW`;
  - CSV export → live metadata, `VERIFIED`, no `archive_provenance`.

### Docs reconciled
- `README.md`, `CHANGES.md`, `docs/api/api-reference.md`, `docs/DOCUMENTATION_SUMMARY.md`,
  `docs/data/data-schema.md`, `docs/data/data-sources.md`,
  `docs/architecture/system-architecture.md`, `docs/architecture/global-audit.md`,
  `docs/methodology/limitations.md`, `docs/testing/test-results.md`, and the remediation
  reports were updated to the live/no-mock runtime.
- Old snapshot reports retain banners or are explicitly labelled historical where their
  numbers describe the removed demo fixture.

---

## Remaining blockers

1. NRT ingestion is verified; the historical standard-science/Earthdata archive download
   has not been executed.
2. The local store starts empty and cannot be authenticated as a historical dataset;
   without `FIRESYNC_STORE_PATH` it is also not durable.
3. Docker image build/startup not run in this environment.
4. No committed browser E2E suite; mobile/iOS Safari and current live-world UI unverified.
5. Calibration remains `INSUFFICIENT`; no validated model exists. The holdout fails
   temporal separation because live data covers one day.
6. The FIRMS key used during verification was shared in chat and must be rotated.
7. No auth/rate limiting on ingestion endpoints.
8. World live aggregation (~100k detections) has not been load-benchmarked.

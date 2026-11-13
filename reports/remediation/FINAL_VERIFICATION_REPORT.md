# Final Verification Report

**Date:** 2026-11-10
**Environment:** Windows, Node.js v24.19.0, npm 11.17.0, Python 3.14.7
**Repository:** `E:\New folder\Bot_Battelion\Bot_Battelion` (Git work tree)
**Primary API:** Express 4 (`server.ts`, `src/server/app.ts`)

> This report records what was actually executed. A passing test suite does **not** establish
> scientific validity, and an implemented ingestion pipeline does **not** mean historical
> data was downloaded. Those are reported separately below.
>
> **Current runtime shape:** World default, live NASA FIRMS NRT only (rolling 1–5 days),
> empty local store by default, no bundled archive. The old 30-observation demo fixture was
> removed on 2026-11-10.

---

## 1. Required summary table

| Category | Result |
|---|---|
| TypeScript | **PASS** (`npm run lint` / `tsc --noEmit`, exit 0) |
| Unit tests | **402 passed** (422 total; 20 are API/ingestion integration tests) |
| Integration tests | **20 passed / 20** (12 API tests + 8 ingestion tests) |
| Production build | **PASS** (Vite build; large-chunk and `__dirname` warnings only) |
| Global live NRT | **PASS** (world 1-day aggregate on 2026-11-09: 103,131 detections, 58,265 bins, 0 source errors) |
| Real ingestion | **NRT VERIFIED; historical archive not run** (31 records, 3 raw CSVs, SHA-256 match) |
| Data provenance | **Live NRT `VERIFIED`; local store empty and `UNVERIFIED`; no bundled archive** |
| R² handling | **PASS** (null when undefined; zero-variance and edge cases tested) |
| Calibration | **INSUFFICIENT** (in-sample only; not `CALIBRATED`, not `VALIDATED`) |
| Temporal holdout | **INSUFFICIENT** (1,423 training / 611 validation cells, but same-day data fails temporal separation) |
| Polygon AOI | **PASS** (8 geometry tests + API filtering + invalid-AOI 400) |
| Calendar coverage | **PASS** (observed days only; missing dates are not zero) |
| API integrity | **PASS** (truthful statuses, validation, 503 without key, no fake jobs) |
| Security | **PASS with manual actions** (key masking, no tracked key; the valid key was shared in chat and must be rotated) |
| Docker | **NOT TESTED** (Dockerfile and Compose inspected; no image build/startup run) |
| Browser E2E | **NOT CONFIGURED** (no committed Playwright/Cypress suite) |

---

## 2. Commands and actual results

### 2.1 TypeScript

```
npm run lint
> tsc --noEmit
(exit 0, no diagnostics)
```

### 2.2 Automated tests

```
npm test
ℹ tests 422
ℹ suites 0
ℹ pass 422
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2703.9984
```

- 36 test files (the `package.json` test script lists them explicitly).
- 20 integration tests:
  - `src/server/app.test.ts`: 12/12
  - `src/server/ingestion.test.ts`: 8/8
- 402 unit/component tests, including:
  - `src/utils/harmonization.test.ts`: 7/7
  - `src/utils/polygon.test.ts`: 8/8
  - live FIRMS cache, retry, partial-failure, key-masking and per-source-cap tests.

### 2.3 Production build

```
npm run build
✓ 2135 modules transformed.
dist/index.html                                 1.54 kB
dist/assets/maplibre-gl-worker-*.js           518.98 kB
dist/assets/index-*.css                       129.29 kB
dist/assets/HarmonizeContent-*.js             107.83 kB
dist/assets/index-*.js                      1,504.31 kB
✓ built in 498ms
```

Warnings only:

- Vite config uses `__dirname` (future `configLoader: 'native'` warning).
- One chunk is larger than 500 kB after minification.

The build succeeded; the warnings are not errors.

**Final rerun after the calibration-status fix:** `npm run lint` PASS, `npm test`
422/422 passing, `npm run build` PASS. The production server was then restarted so the
stricter calibration status took effect.

**Final rerun after documentation/comment reconciliation (2026-11-10):** `npm run lint`
PASS (exit 0), `npm test` 422/422 passing across 36 files (0 failed, 0 skipped),
`npm run build` PASS (same two warnings: `__dirname` and one chunk over 500 kB). After
that rerun, `/api/v1/health` still reported an empty `UNVERIFIED` local store and
`INSUFFICIENT` calibration; the live world hotspots request returned total `103,131`,
`provenance_status: VERIFIED`, `cached: true` and no source errors; a historical
`source=live` request returned `400` with code `LIVE_WINDOW`.

### 2.4 Production API smoke test (final run)

Started with `NODE_ENV=production PORT=4173 tsx server.ts` after the build. The local store
was empty and the FIRMS key was configured.

| Check | Result |
|---|---|
| `GET /api/v1/health` | `200`; records `0`; memory, not durable; `local_store_status: UNVERIFIED`; key configured; `live_nrt_max_days: 5`; calibration `INSUFFICIENT`; harmonization `EXPLORATORY` |
| `GET /api/v1/data-availability` | `200`; `local_store.total_records: 0`, `data_status: empty`; `live_nrt.available: true`, `max_days: 5`; calibration `INSUFFICIENT` |
| `GET /api/v1/hotspots?source=live&days=1&bbox=-180,-90,180,90&limit=5` | `200`; total `103,131`; returned `5`; `provenance_status: VERIFIED`; `cached: true`; `live_area: world`; `truncated: false`; no source errors |
| `GET /api/v1/calendar?source=live&days=1&bbox=-180,-90,180,90` | `200`; period `2026-11-09` to `2026-11-09`; observed `1`; active `1`; `missing_days: null`; live; `cached: true`; no source errors |
| `GET /api/v1/analytics/summary?source=live&days=1&bbox=-180,-90,180,90` | `200`; MODIS `7,073`; VIIRS `96,058`; total raw `103,131`; bins `58,265`; completeness `null`; `cached: true`; no source errors |
| `GET /api/v1/analytics/calibration?source=live&days=1&bbox=-180,-90,180,90` | `200`; status **`INSUFFICIENT`**; R² `0`; paired cells `2,034`; `independent_validation: false` |
| `GET /api/v1/analytics/calibration/holdout?source=live&days=1&bbox=-180,-90,180,90` | `200`; status **`INSUFFICIENT`**; R² `0.0127`; training `1,423`; validation `611`; `independent_validation: false` (same-day data fails temporal separation) |
| `GET /api/v1/export/csv?source=live&days=1&bbox=-180,-90,180,90&dataset=modis` | `200`; metadata includes `data_source,live`, `provenance_status,VERIFIED`, `cached,true`, `calibration_status,INSUFFICIENT`; no `archive_provenance` |
| `GET /api/v1/fires?area=world&days=1&cap=5` | `200`; `3,000` returned (MODIS `1,000`, VIIRS `2,000`) because of the per-source minimum cap; `truncated: true`; no errors |
| Historical request (`start_date=2026-11-01`) | `400`, code `LIVE_WINDOW`, with the honest 5-day-window message |
| `GET /` in production | `200`; `dist/index.html` served |
| Unknown `/api/*` route | JSON `404`, not SPA HTML |

The live endpoints share one `LiveFiresService` cache, in-flight map and rate budget. The
world aggregate total comes from `/hotspots`, `/calendar` and `/analytics/summary`;
`/fires` intentionally reports the capped response and `truncated: true`.

### 2.5 Browser/UI verification

There is **no committed Playwright/Cypress suite**. An earlier desktop Chromium pass was
performed before the live-world/archive-removal change; its 30-observation KPI numbers are
historical and are not evidence of the current UI. The current live-world UI was not
re-driven in a browser during this final pass.

Unverified browser items:

- live-world map rendering with ~100k available detections (the map requests a capped
  overview);
- mobile layout and iOS Safari;
- GIBS tile loading under the current network;
- capture/share behavior with live data.

---

## 3. Global live data verification

### 3.1 World aggregate

On 2026-11-09, a live 1-day world request returned:

| Metric | Value |
|---|---:|
| MODIS detections | 7,073 |
| VIIRS detections | 96,058 |
| Total raw detections | 103,131 |
| Spatial-temporal 1-km bins | 58,265 |
| Active days | 1 |
| Data coverage completeness | `null` (unknown) |
| Source errors | 0 |

MODIS and VIIRS counts stay separate. The total raw detection count is not a harmonized
fire count and is never presented as one.

### 3.2 Capped map overview

`/api/v1/fires` limits detections per source with a minimum cap of 1,000. A world request
with `cap=5` therefore returns up to 3,000 detections and sets `truncated: true`. The map
uses a larger cap (`WORLD_OVERVIEW_CAP = 5000` per source) and labels the capped overview.
It does not ship the full ~100k detections to the browser on every load.

### 3.3 Historical requests

Live NRT covers only the rolling last 1–5 days. A request starting `2026-11-01` returned
`400` with code `LIVE_WINDOW` and an explanation that historical dates require a
standard-science archive ingestion that is not available. No historical coverage is
claimed, and no archive fallback exists.

### 3.4 Local store

The runtime store starts empty. `/health` and `/data-availability` report zero records and
`local_store_status: UNVERIFIED` with the reason "The local store is empty. No observation,
archive or placeholder record is pre-seeded." Only a completed real ingestion job adds
records.

---

## 4. Scientific verification

### 4.1 In-sample calibration diagnostic

| Metric | Value |
|---|---:|
| Paired 1-km cells | 2,034 |
| MAE | 0.5544 |
| RMSE | 0.7078 |
| Mean bias | −0.2091 |
| R² | 0 |
| Status | `INSUFFICIENT` |
| Independent validation | **No** |

This is an in-sample comparison against a MODIS reference. R² `0` means the fixed model
explains none of the observed variance; it is not a validation claim.

### 4.2 Temporal holdout

| Item | Actual |
|---|---|
| Training cells | 1,423 (meets the ≥30 minimum) |
| Validation cells | 611 (meets the ≥10 minimum) |
| R² | 0.0127 |
| MAE / RMSE / bias | 0.1019 / 0.2418 / −0.0032 |
| Temporal separation | **Not satisfied** (all observations are from one day) |
| Status | `INSUFFICIENT` |
| Independent validation | **No** |

The split sizes look sufficient, but the live dataset is a single day. The holdout
function requires every validation date to be later than every training date; it therefore
returns `INSUFFICIENT` and `independent_validation: false`. This is the correct behavior.

### 4.3 R² and edge cases

Verified by tests:

- empty dataset → R² `null`, status `INSUFFICIENT`;
- one observation → R² `null`;
- constant reference (zero variance) → R² `null`, never `0`;
- NaN / Infinity → rejected or `null`;
- missing FRP → excluded, not invented;
- negative FRP → rejected by ingestion validation;
- valid non-constant reference → numeric R².

`evaluateCalibrationModel` can never return `VALIDATED`. Only
`evaluateTemporalHoldout` can, and only when every explicit criterion is met.

### 4.4 Removed demo fixture

The old 30-observation demo fixture (`src/data/nasa_firms_archive.ts`) was deleted. The
files under `reports/evidence/` are retained as historical evidence of an earlier
exploratory check; they are not current live data and are not loaded as observations.
`src/data/validationEvidence.ts` labels them accordingly.

### 4.5 What is not claimed

- No ground-truth validation.
- No fitted global or Bangladesh calibration coefficient.
- No GLM. The legacy evidence file's "Constrained Poisson-Weighted GLM" label is
  unsupported and is treated as stale metadata.
- No claim that MODIS is ground truth; it is a reference sensor.
- No claim that co-detection cells represent sensor sensitivity or non-detection
  opportunities.
- No claim that a 1,423/611 split is validation when temporal separation fails.

---

## 5. Real ingestion verification

### 5.1 Python pipeline

```
python -m py_compile data_pipeline/*.py
(exit 0)
```

Dry-run:

```
python data_pipeline/run_pipeline.py \
  --region bangladesh --start 2024-01-01 --end 2024-01-12 --dry-run
[dry-run] Windows: 3 x 2 product(s)
[dry-run]   2024-01-01 .. 2024-01-05 (5 day(s))
[dry-run]   2024-01-06 .. 2024-01-10 (5 day(s))
[dry-run]   2024-01-11 .. 2024-01-12 (2 day(s))
[dry-run] No request was made and no file was written.
(exit 0)
```

Empty raw directory:

```
Status: failed
Accepted 0 record(s); rejected 0; duplicates 0.
(exit 1)
```

Download without a key:

```
ERROR: --download requires FIRMS_MAP_KEY in the server environment.
No request was made and no report was fabricated.
(exit 2)
```

Synthetic fixture (2 valid rows, 1 out-of-bbox row, 1 negative-FRP row):

```
Status: completed
Accepted 2 record(s) (2 MODIS, 0 VIIRS); rejected 2; duplicates 0.
(exit 0)
```

Quality report:

- `rejections.by_reason`: `coordinates outside the requested bbox` 1,
  `frp is negative or not finite` 1;
- `coverage.coverage_status`: `observed_days_only`;
- `dates_without_records`: 2024-01-01, 2024-01-04, 2024-01-05, with the explicit note
  that a date without a record is **not** a zero-fire day;
- provenance `VERIFIED` means the preserved fixture bytes match the recorded SHA-256; it
  does **not** mean the synthetic fixture is NASA data.

### 5.2 Real NRT download (verified)

**VERIFIED for the NRT Area API; historical archive still not run.** The first supplied
key (39 characters) was rejected by NASA as `Invalid MAP_KEY` (401/400). A replacement
32-character key was saved to the gitignored `.env` and accepted on 2026-11-10:

- `POST /api/v1/ingestion/test-key` → HTTP `200`, `valid: true`;
- `GET /api/v1/fires?area=88,20.5,92.8,26.7&days=1` → HTTP `200`, `total: 31`
  (MODIS `2`, VIIRS `29`), `errors: 0`;
- `POST /api/v1/ingestion/trigger` with `MODIS_NRT`, `VIIRS_NOAA20_NRT` and
  `VIIRS_NOAA21_NRT` → HTTP `202`, then `completed` with
  `records_imported: 31`, `provenance_status: VERIFIED`, and manifest checksum
  `a77c56f289963faaa5df5b2f9e853539482b7c7f756777dd6fa615ca762489e8`.

The three raw CSVs were preserved and their SHA-256 values match `checksums.json`:

| Product | Data rows | Bytes | SHA-256 |
|---|---:|---:|---|
| `MODIS_NRT` | 2 | 292 | `483591ff96bbed584fe0119fa8b26317b1fb5eb9c30ac248020b76432c52c1e8` |
| `VIIRS_NOAA20_NRT` | 12 | 1,111 | `7f26594fbe9a40d6ace7f35e3829219eda5651dddf6a4e12c1dfa76fa87bc66e` |
| `VIIRS_NOAA21_NRT` | 17 | 1,527 | `87b3ad1f01720f56a9295af876091c795d94e8cca93ba49790f7fdfaf0cc4714` |

A metadata bug was found during the first successful run: `ingestion_log.json` recorded
the earlier `running` snapshot (`status: running`, `checksum: null`,
`provenance_status: UNVERIFIED`) because metadata was written before the completed job
was built. `runJob` now constructs the terminal job first, writes metadata with it, then
saves the job. The rerun confirmed `status: completed`, `records_imported: 31`, the real
checksum and `provenance_status: VERIFIED` in `ingestion_log.json`. The first run's
stale metadata is preserved under `data/ingestion_runs/2026-11-10T00-44-05Z/`.

The invalid-key path was also exercised honestly: the job failed with
`records_imported: 0`, `checksum: null`, no raw file and no manifest. The live
`/api/v1/fires` endpoint initially misclassified the upstream HTTP 400 as a transient
outage; `classifyFailures` now reads the short response body, recognizes `Invalid MAP_KEY`,
and returns `502` with "NASA FIRMS rejected the server key". Regression tests cover both
the auth case and an unrelated HTTP 400.

This verifies NRT ingestion only. The historical standard-science archive/Earthdata
download has **not** been run, so no historical coverage is claimed.

### 5.3 Server ingestion

- Missing key → `503`, no job.
- Invalid request → `400`, no job.
- Invalid key → real job `failed`, `records_imported: 0`, `checksum: null`, no raw file;
  the failure is not presented as success.
- Valid key → real job `completed`, `records_imported: 31`, `provenance_status: VERIFIED`;
  three raw CSVs preserved and all three SHA-256 values match.
- Job list after the runs → both the failed invalid-key job and the completed valid-key
  job are retained with their real terminal states.
- Mocked-fetch tests cover success, dedupe, failure, partial success, non-CSV response,
  and key masking.

The NRT Area API was exercised against NASA with a live key. The historical
standard-science/Earthdata download path was not exercised.

---

## 6. Provenance verification

| Item | Status |
|---|---|
| Live NRT world response | `VERIFIED` (official NASA FIRMS endpoint; cached response metadata recorded) |
| Live NRT ingestion batch (2026-11-09, 31 records) | `VERIFIED` (3 raw CSVs + SHA-256 manifest) |
| Local store at startup | Empty; `UNVERIFIED` with an explicit reason |
| Bundled 30-observation archive | **Removed**; file deleted; no runtime seed |
| `data/processed/canonical_observations.json` | Present, but no raw inputs/manifests → not verified |
| Python pipeline raw preservation | Implemented; synthetic fixture verified |
| SHA-256 meaning | File integrity, **not** NASA authenticity |

The UI/API expose `local_store_status: UNVERIFIED` while the store is empty and
`provenance_status: VERIFIED` for live NRT responses. `VERIFIED` for live data means the
response came from the official NASA FIRMS endpoint; it is not a scientific validation of
the calibration. There is no `archive_provenance` field because no bundled archive exists.

---

## 7. Security verification

| Check | Result |
|---|---|
| `.env` | 50 bytes; one 32-character `FIRMS_MAP_KEY` entry, gitignored and not committed; NASA accepted it on 2026-11-10, but it was shared in chat and must be rotated |
| `.env` ignored | yes (`^\.env$`) |
| `.env` ever tracked in Git history | no |
| FIRMS key in tracked source | no matches |
| FIRMS key in Git history | no matches |
| Old hardcoded `POSTGRES_PASSWORD: password` in history | found; value must never be reused |
| Server-side key only | yes; browser never receives or submits it |
| Key masking in jobs/errors/manifests | tested |
| Missing-key ingestion | `503`, no job, no simulated success |
| FastAPI default DB password | removed |
| FastAPI health database claim | now `"not integrated"` |
| CSV formula injection | sanitized and regression-tested |

Manual actions still required:

1. Rotate the FIRMS MAP_KEY that was shared in chat, replace it in `.env`, and restart the
   server. The current key is valid but must be treated as exposed.
2. Never reuse the old `password` database credential; rotate any database that used it.
3. Do not expose the unauthenticated ingestion endpoints publicly without a reverse proxy
   or auth layer.
4. Review old logs for historical key leakage; new logs mask the key.

---

## 8. Polygon AOI verification

- 8 geometry tests pass, including:
  - boundary points inside;
  - invalid geometry rejection;
  - bbox prefilter;
  - antimeridian-crossing rings (179.5°E / 179.5°W inside, 0° outside);
  - non-crossing rings unaffected.
- API: `bbox` + `aoi` filters observations; invalid AOI returns `400`.
- Shared URL state: `aoi=lon,lat;lon,lat;...` round-trips; all pages receive the same
  `scope.aoi`.
- The polygon filter is applied after the bbox prefilter; original observations are not
  mutated.

---

## 9. Calendar coverage verification

- `buildDailySummariesFromCells` emits observed dates only, with
  `coverage_status: 'observed'`.
- Missing dates are absent, not zero.
- The calendar renders missing dates distinctly (dashed / "no observation record").
- `observation_coverage_pct` is `null` when unknown, never 100%.
- Historical comparisons return `insufficient_history` when opportunities are inadequate.
- Calendar CSV metadata states `missing_dates: not emitted; missing is not zero`.
- Live calendar output states that NRT covers only the rolling last 5 days.

---

## 10. API integrity verification

- No hardcoded `records_imported: 4`, random checksums or placeholder jobs.
- Job list is empty until a real job runs.
- Missing configuration returns an explicit error, not success.
- Status codes: `400` invalid input / `LIVE_WINDOW`, `404` unknown job or API route,
  `409` cancel terminal job, `502` rejected key or all live sources failed, `503` missing
  key, `202` accepted real job.
- Error responses do not echo the key.
- Exports include data source, live cache state, provenance, AOI/date/sensor scope,
  processing version, calibration status, BAU definition and coverage status.
- Raw MODIS and VIIRS exports are separate; raw counts are never summed.
- `source=store` remains the API default; the frontend explicitly requests `source=live`.

---

## 11. Docker verification

**NOT TESTED.** The Dockerfile and Compose file were inspected:

- multi-stage build; runtime uses `dist/` and does not need Vite;
- `app` is the only required service;
- `FIRESYNC_STORE_PATH` enables the JSON adapter;
- `firesync_data` volume persists `/app/data`;
- healthcheck calls `/api/v1/health`;
- `postgis` and `redis` are optional profiles, not integrated;
- `POSTGRES_PASSWORD` is mandatory for the PostGIS profile.

No `docker build` or `docker compose up` was executed in this environment. The documented
procedure must be tested before deployment.

---

## 12. Definition-of-done checklist

| # | Requirement | Status |
|---|---|---|
| 1 | No fake ingestion success | Done |
| 2 | No random checksums | Done |
| 3 | No misleading validation claims | Done |
| 4 | R² null when undefined | Done |
| 5 | Sensor Comparison renders real data | Done |
| 6 | Missing observations never zero | Done |
| 7 | No mock or bundled archive in runtime | Done (archive file deleted; empty store) |
| 8 | Global live path works | Done (world 1-day aggregate verified) |
| 9 | Historical ingestion uses documented NASA sources | Implemented; real NRT download verified; historical archive download not run |
| 10 | Raw files and checksums preserved | Done for the NRT batch (3 CSVs, 3/3 SHA-256 match); Python fixture verified |
| 11 | Scientific calculations tested | Done |
| 12 | Calibration claims match evidence | Done (`INSUFFICIENT`; holdout also `INSUFFICIENT`) |
| 13 | Polygon AOI consistent across app | Done |
| 14 | Exports contain provenance/model metadata | Done |
| 15 | One documented primary API | Done (Express) |
| 16 | Security issues fixed or documented | Done with manual actions |
| 17 | Documentation matches code | Done (reconciled 2026-11-10 for global live/no-mock behavior) |
| 18 | Existing functionality continues to work | Done (422 tests, build, production live smoke test) |
| 19 | Actual verification results recorded | This report |

---

## 13. Remaining blockers and residual risks

1. **Historical archive download not run** → the NRT Area API works with the current key
   (31 records verified), but the standard-science FIRMS/Earthdata bulk download has not
   been executed. No historical coverage is claimed. The key was shared in chat and must
   be rotated.
2. **No bundled archive** → the runtime store starts empty. This is intentional; there is
   no fallback if live data is unavailable.
3. **Calibration `INSUFFICIENT`** → 2,034 in-sample paired cells and a 1,423/611 split,
   but no temporal separation and no independent validation. R² `0` in-sample and
   `0.0127` on the same-day holdout do not validate the model.
4. **Docker not tested** → image build/startup unverified.
5. **Browser E2E not configured** → the current live-world UI was not re-driven in a
   browser. Mobile Safari and GIBS behavior remain unverified.
6. **No auth/rate limiting** → do not expose ingestion endpoints publicly.
7. **No historical dataset** → anomaly detection and multi-year comparisons are normally
   `insufficient_data`.
8. **Performance unverified** → ~100k world detections per aggregate; no load benchmark.

---

## 14. Conclusion

The remediation removed fabricated ingestion and the bundled runtime archive, corrected
R² and calibration semantics, added real provenance and AOI handling, implemented real
ingestion, and added a global live NRT path with a World default and server-side aggregates.
On 2026-11-10 the NRT Area API path was exercised with a valid NASA key: 31 records were
imported across three products, the raw CSVs were preserved, and all three SHA-256 values
match the manifest. The final world 1-day live aggregate returned 103,131 detections with
zero source errors.

**Tests pass. The production build passes. The API behaves truthfully in the tested
paths. NRT ingestion and global live aggregation are verified. Scientific validation has
not been achieved, historical standard-science ingestion has not been executed, and the
live map is intentionally capped.** Those facts must remain separate in any project claim.

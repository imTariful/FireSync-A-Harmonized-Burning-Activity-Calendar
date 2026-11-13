# Limitations

This document describes the known limitations of FireSync across data, methodology,
technology, and deployment. It describes the **current** repository, not the removed
30-observation demo fixture.

**Current runtime shape:** World default, live NASA FIRMS NRT only (rolling 1–5 days),
empty local store by default, no bundled archive, calibration `INSUFFICIENT`.

---

## Data Limitations

### Temporal Coverage

**Current status:** live NRT only, rolling **1–5 days**.

**Impact:**
- No historical fire record is available in the running deployment.
- Long-term trends, seasonal baselines and multi-year anomaly detection cannot be
  computed from live NRT.
- A request older than the 5-day window returns `400 LIVE_WINDOW`; it is not silently
  converted into a shorter request.
- The bulk historical archive is a **separate local Parquet store** built from
  official FIRMS download ZIPs (`data_pipeline/`); it is not part of the runtime
  store and is absent on a fresh clone until the pipeline runs.

---

### Geographic Scope

**Current status:** live queries work worldwide, including `area=world`.

**Impact:**
- A world request is large. The final 1-day aggregate on 2026-11-09 measured
  **103,131 detections** (MODIS 7,073; VIIRS 96,058) and **58,265** spatial-temporal bins.
- The map uses a capped world overview and reports `truncated: true`; it does not display
  every global detection at once.
- Non-map pages use server-side aggregates, but no production load or latency benchmark
  has been recorded.
- Regional calibration is not implemented. The fixed 0.294 factor is global only as an
  exploratory assumption, not as a validated regional model.

**Path forward:** benchmark global aggregation, add spatial indexing/partitioning if
needed, and fit/validate regional models only with independent data.

---

### Product Quality

**Current status:**
- Live MODIS: `MODIS_NRT` (near real-time).
- Live VIIRS: `VIIRS_NOAA20_NRT`, `VIIRS_NOAA21_NRT` (near real-time).
- Historical archive: MODIS + VIIRS Suomi-NPP from FIRMS download ZIPs
  (MODIS 2000-11→2025, VIIRS 2012-01→2025); NOAA-20/21 are not in the archive.

**Impact:**
- NRT products are not suitable for retrospective scientific analysis.
- NRT quality flags and processing differ from standard science products.
- Live results cannot support long-term trend or attribution claims.

**Path forward:** ingest standard-processing products (`MODIS_C6_1`, `VNP14IMGML`,
`VJ114IMGML`) through the official FIRMS/Earthdata path and validate the normalization.

---

### Observation Opportunity

**Current status:** not tracked.

**Impact:**
- Missing dates are **not** drawn as zero fire, but the system still cannot distinguish
  "no fire" from "no usable observation" (cloud, overpass gap, quality rejection).
- `observation_coverage_pct` is `null` when unknown, never a fabricated 100%.
- Cross-sensor comparisons cannot correct for different overpass times or viewing
  geometry.

**Path forward:** implement observation-opportunity tracking using satellite ephemeris,
cloud masks and per-product quality flags.

---

## Methodological Limitations

### Calibration Model

**Current status:** `INSUFFICIENT`.

**Issues:**
- The fixed β = 0.294 is an assumption from the literature, not a fitted coefficient.
- `evaluateCalibrationModel` is in-sample only and therefore cannot return `VALIDATED`.
- A live world run produced 2,034 paired in-sample cells, R² `0`, MAE `0.5544`, RMSE
  `0.7078` and mean bias `-0.2091`; this describes agreement, not validation.
- R² is `null` when mathematically undefined, never `0` as a stand-in.
- No independent temporal or spatial holdout has met the documented criteria.

**Impact:**
- Calibration is not scientifically validated and cannot support scientific conclusions.
- Prediction uncertainty is unknown.
- A global fixed factor may not fit regional fire regimes.

**Path forward:**
- Fit β empirically only on a real historical dataset.
- Meet the explicit holdout criteria (≥30 training cells, ≥10 independent validation
  cells, temporal separation, non-zero reference variance, finite uncertainty metrics).
- Add bootstrap or model-based uncertainty.
- Consider regional calibration if a global model is inappropriate.

---

### BAU Definition

**Current status:** exploratory and intentionally non-physical.

**Issues:**
- BAU is an index, not a count of fires, burned area or a physical unit.
- The FRP term adds complexity and has no independent physical calibration.
- A BAU value cannot be compared across sensors or regions without validation.

**Path forward:** document BAU as an exploratory index only, or replace it with a
validated, unit-explicit quantity if the evidence supports one.

---

### Statistical Validation

**Current status:** `INSUFFICIENT`.

**Issues:**
- Live NRT provides only 1–5 days, so it cannot supply a multi-year independent holdout.
- In-sample paired cells are not independent validation.
- No geographic holdout, no bootstrap uncertainty and no ground-truth comparison.
- R² is undefined for constant reference data and is reported as `null`.

**Path forward:** obtain a real historical dataset, define train/validation periods before
fitting, and report every failed criterion rather than relabelling a diagnostic as
validation.

---

### Anomaly Detection

**Current status:** limited; normally `insufficient_data` on live NRT.

**Issues:**
- Requires at least three other years with observations for the same month.
- Live NRT has no multi-year baseline.
- Thresholds are not calibrated to regional fire regimes.
- No confidence intervals on anomaly scores.

**Path forward:** ingest multi-year history and validate thresholds against independent
fire records.

---

### Temporal Matching

**Current status:** same-day 1-km cells; the offline paired-observation script computes
the smallest observed MODIS–VIIRS time difference, but the calibration itself does not
enforce a ±1-hour window.

**Issues:**
- MODIS and VIIRS overpass times differ.
- Same-day detections may be hours apart and fire conditions can change.
- Pairing by cell/day may mix different overpasses.

**Path forward:** add an explicit time window to calibration pairs and report sensitivity
to that choice.

---

## Technical Limitations

### Spatial Projection and Grid

**Current status:** cylindrical equal-area projection with standard parallel φ₀ = 23.5°N;
1-km cells only.

**Issues:**
- Distortion increases far from the standard parallel, especially near the poles.
- The grid is not a discrete global grid; equal-area behavior degrades globally.
- No multi-resolution (1 km / 5 km / 10 km) support.
- AOI polygon filtering handles antimeridian rings, but the underlying grid is still not
  globally optimal.

**Path forward:** evaluate a discrete global grid (e.g. H3) or a latitude-aware equal-area
scheme before making global cell-area claims.

---

### Performance and Scale

**Current status:** not benchmarked at production volume.

**Issues:**
- World live aggregates process ~100k detections per request.
- The server-side cache reduces repeated NASA calls but does not remove aggregation cost.
- The map is capped; complete counts require aggregate endpoints.
- No load test, memory profile or latency SLO exists.

**Impact:**
- Unknown behavior under concurrent world requests.
- Unknown memory ceiling for the in-memory store and caches.

**Path forward:** add benchmarks, request concurrency tests, memory limits and, if needed,
a spatial database or streaming aggregation.

---

### Live Source Dependency

**Current status:** live NRT requires `FIRMS_MAP_KEY` and a working NASA endpoint.

**Issues:**
- NASA rate limits and outages are external.
- If all sources fail, the API returns a classified `502`; the UI shows an honest
  unavailable state.
- There is no archive fallback by design, so a live outage means no observations.

**Path forward:** keep the explicit error state; add operational monitoring and, only with
real preserved data, an optional historical store.

---

### Database and Durability

**Current status:** in-memory store with optional JSON persistence; PostgreSQL/PostGIS
profiles exist but are not integrated.

**Issues:**
- Without `FIRESYNC_STORE_PATH`, ingested records are lost on restart.
- JSON persistence is single-process and not suitable for scale.
- No spatial indexing or query optimization in the active store.
- No production database is claimed.

**Path forward:** integrate PostgreSQL/PostGIS only when the operational need is real, and
test it before claiming production readiness.

---

### Monitoring, Auth and Rate Limiting

**Current status:** not implemented.

**Issues:**
- No application monitoring, structured logging or alerting.
- No user authentication or authorization.
- No API rate limiting beyond the internal live-source budget.
- CORS is open.
- Ingestion endpoints are unauthenticated.

**Impact:** do not expose ingestion endpoints publicly without a reverse proxy/auth layer.

**Path forward:** add auth, rate limiting, restricted CORS, structured logs and monitoring.

---

## Deployment Limitations

### Production Deployment

**Current status:** local production build works; Docker image build/startup has **not**
been tested.

**Issues:**
- No production environment, database, monitoring or CI/CD pipeline is provisioned.
- No committed browser E2E suite; the UI was checked once in desktop Chromium.
- iOS Safari and mobile behavior remain unverified.

**Path forward:** build and start the Docker image, run browser E2E, and provision
monitoring before any public deployment.

---

### Infrastructure Costs

**Estimated costs:** cloud `$1,300–1,800/month` minimum; self-hosted `$500–900/month`
minimum for a global historical deployment. These are planning estimates, not measured
costs.

**Impact:** global historical storage and processing are not currently funded or
provisioned.

---

## Testing Limitations

**Current status:** 422/422 automated tests across 36 files (402 unit/component, 20
integration); lint and production build pass.

**Issues:**
- No browser E2E suite (Playwright/Cypress).
- No Python unit-test suite; the pipeline is checked via CLI scenarios.
- Live NRT was verified once with a real key; the historical archive pipeline was
  verified on the full 40-ZIP archive (392.5M deduplicated observations).
- Docker and optional PostGIS/Redis profiles are not integration-tested.
- No performance/load benchmark.

**Impact:** API and utility regressions are covered, but browser workflows, historical
ingestion, infrastructure and scale are not.

**Path forward:** add Playwright/Cypress, Python tests, a secret-gated live NRT check,
historical ingestion verification, and a performance benchmark.

---

## Scientific Limitations

### Ground Truth

**Current status:** no ground-truth validation.

**Issues:**
- A hotspot is a satellite thermal anomaly, not a unique fire.
- No independent fire perimeter or ground-based observation is used.
- Agreement with MODIS is not ground truth.

**Impact:** detection accuracy and fire-event attribution cannot be claimed.

**Path forward:** compare with independent burned-area/perimeter data where available.

---

### Event Detection

**Current status:** not implemented.

**Issues:**
- Persistent fires are counted as multiple hotspot detections.
- No spatio-temporal clustering or event-level metrics.
- Detection counts are not fire counts.

**Path forward:** implement clustering and label event metrics separately from detection
counts.

---

## Summary

### Critical Limitations (Blockers)

1. **Historical dataset is local-only** — the 392.5M-row archive exists when the
   pipeline has run on local FIRMS ZIPs; it is gitignored and absent by default.
2. **Calibration not validated** — status `INSUFFICIENT`; the fixed 0.294 factor is an
   assumption.
3. **No observation-opportunity tracking** — missing data cannot be interpreted as
   no-fire.
4. **No production deployment** — Docker, monitoring and CI/CD are unverified.
5. **No independent holdout** — in-sample paired cells do not establish generalizability.

### Important Limitations (Affecting Quality)

1. **NRT data quality** — not standard science processing.
2. **Global projection/grid** — not a discrete global grid; polar distortion remains.
3. **World response size** — map is capped; aggregates are not benchmarked.
4. **No authentication/authorization** — not production-ready.
5. **No monitoring** — no operational visibility.
6. **Coverage gaps** — no browser E2E, Python unit suite or historical-ingestion test.

### Minor Limitations (Nice to Have)

1. **FRP term** — adds complexity without independent calibration.
2. **BAU definition** — exploratory index, not a physical unit.
3. **No event detection** — would improve interpretation.
4. **No multi-resolution grid** — would enable different use cases.

---

## Conclusion

FireSync now has a working **global live NRT** path and no longer substitutes a bundled
archive or synthetic sample. It is still a scientifically structured proof-of-concept, not
a validated global fire intelligence system. Historical coverage, independent calibration
validation, observation-opportunity tracking, production infrastructure and browser E2E
remain unfinished.

**Scientific honesty:** these limitations must remain visible in the UI, API and reports.
The project should not be claimed as historically complete, scientifically validated or
production-ready until the corresponding checks are executed and recorded.

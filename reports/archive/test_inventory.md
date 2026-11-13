# FireSync Global — Test Inventory

> **Superseded snapshot (2026-11-01):** This is a planning inventory, not an executed
> test run. Its counts and pass percentages mixed hypothetical tests with actual runs.
> The current suite is **422 tests across 36 files** (402 unit/component, 20
> integration), all passing. The 30-observation bundled archive referenced below was
> removed on 2026-11-10; the runtime store starts empty and live NRT is the only
> observation source. PostgreSQL/PostGIS and Redis are optional compose profiles
> and are not integrated; the Python pipeline uses a local JSON job queue, not Redis.
> See `docs/testing/test-results.md` for actual results.

**Date:** 2026-11-01  
**Test Lead:** Independent QA Automation Engineer  
**Scope:** Complete end-to-end verification of FireSync Global

---

## Phase 1: Project Discovery Results

### 1.1 Project Structure

**Frontend:**
- Framework: React 19, TypeScript, Vite
- Entry point: `src/App.tsx`
- Build tool: Vite with Tailwind CSS
- Map library: MapLibre GL JS
- State management: React hooks (useState, useEffect, useMemo)

**Backend:**
- Primary: Express/Node.js (`server.ts`)
- Port: 3000
- Secondary: Python FastAPI (`backend/app/main.py`) - defined but not actively used in current runtime
- Database: PostgreSQL + PostGIS 16-3.4 (via Docker Compose)
- In-memory archive: `src/data/nasa_firms_archive.ts` (30 records, development only)

**Data Pipeline:**
- Python ingestion: `data_pipeline/run_pipeline.py`
- New global components (Phase 2):
  - `data_pipeline/job_queue.py` - Redis job queue
  - `data_pipeline/firms_api_client.py` - NASA FIRMS API client
  - `data_pipeline/tile_window_generator.py` - Tile/window generators

**API Routes (Express/server.ts):**
- `/api/v1/health`
- `/api/v1/metadata`
- `/api/v1/data-availability`
- `/api/v1/hotspots`
- `/api/v1/calendar`
- `/api/v1/analytics/summary`
- `/api/v1/analytics/sensors`
- `/api/v1/analytics/calibration`
- `/api/v1/analytics/timeseries`
- `/api/v1/analytics/anomalies`
- `/api/v1/export/csv`
- `/api/v1/export/calendar.csv`
- `/api/v1/export/validation.csv`
- `/api/v1/ingestion/jobs`
- `/api/v1/ingestion/test-key`
- `/api/v1/ingestion/trigger`

**Database Schema:**
- Production model: `backend/app/models/observation.py` (SQLAlchemy, PostGIS)
- 20 fields including: id, source_record_id, lat/lon, acq_date/time, sensor, satellite, product, confidence, FRP, quality flags, record_hash
- Indexes: (date, sensor), (lat, lon)

**Spatial Indexing:**
- Current: Cylindrical equal-area projection (φ₀ = 23.5°N)
- Cell size: 1 km
- Limitation: Not globally appropriate (polar distortion)
- Global grid: Not implemented (Phase 2-3)

**Harmonization:**
- File: `src/utils/harmonization.ts`
- Formula: BAU = 0.5·MODIS + 0.5·(0.294·VIIRS) + 0.005·ln(1+FRP)
- Status: EXPLORATORY (empirical β = 0.529 vs fixed 0.294)
- No observation opportunity tracking
- No regional calibration

**Statistical Models:**
- Anomaly detection: `src/utils/anomaly.ts`
- Method: Median and MAD (robust Z-score)
- Validation: `scripts/evaluate_holdout_validation.ts`
- Status: EXPLORATORY (9 paired cells, uniform MODIS values → R² undefined)

**Export Functions:**
- File: `src/utils/csv_export.ts`
- Formats: CSV with CWE-1236 formula injection protection
- Async exports: Not implemented

**Docker Configuration:**
- File: `docker-compose.yml`
- Services: PostGIS (port 5432), Backend (port 3000)
- Status: Configured but not running

**Deployment Configuration:**
- No production deployment exists
- No CI/CD pipeline
- No cloud infrastructure configured

### 1.2 Existing Automated Tests

**Test Files:**
1. `src/utils/anomaly.test.ts` - Statistical calculations
2. `src/utils/csv_export.test.ts` - CSV export and sanitization
3. `src/utils/harmonization.test.ts` - Harmonization calculations
4. `src/utils/spatial.test.ts` - Spatial projections and indexing

**Test Count:** 17 tests (from npm test output)

**Test Framework:** tsx test runner

### 1.3 Package Scripts

**From package.json:**
- `npm test` - Run utility tests
- `npm run dev` - Start development server (Vite + Express)
- `npm run build` - Build for production
- `npm run preview` - Preview production build

**Python Scripts:**
- `python data_pipeline/run_pipeline.py` - Ingestion pipeline
- `python data_pipeline/job_queue.py` - Job queue (new)
- `python data_pipeline/firms_api_client.py` - API client (new)
- `python data_pipeline/tile_window_generator.py` - Generators (new, tested)

### 1.4 Environment Variables

**From .env.example:**
- `FIRMS_MAP_KEY` - NASA FIRMS API key (not set)
- `DATABASE_URL` - PostgreSQL connection string
- `CORS_ORIGINS` - CORS configuration
- `API_BASE_URL` - API base URL

**Current Status:**
- `.env` file does not exist
- No FIRMS_MAP_KEY configured
- No production secrets configured

### 1.5 Dependencies

**From package.json:**
- React 19
- TypeScript
- Vite
- Tailwind CSS
- MapLibre GL
- Express
- tsx (test runner)

**Python:**
- pandas
- numpy
- sqlalchemy
- psycopg2
- redis (new, for job queue)
- requests (new, for API client)

---

## Phase 2: Missing Tests - Critical Gaps

### 2.1 Data Integrity Tests - MISSING

**Required Tests:**
- [ ] SHA-256 checksum verification of raw NASA files
- [ ] Source product identifier validation
- [ ] Satellite identity verification
- [ ] Processing level distinction (SP vs NRT)
- [ ] Coordinate validation (lat/lon bounds)
- [ ] Confidence field validation
- [ ] FRP field validation (non-negative, reasonable range)
- [ ] Quality flag preservation
- [ ] Schema consistency across products
- [ ] Missing value handling
- [ ] Invalid record detection
- [ ] Duplicate record detection (by record_hash)
- [ ] Raw vs normalized record count reconciliation
- [ ] Rejection reason logging
- [ ] NRT vs SP product separation verification
- [ ] Test fixture isolation (ensure fixtures don't enter production)

**Status:** BLOCKED - No global data to test

### 2.2 Global Coverage Tests - MISSING

**Required Tests:**
- [ ] North America processing
- [ ] South America processing
- [ ] Europe processing
- [ ] Africa processing
- [ ] Asia processing
- [ ] Oceania processing
- [ ] Polar region processing (where supported)
- [ ] Island processing
- [ ] Coastal boundary handling
- [ ] International date line crossing
- [ ] Equator processing
- [ ] Northern/Southern hemisphere processing
- [ ] Geographic bounds validation
- [ ] Data gap detection
- [ ] Satellite composition verification
- [ ] Product composition verification

**Status:** BLOCKED - No global data to test; current projection not globally appropriate

### 2.3 Geospatial Validation Tests - PARTIAL

**Existing Tests:**
- [x] Coordinate transformations (spatial.test.ts)
- [x] Spatial cell assignment (spatial.test.ts)
- [x] Haversine distance (spatial.test.ts)
- [x] Bbox validation (spatial.test.ts)

**Missing Tests:**
- [ ] Equal-area grid behavior at various latitudes
- [ ] Cell boundary accuracy
- [ ] Neighbor calculations
- [ ] Dateline crossing
- [ ] Polar region behavior
- [ ] Multiple spatial resolutions
- [ ] Country attribution
- [ ] Coastal observation handling
- [ ] Spatial aggregation verification
- [ ] Independent reference value comparison

**Status:** PARTIAL - Basic tests exist, global tests missing

### 2.4 Temporal Validation Tests - MISSING

**Required Tests:**
- [ ] UTC timestamp handling
- [ ] Date boundary handling (midnight, month-end, year-end)
- [ ] Leap year handling
- [ ] Satellite overpass window validation
- [ ] Time-zone conversion (if applicable)
- [ ] Daily aggregation correctness
- [ ] Missing observation period detection
- [ ] Historical coverage verification
- [ ] Same-day detection temporal separation

**Status:** MISSING - No temporal validation tests exist

### 2.5 Harmonization Scientific Tests - MISSING

**Required Tests:**
- [ ] MODIS-VIIRS pairing logic
- [ ] Spatial matching accuracy
- [ ] Temporal matching accuracy
- [ ] Sensor-specific filtering
- [ ] Confidence threshold application
- [ ] Product-level separation
- [ ] Observation opportunity tracking (not implemented)
- [ ] Missing sensor data handling
- [ ] FRP calculation verification
- [ ] Model coefficient verification (β = 0.294 vs empirical 0.529)
- [ ] Regional model behavior (not implemented)
- [ ] Uncertainty estimation (not implemented)
- [ ] MODIS not treated as ground truth verification
- [ ] Missing observations ≠ zero activity verification
- [ ] Persistent fire detection handling

**Status:** BLOCKED - Requires global data; observation opportunity not implemented

### 2.6 Statistical Validation Tests - PARTIAL

**Existing Tests:**
- [x] Median calculation (anomaly.test.ts)
- [x] MAD calculation (anomaly.test.ts)
- [x] Robust Z-score (anomaly.test.ts)
- [x] Zero MAD handling (anomaly.test.ts)

**Missing Tests:**
- [ ] MAE calculation (partially in harmonization.test.ts)
- [ ] RMSE calculation (partially in harmonization.test.ts)
- [ ] Mean bias calculation (partially in harmonization.test.ts)
- [ ] R² calculation with zero variance handling
- [ ] Correlation calculations
- [ ] Percentile calculations
- [ ] Bootstrap confidence intervals
- [ ] Seasonal baseline accuracy
- [ ] Anomaly score verification
- [ ] Empty dataset handling
- [ ] Single observation handling
- [ ] Uniform reference values (critical issue: all MODIS = 1)
- [ ] Zero reference variance (critical issue: R² undefined)
- [ ] Missing observations handling
- [ ] Extreme outliers handling
- [ ] Temporal leakage detection
- [ ] Geographic leakage detection
- [ ] Bootstrap reproducibility with fixed seed

**Status:** PARTIAL - Basic tests exist, edge case and validation tests missing

### 2.7 Backend API Tests - MISSING

**Required Tests:**
- [ ] `/api/v1/health` - Correct status, database status
- [ ] `/api/v1/metadata` - Schema validation
- [ ] `/api/v1/data-availability` - Actual data vs reported
- [ ] `/api/v1/hotspots` - Filtering, pagination, correctness
- [ ] `/api/v1/calendar` - Daily summaries, baselines
- [ ] `/api/v1/analytics/summary` - KPI accuracy
- [ ] `/api/v1/analytics/sensors` - Sensor comparison
- [ ] `/api/v1/analytics/calibration` - Model metrics
- [ ] `/api/v1/analytics/timeseries` - Time series data
- [ ] `/api/v1/analytics/anomalies` - Anomaly detection
- [ ] `/api/v1/export/csv` - Record count, schema, sanitization
- [ ] `/api/v1/export/calendar.csv` - Calendar export
- [ ] `/api/v1/export/validation.csv` - Validation export
- [ ] `/api/v1/ingestion/jobs` - Job listing
- [ ] `/api/v1/ingestion/test-key` - Key validation
- [ ] `/api/v1/ingestion/trigger` - Job triggering
- [ ] Invalid input handling for all routes
- [ ] Missing parameter handling
- [ ] Empty result handling
- [ ] Database error handling
- [ ] Cache invalidation
- [ ] Authorization (not implemented)
- [ ] Rate limiting (not implemented)

**Status:** MISSING - No API integration tests exist

### 2.8 Frontend E2E Tests - MISSING

**Required Tests:**
- [ ] Dashboard loads with real data
- [ ] Global summary reconciles with backend
- [ ] Charts display real data
- [ ] Empty states work correctly
- [ ] Errors are visible
- [ ] Map initializes
- [ ] Map layers work
- [ ] Zoom/pan work
- [ ] Dateline crossing works
- [ ] Filters update observations
- [ ] Time controls update data
- [ ] Large dataset aggregation
- [ ] Historical analytics (daily, monthly, seasonal, annual)
- [ ] Date-range filters
- [ ] Country/region selection
- [ ] Geographic summaries
- [ ] Empty region handling
- [ ] Boundary observation handling
- [ ] Scientific validation metrics display
- [ ] Uncertainty visibility
- [ ] Exploratory status labeling
- [ ] R² undefined handling
- [ ] Source metadata display
- [ ] Product identifiers
- [ ] Processing levels
- [ ] Provenance tracking
- [ ] Record details

**Status:** MISSING - No E2E tests exist; no browser automation framework configured

### 2.9 Export Tests - PARTIAL

**Existing Tests:**
- [x] CSV formula injection protection (csv_export.test.ts)
- [x] CSV formatting (csv_export.test.ts)

**Missing Tests:**
- [ ] GeoJSON export (not implemented)
- [ ] Parquet export (not implemented)
- [ ] JSON export (not implemented)
- [ ] Large asynchronous exports (not implemented)
- [ ] Record count verification
- [ ] Geographic coordinate preservation
- [ ] Timestamp preservation
- [ ] Source provenance preservation
- [ ] Encoding verification
- [ ] Schema verification
- [ ] Export permissions (not implemented)
- [ ] Export vs query result comparison

**Status:** PARTIAL - CSV tests exist, other formats not implemented

### 2.10 Performance Tests - MISSING

**Required Tests:**
- [ ] Dashboard request latency
- [ ] Regional query latency
- [ ] Country query latency
- [ ] Global summary latency
- [ ] Map viewport query latency
- [ ] Historical time range query latency
- [ ] Sensor comparison latency
- [ ] Large export latency
- [ ] Concurrent user load testing
- [ ] P50/P95/P99 latency measurement
- [ ] Throughput measurement
- [ ] Error rate measurement
- [ ] CPU utilization monitoring
- [ ] Memory utilization monitoring
- [ ] Database utilization monitoring
- [ ] Cache hit rate measurement
- [ ] Query execution time measurement

**Status:** MISSING - No performance tests exist

### 2.11 Security Tests - MISSING

**Required Tests:**
- [ ] Secrets and API keys (none configured)
- [ ] Database credentials (dev credentials in docker-compose)
- [ ] Authentication (not implemented)
- [ ] Authorization (not implemented)
- [ ] SQL injection protection
- [ ] Cross-site scripting protection
- [ ] CSV formula injection (tested)
- [ ] CORS configuration
- [ ] Rate limiting (not implemented)
- [ ] Export permissions (not implemented)
- [ ] Dependency vulnerability scanning
- [ ] Sensitive value logging

**Status:** MISSING - Only CSV injection tested

### 2.12 Recovery Tests - MISSING

**Required Tests:**
- [ ] Database restart recovery
- [ ] Backend restart recovery
- [ ] Worker restart recovery (workers not running)
- [ ] Interrupted ingestion recovery
- [ ] Failed download recovery
- [ ] Duplicate job submission handling
- [ ] Retry behavior verification
- [ ] Partial dataset availability handling
- [ ] Cache recovery
- [ ] Persistent storage verification

**Status:** MISSING - No recovery tests exist

### 2.13 Production Smoke Tests - BLOCKED

**Required Tests:**
- [ ] Frontend availability
- [ ] Backend health
- [ ] Database connectivity
- [ ] Actual data queries
- [ ] Map functionality
- [ ] Export functionality
- [ ] Persistence
- [ ] Monitoring
- [ ] Error logging

**Status:** BLOCKED - No production deployment exists

---

## Test Summary

### Test Categories

| Category | Existing | Missing | Blocked | Total |
|----------|----------|---------|---------|-------|
| Data Integrity | 0 | 16 | 16 | 16 |
| Global Coverage | 0 | 17 | 17 | 17 |
| Geospatial | 4 | 10 | 2 | 14 |
| Temporal | 0 | 9 | 0 | 9 |
| Harmonization | 0 | 15 | 15 | 15 |
| Statistical | 4 | 12 | 0 | 16 |
| Backend API | 0 | 29 | 0 | 29 |
| Frontend E2E | 0 | 24 | 0 | 24 |
| Export | 2 | 11 | 8 | 13 |
| Performance | 0 | 14 | 0 | 14 |
| Security | 1 | 11 | 0 | 12 |
| Recovery | 0 | 10 | 1 | 10 |
| Production | 0 | 9 | 9 | 9 |
| **TOTAL** | **11** | **173** | **68** | **188** |

### Test Status

- **Passing:** 11 (existing utility tests)
- **Missing:** 173
- **Blocked:** 68 (require global data, production deployment, or external dependencies)
- **Total Required:** 188

### Critical Blocking Issues

1. **No FIRMS_MAP_KEY** - Cannot download global data or test API client
2. **No global data** - Cannot test global coverage, harmonization, or validation
3. **No production deployment** - Cannot test production smoke tests
4. **No Redis** - Cannot test job queue (but component is implemented)
5. **No database running** - Cannot test backend API
6. **No browser automation** - Cannot test frontend E2E
7. **No infrastructure** - Cannot test performance or reliability

### What Can Be Tested Now

1. ✅ Existing utility tests (anomaly, csv_export, harmonization, spatial)
2. ✅ Tile/window generators (tested and working)
3. ⏸️ Job queue (requires Redis)
4. ⏸️ API client (requires FIRMS_MAP_KEY)
5. ⏸️ Backend API (requires database + server)
6. ⏸️ Frontend (requires server + browser automation)

### What Cannot Be Tested Now

1. ❌ Global data integrity (no global data)
2. ❌ Global coverage (no global data, projection not global)
3. ❌ Harmonization science (no global data, observation opportunity not implemented)
4. ❌ Validation science (insufficient sample, zero reference variance)
5. ❌ Backend API (database not running)
6. ❌ Frontend E2E (no browser automation)
7. ❌ Performance (no production environment)
8. ❌ Production smoke tests (no production deployment)

---

## Conclusion

The FireSync Global project has **11 passing utility tests** out of **188 required tests**. **173 tests are missing**, and **68 are blocked** by external dependencies (FIRMS_MAP_KEY, global data, production deployment, infrastructure).

**The project is NOT ready for global acceptance testing** because:
1. No global data exists to test
2. No production deployment exists
3. Critical infrastructure is not provisioned
4. Most scientific validation cannot be performed without global data

**Recommended immediate action:** Execute the 11 existing utility tests to establish a baseline, then address the blocking issues before attempting comprehensive verification.

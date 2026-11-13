# FireSync Global — Architecture Audit

> **Reconciliation note (2026-11-10):** This document is a historical audit snapshot
> dated 2026-11-01. Several statements below were true of that snapshot but are no
> longer accurate. Read the audit as a record of the gap analysis, not as a description
> of the current repository.
>
> **Corrections to the body below:**
> - **Tests:** the current suite is **422 tests across 36 files** (402 unit/component,
>   20 integration), not 17 tests.
> - **Ingestion:** the Python pipeline is now implemented (`firms_api_client.py`,
>   `tile_window_generator.py`, `job_queue.py`, `run_pipeline.py`) with retries, resume,
>   raw CSV preservation, SHA-256 manifests, quality/coverage reports and a durable JSON
>   job queue. The Express server can trigger real FIRMS NRT ingestion when
>   `FIRMS_MAP_KEY` is configured. The NRT path was exercised with a valid key on
>   2026-11-10 (31 records, 3 raw CSVs, matching SHA-256); the historical archive path
>   remains unexecuted.
> - **FIRMS Area API windows:** NRT products accept at most **5 days** per request and
>   standard-processing products at most **10 days**. Longer ranges are split into
>   windows; the old "30 days per area request" statement is outdated.
> - **Storage:** the running Express app uses an in-memory store that starts **empty**,
>   with an optional JSON file adapter (`FIRESYNC_STORE_PATH`). PostgreSQL/PostGIS and
>   Redis are optional Docker Compose profiles and are **not integrated** with the
>   Express runtime. The old bundled 30-observation archive was removed on 2026-11-10.
> - **Global live path:** the frontend now defaults to **World** and requests live FIRMS
>   NRT for the rolling last 1–5 days. The map uses a capped world overview; non-map
>   pages use server-side aggregates. Historical live requests return `400 LIVE_WINDOW`.
> - **Calibration:** status is `INSUFFICIENT` for every non-`VALIDATED` outcome, including
>   in-sample diagnostics. A live world run measured 2,034 paired in-sample cells with
>   R² `0`; that is still not an independent holdout. The old demo fixture had zero
>   reference variance and R² `null`. There is no validated "empirical β = 0.529" model.
>   The fixed β = 0.294 is an explicitly exploratory assumption.
> - **Provenance:** there is no bundled archive. Live NRT responses are labelled
>   `VERIFIED` because they come from the official FIRMS endpoint; checksum verification
>   applies only to files preserved by real ingestion/pipeline runs.
> - **Production serving:** `server.ts` serves the built `dist/` directory in production
>   and refuses to start if `dist/index.html` is missing. Vite middleware is development-only.
>
> The global-expansion recommendations remain future work; none of them should be read
> as implemented.

**Date:** 2026-11-01  
**Current Status:** Phase 3 EXPLORATORY (30 records, Bangladesh-focused)  
**Target Status:** Global Fire Intelligence Platform  
**Assessment:** Significant architectural expansion required

---

## Executive Summary

The existing FireSync project is a scientifically structured, technically sound proof-of-concept for MODIS-VIIRS harmonization in Bangladesh. However, it is currently designed for:
- **Single-region focus** (Bangladesh demonstration region)
- **Small dataset** (30 records, 9 paired cells)
- **Exploratory calibration** (fixed scaling factor, insufficient sample size)
- **Development architecture** (in-memory archive, not production-ready)
- **No live data pipeline** (requires FIRMS_MAP_KEY)

Transforming this into a **global fire intelligence platform** requires substantial architectural redesign, not incremental expansion. The current implementation preserves scientific rigor but lacks the infrastructure for worldwide data ingestion, processing, and serving.

---

## 1. Existing Architecture Audit

### 1.1 Current System Components

| Component | Technology | Status | Global Scalability |
|-----------|------------|--------|-------------------|
| **Frontend** | React 19, TypeScript, Vite, Tailwind CSS | ✅ Working | ✅ Scalable |
| **Mapping** | MapLibre GL JS | ✅ Working | ⚠️ Requires server-side aggregation for global data |
| **Backend API** | Express, Node.js (server.ts) | ✅ Working | ⚠️ Needs global endpoints, query optimization |
| **Data Storage** | In-memory + optional JSON file store | ✅ Demo only | ❌ Must replace with database |
| **Database Schema** | PostgreSQL + PostGIS (SQLAlchemy) | ⚠️ Optional, not integrated | ✅ Scalable |
| **Data Pipeline** | Python (run_pipeline.py) | ✅ Implemented; download needs FIRMS_MAP_KEY | ⚠️ Needs global tiling, parallel processing |
| **Spatial Indexing** | Cylindrical equal-area 1-km grid | ⚠️ Bangladesh-tuned | ❌ Not globally appropriate |
| **Harmonization** | Fixed β = 0.294 (exploratory assumption) | ⚠️ Unvalidated | ❌ Needs regional models |
| **API Endpoints** | /api/v1/* | ✅ Working | ⚠️ Needs global versions |
| **Docker** | Docker Compose (PostGIS optional profile) | ✅ Configured, not integration-tested | ✅ Scalable |
| **Tests** | 421 tests across 36 files | ✅ Passing | ⚠️ Needs global coverage tests |

### 1.2 Current Geographic Limitations

**Hard-coded geographic constraints:**

1. **Study regions** (`src/utils/spatial.ts`):
   - 4 predefined regions: Bangladesh, Indochina, Amazon Arc, California
   - All hardcoded bounding boxes
   - No mechanism for arbitrary global coordinates

2. **Spatial projection** (`src/utils/spatial.ts`):
   - Cylindrical equal-area projection with φ₀ = 23.5°N (Tropic of Cancer)
   - Optimized for tropical/subtropical latitudes
   - **Not globally equal-area** at poles (significant distortion near ±90°)
   - Dateline handling not addressed

3. **1-km grid assumptions**:
   - Assumes cell area is constant globally
   - Not true for cylindrical projection at high latitudes
   - Polar regions require alternative grid systems

4. **Frontend map** (`src/components/map/HotspotMap.tsx`):
   - Single-region zoom and center
   - No global navigation or viewport management
   - Loads all observations into browser (not scalable)

### 1.3 Current Data Limitations

**Dataset scope:**
- **Total records:** 30
- **Temporal coverage:** 8 active days across 2+ years
- **Geographic coverage:** Bangladesh only (88.0°E - 92.8°E, 20.5°N - 26.7°N)
- **Sensors:** MODIS (9), VIIRS (21)
- **Paired cells:** 9 (insufficient for validation)

**Ingestion limitations:**
- No FIRMS_MAP_KEY configured
- No automated global download capability
- Python pipeline designed for single CSV files
- No retry logic, exponential backoff, or error recovery
- No job queue or orchestration
- No progress tracking for large downloads
- No incremental update mechanism

**Data storage limitations:**
- In-memory archive (nasa_firms_archive.ts) cannot scale
- No partitioning by time or geography
- No separation of raw, processed, and analytical layers
- No Parquet or columnar storage for analytics
- No object storage for historical archives

### 1.4 API Limitations

**Current API design:**
- More than 20 routes under `/api/v1/`
- `/hotspots` supports `limit`/`offset` pagination; other list responses are small
- No rate limiting
- No request throttling
- No caching layer
- No viewport-based queries
- No tile-based data serving
- Synchronous exports only; no asynchronous export jobs

**API endpoints requiring global redesign:**
- `/api/v1/hotspots` — Must support viewport-based queries, tile serving
- `/api/v1/calendar` — Must support multi-year global data
- `/api/v1/analytics/*` — Must aggregate pre-computed analytics
- `/api/v1/export/*` — Must use async jobs for large exports

### 1.5 Scientific Methodology Limitations

**Current harmonization issues:**
1. **Fixed scaling factor:** β = 0.294 globally
   - An exploratory legacy ratio of 0.529 exists in old evidence, but it is based on 9 paired cells and is not a validated estimate
   - No regional or biome-specific calibration
   - No fire-size or FRP-dependent scaling

2. **BAU interpretation ambiguity:**
   - Currently defined as "dimensionless 1-km equivalent activity indicator"
   - No clear physical units or interpretation
   - FRP term contributes only 2.71% (negligible but adds complexity)

3. **No observation opportunity tracking:**
   - Cannot distinguish "no fire" from "no observation"
   - Cannot account for cloud occlusion
   - Cannot track satellite overpass schedules
   - Critical for global validation

4. **No event detection:**
   - Hotspot detections are treated as unique fires
   - No spatial-temporal clustering into fire events
   - Cannot distinguish multiple detections of same fire

5. **Regional validation missing:**
   - No biome-level or continent-level performance evaluation
   - No geographic holdout validation
   - Cannot assess whether Bangladesh calibration generalizes globally

### 1.6 Database and Storage Limitations

**Documented PostGIS schema** (historical: a `backend/` FastAPI skeleton existed at audit time and has since been removed; the active schema is `src/types/fire.ts`):
- Single table with 20 columns
- Basic composite indexes on (date, sensor) and (lat, lon)
- **Not partitioned** (performance issue for global datasets)
- **No time-series partitioning** (query performance degradation)
- **No spatial partitioning** (inefficient for global queries)
- **No columnar storage** (inefficient for analytics)

**Storage layers not implemented:**
- No object storage (S3-compatible) for raw archives
- No Parquet for analytical datasets
- No Redis cache layer
- No data lake architecture
- No lifecycle management for historical data

### 1.7 Components Requiring Redesign

**Major redesigns required:**

1. **Spatial indexing system** — Replace cylindrical projection with global discrete grid
2. **Data ingestion** — Implement tiled, parallel, global download with job queue
3. **Storage architecture** — Three-layer system (raw/processed/analytical)
4. **API layer** — Add global endpoints, caching, tile serving, async exports
5. **Harmonization model** — Replace fixed β with regional calibration, observation opportunity tracking
6. **Frontend map** — Add global navigation, time playback, server-side aggregation
7. **Validation framework** — Add regional, biome-level, geographic holdout validation

### 1.8 Components That Should Remain Unchanged

**Preserve these components:**

1. **Core scientific philosophy** — Detection ≠ fire event distinction
2. **Canonical observation schema** — Well-designed, preserves provenance
3. **Non-parametric anomaly detection** — Median/MAD approach is sound
4. **CSV formula sanitization** — CWE-1236 defense is critical
5. **Frontend framework** — React, TypeScript, Tailwind, MapLibre GL are appropriate
6. **Basic API structure** — RESTful design is good, just needs expansion
7. **Test infrastructure** — 421 tests provide a solid regression foundation
8. **Docker configuration** — PostGIS setup is appropriate

**Do not remove:**
- The existing harmonization utilities (they need enhancement, not removal)
- The anomaly detection system (it needs historical data to work)
- The export functionality (it needs async jobs for large data)
- The scientific documentation (it needs global extension)

---

## 2. Global Scalability Problems

### 2.1 Data Volume Estimation

**NASA FIRMS global data scale:**
- MODIS: ~4-6 million detections per day globally
- VIIRS: ~10-15 million detections per day globally
- Historical archive: 20+ years of data

**Storage requirements (approximate):**
- MODIS C6.1 (2000-present): ~30 billion observations
- VIIRS (2012-present): ~15 billion observations
- Total: ~45 billion observations

**Storage implications:**
- 45 billion observations × ~200 bytes each = ~9 TB raw storage
- With indexing: ~15-20 TB in database
- **Cannot** store as single unpartitioned table
- **Cannot** load entire dataset into memory
- **Cannot** serve all observations via HTTP API

### 2.2 Query Performance Issues

**Unaddressed global query patterns:**

1. **Global bounding box queries:**
   - Scanning 45 billion rows without spatial partitioning
   - Full-table scans on (lat, lon) index for every query
   - Unacceptable latency (minutes to hours)

2. **Time-series queries:**
   - Querying 20 years of daily data for global calendar
   - Aggregating without pre-computation
   - Unacceptable latency

3. **Viewport-based map queries:**
   - Current: Returns all observations to browser, filters client-side
   - Global: Would return millions of points, crash browser
   - **Must** use server-side aggregation or vector tiles

### 2.3 NASA FIRMS API Limitations

**API constraints:**
- 5,000 transactions per 10-minute window
- Maximum 5 days per NRT area request (10 days for standard-processing products)
- No batch global download endpoint
- Must use tiled requests for global coverage

**Implications:**
- Cannot download entire globe in one request
- Must partition into ~200 geographic tiles
- Must implement rate limiting and backoff
- Must track transaction budget per 10-minute window
- Downloading full historical archive would take days with proper throttling

### 2.4 NASA Product Availability

**Standard science products (preferred):**
- MODIS_SP: 2000-11-01 to 2025-01-31 (multi-month lag)
- VIIRS_SNPP_SP: 2012-01-20 to 2025-02-28 (multi-month lag)
- VIIRS_NOAA20_SP: 2018-04-01 to 2025-02-28 (multi-month lag)

**NRT products (operational only):**
- MODIS_NRT: 2025-02-01 to present
- VIIRS_SNPP_NRT: 2025-03-01 to present
- VIIRS_NOAA20_NRT: 2025-03-01 to present
- VIIRS_NOAA21_NRT: 2024-01-17 to present

**Critical distinction:**
- NRT products have multi-month lag for scientific quality
- Standard science products have multi-month lag for availability
- Cannot use NRT for retrospective scientific analysis
- Historical coverage is incomplete for recent years

**Temporal coverage gaps:**
- MODIS pre-2000: Not available
- VIIRS pre-2012: Not available
- NOAA-21 pre-2022: Not available
- Recent data: Standard science products delayed by months

---

## 3. Current Technical Capabilities

### 3.1 Frontend Capabilities

**Existing pages:**
- Overview dashboard (Bangladesh-focused)
- Hotspot map explorer (single-region)
- Burning activity calendar (year selector, not multi-year)
- Sensor comparison (static metrics)
- Methodology documentation
- Export page (synchronous downloads)
- Settings page

**Strengths:**
- React 19 with TypeScript provides type safety
- MapLibre GL provides performant mapping
- Tailwind CSS provides consistent styling
- Component structure is modular

**Limitations for global use:**
- No global navigation or zoom levels
- No time-based playback controls
- No continent/country selector
- No biome or land-cover filtering
- No multi-year historical timeline
- No asynchronous export jobs
- No large dataset handling

### 3.2 Backend Capabilities

**Existing API endpoints:**
- `/api/v1/health` — System health check
- `/api/v1/metadata` — Study regions and dataset metadata
- `/api/v1/data-availability` — Local archive summary
- `/api/v1/hotspots` — Filtered observations (limit 1000)
- `/api/v1/calendar` — Daily summaries with baselines
- `/api/v1/analytics/summary` — KPIs
- `/api/v1/analytics/sensors` — Sensor comparison
- `/api/v1/analytics/calibration` — Calibration metrics
- `/api/v1/analytics/timeseries` — Time series
- `/api/v1/analytics/anomalies` — Anomaly detection
- `/api/v1/export/csv` — CSV export
- `/api/v1/export/calendar.csv` — Calendar CSV export
- `/api/v1/export/validation.csv` — Validation CSV export
- `/api/v1/ingestion/jobs` — Ingestion job list
- `/api/v1/ingestion/test-key` — FIRMS key validation
- `/api/v1/ingestion/trigger` — Trigger ingestion

**Strengths:**
- RESTful design is clean
- Filtering logic is correct
- Harmonization engine is scientifically structured
- CSV export with CWE-1236 defense

**Limitations for global use:**
- No global endpoints (all assume Bangladesh or single region)
- No pagination on observation returns
- No caching layer
- No rate limiting
- No tile-based or viewport-based queries
- No asynchronous job system
- No bulk export capability
- No pre-computed analytics

### 3.3 Data Pipeline Capabilities

**Current pipeline** (`data_pipeline/run_pipeline.py`):
- Single-region, single-file CSV processing
- SHA-256 checksum verification
- Schema normalization
- Duplicate detection
- JSON output

**Strengths:**
- Scientific data normalization is correct
- Checksum verification ensures reproducibility
- JSON schema is well-designed

**Limitations for global use:**
- No NASA FIRMS API integration (requires FIRMS_MAP_KEY)
- No tiled or parallel downloading
- No retry logic or error recovery
- No job queue or orchestration
- No progress tracking
- No incremental updates
- No multi-sensor coordination
- No product availability checking

### 3.4 Scientific Capabilities

**Current harmonization** (`src/utils/harmonization.ts`):
- 1-km equal-area cell aggregation
- Fixed VIIRS scaling (β = 0.294, exploratory assumption)
- Simple BAU formula with FRP term
- Temporal holdout validation framework

**Current anomaly detection** (`src/utils/anomaly.ts`):
- Median and MAD baselines
- Robust Z-score calculation
- Monthly seasonal grouping

**Limitations for global use:**
- No observation opportunity tracking
- No satellite overpass timing consideration
- No regional calibration
- No biome-specific baselines
- No fire-size dependent scaling
- No uncertainty quantification
- Validation requires 50+ paired cells (currently 9)

---

## 4. Infrastructure Requirements for Global Deployment

### 4.1 Minimum Infrastructure

**Development environment:**
- 16GB RAM minimum (for processing global subsets)
- 500GB SSD storage (for raw and processed data)
- 4 vCPU (for parallel processing)

**Production environment (estimated):**
- 64GB RAM (for PostgreSQL and Redis)
- 10TB object storage (S3-compatible)
- 16 vCPU (for background workers)
- PostgreSQL + PostGIS 16-3.4
- Redis (caching and job queue)
- Application servers (2-4 instances)

### 4.2 Required Additional Technologies

**Must add:**
- Redis (caching, job queue)
- Task queue (RQ, Celery, or equivalent)
- Parquet (for analytical storage)
- GeoPandas/Shapely (Python geospatial processing)
- Object storage (S3-compatible: MinIO, Wasabi, or AWS S3)
- Load balancer (Nginx or cloud provider LB)
- Monitoring (Prometheus, Grafana)

**Optional but recommended:**
- Kubernetes (orchestration)
- Airflow or Prefect (data pipeline orchestration)
- Dask or Ray (distributed processing)
- TimescaleDB (time-series optimization)

### 4.3 Estimated Costs

**Cloud provider estimate (AWS):**
- S3 storage (10TB): ~$230/month
- RDS PostgreSQL (r6g.large): ~$350/month
- ElastiCache Redis: ~$50/month
- EC2 instances (4x m6g.large): ~$600/month
- Data transfer: ~$100-500/month
- **Total:** ~$1,300-1,800/month minimum

**Self-hosted:**
- Hardware: $3,000-5,000 one-time
- Colocation: $300-500/month
- Bandwidth: $200-400/month
- **Total:** ~$500-900/month (lower initial cost, higher operational burden)

---

## 5. Phase 1A: Architecture and Feasibility Assessment

### 5.1 What Is Feasible Now

**Can be implemented with current resources:**
1. ✅ Global architecture documentation
2. ✅ Design of global storage and indexing system
3. ✅ NASA FIRMS API verification (requires FIRMS_MAP_KEY)
4. ✅ Design of tiled ingestion strategy
5. ✅ Database schema expansion for global data
6. ✅ API endpoint design for global queries

**Cannot be implemented without:**
1. ❌ NASA FIRMS MAP_KEY (user must obtain)
2. ❌ Sufficient storage for global data
3. ❌ Production infrastructure
4. ❌ Real global dataset (requires months of downloading)
5. ❌ Regional calibration (requires global data to train models)
6. ❌ Production deployment

### 5.2 Critical Blockers

**Primary blocker:**
- **No NASA FIRMS MAP_KEY** — Cannot download any real global data
- User must obtain from: https://firms.modaps.eosdis.nasa.gov/api/map_key

**Secondary blockers:**
- **Current calibration is EXPLORATORY** — Not scientifically validated
- **Dataset is inadequate** — 30 records << billions needed
- **No infrastructure budget** — Production deployment requires $1,300-1,800/month minimum
- **Time required** — Full global historical download would take weeks with proper throttling

### 5.3 Realistic Timeline

**Assuming FIRMS_MAP_KEY obtained immediately:**

**Stage A (Architecture):** 1-2 weeks
- Document global architecture
- Design storage schema
- Design ingestion strategy
- Design API endpoints

**Stage B (Ingestion infrastructure):** 2-3 weeks
- Implement tiled ingestion workers
- Set up Redis queue
- Implement job orchestration
- Add retry logic and backoff
- Set up object storage

**Stage C (Data acquisition):** 4-8 weeks
- Download MODIS historical (partial)
- Download VIIRS historical (partial)
- Validate and process
- Build canonical archive
- **Can start serving limited regions during this stage**

**Stage D (Spatial indexing):** 2-3 weeks
- Implement global discrete grid (H3 or HEALPix)
- Migrate existing data to new indexing
- Validate equal-area properties
- Add polar region handling

**Stage E (Harmonization research):** 4-6 weeks
- Collect paired observations globally
- Fit regional calibration models
- Implement observation opportunity tracking
- Validate regional performance
- Quantify uncertainty

**Stage F (Analytics & API):** 3-4 weeks
- Build global aggregation pipelines
- Implement tile serving
- Add global API endpoints
- Implement caching layer
- Add async export jobs

**Stage G (Frontend):** 3-4 weeks
- Global map with time playback
- Country/continent navigation
- Sensor layer controls
- Historical timeline
- Data explorer

**Stage H (Validation & deployment):** 2-3 weeks
- Run global validation tests
- Performance testing
- Production deployment
- Monitoring setup

**Total: 21-32 weeks (5-8 months)** assuming full-time work and adequate infrastructure

---

## 6. Recommended Architecture for Global Scale

### 6.1 Storage Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ Layer A: Raw (Immutable Source Files)                            │
│ data/raw/{product}/{satellite}/{year}/{month}/                     │
│ - Original NASA FIRMS CSV files                                      │
│ - SHA-256 checksums verified                                        │
│ - Never modified after download                                    │
│ - Object storage (S3-compatible)                                   │
└─────────────────────────────────────────────────────────────────┘
                           ↓ Processing
┌─────────────────────────────────────────────────────────────────┐
│ Layer B: Processed (Canonical Observations)                       │
│ data/processed/{product}/{year}/{month}/                         │
│ - Normalized to canonical schema                                     │
│ - Deduplicated by record_hash                                       │
│ - Quality flags validated                                         │
│ - PostgreSQL/PostGIS (partitioned by date and sensor)               │
│ - Parquet for analytical queries                                    │
└─────────────────────────────────────────────────────────────────┘
                           ↓ Aggregation
┌─────────────────────────────────────────────────────────────────┐
│ Layer C: Analytical (Pre-computed Aggregations)                   │
│ data/analytics/{resolution}/{year}/{month}/                       │
│ - 1-km cell aggregations by day                                       │
│ - 5-km cell aggregations for global maps                             │
│ - 25-km aggregations for continental views                            │
- Country and biome summaries                                         │
│ - Monthly/seasonal baselines                                         │
│ - Parquet columnar storage                                           │
└─────────────────────────────────────────────────────────────────┘
```

### 6.2 Global Spatial Indexing Recommendation

**Evaluate two options:**

**Option A: H3 Hierarchical Geospatial Indexing**
- Pros: Great for visualization, supported by many tools, equal-area at level 5
- Cons: Learning curve, hexagonal boundaries (some users prefer rectangular)
- Resolution: Level 5 ≈ 10 km², Level 6 ≈ 2.4 km², Level 7 ≈ 0.6 km²

**Option B: HEALPix**
- Pros: Native support in astronomy community, true equal-area, hierarchical
- Cons: Learning curve, less common in web GIS
- Resolution: H3K4 ≈ 25 km², H3K5 ≈ 5 km², H3K6 ≈ 1 km²

**Recommendation:** H3 for analytics, H3 for visualization, or pure lat/lon with dynamic resolution buckets for simplicity

### 6.3 Ingestion Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ Ingestion Orchestrator (Redis Queue)                                   │
│ - Manages job queue                                                  │
│ - Throttles requests to stay within API limits                          │
│ - Tracks progress and failures                                        │
└─────────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────────┐
│ Worker Pool (Python processes)                                       │
│ - Pull jobs from queue                                                │
│ - Download NASA FIRMS data via API                                     │
│ - Validate checksums and schema                                         │
│ - Normalize to canonical schema                                       │
│ - Store to Layer B and C                                                │
│ - Update progress tracking                                           │
└─────────────────────────────────────────────────────────────────┘
```

**Tile strategy:**
- Partition globe into ~200 geographic tiles (10° × 10°)
- Download data in supported API windows (NRT ≤ 5 days, SP ≤ 10 days)
- Process in parallel within transaction budget
- Use exponential backoff on failures
- Resume from last successful download

### 6.4 API Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ API Gateway (Express + Redis Cache)                                    │
│ - Rate limiting                                                        │
│ - Request throttling                                                   │
│ - Viewport-based caching                                               │
└─────────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────────┐
│ API Layer (Express)                                                      │
│ - /api/v1/global/* endpoints                                         │
│ - Viewport-based queries                                               │
│ - Tile serving endpoints                                             │
│ - Async export job management                                       │
└─────────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────────┐
│ Database Layer (PostgreSQL + PostGIS)                                  │
│ - Layer B: Canonical observations (partitioned)                     │
│ - Redis cache for frequent queries                                     │
└─────────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────────┐
│ Analytical Layer (Parquet)                                               │
│ - Pre-computed aggregations                                           │
│ - Global analytics                                                   │
│ - Country/biome summaries                                             │
└─────────────────────────────────────────────────────────────────┘
```

---

## 7. Priority Recommendations

### 7.1 Critical Prerequisites (Must Have)

1. **Obtain NASA FIRMS MAP_KEY**
   - Apply at: https://firms.modands.eosdis.nasa.gov/api/map_key
   - Free API key required for any data download
   - 5,000 transactions per 10-minute window

2. **Provision infrastructure budget**
   - Minimum: $500-900/month (self-hosted) or $1,300-1,800/month (cloud)
   - Storage: 10TB minimum for partial global archive
   - RAM: 64GB for database and caching

3. **Secure development time**
   - 5-8 months full-time work
   - Or equivalent part-time timeline (10-16 months)

### 7.2 High-Priority Redesigns

1. **Implement global spatial indexing** (replace cylindrical projection)
2. **Implement three-layer storage** (raw/processed/analytical)
3. **Implement tiled ingestion with job queue** (replace single-file processing)
4. **Add global API endpoints** (with caching and pagination)
5. **Replace fixed calibration with regional models** (requires global data to train)

### 7.3 Medium-Priority Enhancements

1. **Global map with time playback** (replace single-region map)
2. **Country and continent navigation** (add region selector)
3. **Sensor-specific map layers** (MODIS/VIIRS toggle)
4. **Regional validation framework** (add biome-level evaluation)
5. **Async export jobs** (for large global exports)

### 7.4 Low-Priority Additions

1. Fire event detection (cluster detections into events)
2. Predictive capabilities (explicitly separated from anomaly detection)
3. User accounts and saved queries
4. Alert system for anomalies
5. Mobile application

---

## 8. Conclusion

### 8.1 Current State Assessment

**What FireSync is today:**
- A scientifically structured proof-of-concept for MODIS-VIIRS harmonization
- Technical foundation is sound (React, TypeScript, Express, PostGIS)
- Scientific methodology is rigorous (canonical schema, non-parametric anomalies)
- **NOT** a global platform

**What FireSync is NOT today:**
- A global fire intelligence platform
- Production-ready for worldwide deployment
- Calibrated for use beyond Bangladesh
- Scaled for global data volumes

### 8.2 Gap Analysis

| Aspect | Current State | Global Requirement | Gap |
|--------|--------------|-------------------|-----|
| Dataset size | 30 records | 45 billion records | 15,000,000x |
| Geographic scope | Bangladesh (0.1% of land area) | Worldwide | 1000x |
| Temporal coverage | 8 active days | 20+ years | 1000x |
| Calibration status | INSUFFICIENT (fixed exploratory β) | Regionally validated | Major |
| Spatial indexing | Single-region cylindrical | Global discrete grid | Redesign |
| Storage | In-memory + optional JSON | Multi-layer with 10TB+ | Redesign |
| API | Single-region, pagination present | Global with caching | Redesign |
| Ingestion | Windowed pipeline implemented; no key | Tiled, parallel, orchestrated | Redesign |
| Infrastructure | Development laptop | Production cluster | Provision |

### 8.3 Realistic Path Forward

**Option A: Pursue Full Global Platform**
- Requires: FIRMS_MAP_KEY, infrastructure budget, 5-8 months work
- Outcome: Global fire intelligence platform
- Risk: High (significant investment, scientific validation uncertain)

**Option B: Incremental Regional Expansion**
- Focus: Expand to 3-5 regions with NASA data
- Requires: FIRMS_MAP_KEY, modest infrastructure, 2-3 months work
- Outcome: Multi-regional platform (South Asia, Amazon, California)
- Risk: Medium (more achievable, scientific validation possible)

**Option C: Scientific Foundation Focus**
- Focus: Improve calibration and validation with expanded dataset (Bangladesh + adjacent regions)
- Requires: FIRMS_MAP_KEY, modest infrastructure, 2-3 months work
- Outcome: Regionally validated harmonization methodology
- Risk: Low (achievable, scientifically defensible)

**Recommendation:** Start with Option C (scientific foundation), then evaluate whether to proceed to Option B (multi-regional) or Option A (full global).

### 8.4 Scientific Honesty Statement

The current FireSync project demonstrates excellent scientific structure and technical competence. However, claiming global readiness would be scientifically dishonest and technically impossible given:

- The dataset is three orders of magnitude too small
- The calibration model is exploratory and requires regional validation
- The infrastructure is not provisioned for global data volumes
- No real global data has been acquired
- The spatial indexing is not globally appropriate

A global platform can be built, but it requires months of work, substantial infrastructure investment, and systematic data acquisition starting with the FIRMS API key. The project should be positioned as a scientifically rigorous foundation for global expansion, not as a ready-to-deploy global system.

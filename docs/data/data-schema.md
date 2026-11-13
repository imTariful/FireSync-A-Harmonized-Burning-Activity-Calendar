# Data Schema

This document describes FireSync's data schema, including the canonical observation model, database schema, and data relationships.

---

## Canonical Observation Model

### Observation Schema

FireSync uses a canonical schema for all MODIS and VIIRS observations, normalized from NASA FIRMS CSV format.

**Table:** `observations`

| Field | Type | Description | Required |
|-------|------|-------------|----------|
| id | string | Unique observation identifier (UUID) | ✅ Yes |
| source_record_id | string | NASA FIRMS source record ID | ✅ Yes |
| latitude | float | Latitude in decimal degrees (WGS 84) | ✅ Yes |
| longitude | float | Longitude in decimal degrees (WGS 84) | ✅ Yes |
| acq_date | date | Acquisition date (YYYY-MM-DD) | ✅ Yes |
| acq_time | string | Acquisition time (HHMM) | ✅ Yes |
| datetime_utc | datetime | Full UTC timestamp (YYYY-MM-DDTHH:mm:ssZ) | ✅ Yes |
| sensor | string | Sensor type (MODIS or VIIRS) | ✅ Yes |
| satellite | string | Satellite platform (Terra, Aqua, Suomi-NPP, NOAA-20, NOAA-21) | ✅ Yes |
| product | string | Product identifier (MODIS_C6_1, VIIRS_SNPP_NRT, etc.) | ✅ Yes |
| processing_version | string | Processing level or version (6.1, 2.0NRT, etc.) | ✅ Yes |
| confidence | integer/string | Detection confidence (0-100 for MODIS, high/nominal/low for VIIRS) | ✅ Yes |
| confidence_category | string | Normalized confidence category (high, nominal, low) | ✅ Yes |
| frp_mw | float | Fire Radiative Power in megawatts | ✅ Yes |
| brightness | float | Brightness temperature in Kelvin (MODIS only) | ❌ No |
| bright_ti4 | float | I-band 4 brightness temperature in Kelvin (VIIRS only) | ❌ No |
| bright_ti5 | float | I-band 5 brightness temperature in Kelvin (VIIRS only) | ❌ No |
| scan | float | Scan angle in degrees | ✅ Yes |
| track | float | Track angle in degrees | ✅ Yes |
| daynight | string | D (day) or N (night) | ✅ Yes |
| source_file | string | Original NASA FIRMS CSV filename | ✅ Yes |
| retrieved_at | datetime | Timestamp when file was downloaded | ✅ Yes |
| quality_flags | string | Quality flags (clear_land, good_quality, etc.) | ✅ Yes |
| record_hash | string | SHA-256 hash for deduplication | ✅ Yes |

### Indexes (optional PostGIS design — not implemented)

**Primary Key:** `id`

**Secondary Indexes:**
- `idx_date_sensor` — (acq_date, sensor) for temporal queries
- `idx_location` — (latitude, longitude) for spatial queries
- `idx_satellite` — (satellite) for platform filtering
- `idx_product` — (product) for product filtering
- `idx_hash` — (record_hash) for deduplication

---

## Database Schema

### Canonical Observation Model

**Model File:** `src/types/fire.ts` (`CanonicalObservation`)

**Current Implementation:**
The TypeScript interface is the single source of truth for every observation the
API returns — live NRT, ingested jobs and historical archive rows are all mapped
onto it (`toCanonical` in `src/server/historical.ts` for archive data).

Key fields: `id`, `source_record_id`, `latitude`, `longitude`, `acq_date`,
`acq_time`, `datetime_utc`, `sensor`, `satellite`, `product`,
`processing_version`, `confidence`, `confidence_category`, `frp_mw`,
`brightness` (MODIS), `bright_ti4`/`bright_ti5` (VIIRS), `scan`, `track`,
`daynight`, `source_file`, `retrieved_at`, `quality_flags`, `record_hash`,
`provenance_status`.

**Note:** There is no SQL database in the running app — the "indexes" above
describe the optional PostGIS design only and are not implemented.

### PostGIS Geometry (Future)

**Recommended Addition:**
```python
from geoalchemy2 import Geometry

geom = Column(Geometry('POINT', srid=4326))
```

**Purpose:** Enable spatial queries with PostGIS functions:
- ST_DWithin — Find observations within distance
- ST_Contains — Check if point is in polygon
- ST_Intersects — Spatial intersection queries

---

## Data Relationships

### Observation Relationships

**Self-Referential:** None (observations are independent)

**Hierarchical:** None (flat table design)

**Foreign Keys:** None (observations are independent entities)

---

## Derived Data Tables

### Spatial-Temporal Cells

**Purpose:** Store aggregated counts per 1-km cell per day

**Schema:**
```python
class SpatialTemporalCell(Base):
    __tablename__ = "spatial_temporal_cells"
    
    id = Column(String, primary_key=True)  # cell_id + date
    cell_id = Column(String, nullable=False)  # Grid cell identifier
    date = Column(Date, nullable=False)
    modis_count = Column(Integer, default=0)
    viirs_count = Column(Integer, default=0)
    harmonized_activity = Column(Float, default=0.0)
    frp_total_mw = Column(Float, default=0.0)
    observation_opportunity = Column(Boolean, default=True)  # Future: track opportunity
```

**Indexes:**
- `idx_cell_date` — (cell_id, date) primary key
- `idx_date` — (date) for temporal queries
- `idx_cell` — (cell_id) for spatial queries

---

### Calibration Metrics

**Purpose:** Store calibration model performance metrics

**Schema:**
```python
class CalibrationMetrics(Base):
    __tablename__ = "calibration_metrics"
    
    id = Column(String, primary_key=True)
    model_id = Column(String, nullable=False)
    model_version = Column(String, nullable=False)
    sample_size_paired_cells = Column(Integer, nullable=False)
    training_period_start = Column(Date, nullable=False)
    training_period_end = Column(Date, nullable=False)
    validation_period_start = Column(Date, nullable=False)
    validation_period_end = Column(Date, nullable=False)
    mae = Column(Float, nullable=True)
    rmse = Column(Float, nullable=True)
    mean_bias = Column(Float, nullable=True)
    r_squared = Column(Float, nullable=True)  # Null if undefined
    calibration_slope = Column(Float, nullable=False)
    calibration_intercept = Column(Float, nullable=False)
    status = Column(String, nullable=False)  # exploratory, validated
    created_at = Column(DateTime, default=datetime.utcnow)
```

---

### Anomaly Scores

**Purpose:** Store anomaly detection results

**Schema:**
```python
class AnomalyScore(Base):
    __tablename__ = "anomaly_scores"
    
    id = Column(String, primary_key=True)
    date = Column(Date, nullable=False)
    region_id = Column(String, nullable=True)
    baseline_activity = Column(Float, nullable=False)
    observed_activity = Column(Float, nullable=False)
    mad = Column(Float, nullable=True)
    z_score = Column(Float, nullable=True)
    category = Column(String, nullable=False)  # normal, moderate, extreme
    created_at = Column(DateTime, default=datetime.utcnow)
```

---

## Ingestion Jobs

### Job Tracking

**Purpose:** Track data ingestion job status

**Schema:**
```python
class IngestionJob(Base):
    __tablename__ = "ingestion_jobs"
    
    id = Column(String, primary_key=True)
    region_id = Column(String, nullable=False)
    start_date = Column(Date, nullable=False)
    end_date = Column(Date, nullable=False)
    products = Column(JSON, nullable=False)  # List of product IDs
    status = Column(String, nullable=False)  # queued, running, completed, failed
    total_jobs = Column(Integer, default=0)
    completed_jobs = Column(Integer, default=0)
    failed_jobs = Column(Integer, default=0)
    records_processed = Column(Integer, default=0)
    records_rejected = Column(Integer, default=0)
    started_at = Column(DateTime, nullable=True)
    completed_at = Column(DateTime, nullable=True)
    error_message = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
```

---

## Data Quality Tables

### Rejection Log

**Purpose:** Track rejected records with reasons

**Schema:**
```python
class RejectionLog(Base):
    __tablename__ = "rejection_log"
    
    id = Column(String, primary_key=True)
    source_record_id = Column(String, nullable=False)
    rejection_reason = Column(String, nullable=False)
    rejection_category = Column(String, nullable=False)  # invalid_coord, duplicate, missing_field, etc.
    raw_data = Column(JSON, nullable=True)  # Store raw record for debugging
    created_at = Column(DateTime, default=datetime.utcnow)
```

---

## Runtime Observation Store

### Canonical Store

**File:** `src/server/store.ts` (runtime store)

**Purpose:** Zero-dependency storage for records produced by real NASA FIRMS ingestion

**Runtime behavior:**
- Default: in-memory store that starts **empty**. There is no bundled seed, demo fixture or
  synthetic fallback. `src/data/nasa_firms_archive.ts` was removed on 2026-11-10.
- Optional: JSON file persistence via `FIRESYNC_STORE_PATH`.
- A completed real ingestion job adds records with `provenance_status: VERIFIED`; the store
  itself reports `UNVERIFIED` while empty and stays `UNVERIFIED` if any record is not verified.
- Ingested observations are deduplicated by record hash.
- Live NRT data served through `source=live` is fetched on demand and is **not** written to
  the store unless an ingestion job is explicitly run.

**Structure:**
```typescript
interface Observation {
  id: string;
  source_record_id: string;
  latitude: number;
  longitude: number;
  acq_date: string;
  acq_time: string;
  datetime_utc: string;
  sensor: "MODIS" | "VIIRS";
  satellite: string;
  product: string;
  processing_version: string;
  confidence: number | string;
  confidence_category: "high" | "nominal" | "low";
  frp_mw: number;
  brightness?: number;  // MODIS only
  bright_ti4?: number;  // VIIRS only
  bright_ti5?: number;  // VIIRS only
  scan: number;
  track: number;
  daynight: "D" | "N";
  source_file: string;
  retrieved_at: string;
  quality_flags: string;
  record_hash: string;
}
```

**Limitations:**
- Without `FIRESYNC_STORE_PATH`, data is lost on restart
- JSON persistence is single-process and not a database
- No spatial indexing
- No query optimization
- Not suitable for global or high-volume production use

---

## Data Migration

### Schema Versioning

**Current Version:** 1.0.0

**Migration Framework:** Not yet implemented

**Recommended Tool:** Alembic (Python) or Flyway (SQL)

### Migration Steps

1. **Backup existing data**
2. **Apply migration script**
3. **Verify data integrity**
4. **Update schema version**
5. **Commit migration to version control**

---

## Data Backup

> **Scope:** The following is a recommended strategy for the optional PostgreSQL
> profile. The running Express app does not use PostgreSQL, so this is not the current
> backup path. For the JSON adapter, back up the file at `FIRESYNC_STORE_PATH`.

### Backup Strategy

**Frequency:** Daily

**Method:** pg_dump (PostgreSQL)

**Retention:** 30 days (daily), 12 months (monthly)

**Command:**
```bash
pg_dump -U firesync -d firesync -F c -f /backups/firesync_$(date +%Y%m%d).dump
```

### Recovery

**Restore from backup:**
```bash
pg_restore -U firesync -d firesync /backups/firesync_20261101.dump
```

---

## Data Archival

### Cold Storage

**Purpose:** Archive raw NASA FIRMS CSV files for long-term retention

**Storage:** S3 or local filesystem

**Retention:** Permanent (source data should never be deleted)

### Hot vs Cold Data

**Hot Data (PostgreSQL):**
- Recent observations (last 1-2 years)
- Spatial-temporal cells
- Calibration metrics
- Anomaly scores

**Cold Data (Object Storage):**
- Raw NASA FIRMS CSV files
- Historical observations (> 2 years)
- Ingestion logs

---

## References

- **PostgreSQL Documentation.** https://www.postgresql.org/docs/
- **PostGIS Documentation.** https://postgis.net/documentation/
- **NASA FIRMS Data Format.** https://firms.modaps.eosdis.nasa.gov/content/academy/data_api/firms_data_use.html

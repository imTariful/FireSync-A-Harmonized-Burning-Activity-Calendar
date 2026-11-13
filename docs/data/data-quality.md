# Data Quality

This document describes FireSync's data quality assurance procedures, what is actually
verified, and which quality metrics remain unknown.

**Current runtime:** World default, live NASA FIRMS NRT only (rolling 1–5 days), empty local
store by default, no bundled archive, no synthetic fallback. The historical
standard-science archive has not been ingested.

---

## Data Quality Philosophy

FireSync follows these rules:

- **Source verification:** SHA-256 checksums are computed and preserved for files fetched
  by the server ingestion path and the Python pipeline. A checksum proves file integrity,
  **not** NASA authenticity.
- **No pre-seeded data:** the runtime store starts empty. There is no bundled archive or
  demo fixture to certify.
- **Schema normalization:** consistent schema across MODIS and VIIRS, with explicit
  rejection reasons.
- **Deduplication:** SHA-256 record-hash duplicate detection.
- **Rejection logging:** rejected records are recorded with a reason, never silently
  dropped.
- **Provenance tracking:** source file, retrieval timestamp and live cache state are
  preserved when available.
- **Missing is not zero:** absent dates and empty stores are not zero-fire claims.

---

## Quality Assurance Pipeline

### Step 1: Download Verification

**Check:** SHA-256 checksum of the downloaded file matches the recorded digest.

**Process:**

1. Download the NASA FIRMS CSV response.
2. Compute SHA-256 of the response and of the written file.
3. Compare the two digests; a mismatch fails the job.
4. Record the digest in `checksums.json` and the source manifest.
5. Preserve the raw file.

**Status:** Implemented for the server NRT ingestion path and the Python pipeline. Verified
on 2026-11-10 for three NRT products (2 / 12 / 17 data rows); all three SHA-256 values
matched.

**Limitation:** a checksum does not prove the file came from NASA. Authenticity requires
the official source URL, product metadata and publication record.

---

### Step 2: Schema Validation

**Check:** Required fields are present and valid.

**Process:**

1. Parse the CSV.
2. Validate required fields (latitude, longitude, date, time, sensor, satellite,
   confidence, FRP).
3. Validate types and ranges.
4. Normalize confidence categories.
5. Reject records with missing or invalid required fields, with a reason.

**Status:** Implemented and covered by ingestion/pipeline tests. The live path passes
through official FIRMS rows; a record-level rejection rate for the live response is not
reported, so none is claimed.

---

### Step 3: Coordinate Validation

**Check:** Coordinates are inside valid geographic bounds and, when a bbox is requested,
inside that bbox.

**Process:**

1. Latitude must be in `[-90, 90]`.
2. Longitude must be in `[-180, 180]`.
3. A requested bbox is applied as a preliminary filter.
4. An AOI polygon is applied after the bbox filter.
5. Invalid coordinates are rejected with a reason.

**Status:** Implemented and tested, including antimeridian-crossing AOIs. The live world
path uses the full globe; no claim is made that every detection is inside a smaller
region unless that region was requested.

---

### Step 4: Duplicate Detection

**Check:** Canonical record hash.

**Process:**

1. Compute a hash from the canonical record fields.
2. Check whether the hash already exists in the store.
3. Reject duplicates.
4. Record the real `records_imported` count after deduplication.

**Status:** Implemented and tested. The live path is fetched per request and cached, not
deduplicated into the store unless an ingestion job is run.

---

### Step 5: Quality Flag Validation

**Check:** Quality flags and confidence values are internally consistent where the product
provides them.

**Process:**

1. Validate recognized quality flag values.
2. Keep MODIS numeric confidence and VIIRS categorical confidence distinct.
3. Do not coerce a missing flag to a valid value.

**Status:** Partially implemented. The application preserves the source confidence and
quality fields; it does not claim a full quality-flag audit for NRT products.

---

## Data Quality Metrics

### Completeness

**Definition:** Percentage of expected observations present.

```
completeness_pct = (actual_records / expected_records) * 100
```

**Current status:** `null` (unknown). Observation opportunity (overpass, cloud, quality
mask) is not tracked, so the denominator cannot be established.

**Limitation:** cannot distinguish missing data from no fire activity.

---

### Accuracy

**Definition:** Proportion of records that pass all validation checks.

**Current status:** not claimed for live NRT. A schema/coordinate pass rate is not a
measure of fire-detection accuracy, and no independent ground truth is available.

---

### Consistency

**Definition:** Proportion of records with a consistent schema and value domain.

**Current status:** schema consistency is enforced by the canonical type and parser tests.
No percentage is claimed for the live world response.

---

### Timeliness

**Definition:** Latency between satellite observation and data availability.

```
latency_hours = (download_timestamp - observation_timestamp) / 3600
```

**Current status:** not measured. NRT is nominally available within hours, but no latency
SLO is measured or claimed here.

---

## Data Quality Checks

### Required Field Checks

| Field | Validation | Status |
|---|---|---|
| latitude | −90 to 90 | Implemented |
| longitude | −180 to 180 | Implemented |
| acq_date | Valid `YYYY-MM-DD` | Implemented |
| acq_time | Valid `HHMM` | Implemented |
| sensor | MODIS or VIIRS | Implemented |
| satellite | Recognized platform | Implemented |
| confidence | Valid range/category | Implemented |
| frp_mw | Non-negative, finite | Implemented |

### Optional Field Checks

| Field | Validation | Status |
|---|---|---|
| brightness | Present for MODIS only | Preserved when present |
| bright_ti4 | Present for VIIRS only | Preserved when present |
| bright_ti5 | Present for VIIRS only | Preserved when present |

---

## Data Quality Issues

### 1. NRT vs Standard Processing

**Issue:** the live path uses `MODIS_NRT`, `VIIRS_NOAA20_NRT` and `VIIRS_NOAA21_NRT`, not
standard-science products.

**Impact:**

- NRT products may differ from standard processing after reprocessing.
- Not suitable for retrospective scientific analysis.
- Quality flags and processing differ from standard products.

**Recommendation:** ingest standard-science products (`MODIS_C6_1`, `VNP14IMGML`,
`VJ114IMGML`) through the official FIRMS/Earthdata path and validate normalization.

---

### 2. Temporal Coverage: One Day in the Final Run

**Issue:** the final live world aggregate covers one observed day (2026-11-09). Live NRT
only exposes the rolling last 1–5 days.

**Impact:**

- No meaningful seasonal baseline.
- Anomaly detection is normally `insufficient_data`.
- Temporal holdout cannot satisfy strict separation.
- No historical trend can be claimed.

**Recommendation:** the local historical archive (`data_pipeline/` over FIRMS
download ZIPs) now provides multi-year coverage when built; do not treat live
NRT as a substitute for it.

---

### 3. Geographic Coverage: Global Query, Unvalidated Regional Calibration

**Issue:** queries work worldwide, but the fixed 0.294 factor is a global exploratory
assumption, not a regionally validated coefficient.

**Impact:**

- Global counts are available, but calibration may not apply to every fire regime.
- No regional validation exists for the Amazon, boreal regions, Australia or Africa.

**Recommendation:** fit and validate regional models only with independent data.

---

### 4. Observation Opportunity: Not Tracked

**Issue:** cannot distinguish "no fire" from "no observation".

**Impact:**

- Missing data must not be treated as zero activity.
- Cloud occlusion is not accounted for.
- Completeness metrics cannot be computed.

**Recommendation:** implement observation-opportunity tracking using satellite ephemeris,
cloud masks and per-product quality flags.

---

## Data Quality Monitoring

### Recommended Monitoring

**Daily metrics:**

- records ingested and rejected, with rejection reasons;
- SHA-256 verification rate;
- live source errors and cache state.

**Weekly metrics:**

- coverage by region;
- data latency;
- temporal and geographic gaps.

**Monthly metrics:**

- quality trends;
- storage growth;
- ingestion job success rate.

None of these dashboards is currently implemented.

---

## Data Quality Reports

### Current Reports

**Pipeline runs:** `reports/data_pipeline/<run_id>/`

- `manifest.json` and `quality_report.json`
- raw-file SHA-256 checksums and rejection reasons
- coverage marked `observed_days_only`; missing dates are not zero

**Live NRT verification:** `reports/remediation/FINAL_VERIFICATION_REPORT.md`

- 2026-11-09 world 1-day aggregate: 103,131 detections (MODIS 7,073; VIIRS 96,058),
  58,265 bins, 0 source errors
- map response is capped and reports `truncated: true`

**Calibration diagnostics:** `reports/calibration_validation.{json,csv,md}`

- these describe the removed 30-observation demo fixture and are historical
- current live calibration status is `INSUFFICIENT`

**Legacy evidence:** `reports/evidence/`

- dated snapshots retained for history
- `ingestion_verification.json` is not proof of raw-file verification
- old R² = 0 values are normalized to `null`; see `reports/evidence/README.md`

---

## Data Quality Improvements

### Short-Term

1. Replace NRT with standard-science products for historical work.
2. Implement observation-opportunity tracking.
3. Add completeness metrics when opportunity tracking is available.
4. Add data-latency monitoring.

### Long-Term

1. Expand temporal coverage with a verified historical archive.
2. Add regional validation rather than assuming one global coefficient.
3. Add automated quality alerts.
4. Add data-quality dashboards.

---

## Data Cleaning

### Outlier Detection

**Method:** statistical outlier detection on coordinates and FRP.

**Current status:** not implemented.

**Recommended:**

- flag observations with extreme FRP values;
- flag coordinates outside expected fire regions;
- review flagged observations manually.

### Smoothing

**Method:** temporal smoothing of detection counts.

**Current status:** not implemented.

**Recommendation:** do not smooth raw data; smoothing belongs in analysis, not source data.

---

## Data Retention

### Retention Policy

**Raw data:** permanent (never delete source NASA FIRMS files)  
**Processed data:** permanent (observations are scientific data)  
**Rejection logs:** 1 year (for debugging)  
**Ingestion logs:** 1 year (for debugging)

### Archival

**Current runtime:** in-memory store, empty at startup, optionally persisted to a JSON file
via `FIRESYNC_STORE_PATH`. Without that variable, ingested records are lost on restart.  
**Optional infrastructure:** PostgreSQL/PostGIS and Redis compose profiles exist but are
not integrated with the Express runtime.  
**Recommended:** object storage or filesystem archives for raw and processed data once the
dataset outgrows the JSON adapter.

---

## Data Quality Certification

### Current Certification

**Status:** no formal certification.

**Documentation:**

- checksums preserved for files fetched by real ingestion/pipeline runs;
- live NRT responses are `VERIFIED` as official-source responses, not scientifically
  validated observations;
- the local store is empty at startup and `UNVERIFIED` with an explicit reason;
- the historical archive is a separate local Parquet store (not part of the
  runtime store) built from official FIRMS download ZIPs — 392.5M deduplicated
  observations when present, unavailable otherwise;
- no record-level accuracy, completeness or latency percentage is claimed.

**Certification statement:**

> FireSync currently serves live NASA FIRMS NRT data for the rolling last 1–5 days and
> starts with an empty local store. It has verified raw-file integrity for the recorded
> NRT ingestion batch, but it has **not** verified a historical dataset, observation
> opportunity, calibration or ground truth. It is insufficient for scientific validation
> or a historical global fire claim.

---

## References

- **NASA FIRMS Data Quality.** https://firms.modaps.eosdis.nasa.gov/content/academy/data_api/firms_data_use.html
- **MODIS Collection 6.1 Quality Assurance.** NASA MODIS Land Team.
- **VIIRS 375m Product Quality.** NASA VIIRS Team.
- **Data Quality Assessment Framework.** ISO/IEC 25012.

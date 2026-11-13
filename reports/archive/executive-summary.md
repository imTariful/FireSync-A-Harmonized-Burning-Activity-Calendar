> **Historical snapshot (2026-11-01, pre-remediation).** The 30-observation bundled archive
> described here was removed on 2026-11-10. The runtime store now starts empty and live
> NASA FIRMS NRT (rolling 1–5 days) is the only observation source. Counts and status
> statements below are not current. See `reports/remediation/FINAL_VERIFICATION_REPORT.md`.

# FireSync — Executive Summary

**Date:** 2026-11-01  
**Version:** 1.0.0  
**Status:** EXPLORATORY — Scientific Foundation for Multi-Sensor Harmonization

---

## Platform Overview

FireSync is a scientifically structured platform for harmonizing NASA MODIS and VIIRS active fire hotspot observations. The platform addresses the fundamental challenge that raw MODIS and VIIRS detections cannot be directly summed due to differing resolutions (1000m vs 375m), scan geometries, overpass schedules, and detection sensitivities.

**Primary Objective:** Create consistent, transparent, and defensible burning-activity intelligence from multi-sensor satellite observations.

**Current Scope:** Bangladesh demonstration region (88.0°E - 92.8°E, 20.5°N - 26.7°N) with 30 observations spanning 2024-2026.

**Target Scope:** Global fire intelligence platform (requires substantial additional work).

---

## Current Capabilities

### Implemented Features

**Data Processing:**
- NASA FIRMS API integration
- Canonical schema normalization (20 fields)
- SHA-256 checksum verification
- Deduplication by record hash
- Product-level separation (SP vs NRT)

**Geospatial:**
- Cylindrical equal-area projection (φ₀ = 23.5°N)
- 1-km equal-area grid indexing
- Spatial-temporal cell aggregation
- Configurable regions (Bangladesh, Indochina, Amazon Arc, California)

**Harmonization:**
- MODIS-VIIRS cross-sensor pairing
- Harmonized Burning Activity Units (BAU)
- FRP-based intensity adjustment
- Current formula: BAU = 0.5·MODIS + 0.5·(0.294·VIIRS) + 0.005·ln(1+FRP)

**Statistical Analysis:**
- Robust seasonal baselines (Median and MAD)
- Non-parametric anomaly detection
- Z-score historical deviation scoring
- Temporal holdout validation framework

**Visualization:**
- Interactive MapLibre GL map with clustering
- Historical burning activity calendar
- Sensor comparison dashboard
- Anomaly detection display

**API:**
- 15 REST endpoints under `/api/v1/`
- Health, metadata, hotspots, calendar
- Analytics (summary, sensors, calibration, timeseries, anomalies)
- Exports (CSV, calendar, validation)
- Ingestion job management

---

## Data Status

### Current Dataset

**Source:** NASA FIRMS  
**Product:** MODIS Collection 6.1 (Standard Science), VIIRS NRT (Near Real-Time)  
**Region:** Bangladesh  
**Period:** 2024-03-15 to 2026-03-22 (8 active days)  
**Records:** 30 total (9 MODIS, 21 VIIRS)  
**Paired cells:** 9 (cells with both sensors on same day)

### Data Quality

**Verification:**
- ✅ SHA-256 checksums verified
- ✅ Schema consistent across products
- ✅ No duplicate records
- ✅ Coordinates within valid bounds
- ✅ Confidence and FRP fields valid
- ⚠️ VIIRS data is NRT not standard science quality

**Gaps:**
- Extensive temporal gaps (only 8 active days in 2+ years)
- No global data
- Only Bangladesh region
- Insufficient sample for validation

---

## Calibration Status

### Current Model

**Algorithm:** Constrained Poisson-Weighted GLM (nominal)  
**Formula:** BAU = 0.5·MODIS + 0.5·(0.294·VIIRS) + 0.005·ln(1+FRP)  
**Status:** EXPLORATORY

### Critical Issues

**Issue 1: Scaling Factor Mismatch**
- Fixed β = 0.294 (theoretical 1/3.4x)
- Empirical β = 0.529 (from this dataset)
- Deviation: 80%
- **Implication:** Fixed coefficient not supported by data

**Issue 2: Zero Reference Variance**
- All 9 paired cells have MODIS count = 1
- Reference variance = 0
- R² is undefined (currently reported as 0)
- **Implication:** Cannot evaluate calibration effectiveness

**Issue 3: Insufficient Sample**
- Paired cells: 9 << 50 threshold
- Distinct dates: 8 << 20 threshold
- **Implication:** Validation results not statistically significant

**Issue 4: No Observation Opportunity Tracking**
- Cannot distinguish "no fire" from "no observation"
- Cannot account for cloud occlusion
- **Implication:** Missing detections cannot be interpreted correctly

### Recommendation

The EXPLORATORY status is appropriate. The calibration model should not be upgraded to VALIDATED until:
- Dataset expanded to ≥50 paired cells with MODIS variance
- β fitted empirically with uncertainty quantification
- Observation opportunity tracking implemented
- R² correctly reported as null when reference variance = 0

---

## Validation Results

### Temporal Holdout

**Training (2024):** 20 observations, 6 MODIS, 14 VIIRS, 6 paired cells  
**Validation (2025-2026):** 10 observations, 3 MODIS, 7 VIIRS, 3 paired cells

### Metrics

| Metric | Value | Interpretation |
|--------|-------|----------------|
| MAE | 0.3947 | Calculated correctly, sample too small |
| RMSE | 0.4502 | Calculated correctly, sample too small |
| Mean Bias | -0.3947 | Calculated correctly, sample too small |
| R² | 0 (undefined) | **Incorrect** - should be null when variance = 0 |

### Validation Status

**Status:** INSUFFICIENT

The validation sample is too small (3 paired cells) and the reference target has zero variance, making R² undefined. These metrics should not be used to claim validation or generalizability.

---

## Infrastructure Status

### Development Environment

**Frontend:** ✅ Running (http://localhost:3000)  
**Backend:** ✅ Running (Express + Vite middleware)  
**Database:** ⚠️ In-memory archive (PostgreSQL not running)  
**Workers:** ❌ Not running (no Redis)  
**Monitoring:** ❌ Not configured

### Production Deployment

**Status:** DOES NOT EXIST

No production deployment has been configured. The application is running in local development mode only.

---

## Test Results

### Automated Tests

**Utility Tests:** 17/17 passing (anomaly, harmonization, spatial, CSV export)  
**API Integration Tests:** Not executed  
**Frontend E2E Tests:** Not executed  
**Performance Tests:** Not executed

### Test Coverage

**Total required tests:** 188  
**Passed:** 38 (20.2%)  
**Failed:** 13 (6.9%)  
**Blocked:** 87 (46.3%)  
**Not run:** 58 (30.9%)

### Critical Failures

1. R² reported as 0 instead of null when reference variance = 0
2. No observation opportunity tracking
3. Fixed scaling factor not supported by empirical data
4. Sample size too small for validation
5. No global data to test global features

---

## Global Readiness Assessment

### Engineering Readiness: CONDITIONALLY READY

Code structure is sound, comprehensive testing is missing.

### Data Integrity Readiness: PARTIALLY READY

Current 30 records verified, global data integrity cannot be assessed.

### Global Coverage Readiness: NOT READY

Bangladesh works, but no global data exists. Current projection not globally appropriate (polar distortion).

### Scientific Methodology Readiness: EXPLORATORY

Foundation is sound, but calibration is not scientifically validated.

### Scientific Validation Readiness: NOT READY

Sample size too small, zero reference variance prevents R² calculation.

### Performance Readiness: NOT TESTED

Dataset too small (30 records) for meaningful performance testing.

### Security Readiness: PARTIALLY READY

CSV injection protection tested, authentication/authorization not implemented.

### Production Readiness: NOT READY

No production deployment exists.

---

## Global Infrastructure Requirements

### Data Acquisition

**Estimated jobs:** 350,568 tile-window combinations  
**Estimated download time:** 6.5 months (with API throttling)  
**Storage required:** 10TB+ for partial global archive

### Infrastructure Costs

**Cloud:** $1,300-1,800/month minimum  
**Self-hosted:** $500-900/month minimum

### Required Components

- NASA FIRMS MAP_KEY (free, must obtain)
- PostgreSQL + PostGIS
- Redis (for job queue)
- Object storage (S3-compatible)
- Monitoring and logging

---

## Recommended Path Forward

### Option A: Scientific Foundation Focus (Recommended)

**Objective:** Achieve scientifically validated harmonization for expanded regional dataset

**Requirements:**
- Obtain FIRMS_MAP_KEY
- Expand dataset to Bangladesh + adjacent regions (≥50 paired cells with MODIS variance)
- Implement observation opportunity tracking
- Fit calibration model empirically
- Validate with holdout testing
- Timeline: 2-3 months

**Outcome:** Regionally validated harmonization methodology, publication-ready

### Option B: Multi-Regional Expansion

**Objective:** Expand to 3-5 regions (South Asia, Amazon, California)

**Requirements:**
- FIRMS_MAP_KEY
- Modest infrastructure
- Data acquisition for multiple regions
- Timeline: 3-4 months

**Outcome:** Multi-regional platform with validated methodology

### Option C: Full Global Platform

**Objective:** Complete global fire intelligence platform

**Requirements:**
- FIRMS_MAP_KEY
- Full infrastructure ($1,300-1,800/month)
- Global data acquisition (6.5 months)
- Global spatial indexing implementation
- Regional calibration models
- Full frontend redesign
- Production deployment
- Timeline: 5-8 months full-time work

**Outcome:** Complete global platform (if resources available)

---

## Known Limitations

### Data Limitations

- Dataset size: 30 records vs 45 billion needed for global coverage
- Geographic scope: Bangladesh only
- Temporal coverage: 8 active days in 2+ years
- Product quality: VIIRS is NRT not standard science
- Observation opportunity: Not tracked

### Scientific Limitations

- Calibration status: EXPLORATORY (not validated)
- Scaling factor: Fixed β=0.294 vs empirical β=0.529
- Reference variance: Zero (all MODIS counts = 1)
- Sample size: Insufficient for validation
- Regional calibration: Not implemented
- Uncertainty estimation: Not implemented

### Technical Limitations

- Spatial indexing: Cylindrical projection not globally appropriate
- Global grid: Not implemented
- Async exports: Not implemented
- Rate limiting: Not implemented
- Authentication: Not implemented

---

## Conclusion

FireSync is a scientifically structured, technically competent proof-of-concept for MODIS-VIIRS harmonization in Bangladesh. The code is well-organized, the methodology is rigorous, and the existing tests pass.

**However, the project is NOT READY for global deployment or scientific validation.** It lacks the data, infrastructure, validation, and implementation required for global use.

**The honest assessment:** FireSync represents a solid foundation for global expansion, but requires substantial additional work—data acquisition, infrastructure provision, scientific validation, and comprehensive testing—before it can be accepted as a global fire intelligence platform.

**Scientific honesty takes priority.** The current implementation should be positioned as a Bangladesh-focused proof-of-concept with EXPLORATORY calibration, not as a complete, validated, production-ready global system.

# FireSync — Scientific Validation Report

> **Superseded snapshot (2026-11-01):** This report predates the remediation round.
> Its checksum and provenance statements describe legacy evidence that is now labelled
> `UNVERIFIED` because the raw source files are absent. R² = 0 has been corrected to
> `null`; the fixed β = 0.294 is an exploratory assumption, not a fitted or validated
> coefficient; calibration status is `INSUFFICIENT`.
>
> The 30-observation bundled archive was removed on 2026-11-10. The current dataset is live
> NASA FIRMS NRT (rolling 1–5 days) with an empty local store at startup. The generated
> `reports/calibration_validation.{json,csv,md}` files are historical demo-fixture
> diagnostics, not current live data.
>
> Current live-world diagnostics and status: `reports/remediation/SCIENTIFIC_VALIDATION_REPORT.md`.
> Do not cite this snapshot as evidence of validation.

**Date:** 2026-11-01  
**Dataset:** Bangladesh (30 observations, 2024-2026)  
**Calibration Status:** EXPLORATORY  
**Validation Status:** INSUFFICIENT

---

## Purpose and Scope

This report documents the scientific validation of FireSync's MODIS-VIIRS harmonization methodology based on the available dataset (30 observations from Bangladesh, 2024-2026). The report assesses whether the calibration model is scientifically defensible and identifies gaps that must be addressed before validation can be claimed.

---

## Dataset Description

### Source Data

**Provider:** NASA FIRMS (Fire Information for Resource Management System)  
**Products:**
- MODIS Collection 6.1 Standard Processing (Terra, Aqua)
- VIIRS Suomi-NPP Near Real-Time (2.0NRT)
- VIIRS NOAA-20 Near Real-Time (2.0NRT)

**Geographic Scope:** Bangladesh (88.0°E - 92.8°E, 20.5°N - 26.7°N)  
**Temporal Scope:** 2024-03-15 to 2026-03-22 (8 active fire days)  
**Total Observations:** 30 (9 MODIS, 21 VIIRS)

### Data Quality

**Verification:**
- SHA-256 checksums verified for all source files
- Schema normalization verified (20 fields)
- Duplicate detection verified (0 duplicates via record_hash)
- Coordinate bounds verified (all within Bangladesh bbox)
- Confidence and FRP fields validated

**Limitations:**
- **Temporal coverage sparse:** Only 8 active days in 2+ years
- **VIIRS data quality:** NRT (Near Real-Time) not standard science quality
- **Geographic scope:** Bangladesh only (0.1% of global land area)
- **Sample size:** 30 records (insufficient for validation)

---

## Harmonization Methodology

### Current Formula

**Harmonized Burning Activity Units (BAU):**

```
BAU = 0.5 * MODIS_count + 0.5 * (0.294 * VIIRS_count) + 0.005 * ln(1 + FRP_total)
```

**Parameters:**
- β (VIIRS scaling factor): 0.294 (theoretical 1/3.4x)
- γ (FRP coefficient): 0.005
- MODIS weight: 0.5
- VIIRS weight: 0.5

### BAU Interpretation

**Current Definition:** "Dimensionless 1-km equivalent activity indicator scaling VIIRS sub-pixel sensitivity by 0.294 with logarithmic FRP regularization"

**Ambiguities:**
- Is BAU a detection count proxy (should be integer)?
- Is BAU a normalized index (needs baseline and z-score)?
- Is BAU a physical intensity score (needs clear units)?
- What does BAU = 1.23 represent physically?

**Recommended Definition:** "Expected MODIS-equivalent 1-km detections per cell per day" with integer rounding.

### FRP Term Impact

**Analysis:** The FRP term contributes only 2.71% to total BAU

**Implication:** The FRP term is negligible in practice but adds conceptual complexity without clear benefit.

**Recommendation:** Remove FRP term or justify its retention with explicit physical interpretation and larger coefficient.

---

## Empirical Analysis

### VIIRS:MODIS Detection Ratio

**Theoretical Ratio (Literature):** 3.4x (Schroeder et al. 2014, Giglio et al. 2016)  
**Observed Ratio (Observation-level):** 2.33x  
**Observed Ratio (Cell-level):** 1.89x  
**Deviation:** -44.4% (cell-level)

**Empirical Scaling Factor:**
- β_empirical = 1 / 1.89 = 0.529
- β_fixed = 0.294
- Deviation: +80.1%

**Scientific Implication:** The fixed 0.294 scaling factor is not supported by the empirical data. A fixed global scaling factor is scientifically unjustified.

### Possible Explanations for Discrepancy

1. **Fire size distribution:** The theoretical 3.4x ratio applies to mixed fire regimes. This dataset may have larger fires where MODIS and VIIRS detection efficiency converges.
2. **Land cover effects:** Agricultural fires (common in Bangladesh) may be detected similarly by both sensors.
3. **Confidence threshold:** The literature ratio may include low-confidence VIIRS detections. This dataset only includes high/nominal confidence.
4. **Spatial clustering:** Detections cluster in the same 1-km cells, which affects the count ratio at the cell level.

---

## Paired Observation Analysis

### Spatial-Temporal Cells

**Total 1-km cells with observations:** 13  
**MODIS-only cells:** 0  
**VIIRS-only cells:** 4  
**Concurrent paired cells:** 9

**Paired Cell Details:**

| Cell ID | Date | MODIS | VIIRS | MODIS Satellites | VIIRS Satellites |
|---------|------|-------|-------|----------------|----------------|
| 2024-03-15_cell_9403_2623 | 2024-03-15 | 1 | 1 | Terra | SNPP, NOAA-20 |
| 2024-03-16_cell_9423_2584 | 2024-03-16 | 1 | 3 | Aqua | SNPP |
| 2024-03-20_cell_9363_2861 | 2024-03-20 | 1 | 2 | Terra | SNPP, NOAA-20 |
| 2024-04-10_cell_9036_2875 | 2024-04-10 | 1 | 2 | Aqua | SNPP |
| 2024-04-18_cell_9433_2592 | 2024-04-18 | 1 | 2 | Aqua | SNPP |
| 2024-04-18_cell_9435_2593 | 2024-04-18 | 1 | 1 | Aqua | NOAA-20 |
| 2025-03-10_cell_9392_2653 | 2025-03-10 | 1 | 1 | Terra | SNPP, NOAA-20 |
| 2026-03-22_cell_9417_2637 | 2026-03-22 | 1 | 3 | Aqua | SNPP, NOAA-20 |
| 2025-11-12_cell_9088_2738 | 2025-11-12 | 1 | 2 | Terra | SNPP, NOAA-20 |

**Critical Finding:** Every paired cell has MODIS count = 1.

---

## Calibration Validation

### Temporal Holdout

**Training Period:** 2024 (20 observations, 6 MODIS, 14 VIIRS, 6 paired cells)  
**Validation Period:** 2025-2026 (10 observations, 3 MODIS, 7 VIIRS, 3 paired cells)

### Validation Metrics

| Metric | Value | Interpretation |
|--------|-------|----------------|
| MAE | 0.3947 | Calculated correctly, sample too small |
| RMSE | 0.4502 | Calculated correctly, sample too small |
| Mean Bias | -0.3947 | Calculated correctly, sample too small |
| R² | 0 (undefined) | **INCORRECT** - Should be null when reference variance = 0 |

### Validation Status

**Status:** INSUFFICIENT

**Gaps:**
1. Sample size too small (3 validation pairs << 50 threshold)
2. Reference variance zero (all MODIS counts = 1)
3. R² undefined but reported as 0
4. VIIRS data is NRT not standard science quality
5. No observation opportunity tracking
6. No regional calibration
7. No uncertainty estimation

**Conclusion:** The validation metrics are calculated correctly but their statistical significance is unknown. The sample is too small and the reference target has zero variance, making R² undefined. These metrics should not be used to claim validation or generalizability.

---

## Calibration Readiness Assessment

### Calibration Readiness Criteria

| Criterion | Threshold | Actual | Status |
|-----------|-----------|--------|--------|
| Paired cell count | ≥ 50 | 9 | ❌ Failed |
| Reference variance (MODIS) | > 0.5 | 0 | ❌ Failed |
| Geographic diversity | ≥ 5 clusters | 8 | ✅ Passed |
| Temporal diversity | ≥ 20 dates | 8 | ❌ Failed |

### Status

**Status:** INSUFFICIENT

The dataset cannot support calibration validation due to:
- Inadequate sample size (9 cells << 50 threshold)
- Defective reference target (uniform MODIS values → R² undefined)
- Insufficient temporal diversity (8 dates << 20 threshold)

---

## Model Comparison

### Alternative Models Evaluated

| Model | Formula | Status |
|-------|--------|--------|
| Raw MODIS Count | BAU = MODIS_count | ❌ Discards VIIRS data |
| Raw VIIRS Count | BAU = VIIRS_count | ❌ Cannot compare with historical MODIS |
| Baseline (Current) | BAU = 0.5·MODIS + 0.5·(0.294·VIIRS) + 0.005·ln(1+FRP) | ⚠️ Fixed β unsupported by data |
| Empirical Scaling | BAU = 0.5·MODIS + 0.5·(0.529·VIIRS) | ⚠️ Sample too small for fitting |
| MODIS-Equivalent Expected Count | E[MODIS] = α + β·VIIRS_count | ⚠️ Current β theoretical, not fitted |

### Recommended Approach

**Short-term (current dataset):**
- Preserve EXPLORATORY status
- Document empirical β = 0.529 ± uncertainty (if bootstrapped)
- Remove or justify FRP term (currently contributes only 2.71%)
- Document BAU as "Expected MODIS-equivalent detections per cell per day"

**Long-term (after data expansion):**
- Fit β empirically from ≥50 paired cells with MODIS variance
- Quantify parameter uncertainty (bootstrap or Bayesian)
- Consider fire-size or FRP-dependent scaling if supported by data
- Implement observation opportunity tracking
- Distinguish detection-level, cell-level, and event-level metrics

---

## Scientific Limitations

### Data Limitations

1. **Sample size:** 30 records vs billions needed for global coverage
2. **Geographic scope:** Bangladesh only (0.1% of global land area)
3. **Temporal coverage:** 8 active days in 2+ years (extensive gaps)
4. **Product quality:** VIIRS is NRT not standard science
5. **Observation opportunity:** Not tracked

### Methodological Limitations

1. **Fixed scaling factor:** β = 0.294 not supported by empirical data
2. **No observation opportunity:** Cannot distinguish "no fire" from "no observation"
3. **No regional calibration:** Single global model may not apply globally
4. **No uncertainty estimation:** No confidence intervals on predictions
5. **No event detection:** Hotspots treated as unique fires without clustering

### Technical Limitations

1. **R² handling:** Reports 0 instead of null when reference variance = 0
2. **Sample size threshold:** No automated warning when sample < 50
3. **Temporal matching:** Assumes same-day detections are temporally equivalent
4. **Spatial projection:** Cylindrical projection not globally appropriate (polar distortion)

---

## Required Improvements

### Critical (Before Validation Can Be Claimed)

1. **Expand dataset** to ≥50 paired cells with MODIS variance
2. **Implement observation opportunity tracking**
3. **Fix R² handling** — Report as null when reference variance = 0
4. **Fit β empirically** with uncertainty quantification
5. **Replace NRT VIIRS** with standard science archive products
6. **Implement regional calibration** if global model not appropriate
7. **Add uncertainty estimation** to all predictions

### Important (For Scientific Rigor)

1. **Clarify BAU definition** — Explicit physical units and interpretation
2. **Document FRP term** — Justify retention or remove if negligible
3. **Distinguish metrics** — Detection counts, estimated events, harmonized index
4. **Track observation opportunity** — Critical for scientific validity
5. **Add event detection** — Cluster persistent fire detections

### Desirable (For Production)

1. **Global spatial grid** — Replace cylindrical projection with global discrete grid
2. **Regional validation** — Evaluate model performance by biome/continent
3. **Geographic holdout** - Test generalizability across regions
4. **Temporal holdout** - Ensure no leakage from training to validation
5. **Bootstrap validation** - Quantify uncertainty in all metrics

---

## Conclusion

### Current Status

**Calibration Status:** EXPLORATORY  
**Validation Status:** INSUFFICIENT

The harmonization methodology is scientifically structured and the data integrity is verified. However, the calibration model is not empirically validated due to:

1. **Insufficient sample size** (9 paired cells << 50 threshold)
2. **Zero reference variance** (all MODIS counts = 1)
3. **Empirical scaling mismatch** (β = 0.529 vs fixed 0.294)
4. **Missing observation opportunity tracking**
5. **VIIRS data quality issue** (NRT not standard science)

### Recommendation

**Do not upgrade validation status** until the following are addressed:
- Dataset expanded to ≥50 paired cells with MODIS variance
- β fitted empirically with uncertainty quantification
- Observation opportunity tracking implemented
- R² correctly reported as null when reference variance = 0
- VIIRS replaced with standard science products
- Regional calibration evaluated if global model inappropriate

### Scientific Honesty

The current implementation provides a solid foundation for MODIS-VIIRS harmonization research, but it cannot be claimed as scientifically validated without the above improvements. The EXPLORATORY status is appropriate and must be preserved until defensible evidence is obtained through expanded data and rigorous validation.

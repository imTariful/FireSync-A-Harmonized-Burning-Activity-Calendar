# Fire Activity Metrics

This document describes the metrics computed by FireSync, their formulas, and their interpretation.

---

## Core Metrics

### Raw Detection Count

**Definition:** Total number of MODIS or VIIRS hotspot observations.

**Formula:**
```
raw_count = Σ observations
```

**Units:** Integer count

**Limitations:**
- MODIS and VIIRS cannot be directly summed (different resolutions, sensitivities)
- Does not account for sub-pixel sensitivity
- Not comparable across sensors

---

### Harmonized Burning Activity Units (BAU)

**Definition:** Expected MODIS-equivalent 1-km detections per cell per day.

**Current Formula:**
```
BAU = 0.5 * MODIS_count + 0.5 * (0.294 * VIIRS_count) + 0.005 * ln(1 + FRP_total)
```

**Parameters:**
- β (VIIRS scaling factor): 0.294 (theoretical 1/3.4x)
- γ (FRP coefficient): 0.005
- MODIS weight: 0.5
- VIIRS weight: 0.5

**Units:** Dimensionless (interpreted as MODIS-equivalent detections)

**Interpretation:**
- BAU = 1.0 → Expected 1 MODIS detection in a 1-km cell on that day
- BAU = 2.5 → Expected 2.5 MODIS-equivalent detections
- BAU < 1.0 → Less than one expected detection (sub-detection-level activity)

**Rationale:**
- MODIS and VIIRS have different resolutions (1000m vs 375m)
- VIIRS detects more small fires; β accounts for sub-pixel sensitivity
- FRP term adds intensity regularization

**Current Issues:**
- **Fixed β is an assumption, not a fitted value** — the legacy 0.529 "empirical" estimate rests on a removed demo fixture and is not a validated calibration.
- **FRP term is small** — the fixed 0.005 coefficient was not re-estimated for the live world dataset.
- **No observation opportunity tracking** — missing records cannot be interpreted as zero fire.
- **BAU remains a dimensionless exploratory index**, not a physical fire count or burned area.

**Status:** `EXPLORATORY` layer; calibration evidence is `INSUFFICIENT`. Requires a verified,
sufficient dataset and independent validation before any stronger claim.

---

### Fire Radiative Power (FRP)

**Definition:** Total Fire Radiative Power in megawatts (MW) for observations in a cell or region.

**Formula:**
```
FRP_total = Σ FRP_mw per observation
```

**Units:** Megawatts (MW)

**Interpretation:**
- Higher FRP → More intense fire
- FRP correlates with fire size and fuel consumption
- Can be used to estimate biomass burning emissions

**MODIS FRP:** Computed from brightness temperature in mid-infrared channel  
**VIIRS FRP:** Computed from brightness temperature in I4 and I5 channels

**Limitations:**
- FRP varies with sensor calibration
- Affected by cloud occlusion
- Saturation at very high intensities

---

## Aggregated Metrics

### Daily Activity

**Definition:** Sum of BAU for all cells on a given day.

**Formula:**
```
daily_activity = Σ BAU per cell for date
```

**Units:** Harmonized Activity Units

**Use Case:** Time series analysis, trend detection

---

### Monthly Activity

**Definition:** Sum of daily activity for a calendar month.

**Formula:**
```
monthly_activity = Σ daily_activity for month
```

**Units:** Harmonized Activity Units

**Use Case:** Seasonal patterns, monthly comparisons

---

### Seasonal Baseline

**Definition:** Median daily activity for a specific month across historical years.

**Formula:**
```
seasonal_baseline(month) = median(daily_activity for month across years)
```

**Units:** Harmonized Activity Units

**Use Case:** Anomaly detection, historical comparison

---

## Statistical Metrics

### Median Absolute Deviation (MAD)

**Definition:** Robust measure of dispersion based on median.

**Formula:**
```
MAD = median(|x_i - median(x)|)
```

**Units:** Same as input metric

**Interpretation:**
- MAD = 0 → All values equal to median
- Higher MAD → Greater variability
- Robust to outliers (unlike standard deviation)

**Use Case:** Anomaly detection, baseline variability assessment

---

### Robust Z-Score

**Definition:** Standardized deviation using median and MAD.

**Formula:**
```
z_score = 0.6745 * (x - median) / MAD
```

**Constant:** 0.6745 ≈ 1 / (Φ⁻¹(0.75) - Φ⁻¹(0.25)), converts MAD to standard deviation scale

**Interpretation:**
- |z| < 2 → Normal variation
- 2 ≤ |z| < 3 → Moderate anomaly
- |z| ≥ 3 → Extreme anomaly

**Edge Case Handling:**
- If MAD = 0, z_score = 0 (no variation, cannot detect anomalies)

**Status:** ✅ PASS — Tested and correct

---

## Calibration Metrics

### Mean Absolute Error (MAE)

**Definition:** Average absolute difference between predicted and actual values.

**Formula:**
```
MAE = (1/n) * Σ |predicted_i - actual_i|
```

**Units:** Same as target variable

**Interpretation:**
- MAE = 0 → Perfect prediction
- Higher MAE → Larger prediction errors
- Robust to outliers

**Status:** ✅ PASS — Calculated correctly (but sample too small for validation)

---

### Root Mean Square Error (RMSE)

**Definition:** Square root of average squared difference between predicted and actual values.

**Formula:**
```
RMSE = sqrt((1/n) * Σ (predicted_i - actual_i)²)
```

**Units:** Same as target variable

**Interpretation:**
- RMSE = 0 → Perfect prediction
- Higher RMSE → Larger prediction errors
- Penalizes large errors more than MAE

**Status:** ✅ PASS — Calculated correctly (but sample too small for validation)

---

### Mean Bias

**Definition:** Average signed difference between predicted and actual values.

**Formula:**
```
bias = (1/n) * Σ (predicted_i - actual_i)
```

**Units:** Same as target variable

**Interpretation:**
- bias = 0 → Unbiased
- bias > 0 → Systematic over-prediction
- bias < 0 → Systematic under-prediction

**Status:** ✅ PASS — Calculated correctly (but sample too small for validation)

---

### R² (Coefficient of Determination)

**Definition:** Proportion of variance in the target variable explained by the model.

**Formula:**
```
R² = 1 - (SS_res / SS_tot)
SS_res = Σ (actual_i - predicted_i)²
SS_tot = Σ (actual_i - mean(actual))²
```

**Units:** Dimensionless (0 to 1)

**Interpretation:**
- R² = 1 → Perfect fit
- R² = 0 → No better than predicting the mean
- R² < 0 → Worse than predicting the mean

**Undefined case:**
- If SS_tot = 0 (all actual values equal), R² is mathematically undefined.
- **Current behavior:** Returns `null`, never `0`.
- The API, UI, CSV exports and validation reports all preserve `null`.

**Status:** ✅ PASS — zero-variance, empty and one-observation cases are tested
(`src/utils/harmonization.test.ts`). A numeric R² is shown only when it is defined.

---

## Data Quality Metrics

### Coverage Completeness

**Definition:** Percentage of expected observations that are present.

**Formula:**
```
coverage_pct = (actual_records / expected_records) * 100
```

**Units:** Percentage (0-100%)

**Interpretation:**
- 100% → All expected observations present
- < 100% → Data gaps or missing satellite overpasses

**Limitation:** Cannot compute without observation opportunity tracking

---

### Confidence Distribution

**Definition:** Distribution of detection confidence values.

**Metrics:**
- Mean confidence
- Median confidence
- High confidence percentage (> 80 for MODIS, "high" category for VIIRS)

**Use Case:** Data quality assessment, filtering

---

## Derived Metrics

### Detection Density

**Definition:** Number of detections per unit area.

**Formula:**
```
density = detections / area_km²
```

**Units:** Detections per km²

**Use Case:** Normalizing activity by area size

---

### Detection Frequency

**Definition:** Number of days with detections in a time period.

**Formula:**
```
frequency = count(dates with detections > 0) / total_days
```

**Units:** Fraction (0-1) or percentage

**Use Case:** Assessing fire seasonality

---

## Future Improvements

### Short-Term

1. **Clarify BAU definition** — Explicit physical units and interpretation
2. **Remove or justify FRP term** — Currently contributes only 2.71%
3. ~~**Fix R² handling** — Report as null when reference variance = 0~~ (done: returns `null`)
4. **Add confidence intervals** — Uncertainty quantification for all metrics

### Long-Term

1. **Fit β empirically** — Replace fixed 0.294 with data-driven value
2. **Implement observation opportunity tracking** — Critical for completeness metrics
3. **Add event-level metrics** — Cluster hotspots into unique fire events
4. **Add biomass burning estimates** — Convert FRP to emissions using algorithms

---

## References

- **Giglio, L., et al. (2016).** Characterization of the MODIS Fire Spatial and Temporal Variability. Remote Sensing of Environment.
- **Schroeder, W., et al. (2014).** VIIRS Active Fire Product: Algorithm Updates and Calibration. Remote Sensing of Environment.
- **NASA FIRMS.** Fire Information for Resource Management System Documentation.

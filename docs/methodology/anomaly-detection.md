# Anomaly Detection

This document describes FireSync's anomaly detection methodology, including seasonal baselines, anomaly scoring, and interpretation.

---

## Anomaly Detection Approach

FireSync uses a non-parametric, robust statistical approach to detect anomalies in fire activity. This method does not assume a normal distribution and is resistant to outliers.

---

## Seasonal Baseline

### Baseline Computation

**Method:** Monthly median of historical daily activity

**Formula:**
```
baseline(month) = median(daily_activity for month across historical years)
```

**Example:**
- Baseline for March = median of all March daily activities from 2020-2024
- Baseline for October = median of all October daily activities from 2020-2024

**Rationale:**
- Fire activity is seasonal (dry vs wet seasons)
- Median is robust to outliers (extreme fire years)
- Monthly granularity captures seasonal patterns without being too fine-grained

### Baseline Limitations

**Minimum Historical Years:** At least 3 years required for meaningful baseline  
**Current Dataset:** live NRT, rolling last 1–5 days; the final world run had one observed day  
**Status:** ⚠️ INSUFFICIENT — Baseline not statistically meaningful

---

## Median Absolute Deviation (MAD)

### MAD Computation

**Formula:**
```
MAD = median(|x_i - median(x)|)
```

**Where:**
- x_i = Daily activity for month across historical years
- median(x) = Monthly baseline
- |·| = Absolute value

**Interpretation:**
- MAD = 0 → All historical values equal to baseline (no variation)
- Higher MAD → Greater historical variability
- MAD is robust to outliers (unlike standard deviation)

**Status:** ✅ PASS — Computed correctly

---

## Robust Z-Score

### Z-Score Computation

**Formula:**
```
z_score = 0.6745 * (current_activity - baseline) / MAD
```

**Constant:** 0.6745 ≈ 1 / (Φ⁻¹(0.75) - Φ⁻¹(0.25))

**Interpretation:**
- z_score measures how many "standard deviations" the current activity is from the baseline
- Uses MAD instead of standard deviation for robustness

**Standard Deviation Scale:**
- For a normal distribution, MAD ≈ 0.6745 × σ
- The constant 0.6745 converts MAD to σ scale
- Enables familiar interpretation (e.g., |z| > 2 = outlier)

**Status:** ✅ PASS — Computed correctly

---

## Anomaly Categorization

### Thresholds

FireSync categorizes anomalies based on absolute z-score:

| Z-Score | Category | Interpretation |
|---------|----------|----------------|
| |z| < 2 | Normal | Within expected variation |
| 2 ≤ |z| < 3 | Moderate Anomaly | Unusual but not extreme |
| |z| ≥ 3 | Extreme Anomaly | Highly unusual event |

**Rationale:**
- |z| ≥ 2 corresponds to top ~5% of normal distribution
- |z| ≥ 3 corresponds to top ~0.1% of normal distribution
- Thresholds are conventional, not calibrated to fire regimes

**Status:** ✅ PASS — Implemented correctly

---

## Edge Case Handling

### Zero MAD

**Issue:** If all historical values are equal, MAD = 0, causing division by zero.

**Current Behavior:**
- `computeModifiedZScore` uses median/MAD.
- If MAD = 0, it falls back to `1.2533 × mean absolute deviation`.
- If the history has no variability at all, it returns `null`; the category becomes
  `insufficient_data`, not `normal`.

**Status:** ✅ PASS — zero-MAD fallback and no-variability cases are tested.

### Insufficient Historical Data

**Issue:** Baseline requires at least 3 other years of data.

**Current Behavior:**
- Fewer than 3 other years → `anomaly_category: 'insufficient_data'`
- No anomaly score is claimed for that month

**Status:** ✅ PASS — conservative handling is implemented and tested.

### Missing Observation Opportunity

**Issue:** Cannot distinguish "no fire" from "no observation."

**Current Behavior:**
- The calendar and anomaly pipeline emit/score only dates with observations.
- A missing date is absent from the result; it is **not** treated as zero fire.
- Per-day observation opportunity (cloud cover, overpass availability) is still unknown,
  so a day with no detection but a valid overpass cannot be distinguished from a day
  with no usable observation.

**Status:** ⚠️ PARTIAL — missing dates are no longer zero-filled, but observation
opportunity tracking is not implemented.

**Required Fix:**
- Implement observation opportunity tracking
- Only compute anomalies for days with usable satellite overpasses
- Flag days with no observation opportunity

---

## Anomaly Interpretation

### What Anomalies Mean

**Positive Anomaly (z > 0):**
- Higher fire activity than historical baseline
- Could indicate:
  - Extreme fire season
  - Large wildfire events
  - Agricultural burning peaks
  - Data quality issues (false positives)

**Negative Anomaly (z < 0):**
- Lower fire activity than historical baseline
- Could indicate:
  - Wet season with reduced burning
  - Effective fire suppression
  - Cloud occlusion (if not tracked)
  - Data quality issues (false negatives)

### What Anomalies Do NOT Mean

Anomalies are **not forecasts**. They are:
- **Historical deviations** from past patterns
- **Retrospective assessments** of unusual events
- **Not predictive** of future fire activity

**Correct Statement:** "March 2024 had extreme fire activity compared to historical March averages."

**Incorrect Statement:** "March 2024 predicts an extreme fire season." (Not supported)

---

## Temporal Leakage

### Issue

**Temporal leakage** occurs when future data influences past calculations, inflating validation performance.

**Example:**
- Computing baseline using 2020-2024 data
- Testing anomalies on 2024 data
- If 2024 is included in baseline, leakage occurs

### Current Implementation

**Calibration holdout (not anomaly validation):**
- Training: 6 paired cells (2024 dates)
- Validation: 3 paired cells (2025-2026 dates)
- The split is temporally separated, but it is far below the required 30 training / 10
  validation cells and the validation MODIS reference has zero variance.

**Status:** `INSUFFICIENT` — the holdout exists as a criteria check, but it does not validate
the calibration or the anomaly method. Anomaly baselines are computed from prior years, not
from a holdout split.

### Geographic Leakage

**Issue:** Geographic leakage occurs when data from one region influences predictions in another.

**Current Implementation:**
- No regional calibration implemented
- Single global model for all regions

**Status:** ⚠️ PARTIAL — Not applicable for single-region dataset, but global model may cause leakage when expanded

---

## Visualization

### Time Series Plot

**Display:**
- X-axis: Date
- Y-axis: Daily activity
- Horizontal line: Seasonal baseline
- Shaded region: ±2 × MAD (normal range)
- Points above 2×MAD: Moderate anomalies (orange)
- Points above 3×MAD: Extreme anomalies (red)

**Status:** ✅ Implemented in frontend

### Calendar Heatmap

**Display:**
- Calendar grid (year view)
- Cell color: Activity level
- Border color: Anomaly category (none/normal/moderate/extreme)

**Status:** ✅ Implemented in frontend

---

## Limitations

### Statistical Limitations

1. **Insufficient historical data** — live NRT covers only the rolling last 1–5 days; the final run had one observed day
2. **Non-stationary fire regimes** — Fire patterns change over time (climate, land use)
3. **Regional variability** — Global thresholds may not apply locally
4. **Small sample size** — Z-score thresholds not calibrated to fire regimes

### Methodological Limitations

1. **No observation opportunity tracking** — Cannot distinguish missing data from no fire
2. **No geographic holdout** — Cannot test generalizability across regions
3. **Non-parametric but assumes seasonality** — May not work for non-seasonal regions
4. **No uncertainty quantification** — No confidence intervals on anomaly scores

### Data Limitations

1. **Only Bangladesh data** — Anomalies not representative of global fire regimes
2. **VIIRS NRT quality** — Near Real-Time data not suitable for retrospective analysis
3. **Sparse temporal coverage** — Too few active days for meaningful baselines

---

## Future Improvements

### Short-Term

1. **Implement observation opportunity tracking** — Critical for scientific validity
2. **Add baseline warning** — Alert user when historical data insufficient
3. **Add regional baselines** — Separate baselines per biome/region
4. **Add confidence intervals** — Quantify uncertainty in anomaly scores

### Long-Term

1. **Global anomaly detection** — Per-region baselines with different thresholds
2. **Spatial anomaly detection** — Identify unusual spatial patterns
3. **Spatio-temporal clustering** — Detect unusual fire event sequences
4. **Machine learning anomalies** — More sophisticated models (e.g., Isolation Forest, LSTM)
5. **Contextual anomalies** — Anomaly detection conditioned on weather, fuel, land use

---

## References

- **Leys, C., et al. (2013).** Detecting outliers: Do not use standard deviation around the mean, use absolute deviation around the median. Journal of Experimental Social Psychology.
- **Iglewicz, B., & Hoaglin, D. C. (1993).** How to Detect and Handle Outliers. ASQC Quality Press.
- **NASA FIRMS.** Fire Information for Resource Management System Anomaly Detection Guidelines.

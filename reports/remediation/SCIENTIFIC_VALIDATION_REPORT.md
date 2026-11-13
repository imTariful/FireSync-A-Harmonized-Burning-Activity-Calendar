# Scientific Validation Report

**Date:** 2026-11-10
**Dataset:** live NASA FIRMS NRT world aggregate, 2026-11-09
**Calibration status:** `INSUFFICIENT`
**Validated:** **NO**
**Live provenance:** `VERIFIED`
**Historical archive:** not ingested
**Evaluator:** `src/utils/harmonization.ts` and the live API endpoints

> This report separates three different things that are often conflated:
> (1) the automated test suite, (2) an in-sample diagnostic of a fixed formula, and
> (3) independent scientific validation. Only (3) can support a `VALIDATED` claim, and it
> has not been achieved.

---

## 1. What was evaluated

| Item | Actual value |
|---|---:|
| MODIS detections | 7,073 |
| VIIRS detections | 96,058 |
| Total raw detections | 103,131 |
| Distinct observation dates | 1 (2026-11-09) |
| Spatial-temporal 1 km cells | 58,265 |
| Concurrent MODIS+VIIRS cells | 2,034 |
| Data source | live NASA FIRMS NRT |
| Live provenance | `VERIFIED` |
| Local store at evaluation time | empty |
| Historical standard-science data | not ingested |

The live response came from the official NASA FIRMS Area API and was served through the
shared `LiveFiresService` cache. It is **near-real-time** data, not a standard-science
historical record. A single day cannot support seasonal, multi-year or temporal-holdout
claims.

The removed 30-observation demo fixture is not part of this evaluation. Files under
`reports/evidence/` are retained as historical evidence of an earlier exploratory check;
they are not loaded as current observations.

---

## 2. Formula under test

The application uses a **fixed, exploratory** blended index:

```
BAU = 0.5 × MODIS_count
    + 0.5 × (0.294 × VIIRS_count)
    + 0.005 × ln(1 + FRP_total_MW)
```

| Element | Definition |
|---|---|
| `MODIS_count` | Number of MODIS detections in a 1 km cell on a date |
| `VIIRS_count` | Number of VIIRS detections in the same 1 km cell on the same date |
| `0.294` | Fixed `1 / 3.4` assumption from the literature; **not fitted** |
| `0.005` | Fixed FRP adjustment; **not fitted** |
| `0.5 / 0.5` | Fixed equal sensor weights; **not fitted or optimised** |
| Output | Dimensionless exploratory index, not a fire count or burned area |
| FRP term contribution | Not re-estimated for the live world dataset |

The formula is not a fitted regression, not a GLM, and not a validated calibration. The
fixed coefficient is retained only because it is a documented exploratory assumption. It
must never be described as an empirically established global or Bangladesh coefficient.

Raw MODIS and VIIRS detection counts are never summed. The index keeps the sensor counts
separate and applies an explicit scale before combining them.

---

## 3. Fixed-coefficient in-sample diagnostic

`evaluateCalibrationModel` scores the fixed formula on the same 2,034 paired cells used to
describe it. It never returns `VALIDATED`.

| Metric | Actual result |
|---|---:|
| Paired cells | 2,034 |
| MAE | 0.5544 |
| RMSE | 0.7078 |
| Mean bias | −0.2091 |
| R² | 0 (defined; the model explains none of the observed variance) |
| Status | `INSUFFICIENT` |
| Independent validation | No |
| n training / n validation | 2,034 / 0 |

An in-sample score is not validation. The sample size is large enough to compute the
metrics, but the evaluation has no independent holdout and no ground truth. R² `0` is a
real numeric result, not a placeholder; it means the fixed model has no explanatory power
on this sample.

### 3.1 Removed demo fixture

The old 30-observation demo fixture produced 9 paired cells with zero MODIS reference
variance and R² `null`. That fixture was removed from the runtime on 2026-11-10. The old
evidence files are historical and are not current live data. The legacy
"Constrained Poisson-Weighted GLM" label in one evidence file is unsupported by any code in
this repository; no GLM was fitted.

---

## 4. Temporal holdout check

`evaluateTemporalHoldout` sorts paired cells by date, trains on the earliest 70% and
validates on the latest 30%. It returns `VALIDATED` only when **all** of the following hold:

| Criterion | Required | Actual |
|---|---|---|
| Training paired cells | ≥ 30 | 1,423 |
| Validation paired cells | ≥ 10 | 611 |
| Temporal separation | Every validation date later than every training date | **Not satisfied** (all observations are 2026-11-09) |
| Validation MODIS variance | Non-zero (R² defined) | Defined |
| Metrics finite | Slope, intercept, R², MAE, RMSE, bias | Finite |

| Metric | Actual result |
|---|---:|
| Training cells | 1,423 |
| Validation cells | 611 |
| Fitted slope | reported by the endpoint |
| Fitted intercept | reported by the endpoint |
| MAE | 0.1019 |
| RMSE | 0.2418 |
| Mean bias | −0.0032 |
| R² | 0.0127 |
| Status | `INSUFFICIENT` |
| Independent validation | **No** |

The split sizes meet the numeric minimums, but the data is from one day. The holdout
function requires every validation date to be later than every training date, so it returns
`INSUFFICIENT` and `independent_validation: false`. The low error metrics do not override
the failed temporal-separation criterion.

The separate `MIN_SAMPLE_FOR_VALIDATION = 50` constant is the minimum even to *consider*
validation in `evaluateCalibrationModel`. The holdout function uses the stricter explicit
split requirements (30 training + 10 validation). Both are necessary, not sufficient.

---

## 5. Candidate methods considered

| Method | Status | Reason |
|---|---|---|
| Ordinary least squares (temporal holdout) | Implemented as a diagnostic | 1,423 training / 611 validation cells, but no temporal separation |
| Robust regression | Not implemented | No evidence that outliers are the limiting problem; no independent sample |
| Poisson GLM | Not implemented | Count data exist, but there is no exposure/opportunity offset and no independent sample |
| Negative binomial GLM | Not implemented | Overdispersion cannot be estimated from co-detections alone |
| Fixed exploratory scaling | Used in the app | Transparent assumption; explicitly not fitted |

A Poisson or negative-binomial model would require a defensible response variable,
predictors, link function, exposure/offset and diagnostics. None of those can be
established from co-detection cells with no non-detection opportunities. Calling the
existing formula a GLM would be false.

The paired cells are **co-detections only**. They do not include cells where one sensor
detected a fire and the other did not, and they do not include observation opportunities
with zero detections. This is a fundamental sampling bias: it is impossible to estimate
sensor sensitivity or calibration from co-detections alone.

---

## 6. Calibration status system

| Status | Meaning in this project | Current model |
|---|---|---|
| `EXPLORATORY` | Describes the harmonization layer, not a calibration result | Harmonization layer only |
| `INSUFFICIENT` | Sample size, variance, opportunity data or holdout evidence is inadequate; no scientific claim is possible | **Current status** |
| `CALIBRATED` | A model was fitted on a documented dataset with reported coefficients and uncertainty, but has not passed independent validation | Not emitted by current code; no fitted model exists |
| `VALIDATED` | Every explicit holdout criterion is met, including ≥30 training and ≥10 validation cells, temporal separation, non-zero reference variance and finite metrics | **Never returned for this dataset** |

`evaluateCalibrationModel` always returns `INSUFFICIENT` because it is in-sample only.
`evaluateTemporalHoldout` is the only function that can return `VALIDATED`, and it cannot
do so here. `CALIBRATED` is defined in the type system but no function currently produces
it; that is intentional until a real fit with uncertainty exists.

---

## 7. R² and edge-case handling

| Case | Required behaviour | Verified |
|---|---|---|
| Empty dataset | R² `null`, status `INSUFFICIENT` | Yes |
| One observation | R² `null` | Yes |
| Constant reference values (zero variance) | R² `null`, never `0` | Yes |
| Non-finite values (NaN / Infinity) | Rejected or `null`; never silently zero | Yes |
| Missing FRP | Excluded from FRP-dependent calculations; no invented value | Yes |
| Negative FRP | Rejected by ingestion validation | Yes |
| Valid non-constant reference | Numeric R² | Yes |

Tests: `src/utils/harmonization.test.ts` (7/7 pass), including the zero-variance case and
the in-sample status assertion. `src/data/validationEvidence.test.ts` asserts that the
legacy `r_squared: 0` is displayed as `null` and the status as `INSUFFICIENT`.

---

## 8. What would be required to upgrade the status

1. **Real historical data.** Download official NASA FIRMS/Earthdata standard-science files
   with raw preservation, source manifests and SHA-256 checksums. The dataset must be
   `VERIFIED` before any scientific claim.
2. **Observation opportunities.** Establish which satellite overpasses actually observed
   each cell, including cloud/quality masks, so non-detections can be distinguished from
   missing observations.
3. **Paired and unpaired cells.** Include cells where only one sensor detected a fire, not
   only co-detections.
4. **Sample size.** At least 30 training and 10 independent validation paired cells, and
   ≥50 paired cells even to consider validation; preferably multiple seasons and years.
5. **Temporal separation.** Validation dates must be strictly later than every training
   date. A single-day live batch cannot satisfy this.
6. **Fitted model with uncertainty.** Report slope/intercept with confidence intervals,
   residual diagnostics, MAE, RMSE, bias and R² where defined.
7. **Independent spatial holdout.** Validation locations must be disjoint from training.
8. **Documented model selection.** Compare the simple baseline against robust/Poisson/
   negative-binomial alternatives and justify the chosen model.
9. **External reference.** MODIS is a reference sensor, not ground truth. Validation
   against independent burned-area or ground data would be needed for stronger claims.

Until all of these are satisfied, the only honest status is `INSUFFICIENT`.

---

## 9. Conclusion

- The automated tests pass, but **tests do not establish scientific validity**.
- The fixed 0.294 factor is an exploratory assumption, not a fitted calibration.
- The live world in-sample diagnostic has 2,034 paired cells and R² `0`; this is not
  validation.
- The temporal holdout has 1,423 training / 611 validation cells but fails temporal
  separation because all observations are from one day; `independent_validation: false`.
- The legacy "Poisson-Weighted GLM" label is unsupported and is not used.
- The old bundled archive was removed; there is no runtime demo fixture.
- **Scientific status: `INSUFFICIENT`. No validated harmonization model exists.**

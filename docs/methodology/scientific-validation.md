# Scientific Validation

This document describes FireSync's calibration semantics, validation criteria and the actual
current status. It replaces earlier text that described the fixed formula as fitted or
"validated".

**Current dataset:** live NASA FIRMS NRT world aggregate, 2026-11-09. The historical
standard-science archive has not been ingested. The old 30-observation demo fixture was
removed on 2026-11-10.

---

## Core principles

1. **In-sample is not validation.** A fixed coefficient evaluated on the same paired cells
   used to describe it is `INSUFFICIENT`. `EXPLORATORY` describes only the harmonization
   layer, never a calibration result.
2. **R² is `null` when undefined**, never `0` as a stand-in. Undefined means too few pairs
   or zero variance in the reference (MODIS) values.
3. **Only `evaluateTemporalHoldout` can return `VALIDATED`**, and only when every criterion
   is met.
4. **A MODIS reference is not ground truth.** Agreement between VIIRS and MODIS counts is
   not validation against observed fire perimeters or burned area.
5. **Missing observations are not zero fire.** Calendar and coverage outputs omit missing
   dates rather than filling them with zero.

---

## Current status (live world NRT)

| Item | Value |
|---|---|
| Data source | live NASA FIRMS NRT |
| Live provenance | `VERIFIED` (official-source response) |
| Dates | 1 (2026-11-09) |
| MODIS detections | 7,073 |
| VIIRS detections | 96,058 |
| Total raw detections | 103,131 |
| Spatial-temporal 1 km cells | 58,265 |
| Paired MODIS+VIIRS cells | 2,034 |
| Fixed coefficient | 0.294 VIIRS count scale, intercept 0.05 |
| In-sample diagnostic | `INSUFFICIENT` |
| R² (in-sample) | `0` (defined; the model explains none of the observed variance) |
| Temporal holdout | `INSUFFICIENT` (1,423 training / 611 validation cells) |
| Holdout R² | `0.0127` |
| Independent validation | `false` (all observations are from one day; temporal separation fails) |
| Historical archive | local Parquet store (MODIS 2000–2025, VIIRS SNPP 2012–2025; data not committed, built via `data_pipeline/`) |

The holdout split sizes meet the numeric minimums, but a single day cannot provide strict
temporal separation. The low holdout error metrics do **not** override that failed
criterion. Status remains `INSUFFICIENT`.

---

## Calibration status definitions

| Status | Meaning |
|---|---|
| `INSUFFICIENT` | The explicit validation criteria are not met, including in-sample-only evidence, insufficient sample, undefined R² or failed temporal separation |
| `EXPLORATORY` | Describes the harmonization layer as a whole; **not** a calibration result |
| `CALIBRATED` | A model was fitted and its uncertainty is reported, but independent validation is incomplete |
| `VALIDATED` | All explicit holdout, sample-size and uncertainty criteria were met |

`evaluateCalibrationModel` is in-sample only and therefore always returns `INSUFFICIENT`.
It never returns `EXPLORATORY` or `VALIDATED`. `evaluateTemporalHoldout` is the only
function that can return `VALIDATED`.

---

## Criteria for `VALIDATED`

`evaluateTemporalHoldout` requires all of the following:

1. At least **30 paired cells** in the training split.
2. At least **10 paired cells** in the independent validation split.
3. Strict temporal separation: every validation date is later than every training date.
4. Non-zero variance in the validation MODIS reference, so R² is defined.
5. Finite fitted slope, intercept, R², MAE, RMSE and mean bias.

If any criterion fails, the status is `INSUFFICIENT` and `independent_validation` is
`false`.

The broader `MIN_SAMPLE_FOR_VALIDATION = 50` constant remains the threshold for even
considering a calibration claim.

---

## What would count as stronger evidence

- Real, provenance-verified historical FIRMS files with manifests and checksums.
- Enough paired 1 km cells across multiple seasons and regions.
- A pre-registered train/validation split with temporal and geographic separation.
- Uncertainty estimates (for example bootstrap confidence intervals).
- Comparison against independent burned-area or ground observations, not only MODIS counts.
- Clear separation of detection counts, thermal anomaly density and burned area.

None of these is available for the current live single-day batch.

---

## Reproduce the diagnostic

The offline evidence scripts require an explicit real observation input path. Without one
they exit with code `2` and an explanation; they never fall back to bundled data.

```bash
npx tsx scripts/evaluate_holdout_validation.ts --store ./data/store/observations.json
```

Use the actual path to a verified observation store or exported JSON. The script:

- scores the fixed formula in-sample (no fitting), and
- runs the temporal holdout criteria check.

It explicitly labels both results and does not describe them as independent validation.
The live API endpoints `/api/v1/analytics/calibration` and
`/api/v1/analytics/calibration/holdout` expose the same semantics for the live window.

---

## Geographic holdout, bootstrap and cross-validation

These are **not implemented**. They should only be added and claimed once enough verified
data exists. The API exposes only the temporal holdout endpoint.

---

## Bottom line

- The harmonization formula is an exploratory assumption.
- The live world in-sample diagnostic has 2,034 paired cells and R² `0`; it is not
  validation.
- The temporal holdout has 1,423 training / 611 validation cells but fails temporal
  separation because all observations are from one day.
- No model is labelled `VALIDATED`.
- **Scientific status: `INSUFFICIENT`.** Historical standard-science ingestion remains
  required before a stronger claim can be considered.

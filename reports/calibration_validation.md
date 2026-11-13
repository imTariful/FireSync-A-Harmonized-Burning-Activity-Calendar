# FireSync — Calibration Diagnostic Report

> **Historical demo-fixture diagnostic (not current live data).** This report was generated
> on 2026-11-09 against the 30-observation bundled fixture that was removed on 2026-11-10.
> The runtime store now starts empty and live NASA FIRMS NRT is the only observation
> source. Do not cite these numbers as current or as validation. Current live-world
> diagnostics are in `reports/remediation/SCIENTIFIC_VALIDATION_REPORT.md`.

**Generated:** 2026-11-09T17:23:16.078Z
**Status:** `INSUFFICIENT`
**Validated:** NO
**Archive provenance:** UNVERIFIED (raw NASA source files and manifests are absent; the archive was removed)

> This report is a diagnostic. It does not establish that the harmonization model is
> scientifically validated, and it is not a comparison with ground truth.

## 1. What was evaluated

- Bundled observations: 30 (MODIS 9, VIIRS 21)
- Paired 1-km cells: 9
- Fixed formula: `BAU = 0.5 * MODIS + 0.5 * (0.294 * VIIRS) + 0.005 * ln(1 + FRP)`
- The coefficients above are **fixed exploratory assumptions**, not fitted values.

## 2. Fixed-coefficient diagnostic (in-sample)

| Metric | Value |
|---|---|
| Paired cells | 9 |
| MAE | 0.3947 |
| RMSE | 0.4502 |
| Mean bias | -0.3947 |
| R² | null (undefined) |
| Status | `INSUFFICIENT` |

## 3. Temporal holdout check

| Metric | Value |
|---|---|
| Training period | 2024-03-15 to 2024-04-18 |
| Validation period | 2025-03-10 to 2026-03-22 |
| Paired cells | 9 |
| Fitted slope | 0 |
| Fitted intercept | 1 |
| MAE | 0 |
| RMSE | 0 |
| Mean bias | 0 |
| R² | null (undefined) |
| Status | `INSUFFICIENT` |

Criteria:
- Training cells: 6 (need 30); validation cells: 3 (need 10).
- Independent temporal holdout has not met the evidence requirements, so the model is not VALIDATED.
- In-sample agreement must never be reported as independent validation.

## 4. Interpretation

- `VALIDATED` is only possible when every criterion in `evaluateTemporalHoldout` is met.
- `R² = null` means undefined (too few cells or zero reference variance), **not** zero.
- The fixed 0.294 VIIRS factor is an exploratory assumption. It has not been fitted here.
- Paired cells are co-detections only; they do not represent non-detection opportunities.

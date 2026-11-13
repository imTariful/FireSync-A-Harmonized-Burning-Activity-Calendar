/**
 * Calibration diagnostic runner for FireSync.
 *
 * IMPORTANT: this script does NOT establish scientific validation.
 *
 * It does two separate, honestly-labelled things:
 *   1. Scores the FIXED exploratory formula against paired 1-km cells (in-sample
 *      diagnostic; no fitting).
 *   2. Runs a temporal holdout split, which can only return VALIDATED when every
 *      explicit criterion in evaluateTemporalHoldout is met (>=30 training cells,
 *      >=10 independent validation cells, temporal separation, finite metrics and
 *      non-zero reference variance).
 *
 * There is NO bundled fallback. The script requires an explicit real observation store; with
 * fewer than the documented evidence threshold the outcome is INSUFFICIENT with R² = null.
 *
 * Usage: npx tsx scripts/evaluate_holdout_validation.ts <store-or-observations.json>
 *
 * Outputs: reports/calibration_validation.json, .csv and .md.
 */

import * as fs from 'fs';
import * as path from 'path';
import { loadObservationsOrExit } from './lib/load_observations';
import {
  aggregateToSpatialTemporalGrid,
  evaluateCalibrationModel,
  evaluateTemporalHoldout,
  HARMONIZATION_CONSTANTS,
} from '../src/utils/harmonization';
import { validationResultsToCsv } from '../src/utils/csv_export';
import type { CanonicalObservation } from '../src/types/fire';

function pairedCells(observations: CanonicalObservation[]) {
  return Array.from(aggregateToSpatialTemporalGrid(observations, 1.0).values())
    .filter((cell) => cell.modis_count > 0 && cell.viirs_count > 0)
    .map((cell) => ({ modis: cell.modis_count, viirs: cell.viirs_count, date: cell.date }));
}

function runCalibrationDiagnostics() {
  console.log('[FireSync Calibration] Running fixed-coefficient diagnostic and temporal holdout check.');
  console.log('[FireSync Calibration] This is not ground-truth validation.');

  const input = loadObservationsOrExit('evaluate_holdout_validation');
  console.log(
    `[FireSync Calibration] Input: ${input.path} (${input.observations.length} observations, provenance ${input.provenance_status})`
  );

  const allPairs = pairedCells(input.observations);
  const trainObs = input.observations.filter((o) => o.acq_date < '2025-01-01');
  const validObs = input.observations.filter((o) => o.acq_date >= '2025-01-01');

  // Fixed exploratory coefficients. These are assumptions, not fitted parameters.
  const slope = HARMONIZATION_CONSTANTS.VIIRS_COUNT_SCALE_FACTOR;
  const intercept = 0.05;

  const fixedDiagnostic = evaluateCalibrationModel(allPairs, slope, intercept);
  const holdout = evaluateTemporalHoldout(allPairs);

  const reportsDir = path.resolve(process.cwd(), 'reports');
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });

  const jsonReport = {
    evaluation_metadata: {
      generated_at: new Date().toISOString(),
      evaluator: 'FireSync calibration diagnostic (not an independent validation authority)',
      evaluation_type: 'fixed-coefficient in-sample diagnostic + temporal holdout criteria check',
      input_path: input.path,
      provenance_status: input.provenance_status,
      provenance_warning:
        input.provenance_status === 'VERIFIED'
          ? 'Every input record was imported by a completed FIRMS ingestion job with raw files and SHA-256 checksums.'
          : 'The input contains records whose raw NASA source files and manifests are not verified.',
      fixed_formula: {
        slope,
        intercept,
        note: 'Fixed exploratory assumption; no coefficient was fitted by this script.',
      },
    },
    input: {
      total_observations: input.observations.length,
      modis_observations: input.observations.filter((o) => o.sensor === 'MODIS').length,
      viirs_observations: input.observations.filter((o) => o.sensor === 'VIIRS').length,
      paired_1km_cells: allPairs.length,
      training_partition_observations: trainObs.length,
      validation_partition_observations: validObs.length,
      provenance_status: input.provenance_status,
      verified_records: input.verified_count,
      unverified_records: input.unverified_count,
    },
    fixed_coefficient_diagnostic: {
      ...fixedDiagnostic,
      interpretation:
        'This scores one fixed formula on the same cells used to describe it. It cannot validate the model and never returns VALIDATED.',
    },
    temporal_holdout: {
      ...holdout,
      interpretation:
        'VALIDATED requires all explicit criteria. Otherwise the result is INSUFFICIENT or EXPLORATORY and must not be reported as validation.',
    },
    scientific_status: holdout.status,
    validated: holdout.status === 'VALIDATED',
    r_squared_definition:
      holdout.r_squared === null
        ? 'null: R² is undefined here (too few cells or zero reference variance). It is not zero.'
        : 'defined',
  };

  fs.writeFileSync(
    path.join(reportsDir, 'calibration_validation.json'),
    JSON.stringify(jsonReport, null, 2),
    'utf-8'
  );

  fs.writeFileSync(
    path.join(reportsDir, 'calibration_validation.csv'),
    validationResultsToCsv(holdout),
    'utf-8'
  );

  const md = `# FireSync — Calibration Diagnostic Report

**Generated:** ${new Date().toISOString()}
**Status:** \`${holdout.status}\`
**Validated:** ${holdout.status === 'VALIDATED' ? 'yes' : 'NO'}
**Input provenance:** ${input.provenance_status} (${input.verified_count} verified / ${input.unverified_count} unverified records)

> This report is a diagnostic. It does not establish that the harmonization model is
> scientifically validated, and it is not a comparison with ground truth.

## 1. What was evaluated

- Input observations: ${input.observations.length} (MODIS ${jsonReport.input.modis_observations}, VIIRS ${jsonReport.input.viirs_observations})
- Input path: \`${input.path}\`
- Paired 1-km cells: ${allPairs.length}
- Fixed formula: \`BAU = 0.5 * MODIS + 0.5 * (${slope} * VIIRS) + 0.005 * ln(1 + FRP)\`
- The coefficients above are **fixed exploratory assumptions**, not fitted values.

## 2. Fixed-coefficient diagnostic (in-sample)

| Metric | Value |
|---|---|
| Paired cells | ${fixedDiagnostic.sample_size_paired_cells} |
| MAE | ${fixedDiagnostic.mae ?? 'null (undefined)'} |
| RMSE | ${fixedDiagnostic.rmse ?? 'null (undefined)'} |
| Mean bias | ${fixedDiagnostic.mean_bias ?? 'null (undefined)'} |
| R² | ${fixedDiagnostic.r_squared ?? 'null (undefined)'} |
| Status | \`${fixedDiagnostic.status}\` |

## 3. Temporal holdout check

| Metric | Value |
|---|---|
| Training period | ${holdout.training_period} |
| Validation period | ${holdout.validation_period} |
| Paired cells | ${holdout.sample_size_paired_cells} |
| Fitted slope | ${holdout.calibration_slope ?? 'null'} |
| Fitted intercept | ${holdout.calibration_intercept ?? 'null'} |
| MAE | ${holdout.mae ?? 'null (undefined)'} |
| RMSE | ${holdout.rmse ?? 'null (undefined)'} |
| Mean bias | ${holdout.mean_bias ?? 'null (undefined)'} |
| R² | ${holdout.r_squared ?? 'null (undefined)'} |
| Status | \`${holdout.status}\` |

Criteria:
${holdout.limitations.map((line) => `- ${line}`).join('\n')}

## 4. Interpretation

- \`VALIDATED\` is only possible when every criterion in \`evaluateTemporalHoldout\` is met.
- \`R² = null\` means undefined (too few cells or zero reference variance), **not** zero.
- The fixed 0.294 VIIRS factor is an exploratory assumption. It has not been fitted here.
- Paired cells are co-detections only; they do not represent non-detection opportunities.
`;

  fs.writeFileSync(path.join(reportsDir, 'calibration_validation.md'), md, 'utf-8');

  console.log(`[FireSync Calibration] Fixed diagnostic status: ${fixedDiagnostic.status}`);
  console.log(`[FireSync Calibration] Temporal holdout status: ${holdout.status}`);
  console.log('[FireSync Calibration] Reports written to reports/calibration_validation.{json,csv,md}');
}

runCalibrationDiagnostics();

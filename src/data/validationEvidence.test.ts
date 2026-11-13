import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HARMONIZATION_CONSTANTS } from '../utils/harmonization';
import { STALE_NOTE, VALIDATION_EVIDENCE, buildValidationEvidence, evidenceSentence } from './validationEvidence';

// Run with: npx tsx --test src/data/validationEvidence.test.ts
// The view imports reports/evidence/*.json directly; this test re-reads the files from disk with fs and compares,
// so a future change of the import (e.g. to copied numbers) that drifts from the files fails here.

const read = (f: string) => JSON.parse(readFileSync(new URL(`../../reports/evidence/${f}`, import.meta.url), 'utf8'));
const validation = read('calibration_validation.json');
const reassessment = read('calibration_reassessment.json');
const paired = read('paired_observations_analysis.json');

test('numbers equal the evidence files on disk', () => {
  const v = VALIDATION_EVIDENCE;
  const m = validation.validation_metrics;
  assert.equal(v.evaluatedCells, m.sample_size_evaluated_cells);
  // The view normalises the file's old conventions: a zero-variance R² of 0 becomes null
  // (undefined, never a fake zero) and the status becomes uppercase.
  assert.deepEqual(v.metrics, {
    mae: m.mae,
    rmse: m.rmse,
    meanBias: m.mean_bias,
    r2: paired.calibration_readiness.reference_variance === 0 ? null : m.r_squared,
    // Zero reference variance forces INSUFFICIENT regardless of the file's old label.
    status: paired.calibration_readiness.reference_variance === 0 ? 'INSUFFICIENT' : String(m.status).toUpperCase(),
  });
  assert.equal(v.metrics.r2, null, 'R² must be null when the MODIS reference does not vary');
  assert.equal(v.metrics.status, 'INSUFFICIENT');
  assert.equal(v.partitions[0].observations, validation.evaluation_metadata.training_partition.total_observations);
  assert.equal(v.partitions[0].pairedCells, validation.evaluation_metadata.training_partition.paired_1km_cells);
  assert.equal(v.partitions[1].observations, validation.evaluation_metadata.validation_partition.total_observations);
  assert.equal(v.partitions[1].modis, validation.evaluation_metadata.validation_partition.modis_observations);
  assert.equal(v.partitions[1].viirs, validation.evaluation_metadata.validation_partition.viirs_observations);
  assert.equal(v.partitions[1].pairedCells, validation.evaluation_metadata.validation_partition.paired_1km_cells);
  assert.equal(v.scaleFactorTested, validation.calibration_parameters.scaling_factor_slope);
  assert.equal(v.referenceVariance, paired.calibration_readiness.reference_variance);
  assert.equal(v.reassessment.datasetSize, reassessment.metadata.dataset_size);
  assert.equal(v.reassessment.pairedCells, reassessment.metadata.paired_cells);
  assert.equal(v.reassessment.empiricalScalingFactor, reassessment.empirical_analysis.empirical_scaling_factor);
  assert.equal(v.reassessment.observedRatioPairedAnalysis, paired.sensor_comparison.viirs_to_modis_ratio);
  assert.deepEqual(v.limitations.map((l) => l.text), validation.limitations);
  assert.deepEqual(v.sources.map((s) => s.generatedAt), [validation.evaluation_metadata.generated_at, reassessment.metadata.generated_at, paired.metadata.generated_at]);
});

test('the tested scale equals the constant the app uses', () => {
  assert.equal(VALIDATION_EVIDENCE.scaleFactorTested, HARMONIZATION_CONSTANTS.VIIRS_COUNT_SCALE_FACTOR);
  assert.equal(VALIDATION_EVIDENCE.minSampleForValidated, HARMONIZATION_CONSTANTS.MIN_SAMPLE_FOR_VALIDATION);
});

test('the sentence is derived from the numbers and does not claim validation', () => {
  const s = VALIDATION_EVIDENCE.sentence;
  assert.match(s, /Evaluated on 3 paired cells of the demo archive/);
  assert.match(s, /r² is undefined/);
  assert.match(s, /null rather than 0/);
  assert.match(s, /the scale factor is not validated/);
  assert.equal(VALIDATION_EVIDENCE.scaleFactorValidated, false);
  assert.doesNotMatch(s, /\bis validated\b/);
});

test('sentence branches: singular, non-zero variance, and a validated status only with enough cells', () => {
  assert.match(evidenceSentence({ evaluatedCells: 1, r2: 0.5, status: 'exploratory', minSample: 50, referenceVariance: 2 }), /1 paired cell of/);
  assert.doesNotMatch(evidenceSentence({ evaluatedCells: 1, r2: 0.5, status: 'exploratory', minSample: 50, referenceVariance: 2 }), /do not vary/);
  // 'validated' printed in the file is not enough with too few cells
  assert.match(evidenceSentence({ evaluatedCells: 3, r2: 0.9, status: 'validated', minSample: 50, referenceVariance: 1 }), /not validated/);
  assert.match(evidenceSentence({ evaluatedCells: 60, r2: 0.9, status: 'validated', minSample: 50, referenceVariance: 1 }), /did not re-check/);
});

test('the stale Terra/Aqua/SNPP overpass text is flagged and followed by the note', () => {
  const stale = VALIDATION_EVIDENCE.limitations.filter((l) => l.stale);
  assert.equal(stale.length, 1);
  assert.match(stale[0].text, /Terra 10:30 vs Aqua\/SNPP 13:30/);
  assert.equal(VALIDATION_EVIDENCE.limitations.filter((l) => !l.stale).length, validation.limitations.length - 1);
  assert.match(STALE_NOTE, /Observed overpass time/);
  assert.match(STALE_NOTE, /Do not read it as current fact/);
});

test('rebuilding gives the same view (pure)', () => {
  assert.deepEqual(buildValidationEvidence(), VALIDATION_EVIDENCE);
});

test('the method notes state that nothing was fitted, per scripts/evaluate_holdout_validation.ts', () => {
  const script = readFileSync(new URL('../../scripts/evaluate_holdout_validation.ts', import.meta.url), 'utf8');
  // the claim in the note must stay true: the script passes fixed slope/intercept to evaluateCalibrationModel and fits nothing
  assert.match(script, /const slope = HARMONIZATION_CONSTANTS\.VIIRS_COUNT_SCALE_FACTOR/);
  assert.match(script, /const intercept = 0\.05/);
  assert.match(VALIDATION_EVIDENCE.methodNotes[0], /fits nothing/);
});

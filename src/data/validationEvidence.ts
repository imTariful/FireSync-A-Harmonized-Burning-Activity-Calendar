/**
 * Validation evidence view-model (pure). ONE source of truth: the three JSON files in reports/evidence/ are
 * imported directly (tsconfig/vite accept JSON imports without config changes), so no number is copied here and
 * nothing can drift. Values below are derived from those files at import time.
 *
 * These files were NOT re-run or modified by this module; they are shown as written. Their generation scripts
 * are scripts/evaluate_holdout_validation.ts, scripts/reassess_calibration.ts and
 * scripts/analyze_paired_observations.ts.
 */

import validation from '../../reports/evidence/calibration_validation.json';
import reassessment from '../../reports/evidence/calibration_reassessment.json';
import paired from '../../reports/evidence/paired_observations_analysis.json';
import { HARMONIZATION_CONSTANTS } from '../utils/harmonization';

export interface PartitionView {
  label: string;
  dateRange: string;
  observations: number;
  modis: number;
  viirs: number;
  pairedCells: number;
}

export interface LimitationView {
  text: string;
  /** True when the text states satellite overpass times that differ from the times observed in this app. */
  stale: boolean;
}

export interface ValidationEvidenceView {
  sources: { file: string; generatedAt: string }[];
  partitions: PartitionView[];
  /** The validation split is the one the metrics below were computed on. */
  evaluatedCells: number;
  metrics: { mae: number; rmse: number; meanBias: number; r2: number | null; status: string };
  scaleFactorTested: number;
  interceptTested: number;
  minSampleForValidated: number;
  /** True only when the file says 'validated' AND n reaches the minimum sample. */
  scaleFactorValidated: boolean;
  /** Zero variance of the MODIS reference counts in paired cells (from paired_observations_analysis.json). */
  referenceVariance: number;
  readinessStatus: string;
  readinessGaps: string[];
  reassessment: {
    datasetSize: number;
    pairedCells: number;
    observedRatioReassessment: number;
    observedRatioPairedAnalysis: number;
    empiricalScalingFactor: number;
    fixedScalingFactor: number;
    ratioDeviationPercent: number;
    frpTermPercent: number;
    empiricalModelLimitations: string[];
  };
  limitations: LimitationView[];
  staleNote: string;
  /** One plain sentence derived from the numbers. */
  sentence: string;
  /** What the evaluation did, from reading the script. */
  methodNotes: string[];
}

/** Text in the evidence file that names Terra / Aqua / SNPP overpass times (stale: observed times differ). */
const STALE_OVERPASS_RE = /Terra 10:30|Aqua\/SNPP 13:30|overpass times \(Terra/i;

export const STALE_NOTE =
  'Stale text kept as written in the evidence file. The overpass times it names are not what this app observes: measured overpass times differ (see "Observed overpass time" in this panel). Do not read it as current fact.';

function num(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new TypeError(`validation evidence: ${what} is not a finite number`);
  return v;
}

function fixed(v: number, digits: number): string {
  return v.toFixed(digits).replace(/\.?0+$/, '') || '0';
}

/** The plain sentence, from numbers only. Exported so tests can exercise the branches. */
export function evidenceSentence(p: { evaluatedCells: number; r2: number | null; status: string; minSample: number; referenceVariance: number }): string {
  const status = p.status.toUpperCase();
  const validated = status === 'VALIDATED' && p.evaluatedCells >= p.minSample;
  const r2Text =
    p.referenceVariance === 0 || p.r2 === null
      ? 'r² is undefined (the MODIS counts in these cells do not vary), so it is reported as null rather than 0'
      : `r² = ${fixed(p.r2, 4)}`;
  return (
    `Evaluated on ${p.evaluatedCells} paired cell${p.evaluatedCells === 1 ? '' : 's'} of the demo archive; ` +
    'that 30-record fixture was removed from the runtime and is not current data; ' +
    `${r2Text}; ` +
    (validated
      ? `the evidence file reports status "${p.status}" with at least ${p.minSample} cells; this app did not re-check it.`
      : `the scale factor is not validated (status "${p.status}"; ${p.minSample} paired cells are the minimum the code asks for).`)
  );
}

export function buildValidationEvidence(): ValidationEvidenceView {
  const meta = validation.evaluation_metadata;
  const m = validation.validation_metrics;
  const train = meta.training_partition;
  const valid = meta.validation_partition;
  const empirical = reassessment.model_comparison.find((x) => x.model_name.startsWith('Empirical Scaling'));

  const evaluatedCells = num(m.sample_size_evaluated_cells, 'sample_size_evaluated_cells');
  const minSample = HARMONIZATION_CONSTANTS.MIN_SAMPLE_FOR_VALIDATION;
  const referenceVariance = num(paired.calibration_readiness.reference_variance, 'reference_variance');
  // The evidence file stores 0 for an undefined R². Reinterpret it honestly as null.
  const r2 = referenceVariance === 0 ? null : num(m.r_squared, 'r_squared');
  const status = referenceVariance === 0 ? 'INSUFFICIENT' : String(m.status).toUpperCase();

  return {
    sources: [
      { file: 'reports/evidence/calibration_validation.json', generatedAt: meta.generated_at },
      { file: 'reports/evidence/calibration_reassessment.json', generatedAt: reassessment.metadata.generated_at },
      { file: 'reports/evidence/paired_observations_analysis.json', generatedAt: paired.metadata.generated_at },
    ],
    partitions: [
      {
        label: 'Training split',
        dateRange: train.date_range,
        observations: train.total_observations,
        modis: train.modis_observations,
        viirs: train.viirs_observations,
        pairedCells: train.paired_1km_cells,
      },
      {
        label: 'Validation split',
        dateRange: valid.date_range,
        observations: valid.total_observations,
        modis: valid.modis_observations,
        viirs: valid.viirs_observations,
        pairedCells: valid.paired_1km_cells,
      },
    ],
    evaluatedCells,
    metrics: { mae: num(m.mae, 'mae'), rmse: num(m.rmse, 'rmse'), meanBias: num(m.mean_bias, 'mean_bias'), r2, status },
    scaleFactorTested: num(validation.calibration_parameters.scaling_factor_slope, 'scaling_factor_slope'),
    interceptTested: num(validation.calibration_parameters.baseline_intercept, 'baseline_intercept'),
    minSampleForValidated: minSample,
    scaleFactorValidated: status === 'VALIDATED' && evaluatedCells >= minSample,
    referenceVariance,
    readinessStatus: paired.calibration_readiness.readiness_status,
    readinessGaps: [...paired.calibration_readiness.gaps_identified],
    reassessment: {
      datasetSize: num(reassessment.metadata.dataset_size, 'dataset_size'),
      pairedCells: num(reassessment.metadata.paired_cells, 'paired_cells'),
      observedRatioReassessment: num(reassessment.empirical_analysis.observed_viirs_modis_ratio, 'observed_viirs_modis_ratio'),
      observedRatioPairedAnalysis: num(paired.sensor_comparison.viirs_to_modis_ratio, 'viirs_to_modis_ratio'),
      empiricalScalingFactor: num(reassessment.empirical_analysis.empirical_scaling_factor, 'empirical_scaling_factor'),
      fixedScalingFactor: num(reassessment.empirical_analysis.fixed_scaling_factor, 'fixed_scaling_factor'),
      ratioDeviationPercent: num(reassessment.empirical_analysis.ratio_deviation_percent, 'ratio_deviation_percent'),
      frpTermPercent: num(reassessment.sensitivity_analysis.frp_weight_percentage, 'frp_weight_percentage'),
      empiricalModelLimitations: empirical ? [...empirical.limitations] : [],
    },
    limitations: validation.limitations.map((text) => ({ text, stale: STALE_OVERPASS_RE.test(text) })),
    staleNote: STALE_NOTE,
    sentence: evidenceSentence({ evaluatedCells, r2, status, minSample, referenceVariance }),
    methodNotes: [
      `The "training" split is only counted. scripts/evaluate_holdout_validation.ts fits nothing: it scores the fixed formula ${fixed(validation.calibration_parameters.baseline_intercept, 3)} + ${fixed(validation.calibration_parameters.scaling_factor_slope, 3)} × VIIRS count against the MODIS count in each paired 1 km cell of the validation split.`,
      'That test is about VIIRS-count-to-MODIS-count agreement per paired cell. It is not a test of the harmonized activity index and not a comparison with ground truth.',
      'The files describe a removed 30-observation demo fixture, not the live runtime. They are retained only as a historical record of an exploratory check and are never loaded as observations.',
    ],
  };
}

/** Built once at import time. */
export const VALIDATION_EVIDENCE: ValidationEvidenceView = buildValidationEvidence();

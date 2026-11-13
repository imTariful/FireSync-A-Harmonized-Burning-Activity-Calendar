import React, { useId } from 'react';
import { AlertTriangle } from 'lucide-react';
import { fmt } from '../../utils/harmonizeView';
import { VALIDATION_EVIDENCE, type ValidationEvidenceView } from '../../data/validationEvidence';

/**
 * Validation evidence, shown as the evidence files state it (EXPLORATORY). Numbers come from
 * reports/evidence/*.json through src/data/validationEvidence.ts (single source of truth). The evidence is tiny
 * (3 validation cells) and does not validate the VIIRS scale; this section says so and adds nothing the files do not support.
 */
export interface ValidationEvidenceSectionProps {
  /** Injectable for tests; defaults to the evidence imported from reports/evidence. */
  evidence?: ValidationEvidenceView;
}

const Stat: React.FC<{ label: string; value: React.ReactNode; hint?: string }> = ({ label, value, hint }) => (
  <div className="bg-raised border border-line rounded-control p-2.5 min-w-0">
    <div className="text-fg-subtle text-2xs uppercase tracking-wider font-semibold">{label}</div>
    <div className="numeric text-fg text-lg font-semibold mt-0.5 break-words">{value}</div>
    {hint ? <div className="text-fg-subtle text-2xs mt-0.5">{hint}</div> : null}
  </div>
);

export const ValidationEvidenceSection: React.FC<ValidationEvidenceSectionProps> = ({ evidence = VALIDATION_EVIDENCE }) => {
  const headingId = useId();
  const e = evidence;
  const r = e.reassessment;
  return (
    <section aria-labelledby={headingId} className="space-y-3" data-state="validation-evidence">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={headingId} className="text-sm font-semibold text-fg">
          {`Validation evidence (${e.metrics.status})`}
        </h3>
        <span className="inline-flex items-center min-h-6 px-2 rounded-full border border-accent text-accent font-mono text-2xs font-semibold uppercase tracking-wider">
          {e.metrics.status}
        </span>
      </div>

      <p role="note" className="bg-raised border-2 border-accent rounded-control p-2.5 text-sm font-medium text-fg" data-state="evidence-sentence">
        {e.sentence}
      </p>

      <div className="grid grid-cols-2 min-[420px]:grid-cols-4 gap-2" data-state="evidence-metrics">
        <Stat label="MAE" value={fmt(e.metrics.mae, 3)} hint="MODIS count units" />
        <Stat label="RMSE" value={fmt(e.metrics.rmse, 4)} hint="MODIS count units" />
        <Stat label="Bias" value={fmt(e.metrics.meanBias, 3)} hint="predicted − MODIS" />
        <Stat label="r²" value={fmt(e.metrics.r2, 2)} hint={e.referenceVariance === 0 ? 'MODIS counts do not vary' : undefined} />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Stat label="Cells evaluated" value={e.evaluatedCells} hint={`code asks for ≥ ${e.minSampleForValidated}`} />
        <Stat label="Status in file" value={e.metrics.status} hint={e.scaleFactorValidated ? undefined : 'not validated'} />
      </div>

      <div className="overflow-x-auto rounded-control border border-line" role="region" aria-label="Evidence sample sizes" tabIndex={0}>
        <table className="w-full text-2xs numeric">
          <thead>
            <tr className="text-fg-subtle text-left">
              <th scope="col" className="p-2 font-semibold">
                Split
              </th>
              <th scope="col" className="p-2 font-semibold text-right">
                Obs
              </th>
              <th scope="col" className="p-2 font-semibold text-right">
                MODIS
              </th>
              <th scope="col" className="p-2 font-semibold text-right">
                VIIRS
              </th>
              <th scope="col" className="p-2 font-semibold text-right">
                Paired 1 km cells
              </th>
            </tr>
          </thead>
          <tbody>
            {e.partitions.map((p) => (
              <tr key={p.label} className="border-t border-line text-fg">
                <th scope="row" className="p-2 text-left font-medium">
                  {p.label}
                  <span className="block font-normal text-fg-subtle">{p.dateRange}</span>
                </th>
                <td className="p-2 text-right">{p.observations}</td>
                <td className="p-2 text-right">{p.modis}</td>
                <td className="p-2 text-right">{p.viirs}</td>
                <td className="p-2 text-right">{p.pairedCells}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="list-disc pl-4 space-y-1 text-xs text-fg-muted" data-state="evidence-method-notes">
        {e.methodNotes.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>

      <details className="text-xs text-fg-muted">
        <summary className="min-h-touch flex items-center cursor-pointer font-semibold text-fg">What the reassessment and paired-cell files say</summary>
        <div className="space-y-2 mt-1">
          <p>
            Same {r.datasetSize}-observation dataset, {r.pairedCells} paired cells. Readiness: <span className="font-semibold">{e.readinessStatus}</span>.
          </p>
          <ul className="list-disc pl-4 space-y-1">
            {e.readinessGaps.map((g) => (
              <li key={g}>{g}</li>
            ))}
          </ul>
          <p className="numeric">
            Observed VIIRS:MODIS ratio {fmt(r.observedRatioReassessment, 2)} (reassessment file) and {fmt(r.observedRatioPairedAnalysis, 2)} (paired-cell file); literature 3.4. The files do not
            say how the two ratios differ, so neither is used here. Their “empirical” scale {fmt(r.empiricalScalingFactor, 3)} vs the fixed {fmt(r.fixedScalingFactor, 3)} ({fmt(r.ratioDeviationPercent, 1)}%)
            rests on {r.pairedCells} cells.
          </p>
          <p>The reassessment file’s own limitations for that fitted value:</p>
          <ul className="list-disc pl-4 space-y-1">
            {r.empiricalModelLimitations.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
          <p className="numeric">The reassessment reports the FRP term at {fmt(r.frpTermPercent, 2)}% of the index.</p>
        </div>
      </details>

      <div className="space-y-1" data-state="evidence-limitations">
        <h4 className="text-xs font-semibold text-fg">Limitations as written in the evidence file</h4>
        <ul className="space-y-1.5 text-xs text-fg-muted">
          {e.limitations.map((l) => (
            <li key={l.text} className={l.stale ? 'flex gap-2 items-start bg-raised border border-accent rounded-control p-2' : 'list-disc ml-4'} data-stale={l.stale ? 'true' : undefined}>
              {l.stale ? <AlertTriangle aria-hidden="true" className="h-4 w-4 shrink-0 text-accent mt-0.5" /> : null}
              <span className="min-w-0">
                {l.text}
                {l.stale ? <span className="block mt-1 font-semibold text-fg">{e.staleNote}</span> : null}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <p className="text-2xs text-fg-subtle" data-state="evidence-sources">
        Shown as written in {e.sources.map((s) => `${s.file} (generated ${s.generatedAt.slice(0, 10)})`).join('; ')}. This app did not re-run or modify the scripts or files.
      </p>
    </section>
  );
};

export default ValidationEvidenceSection;

import { SensorDot } from '../SensorDot';
import React, { useDeferredValue, useId, useMemo, useState } from 'react';
import { AlertTriangle, ChevronDown, RotateCcw } from 'lucide-react';
import type { CanonicalObservation } from '../../types/fire';
import {
  CONTROL_LIMITS,
  DEFAULT_SATELLITE_SELECTION,
  EXPLORATORY_LABEL,
  LEGEND_SENTENCE,
  MATCHING_DEFAULTS,
  MODIS_SELECTION_OPTIONS,
  VIIRS_SELECTION_OPTIONS,
  buildScatterGeometry,
  buildWhyDiffer,
  cellDayAgreement,
  computeHarmonizeViewComplete,
  fmt,
  fmtPct,
  fmtSigned,
  isDefaultSatelliteSelection,
  observedOverpassTimes,
  OVERPASS_APPROX_NOTE,
  OVERPASS_MIN_N,
  partialReasonText,
  runSensitivity,
  windowFeasibility,
  satelliteSelectionToOptions,
  type CellDayAgreement,
  type ComparisonLevel,
  type DateCompleteness,
  type FrpView,
  type HarmonizeView,
  type OverpassObserved,
  type ModisSelection,
  type SatelliteSelection,
  type SensitivityReport,
  type ViirsSelection,
  type TimeOffsetSummary,
} from '../../utils/harmonizeView';
import { HarmonizedActivitySection } from './HarmonizedActivitySection';
import { ValidationEvidenceSection } from './ValidationEvidenceSection';

/**
 * MODIS <-> VIIRS harmonization panel (EXPLORATORY).
 *
 * Takes the detections already loaded for the current view (no fetching here). MODIS and VIIRS arrive as two
 * separate lists and are never summed; the only comparison is detection matching from utils/matching.ts.
 * Not wired into any page yet: render it from a page with `splitBySensor(observations)` from harmonizeView.ts.
 */
export interface HarmonizationPanelProps {
  modis: readonly CanonicalObservation[];
  viirs: readonly CanonicalObservation[];
  /** True while the viewport's detections are loading; stale results are hidden, not shown as current. */
  loading?: boolean;
  /** Clock for "today (UTC)"; injectable for tests. Defaults to the current time when the view is computed. */
  now?: Date | number;
  className?: string;
}

// ---------------------------------------------------------------------------
// Small building blocks
// ---------------------------------------------------------------------------

const Badge: React.FC = () => (
  <span className="inline-flex items-center min-h-6 px-2 rounded-full border border-accent text-accent font-mono text-2xs font-semibold uppercase tracking-wider">
    {EXPLORATORY_LABEL}
  </span>
);

const Stat: React.FC<{ label: string; value: React.ReactNode; hint?: string }> = ({ label, value, hint }) => (
  <div className="bg-raised border border-line rounded-control p-2.5 min-w-0">
    <div className="text-fg-subtle text-2xs uppercase tracking-wider font-semibold">{label}</div>
    <div className="numeric text-fg text-lg font-semibold mt-0.5 break-words">{value}</div>
    {hint ? <div className="text-fg-subtle text-2xs mt-0.5">{hint}</div> : null}
  </div>
);

const Warning: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div role="note" className="flex gap-2 items-start bg-raised border border-accent rounded-control p-2.5 text-xs text-fg">
    <AlertTriangle aria-hidden="true" className="h-4 w-4 shrink-0 text-accent mt-0.5" />
    <span className="min-w-0">{children}</span>
  </div>
);

interface CollapsibleProps {
  title: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}

const Collapsible: React.FC<CollapsibleProps> = ({ title, open, onToggle, children }) => {
  const id = useId();
  return (
    <section className="border border-line rounded-card bg-surface">
      <h3>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={onToggle}
          className="w-full min-h-touch flex items-center justify-between gap-2 px-3 text-left text-sm font-semibold text-fg cursor-pointer rounded-card"
        >
          <span>{title}</span>
          <ChevronDown
            aria-hidden="true"
            className={`h-4 w-4 shrink-0 text-fg-muted motion-safe:transition-transform ${open ? 'rotate-180' : ''}`}
          />
        </button>
      </h3>
      {open ? (
        <div id={id} className="px-3 pb-3 space-y-3">
          {children}
        </div>
      ) : null}
    </section>
  );
};

interface SliderProps {
  label: string;
  value: number;
  unit: string;
  min: number;
  max: number;
  step: number;
  defaultValue: number;
  onChange: (v: number) => void;
}

const Slider: React.FC<SliderProps> = ({ label, value, unit, min, max, step, defaultValue, onChange }) => {
  const id = useId();
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-sm font-medium text-fg">
          {label}
        </label>
        <span className="numeric text-sm text-fg">
          {value} {unit}
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full h-touch accent-accent cursor-pointer"
      />
      <div className="flex justify-between text-2xs text-fg-subtle numeric">
        <span>
          {min} {unit}
        </span>
        <span>
          default {defaultValue} {unit}
        </span>
        <span>
          {max} {unit}
        </span>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Dependency-free SVG scatter
// ---------------------------------------------------------------------------

const FrpScatter: React.FC<{ frp: FrpView }> = ({ frp }) => {
  const reg = frp.regression;
  const g = useMemo(() => buildScatterGeometry(frp.points, reg ? { slope: reg.slope, intercept: reg.intercept } : null), [frp.points, reg]);
  const summary =
    `Scatter of VIIRS FRP against MODIS FRP in megawatts, n=${frp.n}.` +
    (reg ? ` Regression slope ${fmt(reg.slope, 2)}, intercept ${fmt(reg.intercept, 2)} MW.` : ' No regression line (too few points).') +
    ' Dashed line is perfect agreement (VIIRS = MODIS).';

  return (
    <figure className="m-0">
      <svg
        viewBox={`0 0 ${g.width} ${g.height}`}
        role="img"
        aria-label={summary}
        className="w-full h-auto max-w-full bg-raised border border-line rounded-control"
      >
        <title>{summary}</title>
        {g.yTicks.map((t) => (
          <g key={`y${t.value}`}>
            <line x1={g.plot.left} x2={g.plot.right} y1={t.pos} y2={t.pos} stroke="var(--line)" strokeWidth={1} />
            <text x={g.plot.left - 6} y={t.pos + 3} textAnchor="end" fill="var(--fg-subtle)" fontSize={10} fontFamily="var(--font-mono)">
              {t.value}
            </text>
          </g>
        ))}
        {g.xTicks.map((t) => (
          <g key={`x${t.value}`}>
            <line x1={t.pos} x2={t.pos} y1={g.plot.top} y2={g.plot.bottom} stroke="var(--line)" strokeWidth={1} />
            <text x={t.pos} y={g.plot.bottom + 14} textAnchor="middle" fill="var(--fg-subtle)" fontSize={10} fontFamily="var(--font-mono)">
              {t.value}
            </text>
          </g>
        ))}
        <rect x={g.plot.left} y={g.plot.top} width={g.plot.right - g.plot.left} height={g.plot.bottom - g.plot.top} fill="none" stroke="var(--line-strong)" />

        <line
          x1={g.identity.x1}
          y1={g.identity.y1}
          x2={g.identity.x2}
          y2={g.identity.y2}
          stroke="var(--fg-subtle)"
          strokeWidth={1.5}
          strokeDasharray="5 4"
        />
        {g.dots.map((d, i) => (
          <circle key={i} cx={d.cx} cy={d.cy} r={3.5} fill="var(--info)" fillOpacity={0.55} stroke="var(--info)" strokeWidth={1} />
        ))}
        {g.regression ? (
          <line x1={g.regression.x1} y1={g.regression.y1} x2={g.regression.x2} y2={g.regression.y2} stroke="var(--accent)" strokeWidth={2} />
        ) : null}

        <text x={(g.plot.left + g.plot.right) / 2} y={g.height - 6} textAnchor="middle" fill="var(--fg-muted)" fontSize={11}>
          MODIS FRP (MW)
        </text>
        <text
          transform={`translate(11 ${(g.plot.top + g.plot.bottom) / 2}) rotate(-90)`}
          textAnchor="middle"
          fill="var(--fg-muted)"
          fontSize={11}
        >
          VIIRS FRP (MW)
        </text>
        <text x={g.plot.left + 6} y={g.plot.top + 14} fill="var(--fg)" fontSize={11} fontFamily="var(--font-mono)">
          n = {frp.n}
        </text>
        {frp.n === 0 ? (
          <text x={(g.plot.left + g.plot.right) / 2} y={(g.plot.top + g.plot.bottom) / 2} textAnchor="middle" fill="var(--fg-muted)" fontSize={12}>
            No usable FRP pairs
          </text>
        ) : null}
      </svg>
      <figcaption className="mt-1.5 text-2xs text-fg-subtle flex flex-wrap gap-x-3 gap-y-1">
        <span>
          <span aria-hidden="true">╌╌</span> dashed: VIIRS = MODIS
        </span>
        {reg ? (
          <span>
            <span aria-hidden="true">──</span> solid: least-squares fit
          </span>
        ) : null}
        {g.notDrawn > 0 ? <span>{g.notDrawn} point(s) not drawn; statistics use all.</span> : null}
      </figcaption>
    </figure>
  );
};

// ---------------------------------------------------------------------------
// Result sections
// ---------------------------------------------------------------------------

const LEVEL_LABEL: Record<ComparisonLevel, string> = { point: 'Pixel pairs', cell: 'MODIS footprints' };
const LEVEL_HELP: Record<ComparisonLevel, string> = {
  point: 'One MODIS detection paired with one nearby VIIRS detection.',
  cell: 'One MODIS detection compared with the VIIRS detections that fall inside its pixel footprint.',
};

const FrpSection: React.FC<{ view: HarmonizeView }> = ({ view }) => {
  const [level, setLevel] = useState<ComparisonLevel>('point');
  const frp = view.frp[level];
  const r = frp.regression;
  return (
    <section aria-labelledby="harm-frp" className="space-y-3">
      <h3 id="harm-frp" className="text-sm font-semibold text-fg">
        Fire radiative power agreement
      </h3>
      <div role="group" aria-label="Comparison level" className="grid grid-cols-2 gap-2">
        {(['point', 'cell'] as const).map((l) => (
          <button
            key={l}
            type="button"
            aria-pressed={level === l}
            onClick={() => setLevel(l)}
            className={`min-h-touch rounded-control border text-sm font-medium cursor-pointer px-2 ${
              level === l ? 'bg-accent text-accent-fg border-accent' : 'bg-raised text-fg border-line-strong'
            }`}
          >
            {LEVEL_LABEL[l]}
          </button>
        ))}
      </div>
      <p className="text-xs text-fg-muted">
        {LEVEL_HELP[level]} y = {frp.yQuantity}.
      </p>

      <FrpScatter frp={frp} />

      <div className="grid grid-cols-2 min-[420px]:grid-cols-4 gap-2">
        <Stat label="n" value={frp.n} hint={frp.excluded > 0 ? `${frp.excluded} excluded (FRP missing or ≤ 0)` : undefined} />
        <Stat label="Bias" value={fmtSigned(frp.bias)} hint="MW, VIIRS − MODIS" />
        <Stat label="MAE" value={fmt(frp.mae)} hint="MW" />
        <Stat label="RMSE" value={fmt(frp.rmse)} hint="MW" />
      </div>
      <p className="numeric text-xs text-fg-muted">
        {r
          ? `VIIRS ≈ ${fmt(r.intercept, 2)} + ${fmt(r.slope, 2)} × MODIS (least squares; r² ${r.r2 === null ? '–' : fmt(r.r2, 2)}; n=${frp.n})`
          : 'No regression line (needs at least 3 pairs and MODIS FRP that varies).'}
      </p>
      {frp.note ? <p className="text-xs text-fg-muted">{frp.note}</p> : null}

      <div className="space-y-2" data-state="robust-frp">
        <h4 className="text-xs font-semibold text-fg">Robust statistics (less affected by a few intense fires)</h4>
        <div className="grid grid-cols-3 gap-2">
          <Stat label="Spearman ρ" value={frp.robust.spearman === null ? '–' : fmt(frp.robust.spearman, 2)} hint="rank correlation" />
          <Stat
            label="Median ratio"
            value={frp.robust.medianRatio === null ? '–' : fmt(frp.robust.medianRatio, 2)}
            hint="VIIRS ÷ MODIS, log scale"
          />
          <Stat label="n" value={frp.robust.n} hint="pairs with FRP > 0" />
        </div>
        {frp.robust.note ? <Warning>{frp.robust.note}</Warning> : null}
        <p className="text-2xs text-fg-subtle">
          Spearman ρ is the Pearson correlation of average ranks. Median ratio = exp(median(ln(VIIRS ÷ MODIS))). Both are {EXPLORATORY_LABEL}; a ratio is not a calibration factor, and agreement
          does not show which sensor is closer to the true radiative power.
        </p>
      </div>
    </section>
  );
};

const TimeOffsetSection: React.FC<{ offset: TimeOffsetSummary }> = ({ offset }) => {
  if (offset.n === 0) return null;
  return (
    <section aria-labelledby="harm-time" className="space-y-2" data-state="time-offset">
      <h3 id="harm-time" className="text-sm font-semibold">
        Time offset of matched pairs
      </h3>
      <div className="grid grid-cols-3 gap-2">
        <Stat label="Median |offset|" value={`${fmt(offset.medianAbsMin, 0)} min`} hint={`window ±${offset.windowMin} min`} />
        <Stat label="Max |offset|" value={`${fmt(offset.maxAbsMin, 0)} min`} />
        <Stat label="In outer 20%" value={`${offset.outerCount} of ${offset.n}`} hint={fmtPct(offset.outerShare)} />
      </div>
      {offset.note ? <Warning>{offset.note}</Warning> : null}
      {offset.bySatellitePair.length > 0 ? (
        <ul className="numeric text-2xs text-fg-subtle space-y-0.5">
          {offset.bySatellitePair.map((g) => (
            <li key={`${g.modis}-${g.viirs}`}>
              MODIS {g.modis} ↔ VIIRS {g.viirs}: {g.n} pair(s), median |offset| {fmt(g.medianAbsMin, 0)} min
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
};

const OverpassSection: React.FC<{ overpass: OverpassObserved }> = ({ overpass }) => (
  <section aria-labelledby="harm-overpass" className="space-y-2" data-state="overpass">
    <h3 id="harm-overpass" className="text-sm font-semibold">
      Observed overpass time (approx., local solar time)
    </h3>
    {overpass.rows.length === 0 ? (
      <p className="text-xs text-fg-muted">No detection in this view has a usable time, longitude and day/night flag.</p>
    ) : (
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-fg-subtle text-2xs uppercase tracking-wider">
              <th scope="col" className="py-1 pr-2 font-semibold">Sensor</th>
              <th scope="col" className="py-1 pr-2 font-semibold">Satellite</th>
              <th scope="col" className="py-1 pr-2 font-semibold">Day/night</th>
              <th scope="col" className="py-1 pr-2 font-semibold text-right">n</th>
              <th scope="col" className="py-1 font-semibold text-right">Median</th>
            </tr>
          </thead>
          <tbody>
            {overpass.rows.map((r) => (
              <tr key={`${r.sensor}-${r.satellite}-${r.daynight}`} className="border-t border-line">
                <td className="py-1 pr-2 text-fg">{r.sensor}</td>
                <td className="py-1 pr-2 text-fg">{r.satellite}</td>
                <td className="py-1 pr-2 text-fg">{r.daynight === 'D' ? 'Day' : 'Night'}</td>
                <td className="py-1 pr-2 numeric text-right text-fg">{r.n}</td>
                <td className="py-1 numeric text-right text-fg">
                  {r.label}
                  {r.lowN ? <span className="text-fg-subtle"> · low n</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )}
    <p className="text-2xs text-fg-subtle">
      {OVERPASS_APPROX_NOTE} “low n” means fewer than {OVERPASS_MIN_N} detections. MODIS and VIIRS rows are never combined.
      {overpass.skipped > 0 ? ` ${overpass.skipped} record(s) without a usable time, longitude or day/night flag were not used.` : ''}
    </p>
  </section>
);

const CellDaySection: React.FC<{ agreement: CellDayAgreement }> = ({ agreement }) => (
  <section aria-labelledby="harm-celldays" className="space-y-2" data-state="cell-day">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 id="harm-celldays" className="text-sm font-semibold">
        Same-day cell agreement (1 km grid)
      </h3>
      <Badge />
    </div>
    {agreement.status !== 'ok' ? (
      <p className="text-xs text-fg-muted">
        {agreement.status === 'no_complete_day'
          ? 'Every UTC date in view is partial, so no cell agreement is shown.'
          : 'No detection with a usable date and position in this view.'}
      </p>
    ) : (
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-fg-subtle text-2xs uppercase tracking-wider">
              <th scope="col" className="py-1 pr-2 font-semibold">UTC date</th>
              <th scope="col" className="py-1 pr-2 font-semibold text-right">MODIS cells</th>
              <th scope="col" className="py-1 pr-2 font-semibold text-right">VIIRS cells</th>
              <th scope="col" className="py-1 pr-2 font-semibold text-right">Both</th>
              <th scope="col" className="py-1 pr-2 font-semibold text-right">MODIS only</th>
              <th scope="col" className="py-1 pr-2 font-semibold text-right">VIIRS only</th>
              <th scope="col" className="py-1 pr-2 font-semibold text-right">MODIS cells with VIIRS</th>
              <th scope="col" className="py-1 font-semibold text-right">VIIRS per shared cell</th>
            </tr>
          </thead>
          <tbody>
            {agreement.rows.map((r) => (
              <tr key={r.date} className="border-t border-line">
                <td className="py-1 pr-2 numeric text-fg">
                  {r.date}
                  {r.partial ? <span className="text-fg-subtle"> · partial</span> : null}
                </td>
                <td className="py-1 pr-2 numeric text-right text-fg">
                  <SensorDot sensor="MODIS" className="mr-1.5" />
                  {r.modisCells}
                </td>
                <td className="py-1 pr-2 numeric text-right text-fg">
                  <SensorDot sensor="VIIRS" className="mr-1.5" />
                  {r.viirsCells}
                </td>
                <td className="py-1 pr-2 numeric text-right text-fg">{r.bothCells}</td>
                <td className="py-1 pr-2 numeric text-right text-fg">{r.modisOnlyCells}</td>
                <td className="py-1 pr-2 numeric text-right text-fg">{r.viirsOnlyCells}</td>
                <td className="py-1 pr-2 numeric text-right text-fg">{fmtPct(r.modisCellsWithViirsShare)}</td>
                <td className="py-1 numeric text-right text-fg">{r.viirsPerSharedCell === null ? '–' : fmt(r.viirsPerSharedCell, 2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )}
    {agreement.warnings.map((w) => (
      <Warning key={w}>{w}</Warning>
    ))}
    <p className="text-2xs text-fg-subtle">{agreement.method}</p>
    <ul className="list-disc pl-4 space-y-1 text-2xs text-fg-subtle">
      {agreement.limitations.map((l) => (
        <li key={l}>{l}</li>
      ))}
    </ul>
    {agreement.skipped > 0 ? <p className="text-2xs text-fg-subtle">{agreement.skipped} record(s) without a usable date or position were not used.</p> : null}
  </section>
);

const SatelliteSelect: React.FC<{
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (v: string) => void;
}> = ({ label, value, options, onChange }) => {
  const id = useId();
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="block text-sm font-medium text-fg">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full min-h-touch rounded-control border border-line-strong bg-raised text-fg text-sm px-2 cursor-pointer"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
};

const SensitivityBody: React.FC<{ report: SensitivityReport }> = ({ report }) => {
  if (report.skippedReason) return <p className="text-xs text-fg-muted">{report.skippedReason}</p>;
  return (
    <>
      {report.sample ? (
        <Warning>
          <span className="font-semibold">Sensitivity check {report.sample.label}</span> ({report.sample.blocksKept} of {report.sample.blocksTotal} spatial blocks; the same view always gives the same
          sample). Counts below are for the sample, not the whole view.
        </Warning>
      ) : null}
      <p className="text-xs text-fg">{report.summary}</p>
      <div className="overflow-x-auto">
        <table className="w-full text-xs numeric border-collapse">
          <caption className="sr-only">Matched pairs for each distance and time window setting</caption>
          <thead>
            <tr className="text-fg-subtle text-2xs uppercase tracking-wider">
              <th scope="col" className="text-left font-semibold py-1.5 pr-2">Distance</th>
              <th scope="col" className="text-left font-semibold py-1.5 pr-2">Window</th>
              <th scope="col" className="text-right font-semibold py-1.5 pr-2">Matched</th>
              <th scope="col" className="text-right font-semibold py-1.5">of MODIS</th>
            </tr>
          </thead>
          <tbody>
            {report.rows.map((r) => (
              <tr key={`${r.maxDistanceKm}-${r.maxTimeDiffMinutes}`} className="border-t border-line text-fg" aria-current={r.isCurrent ? 'true' : undefined}>
                <td className="py-1.5 pr-2">{r.maxDistanceKm} km</td>
                <td className="py-1.5 pr-2">±{r.maxTimeDiffMinutes} min{r.isCurrent ? ' (current)' : ''}</td>
                <td className="py-1.5 pr-2 text-right">
                  {r.matched}
                  {r.deltaMatchedVsCurrent !== 0 ? ` (${fmtSigned(r.deltaMatchedVsCurrent, 0)})` : ''}
                </td>
                <td className="py-1.5 text-right">{fmtPct(r.matchedShareOfModis)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="list-disc pl-4 space-y-1 text-2xs text-fg-subtle">
        {report.limitations.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
    </>
  );
};

const Counts: React.FC<{ d: DateCompleteness }> = ({ d }) => (
  <span className="numeric">
    MODIS {d.modis} · VIIRS {d.viirs}
  </span>
);

/** Partial UTC day note + include toggle. MODIS and VIIRS counts are always shown separately. */
const PartialDayNote: React.FC<{
  excluded: readonly DateCompleteness[];
  includedPartial: readonly DateCompleteness[];
  includePartial: boolean;
  onToggle: (v: boolean) => void;
}> = ({ excluded, includedPartial, includePartial, onToggle }) => {
  const id = useId();
  const list = includePartial ? includedPartial : excluded;
  if (list.length === 0) return null;
  return (
    <div className="space-y-2" data-state="partial-day">
      {includePartial ? (
        <div role="alert" className="flex gap-2 items-start bg-raised border-2 border-danger rounded-control p-2.5 text-xs text-fg">
          <AlertTriangle aria-hidden="true" className="h-4 w-4 shrink-0 text-danger mt-0.5" />
          <div className="min-w-0 space-y-1">
            <p className="font-semibold text-danger">Partial day included: do not quote these numbers</p>
            <p>
              The included day is unfinished or covered by only one sensor, so the two sensors are compared over unequal observation windows. Counts, the
              detection ratio and FRP agreement below are <span className="font-semibold">{EXPLORATORY_LABEL}</span> and can be misleading.
            </p>
          </div>
        </div>
      ) : null}
      <Warning>
        <span className="block font-semibold">{includePartial ? 'Partial UTC day(s) in this comparison' : 'Partial UTC day(s) excluded from this comparison'}</span>
        <ul className="mt-1 space-y-1">
          {list.map((d) => (
            <li key={d.date}>
              <span className="numeric font-semibold">{d.date}</span> — <Counts d={d} />. {partialReasonText(d, includePartial)}
            </li>
          ))}
        </ul>
      </Warning>
      <label htmlFor={id} className="min-h-touch flex items-center gap-2 text-sm text-fg cursor-pointer">
        <input id={id} type="checkbox" checked={includePartial} onChange={(e) => onToggle(e.target.checked)} className="h-4 w-4 accent-accent cursor-pointer" />
        <span>Include partial day(s) anyway (exploratory)</span>
      </label>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export const HarmonizationPanel: React.FC<HarmonizationPanelProps> = ({ modis, viirs, loading = false, now, className = '' }) => {
  const [distanceKm, setDistanceKm] = useState<number>(MATCHING_DEFAULTS.maxDistanceKm);
  const [timeMin, setTimeMin] = useState<number>(MATCHING_DEFAULTS.maxTimeDiffMinutes);
  const [whyOpen, setWhyOpen] = useState(false);
  const [sensOpen, setSensOpen] = useState(false);
  const [includePartial, setIncludePartial] = useState(false);
  const [satellites, setSatellites] = useState<SatelliteSelection>(DEFAULT_SATELLITE_SELECTION);

  // Keep the sliders snappy: matching re-runs on the deferred values.
  const dist = useDeferredValue(distanceKm);
  const time = useDeferredValue(timeMin);

  const computed = useMemo(() => {
    if (loading) return null;
    try {
      return computeHarmonizeViewComplete(modis, viirs, {
        now: now ?? Date.now(),
        includePartial,
        matching: { maxDistanceKm: dist, maxTimeDiffMinutes: time, ...satelliteSelectionToOptions(satellites) },
      });
    } catch {
      return null;
    }
  }, [modis, viirs, dist, time, loading, now, includePartial, satellites]);

  // Sensitivity re-runs matching on the same partial-day-filtered detections as the main view.
  const sensitivity = useMemo(() => {
    if (!sensOpen || !computed?.result) return null;
    return runSensitivity([...computed.used.modis, ...computed.used.viirs], computed.result, satelliteSelectionToOptions(satellites));
  }, [sensOpen, computed, satellites]);

  // Observed from everything loaded for this view (not limited by the satellite selection or partial-day rule).
  const overpass = useMemo(() => (loading ? null : observedOverpassTimes([...modis, ...viirs])), [modis, viirs, loading]);

  // Gap between the selected satellites' observed times vs the chosen window (uses the deferred window, like matching).
  const feasibility = useMemo(() => (overpass ? windowFeasibility(overpass, satellites, time) : []), [overpass, satellites, time]);

  // Same-day cell agreement: same partial-day rule and satellite selection as the main view.
  const cellDay = useMemo(() => {
    if (loading) return null;
    try {
      return cellDayAgreement(modis, viirs, { now: now ?? Date.now(), includePartial, ...satelliteSelectionToOptions(satellites) });
    } catch {
      return null;
    }
  }, [modis, viirs, loading, now, includePartial, satellites]);

  const why = useMemo(() => (computed?.view ? buildWhyDiffer(computed.view, overpass ?? undefined) : null), [computed, overpass]);

  const view = computed?.view ?? null;
  const noCompleteDay = computed?.status === 'no_complete_day';
  const hasBoth = view ? view.inputs.modis > 0 && view.inputs.viirs > 0 : false;
  const isDefault =
    distanceKm === MATCHING_DEFAULTS.maxDistanceKm && timeMin === MATCHING_DEFAULTS.maxTimeDiffMinutes && isDefaultSatelliteSelection(satellites);

  const changeSatellites = (next: SatelliteSelection) => setSatellites(next);

  return (
    <section
      aria-labelledby="harm-title"
      aria-busy={loading}
      className={`w-full max-w-full min-w-0 bg-surface text-fg border border-line rounded-card shadow-elev-2 p-3 space-y-4 ${className}`}
    >
      <header className="space-y-1.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="harm-title" className="text-base font-semibold">
            MODIS ↔ VIIRS harmonization
          </h2>
          <Badge />
        </div>
        <p className="text-xs text-fg-muted">
          Compares detections the two sensors both reported in this view by location and time. MODIS and VIIRS are kept separate and never added together.
        </p>
      </header>

      {/* Controls */}
      <div className="space-y-1 border-t border-line pt-3">
        <Slider
          label="Match distance"
          value={distanceKm}
          unit="km"
          {...CONTROL_LIMITS.distanceKm}
          defaultValue={MATCHING_DEFAULTS.maxDistanceKm}
          onChange={setDistanceKm}
        />
        <Slider
          label="Time window (±)"
          value={timeMin}
          unit="min"
          {...CONTROL_LIMITS.timeMinutes}
          defaultValue={MATCHING_DEFAULTS.maxTimeDiffMinutes}
          onChange={setTimeMin}
        />
        <div className="grid grid-cols-2 gap-2 pt-1" data-state="satellite-select">
          <SatelliteSelect
            label="MODIS satellite"
            value={satellites.modis}
            options={MODIS_SELECTION_OPTIONS}
            onChange={(v) => changeSatellites({ ...satellites, modis: v as ModisSelection })}
          />
          <SatelliteSelect
            label="VIIRS satellite"
            value={satellites.viirs}
            options={VIIRS_SELECTION_OPTIONS}
            onChange={(v) => changeSatellites({ ...satellites, viirs: v as ViirsSelection })}
          />
        </div>
        <p className="text-2xs text-fg-subtle">
          Default pools every loaded satellite of each sensor, so one fire seen by two satellites can be counted twice. Counts stay separate per sensor.
        </p>
        {feasibility.some((f) => f.warning) ? (
          <div className="space-y-1.5 pt-1" data-state="window-feasibility">
            {feasibility.map((f) => (f.warning ? <Warning key={f.daynight}>{f.warning}</Warning> : null))}
          </div>
        ) : null}
        <button
          type="button"
          disabled={isDefault}
          onClick={() => {
            setDistanceKm(MATCHING_DEFAULTS.maxDistanceKm);
            setTimeMin(MATCHING_DEFAULTS.maxTimeDiffMinutes);
            setSatellites(DEFAULT_SATELLITE_SELECTION);
          }}
          className="min-h-touch inline-flex items-center gap-2 px-3 rounded-control border border-line-strong bg-raised text-sm font-medium text-fg cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <RotateCcw aria-hidden="true" className="h-4 w-4" />
          Reset to defaults
        </button>
      </div>

      {!loading && computed ? (
        <PartialDayNote
          excluded={computed.excluded}
          includedPartial={computed.includedPartial}
          includePartial={includePartial}
          onToggle={setIncludePartial}
        />
      ) : null}

      {/* Loading / empty / results */}
      {loading ? (
        <div role="status" aria-live="polite" className="space-y-2" data-state="loading">
          <span className="sr-only">Loading detections for this view…</span>
          <div className="h-16 rounded-control bg-raised motion-safe:animate-pulse" />
          <div className="h-40 rounded-control bg-raised motion-safe:animate-pulse" />
          <p className="text-xs text-fg-subtle">Loading detections… earlier results are hidden until the new view is ready.</p>
        </div>
      ) : noCompleteDay ? (
        <div data-state="no-complete-day" className="space-y-2 bg-raised border border-line rounded-card p-3">
          <p className="text-sm font-medium text-fg">No complete UTC day in this view</p>
          <p className="text-xs text-fg-muted">
            Every UTC date in view is partial, so no comparison, ratio or FRP agreement is shown. Pick a range of 2 or more days so that at least one finished day is
            included.
          </p>
        </div>
      ) : !view ? (
        <p role="alert" className="text-sm text-danger" data-state="error">
          Could not compute the comparison for these settings.
        </p>
      ) : !hasBoth ? (
        <div data-state="empty" className="space-y-2 bg-raised border border-line rounded-card p-3">
          <p className="text-sm font-medium text-fg">Nothing to compare in this view</p>
          <p className="text-xs text-fg-muted">
            A comparison needs detections from both sensors. This view has <span className="numeric">{view.inputs.modis}</span> MODIS and{' '}
            <span className="numeric">{view.inputs.viirs}</span> VIIRS detection(s). Zoom in, pan, widen the day range{isDefaultSatelliteSelection(satellites) ? '' : ', or change the satellite selection'}. An empty sensor can also mean it
            did not pass over this area in the period.
          </p>
          {view.warnings.filter((w) => !/Both sensors are needed/.test(w)).map((w) => (
            <Warning key={w}>{w}</Warning>
          ))}
        </div>
      ) : (
        <div className="space-y-4" data-state="ready">
          {view.warnings.map((w) => (
            <Warning key={w}>{w}</Warning>
          ))}

          <section aria-labelledby="harm-counts" className="space-y-2">
            <h3 id="harm-counts" className="text-sm font-semibold">
              What matched
            </h3>
            <div className="grid grid-cols-3 gap-2">
              <Stat label="Matched" value={view.point.matched} hint={`${fmtPct(view.point.matchedShareOfModis)} of MODIS`} />
              <Stat label="VIIRS only" value={view.point.viirsOnly} hint={`of ${view.inputs.viirs} VIIRS`} />
              <Stat label="MODIS only" value={view.point.modisOnly} hint={`of ${view.inputs.modis} MODIS`} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Stat
                label="Detection ratio"
                value={view.detectionRatio.overall === null ? '–' : fmt(view.detectionRatio.overall, 2)}
                hint={`${view.inputs.viirs} VIIRS ÷ ${view.inputs.modis} MODIS`}
              />
              <Stat
                label="VIIRS per MODIS cell"
                value={view.detectionRatio.coDetected === null ? '–' : fmt(view.detectionRatio.coDetected, 2)}
                hint={`${view.cell.viirsInCells} VIIRS in ${view.cell.coDetectedCells} cell(s)`}
              />
            </div>
            <p className="text-2xs text-fg-subtle">
              “Only” means no counterpart was found by this method, not that the other sensor saw nothing. The ratio divides two separate counts; it depends on coverage and is not a
              calibration factor.
            </p>
          </section>

          <TimeOffsetSection offset={view.timeOffset} />

          {overpass ? <OverpassSection overpass={overpass} /> : null}

          <FrpSection view={view} />

          {cellDay ? <CellDaySection agreement={cellDay} /> : null}

          <HarmonizedActivitySection
            modis={modis}
            viirs={viirs}
            now={now}
            includePartial={includePartial}
            satellites={satellites}
            matchedCells={computed?.result?.cell.cells ?? null}
            matchWindowMinutes={time}
          />

          <ValidationEvidenceSection />
        </div>
      )}

      {/* Method + limitations: always visible once there is something to describe */}
      {!loading && view ? (
        <section aria-labelledby="harm-method" className="space-y-2 border-t border-line pt-3">
          <h3 id="harm-method" className="text-sm font-semibold">
            Method and limitations
          </h3>
          <p className="text-xs text-fg-muted">{view.method}</p>
          <ul className="list-disc pl-4 space-y-1 text-xs text-fg-muted">
            {view.limitations.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {!loading && view && hasBoth ? (
        <div className="space-y-2">
          <Collapsible title="Sensitivity check" open={sensOpen} onToggle={() => setSensOpen((o) => !o)}>
            {sensitivity ? <SensitivityBody report={sensitivity} /> : <p className="text-xs text-fg-muted">Computing…</p>}
          </Collapsible>
          <Collapsible title="Why do they differ?" open={whyOpen} onToggle={() => setWhyOpen((o) => !o)}>
            {why?.warning ? <Warning>{why.warning}</Warning> : null}
            {why?.blocks.map((b) => (
              <article key={b.id} className="space-y-1">
                <h4 className="text-sm font-semibold text-fg">{b.title}</h4>
                <p className="text-xs text-fg-muted">{b.body}</p>
                <p className="text-xs text-fg bg-raised border border-line rounded-control p-2">
                  <span className="text-fg-subtle uppercase tracking-wider text-2xs font-semibold">In this view · </span>
                  {b.live}
                </p>
              </article>
            ))}
          </Collapsible>
        </div>
      ) : null}

      <p className="text-2xs text-fg-subtle border-t border-line pt-3">{LEGEND_SENTENCE}</p>
    </section>
  );
};

export default HarmonizationPanel;

import { SensorDot } from '../SensorDot';
import React, { useId, useMemo, useState } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';
import type { CanonicalObservation } from '../../types/fire';
import {
  EXPLORATORY_LABEL,
  fmt,
  fmtPct,
  partialReasonText,
  satelliteSelectionToOptions,
  type SatelliteSelection,
} from '../../utils/harmonizeView';
import type { MatchedCell } from '../../utils/matching';
import {
  CELL_SIZE_DEFAULT_KM,
  CELL_SIZE_OPTIONS_KM,
  HINT_MIN_N,
  VIIRS_SCALE_DEFAULT,
  VIIRS_SCALE_LIMITS,
  computeHarmonizedActivity,
  type ActivityDateRow,
  type ActivitySensitivity,
  type HarmonizedActivityResult,
  type ScaleHint,
} from '../../utils/harmonizedActivity';

/**
 * Harmonized activity (EXPLORATORY): per-UTC-date MODIS count | VIIRS count | index, with the index split into
 * its three terms. The MODIS and VIIRS colours (utils/sensorStyle.ts) are used ONLY for the two raw counts; the three
 * index terms use neutral tokens and patterns. Nothing here sums raw MODIS and VIIRS counts.
 *
 * The partial-UTC-day toggle lives in HarmonizationPanel and is passed in (`includePartial`), so there is one switch.
 */
export interface HarmonizedActivitySectionProps {
  modis: readonly CanonicalObservation[];
  viirs: readonly CanonicalObservation[];
  /** Same clock the panel uses; defaults to the current time when computed. */
  now?: Date | number;
  /** The panel's include-partial-day toggle. */
  includePartial: boolean;
  /** The panel's satellite selection. */
  satellites?: SatelliteSelection;
  /** MODIS footprints with VIIRS inside, from the panel's matching result (same window and partial-day rule). */
  matchedCells?: readonly MatchedCell[] | null;
  /** The panel's matching window in minutes (wording only). */
  matchWindowMinutes?: number;
  /** Initial slider value (tests); defaults to the archive constant. */
  initialViirsScale?: number;
}


const Badge: React.FC = () => (
  <span className="inline-flex items-center min-h-6 px-2 rounded-full border border-accent text-accent font-mono text-2xs font-semibold uppercase tracking-wider">
    {EXPLORATORY_LABEL}
  </span>
);

const Note: React.FC<{ children: React.ReactNode; strong?: boolean }> = ({ children, strong = false }) => (
  <div role="note" className={`flex gap-2 items-start bg-raised border ${strong ? 'border-2 border-danger' : 'border-accent'} rounded-control p-2.5 text-xs text-fg`}>
    <AlertTriangle aria-hidden="true" className={`h-4 w-4 shrink-0 mt-0.5 ${strong ? 'text-danger' : 'text-accent'}`} />
    <span className="min-w-0">{children}</span>
  </div>
);

/** Raw counts: the only place the two sensor colours appear. They stay two separate numbers. */
const CountChips: React.FC<{ modis: number; viirs: number }> = ({ modis, viirs }) => (
  <span className="numeric text-xs inline-flex flex-wrap gap-x-3">
    <span>
      <SensorDot sensor="MODIS" className="mr-1" />
      <span className="font-semibold">MODIS</span>{' '}
      {modis}
    </span>
    <span>
      <SensorDot sensor="VIIRS" className="mr-1" />
      <span className="font-semibold">VIIRS</span>{' '}
      {viirs}
    </span>
  </span>
);

// Neutral fills for the three index terms (distinct by lightness and pattern, not by sensor colour).
const TERM_STYLE = {
  modis: { background: 'var(--line-strong)' },
  viirsScaled: {
    backgroundColor: 'var(--raised)',
    backgroundImage: 'repeating-linear-gradient(45deg, var(--fg) 0 2px, transparent 2px 6px)',
    outline: '1px solid var(--fg-muted)',
    outlineOffset: '-1px',
  },
  frp: { background: 'var(--success)' },
} as const;

const TermLegend: React.FC = () => (
  <ul className="flex flex-wrap gap-x-4 gap-y-1 text-2xs text-fg-muted" aria-label="Index terms">
    <li className="inline-flex items-center gap-1.5">
      <span aria-hidden="true" className="inline-block h-3 w-5 rounded-sm" style={TERM_STYLE.modis} /> MODIS term
    </li>
    <li className="inline-flex items-center gap-1.5">
      <span aria-hidden="true" className="inline-block h-3 w-5 rounded-sm" style={TERM_STYLE.viirsScaled} /> scaled VIIRS term (rests on the scale)
    </li>
    <li className="inline-flex items-center gap-1.5">
      <span aria-hidden="true" className="inline-block h-3 w-5 rounded-sm" style={TERM_STYLE.frp} /> FRP term
    </li>
  </ul>
);

const DateRow: React.FC<{ row: ActivityDateRow; maxIndex: number }> = ({ row, maxIndex }) => {
  const { modis, viirsScaled, frp } = row.terms;
  const pct = (v: number) => (maxIndex > 0 ? (v / maxIndex) * 100 : 0);
  const label =
    `${row.date}: index ${fmt(row.index, 2)}, exploratory. MODIS term ${fmt(modis, 2)}, scaled VIIRS term ${fmt(viirsScaled, 2)}, FRP term ${fmt(frp, 2)}. ` +
    `${row.modisCount} MODIS detections, ${row.viirsCount} VIIRS detections, ${row.cells} cells.`;
  return (
    <li className="bg-raised border border-line rounded-control p-2.5 space-y-1.5" data-date={row.date}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="numeric text-sm font-semibold text-fg">
          {row.date}
          {row.partial ? <span className="ml-2 text-2xs text-danger font-semibold">partial day</span> : null}
        </span>
        <CountChips modis={row.modisCount} viirs={row.viirsCount} />
      </div>
      <div className="flex items-center gap-2">
        <div role="img" aria-label={label} className="flex h-4 min-w-0 flex-1 rounded-sm bg-surface overflow-hidden" data-bar={row.date}>
          {modis > 0 ? <span style={{ ...TERM_STYLE.modis, width: `${pct(modis)}%` }} /> : null}
          {viirsScaled > 0 ? <span style={{ ...TERM_STYLE.viirsScaled, width: `${pct(viirsScaled)}%` }} /> : null}
          {frp > 0 ? <span style={{ ...TERM_STYLE.frp, width: `${pct(frp)}%`, minWidth: 2 }} /> : null}
        </div>
        <span className="numeric text-sm font-semibold text-fg shrink-0 w-14 text-right">{fmt(row.index, 2)}</span>
      </div>
      <p className="numeric text-2xs text-fg-muted">
        MODIS term {fmt(modis, 2)} + scaled VIIRS term {fmt(viirsScaled, 2)} + FRP term {fmt(frp, 3)} · {row.cells} cell(s), {row.cellsBoth} with both sensors
        {row.scaleAssumptionShare !== null ? ` · ${fmtPct(row.scaleAssumptionShare)} of the index rests on the scale` : ''}
      </p>
    </li>
  );
};

const HintBlock: React.FC<{ hint: ScaleHint | null; scale: number }> = ({ hint, scale }) => (
  <div className="space-y-2" data-state="scale-hint">
    <h4 className="text-xs font-semibold text-fg">Scale constant vs this view</h4>
    <div className="grid grid-cols-1 min-[420px]:grid-cols-2 gap-2">
      <div className="bg-raised border border-line rounded-control p-2.5 min-w-0">
        <div className="text-fg-subtle text-2xs uppercase tracking-wider font-semibold">Constant (archive pages)</div>
        <div className="numeric text-fg text-lg font-semibold">{fmt(VIIRS_SCALE_DEFAULT, 3)}</div>
        <p className="text-2xs text-fg-muted">
          = 1 ÷ 3.4, a literature ratio of VIIRS to MODIS detections. n = none: it was not fitted to data in this view and is not validated.
          {scale !== VIIRS_SCALE_DEFAULT ? ` Slider is at ${fmt(scale, 2)}.` : ''}
        </p>
      </div>
      <div className="bg-raised border border-line rounded-control p-2.5 min-w-0">
        <div className="text-fg-subtle text-2xs uppercase tracking-wider font-semibold">This view, shared cells only</div>
        {hint && hint.n > 0 && hint.median !== null && hint.impliedScale !== null ? (
          <>
            <div className="numeric text-fg text-lg font-semibold">{fmt(hint.impliedScale, 3)}</div>
            <p className="numeric text-2xs text-fg-muted">
              implied scale = 1 ÷ median {fmt(hint.median, 2)} (IQR {fmt(hint.q1, 2)} to {fmt(hint.q3, 2)}, width {fmt(hint.iqr, 2)}); n = {hint.n} MODIS footprint(s) with VIIRS
              inside
            </p>
          </>
        ) : (
          <>
            <div className="numeric text-fg text-lg font-semibold">–</div>
            <p className="text-2xs text-fg-muted">n = 0: no MODIS footprint with a VIIRS detection inside in this view, so there is no hint.</p>
          </>
        )}
      </div>
    </div>
    {hint && hint.smallN ? (
      <Note>
        <span className="font-semibold">Small sample:</span> n = {hint.n} is below {HINT_MIN_N}. The hint is anecdotal here.
      </Note>
    ) : null}
    <p className="text-2xs text-fg-subtle">
      Conditional on shared cells and on this window; it is descriptive, not a calibration factor, and it is a different quantity from the overall VIIRS ÷ MODIS detection ratio shown above.
      {hint ? ` ${hint.caveats.filter((c) => !/Small sample|Not a calibration/.test(c)).join(' ')}` : ''}
    </p>
  </div>
);

const SensitivityTable: React.FC<{ s: ActivitySensitivity }> = ({ s }) => (
  <div className="space-y-2" data-state="activity-sensitivity" data-status={s.status}>
    <h4 className="text-xs font-semibold text-fg">Sensitivity to the VIIRS scale</h4>
    {s.rows.length > 0 ? (
      <div className="overflow-x-auto rounded-control border border-line" role="region" aria-label="Index by date and VIIRS scale" tabIndex={0}>
        <table className="w-full text-2xs numeric">
          <thead>
            <tr className="text-fg-subtle text-left">
              <th scope="col" className="p-2 font-semibold">
                UTC date
              </th>
              {s.scales.map((c) => (
                <th key={c.label} scope="col" className="p-2 font-semibold text-right whitespace-nowrap">
                  {fmt(c.scale, 3)}
                  <span className="block font-normal">{c.label === 'default' ? 'default' : c.label === 'one' ? '1.0' : c.label}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {s.rows.map((r) => (
              <tr key={r.date} className="border-t border-line text-fg">
                <th scope="row" className="p-2 text-left font-medium whitespace-nowrap">
                  {r.date}
                </th>
                {r.values.map((v, i) => (
                  <td key={i} className="p-2 text-right whitespace-nowrap">
                    {fmt(v, 2)}
                    <span className="text-fg-subtle"> #{r.ranks[i]}</span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    ) : null}
    <p className="text-xs text-fg-muted">{s.note}</p>
    <p className="text-2xs text-fg-subtle">#n is the rank of the date (1 = highest index) at that scale.</p>
  </div>
);

const NotBox: React.FC = () => (
  <div role="note" aria-label="What this is not" className="bg-raised border border-line-strong rounded-control p-2.5 space-y-1" data-state="what-this-is-not">
    <p className="text-xs font-semibold text-fg">What this is not</p>
    <ul className="list-disc pl-4 space-y-0.5 text-xs text-fg-muted">
      <li>Not a calibration: the scale is a literature constant and the hint is conditional on shared cells.</li>
      <li>Not validated: the existing validation evidence (reports/evidence) is tiny and exploratory.</li>
      <li>Not a prediction: it describes detections already received, nothing about future fire.</li>
      <li>Not burned area, fire size or a count of fires.</li>
    </ul>
  </div>
);

export const HarmonizedActivitySection: React.FC<HarmonizedActivitySectionProps> = ({
  modis,
  viirs,
  now,
  includePartial,
  satellites,
  matchedCells = null,
  matchWindowMinutes,
  initialViirsScale = VIIRS_SCALE_DEFAULT,
}) => {
  const headingId = useId();
  const sliderId = useId();
  const gridId = useId();
  const [scale, setScale] = useState<number>(initialViirsScale);
  const [cellKm, setCellKm] = useState<number>(CELL_SIZE_DEFAULT_KM);

  const result: HarmonizedActivityResult | null = useMemo(() => {
    try {
      return computeHarmonizedActivity(modis, viirs, {
        now: now ?? Date.now(),
        includePartial,
        viirsScale: scale,
        cellSizeKm: cellKm,
        matchedCells,
        matchWindowMinutes,
        ...(satellites ? satelliteSelectionToOptions(satellites) : {}),
      });
    } catch {
      return null;
    }
  }, [modis, viirs, now, includePartial, scale, cellKm, matchedCells, matchWindowMinutes, satellites]);

  const maxIndex = result ? Math.max(0, ...result.rows.map((r) => r.index)) : 0;
  const isDefault = scale === VIIRS_SCALE_DEFAULT && cellKm === CELL_SIZE_DEFAULT_KM;
  const defaultPct = ((VIIRS_SCALE_DEFAULT - VIIRS_SCALE_LIMITS.min) / (VIIRS_SCALE_LIMITS.max - VIIRS_SCALE_LIMITS.min)) * 100;

  return (
    <section aria-labelledby={headingId} className="space-y-3" data-state="harmonized-activity">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={headingId} className="text-sm font-semibold text-fg">
          {`Harmonized activity (${EXPLORATORY_LABEL})`}
        </h3>
        <Badge />
      </div>
      <p className="text-xs text-fg-muted">
        Per UTC date: the MODIS and VIIRS detection counts are shown separately. Only the index mixes the sensors, and it is split into three terms so you can see how much of it
        depends on the VIIRS scale.
      </p>

      {/* Controls */}
      <div className="space-y-3">
        <div>
          <div className="flex items-baseline justify-between gap-2">
            <label htmlFor={sliderId} className="text-sm font-medium text-fg">
              VIIRS scale
            </label>
            <span className="numeric text-sm text-fg">{fmt(scale, 2)}</span>
          </div>
          <input
            id={sliderId}
            type="range"
            min={VIIRS_SCALE_LIMITS.min}
            max={VIIRS_SCALE_LIMITS.max}
            step={VIIRS_SCALE_LIMITS.step}
            value={scale}
            aria-valuetext={`${fmt(scale, 2)}${scale === VIIRS_SCALE_DEFAULT ? ' (default)' : ''}`}
            onChange={(e) => setScale(Number(e.target.value))}
            className="w-full h-touch accent-accent cursor-pointer"
          />
          <div className="relative h-5 text-2xs text-fg-subtle numeric">
            <span className="absolute left-0">{VIIRS_SCALE_LIMITS.min}</span>
            <span className="absolute -translate-x-1/2 text-fg whitespace-nowrap" style={{ left: `${defaultPct}%` }} data-marker="default">
              ▲ default {fmt(VIIRS_SCALE_DEFAULT, 3)}
            </span>
            <span className="absolute right-0">{VIIRS_SCALE_LIMITS.max}</span>
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-0">
            <label htmlFor={gridId} className="block text-sm font-medium text-fg">
              Grid cell size
            </label>
            <select
              id={gridId}
              value={cellKm}
              onChange={(e) => setCellKm(Number(e.target.value))}
              className="min-h-touch rounded-control border border-line-strong bg-raised text-fg text-sm px-2 cursor-pointer"
            >
              {CELL_SIZE_OPTIONS_KM.map((k) => (
                <option key={k} value={k}>
                  {k} km{k === CELL_SIZE_DEFAULT_KM ? ' (default)' : ''}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            disabled={isDefault}
            onClick={() => {
              setScale(VIIRS_SCALE_DEFAULT);
              setCellKm(CELL_SIZE_DEFAULT_KM);
            }}
            className="min-h-touch inline-flex items-center gap-2 px-3 rounded-control border border-line-strong bg-raised text-sm font-medium text-fg cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RotateCcw aria-hidden="true" className="h-4 w-4" />
            Reset to default
          </button>
        </div>
        <p className="text-2xs text-fg-subtle" data-state="fixed-parameters">
          Fixed, not adjustable: day bucketing is the UTC date and the cell weights (0.5 / 0.5 / 0.005 in shared cells; 1 / 0.004 in single-sensor cells) are those of
          harmonization.ts, which has no setting for them. The default scale is quoted for 1 km cells; another cell size changes what a cell count means.
        </p>
      </div>

      {/* Results */}
      {!result ? (
        <p role="alert" className="text-sm text-danger" data-state="error">
          Could not compute the harmonized activity for these settings.
        </p>
      ) : (
        <>
          {result.excluded.length > 0 ? (
            <Note>
              <span className="block font-semibold">Partial UTC day(s) excluded from the index</span>
              <ul className="mt-1 space-y-1" data-state="activity-excluded">
                {result.excluded.map((d) => (
                  <li key={d.date}>
                    <span className="numeric font-semibold">{d.date}</span> — <CountChips modis={d.modis} viirs={d.viirs} /> {partialReasonText(d, false)}
                  </li>
                ))}
              </ul>
              <span className="block mt-1">Use the include-partial-day option above to add it back (not recommended).</span>
            </Note>
          ) : null}
          {result.includedPartial.length > 0 ? (
            <Note strong>
              <span className="font-semibold text-danger">Partial day included: do not quote these numbers.</span> The marked date compares unequal observation windows.
            </Note>
          ) : null}
          {result.warnings
            .filter((w) => !/INCLUDED/.test(w))
            .map((w) => (
              <Note key={w}>{w}</Note>
            ))}

          {result.status === 'no_complete_day' ? (
            <div data-state="no-complete-day" className="bg-raised border border-line rounded-card p-3 text-xs text-fg-muted">
              Every UTC date in view is partial, so no index is shown.
            </div>
          ) : result.status === 'empty' ? (
            <div data-state="empty" className="bg-raised border border-line rounded-card p-3 text-xs text-fg-muted">
              No dated detections to summarise in this view.
            </div>
          ) : (
            <div className="space-y-3" data-state="ready">
              <TermLegend />
              <ul className="space-y-2" aria-label="Harmonized activity by UTC date">
                {result.rows.map((r) => (
                  <DateRow key={r.date} row={r} maxIndex={maxIndex} />
                ))}
              </ul>
              <p className="text-2xs text-fg-subtle">Bars share one scale across dates. The number at the right is the index ({EXPLORATORY_LABEL}); the raw counts above each bar are not added.</p>
            </div>
          )}

          <HintBlock hint={result.hint} scale={scale} />
          <SensitivityTable s={result.sensitivity} />
          <details className="text-xs text-fg-muted">
            <summary className="min-h-touch flex items-center cursor-pointer font-semibold text-fg">Method and limitations</summary>
            <p className="mt-1">{result.method}</p>
            <ul className="list-disc pl-4 mt-1 space-y-1">
              {result.limitations.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          </details>
        </>
      )}

      <NotBox />
    </section>
  );
};

export default HarmonizedActivitySection;

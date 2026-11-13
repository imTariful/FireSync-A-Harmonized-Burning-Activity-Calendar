import React, { useState } from 'react';
import { CalibrationModelMetrics } from '../../types/fire';
import { CheckCircle2, AlertCircle } from 'lucide-react';

interface CalibrationDiagnosticChartProps {
  metrics: CalibrationModelMetrics;
  pairedPoints?: { modis: number; viirs: number; date?: string; cell_id?: string }[];
}

export const CalibrationDiagnosticChart: React.FC<CalibrationDiagnosticChartProps> = ({
  metrics,
  pairedPoints,
}) => {
  const chartSize = 320;
  const padding = 45;
  const innerSize = chartSize - padding * 2;
  const points = (pairedPoints ?? []).filter((p) => Number.isFinite(p.modis) && Number.isFinite(p.viirs) && p.modis >= 0 && p.viirs >= 0);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const active = points[Math.min(selectedIndex, Math.max(0, points.length - 1))];
  const hasPoints = points.length > 0;
  const maxVal = points.reduce((max, p) => Math.max(max, p.modis, p.viirs), 1);

  const getX = (viirsRaw: number) => {
    return padding + (viirsRaw / maxVal) * innerSize;
  };

  const getY = (modisObs: number) => {
    // Observed MODIS on Y axis
    return padding + innerSize - (modisObs / maxVal) * innerSize;
  };

  return (
    <div className="bg-surface border border-line rounded-card p-5 shadow-elev-1 space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-line pb-3">
        <div>
          <h4 className="text-sm font-bold text-fg tracking-tight">
            Paired-cell sensor explorer
          </h4>
          <p className="text-2xs text-fg-muted mt-0.5">
            Actual raw counts on shared 1-km cell-days. Tap or focus a point to inspect it; calibration diagnostics remain separate.
          </p>
        </div>
        <div className="flex items-center gap-1.5 font-mono text-xs">
          {metrics.status === 'VALIDATED' ? (
            <span className="badge badge-success inline-flex items-center gap-1.5">
              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="uppercase tracking-wider text-2xs">Validated Specification</span>
            </span>
          ) : (
            <span className="badge badge-amber inline-flex items-center gap-1.5">
              <AlertCircle className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="uppercase tracking-wider text-2xs">{metrics.status} Specification</span>
            </span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-center">
        {/* Scatter Plot */}
        <div className="lg:col-span-5 min-w-0 space-y-3">
          <svg viewBox={`0 0 ${chartSize} ${chartSize}`} className="w-full max-w-[380px] mx-auto select-none" role="img" aria-label="Paired-cell scatter plot: VIIRS raw detections on x, MODIS raw detections on y">
            {/* Background grid */}
            <rect
              x={padding}
              y={padding}
              width={innerSize}
              height={innerSize}
              fill="var(--canvas)"
              stroke="var(--line)"
              rx="4"
            />

            {/* Subtle grid lines */}
            {[0.25, 0.5, 0.75].map((ratio) => (
              <g key={ratio}>
                <line x1={padding + innerSize * ratio} y1={padding} x2={padding + innerSize * ratio} y2={padding + innerSize} stroke="var(--line)" strokeDasharray="2 2" />
                <line x1={padding} y1={padding + innerSize * ratio} x2={padding + innerSize} y2={padding + innerSize * ratio} stroke="var(--line)" strokeDasharray="2 2" />
              </g>
            ))}

            {/* 1:1 Identity reference line */}
            <line x1={padding} y1={padding + innerSize} x2={padding + innerSize} y2={padding} stroke="var(--line-strong)" strokeDasharray="4 3" strokeWidth="1.2" />

            {[0, 0.5, 1].map((fraction) => <g key={fraction}><text x={padding + innerSize * fraction} y={padding + innerSize + 16} textAnchor="middle" fill="var(--fg-muted)" fontSize={10}>{(maxVal * fraction).toLocaleString(undefined, { maximumFractionDigits: 1 })}</text><text x={padding - 8} y={padding + innerSize * (1 - fraction) + 3} textAnchor="end" fill="var(--fg-muted)" fontSize={10}>{(maxVal * fraction).toLocaleString(undefined, { maximumFractionDigits: 1 })}</text></g>)}

            {/* Scatter points — real data only */}
            {hasPoints
              ? points.map((pt, idx) => (
                  <circle
                    key={idx}
                    cx={getX(pt.viirs)}
                    cy={getY(pt.modis)}
                    r={active === pt ? 6 : 3.5}
                    style={{ fill: 'var(--info)' }}
                    stroke="var(--canvas)"
                    strokeWidth="1.5"
                    className="cursor-pointer opacity-75 hover:opacity-100 focus:opacity-100"
                    tabIndex={idx < 100 ? 0 : -1}
                    role="button"
                    aria-label={`Pair ${idx + 1}: MODIS ${pt.modis}, VIIRS ${pt.viirs}${pt.date ? `, ${pt.date}` : ''}`}
                    onPointerEnter={() => setSelectedIndex(idx)} onFocus={() => setSelectedIndex(idx)} onClick={() => setSelectedIndex(idx)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedIndex(idx); } }}
                  ><title>{`MODIS ${pt.modis} · VIIRS ${pt.viirs} · ${pt.date ?? 'date unavailable'}`}</title></circle>
                ))
              : (
                  <text
                    x={chartSize / 2}
                    y={chartSize / 2}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fill="var(--fg-muted)"
                    fontSize="10"
                    fontFamily="monospace"
                  >
                    No paired observations available
                  </text>
                )
            }

            {/* Axis labels */}
            <text x={chartSize / 2} y={chartSize - 6} textAnchor="middle" fill="var(--fg-subtle)" fontSize="9" fontFamily="monospace">
              VIIRS raw detections / cell-day
            </text>
            <text x={-chartSize / 2} y={14} transform="rotate(-90)" textAnchor="middle" fill="var(--fg-subtle)" fontSize="9" fontFamily="monospace">
              Observed MODIS Detections
            </text>
          </svg>
          <p className="text-2xs text-fg-subtle">Dashed diagonal: equal raw counts only, not a fitted regression or equivalent sensor response. Points can overlap.</p>
          {hasPoints && <><label className="block text-xs text-fg-muted">Inspect a paired cell<input aria-label="Inspect paired cell" type="range" min={0} max={points.length - 1} value={Math.min(selectedIndex, points.length - 1)} onChange={(e) => setSelectedIndex(Number(e.target.value))} className="w-full accent-amber-400 mt-2" /></label><div aria-live="polite" className="bg-canvas border border-line p-3 rounded-control text-xs space-y-1"><p className="font-semibold">Pair {Math.min(selectedIndex + 1, points.length)} of {points.length.toLocaleString()} · {active?.date ?? 'date unavailable'}</p><p>MODIS {active?.modis.toLocaleString()} · VIIRS {active?.viirs.toLocaleString()} detections</p>{active?.cell_id && <p className="text-2xs text-fg-subtle break-all">Cell {active.cell_id}</p>}</div></>}
        </div>

        {/* Validation Metric Cards */}
        <div className="lg:col-span-7 space-y-3">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
            {[
              { label: 'MAE', value: metrics.mae, colorClass: 'text-accent' },
              { label: 'RMSE', value: metrics.rmse, colorClass: 'text-fg' },
              { label: 'Mean Bias', value: metrics.mean_bias == null ? null : metrics.mean_bias > 0 ? `+${metrics.mean_bias}` : metrics.mean_bias, colorClass: 'text-info' },
              { label: 'R² Score', value: metrics.r_squared, colorClass: 'text-success' },
            ].map(({ label, value, colorClass }) => (
              <div key={label} className="bg-canvas border border-line rounded-control p-3">
                <div className="text-fg-subtle text-2xs font-mono uppercase tracking-wider">{label}</div>
                <div className={`text-xl font-bold font-mono numeric mt-0.5 ${colorClass}`}>{value ?? 'Unavailable'}</div>
              </div>
            ))}
          </div>

          <div className="bg-canvas border border-line rounded-control p-3.5 space-y-1.5 text-xs">
            {[
              { label: 'Model Algorithm', value: metrics.algorithm, valueClass: 'text-fg font-semibold' },
              { label: 'Mapping Coefficients', value: `Slope = ${metrics.calibration_slope ?? 'unavailable'} · Intercept = ${metrics.calibration_intercept ?? 'unavailable'}`, valueClass: 'text-accent numeric font-mono' },
              { label: 'Paired Cell Sample', value: `N = ${metrics.sample_size_paired_cells}`, valueClass: 'text-fg numeric font-mono' },
            ].map(({ label, value, valueClass }) => (
              <div key={label} className="flex justify-between items-center">
                <span className="text-fg-subtle font-mono text-2xs uppercase tracking-wider">{label}</span>
                <span className={`text-xs ${valueClass}`}>{value}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Limitations footer */}
      <div className="bg-canvas border border-line rounded-control p-3 text-2xs text-fg-muted space-y-1">
        <div className="font-mono text-fg-subtle text-2xs uppercase tracking-wider font-semibold mb-1">
          Scientific Evaluation Notes &amp; Assumptions
        </div>
        <ul className="list-disc pl-4 space-y-0.5">
          {metrics.limitations.map((lim, idx) => (
            <li key={idx}>{lim}</li>
          ))}
        </ul>
      </div>
    </div>
  );
};

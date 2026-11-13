import React, { useId, useState } from 'react';
import { BarChart3, LineChart, ArrowUpRight, Table2 } from 'lucide-react';
import { chartLine, chartMaximum, rankedPeriods, type VisualMetric, type VisualPoint } from '../../utils/dashboardVisuals';

const format = (n: number | null | undefined) => n == null ? 'Unavailable' : n.toLocaleString(undefined, { maximumFractionDigits: 2 });
const compact = (n: number) => Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
const control = 'min-h-11 rounded-control border border-line px-3 py-2 text-xs font-medium transition-colors';
interface Props {
  title: string; description: string; points: VisualPoint[]; metrics: VisualMetric[];
  onInspect?: (point: VisualPoint) => void; inspectLabel?: string;
}

export function InteractiveActivityChart({ title, description, points, metrics, onInspect, inspectLabel = 'Inspect selected period' }: Props) {
  const id = useId();
  const [metricKey, setMetricKey] = useState(metrics[0].key);
  const [mode, setMode] = useState<'line' | 'bars'>('bars');
  const [hidden, setHidden] = useState<string[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [table, setTable] = useState(false);
  const metric = metrics.find((m) => m.key === metricKey) ?? metrics[0];
  const series = metric.series.filter((s) => !hidden.includes(s.key));
  const max = chartMaximum(points, series.map((s) => s.key));
  const activeIndex = Math.max(0, points.findIndex((p) => p.key === activeKey));
  const active = points[activeIndex];
  const ranking = rankedPeriods(points, series[0]?.key ?? '');
  const width = 650, height = 210, left = 56, top = 25, bottom = top + height;
  const x = (i: number) => left + (points.length < 2 ? width / 2 : i / (points.length - 1) * width);
  const knownPeriods = points.filter((p) => series.some((s) => p.values[s.key] != null)).length;
  const selectAt = (event: React.PointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const position = (event.clientX - bounds.left) / bounds.width * 730;
    const i = Math.min(points.length - 1, Math.max(0, Math.round((position - left) / width * (points.length - 1))));
    if (points[i]) setActiveKey(points[i].key);
  };
  return <section aria-label={title} className="bg-surface border border-line rounded-card p-4 sm:p-5 space-y-4 min-w-0 shadow-elev-1">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="space-y-1"><p className="text-2xs uppercase tracking-widest text-accent font-semibold">Explore the observations</p><h3 className="text-base font-bold text-fg">{title}</h3><p className="text-xs text-fg-muted max-w-2xl">{description}</p></div>
      <span className="badge border border-line">{knownPeriods} / {points.length} periods with values</span>
    </div>
    <div className="flex flex-wrap gap-2 items-center">
      <label className="text-xs text-fg-muted">Measure <select aria-label={`${title} measure`} value={metric.key} onChange={(e) => { setMetricKey(e.target.value); setHidden([]); }} className={`${control} bg-canvas text-fg ml-2 max-w-full`}>
        {metrics.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
      </select></label>
      <div role="group" aria-label={`${title} chart style`} className="flex gap-1">{(['bars', 'line'] as const).map((style) => <button type="button" key={style} aria-pressed={mode === style} onClick={() => setMode(style)} className={`${control} flex items-center gap-1.5 ${mode === style ? 'bg-accent text-accent-fg' : 'bg-raised text-fg-muted'}`}>
        {style === 'bars' ? <BarChart3 size={14} /> : <LineChart size={14} />}{style === 'bars' ? 'Bars' : 'Lines'}
      </button>)}</div>
      <button type="button" aria-expanded={table} onClick={() => setTable(!table)} className={`${control} bg-raised text-fg-muted inline-flex items-center gap-1.5`}><Table2 size={14} />{table ? 'Hide data' : 'View data'}</button>
    </div>
    <div role="group" aria-label={`${title} visible series`} className="flex flex-wrap gap-2">{metric.series.map((s) => <button type="button" key={s.key} aria-pressed={!hidden.includes(s.key)} disabled={series.length === 1 && !hidden.includes(s.key)}
      onClick={() => setHidden((previous) => previous.includes(s.key) ? previous.filter((key) => key !== s.key) : [...previous, s.key])}
      className="inline-flex min-h-9 items-center gap-2 px-3 rounded-full bg-canvas border border-line text-xs text-fg disabled:cursor-default" style={{ opacity: hidden.includes(s.key) ? 0.45 : 1 }}><span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: s.color }} />{s.label}</button>)}<span className="self-center text-2xs text-fg-subtle">Select a legend to hide/show a series.</span></div>
    {!points.length || !knownPeriods ? <div className="rounded-control border border-dashed border-line p-8 text-center text-sm text-fg-muted">No available values for this selection. Change the area, dates or measure.</div> : <>
      <div className="overflow-x-auto rounded-control bg-canvas/50 border border-line"><svg viewBox="0 0 730 280" className="w-full min-w-[480px] h-auto" role="img" aria-labelledby={`${id}-title ${id}-desc`} onPointerMove={selectAt} onPointerDown={selectAt}>
        <title id={`${id}-title`}>{`${title} — ${metric.label}`}</title><desc id={`${id}-desc`}>{`Inspect dates with the slider below. Missing values are gaps, not zeros. Values use ${metric.unit}.`}</desc>
        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => <g key={ratio}><line x1={left} x2={left + width} y1={bottom - ratio * height} y2={bottom - ratio * height} stroke="var(--line)" strokeDasharray="3 5" /><text x={left - 8} y={bottom - ratio * height + 4} textAnchor="end" fill="var(--fg-muted)" fontSize={10}>{compact(max * ratio)}</text></g>)}
        <text x={left} y={14} fill="var(--fg-muted)" fontSize={10}>{metric.unit}</text>
        <line x1={x(activeIndex)} x2={x(activeIndex)} y1={top} y2={bottom} stroke="var(--fg-muted)" strokeDasharray="3 3" opacity={0.5} />
        {series.map((s, si) => <g key={s.key}>
          {mode === 'line' && <path transform={`translate(${left},${top})`} d={chartLine(points.map((p) => p.values[s.key]), max, width, height)} stroke={s.color} strokeWidth={2.5} fill="none" />}
          {points.map((p, i) => {
            const value = p.values[s.key];
            if (value == null) return null;
            const y = bottom - value / max * height, barWidth = Math.max(0.7, Math.min(28, width / Math.max(points.length, 2) * 0.65 / series.length));
            return mode === 'bars' ? <rect key={p.key} x={x(i) + (si - series.length / 2) * barWidth} y={y} width={barWidth - Math.min(2, barWidth / 4)} height={Math.max(value === 0 ? 1.5 : 0, bottom - y)} fill={s.color} opacity={i === activeIndex ? 1 : 0.65} rx={Math.min(2, barWidth / 4)}><title>{`${p.label}: ${s.label} ${format(value)} ${metric.unit}`}</title></rect>
              : <circle key={p.key} cx={x(i)} cy={y} r={i === activeIndex ? 4.5 : points.length > 80 ? 1.5 : 3} fill={s.color}><title>{`${p.label}: ${s.label} ${format(value)} ${metric.unit}`}</title></circle>;
          })}
        </g>)}
        {points.map((p, i) => (i === 0 || i === points.length - 1 || i % Math.ceil(points.length / 6) === 0) && <text key={p.key} x={x(i)} y={260} fill="var(--fg-muted)" fontSize={10} textAnchor="middle">{/^\d{4}-\d{2}-\d{2}$/.test(p.label) ? p.label.slice(5) : p.label}</text>)}
      </svg></div>
      <label className="block text-xs text-fg-muted">Inspect period <span className="font-mono text-fg ml-2">{active?.label}</span><input aria-label={`${title} inspect period`} type="range" min={0} max={Math.max(0, points.length - 1)} step={1} value={activeIndex} onChange={(e) => setActiveKey(points[Number(e.target.value)].key)} className="w-full mt-2 accent-amber-400" /></label>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2" aria-live="polite">{metric.series.map((s) => <div key={s.key} className="bg-canvas border border-line rounded-control p-3 border-l-[3px]" style={{ borderLeftColor: s.color }}><p className="text-2xs text-fg-muted">{s.label} · {active?.label}</p><p className="text-xl font-bold numeric mt-1">{format(active?.values[s.key])}<span className="text-2xs font-normal text-fg-muted ml-2">{metric.unit}</span></p></div>)}</div>
      {active?.note && <p className="text-2xs text-fg-muted">{active.note}</p>}
      {onInspect && active && <button type="button" disabled={!metric.series.some((s) => active.values[s.key] != null)} onClick={() => onInspect(active)} className={`${control} bg-raised text-accent inline-flex items-center gap-2 disabled:opacity-50`}>{inspectLabel}<ArrowUpRight size={14} /></button>}
      {ranking.length > 1 && <div className="border-t border-line pt-3"><p className="text-2xs text-fg-subtle mb-2">Most active available periods · {series[0]?.label} · {metric.unit}</p><div className="flex flex-wrap gap-2">{ranking.map((p, i) => <button type="button" key={p.key} onClick={() => setActiveKey(p.key)} className="text-xs bg-raised border border-line rounded-control p-2 hover:border-accent"><span className="text-accent mr-2">0{i + 1}</span>{p.label}<span className="text-fg-muted ml-2">{format(p.values[series[0].key])}</span></button>)}</div></div>}
    </>}
    {table && <div className="overflow-x-auto max-h-72"><table className="w-full text-xs text-left"><caption className="text-left text-fg-muted mb-2">Available input values · {metric.unit}</caption><thead><tr><th className="p-2">Period</th>{metric.series.map((s) => <th className="p-2" key={s.key}>{s.label}</th>)}</tr></thead><tbody>{points.map((p) => <tr key={p.key} className="border-t border-line"><td className="p-2 font-mono whitespace-nowrap">{p.label}</td>{metric.series.map((s) => <td key={s.key} className="p-2 numeric">{format(p.values[s.key])}</td>)}</tr>)}</tbody></table></div>}
    <p className="text-2xs text-fg-subtle leading-relaxed">{metric.note} Gaps mean unavailable records; a measured zero is shown at the axis. No interpolation, predictions or burned-area estimates.</p>
  </section>;
}

/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Download, Grid3x3, Info, Layers, Map as MapIcon } from 'lucide-react';
import {
  agniApi,
  type AgniCellRow,
  type AgniDayNight,
  type AgniFireType,
  type AgniLayer,
  type AgniMonthRow,
  type AgniStatus,
} from '../api/agnicalendar';
import { FIRE_LEGEND } from '../types/ai';
import { MonthlyActivityExplorer } from '../components/calendar/MonthlyActivityExplorer';
import {
  overlayBounds,
  type AnalysisOverlay,
  type OverlayFeatureCollection,
} from '../utils/geoOverlays';

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

interface RegionPreset {
  id: string;
  label: string;
  bbox?: string; // west,south,east,north — undefined = global
}

const REGIONS: RegionPreset[] = [
  { id: 'global', label: 'Global' },
  { id: 'amazon', label: 'Amazon Basin', bbox: '-75,-15,-50,5' },
  { id: 'australia', label: 'Australia', bbox: '110,-45,155,-10' },
  { id: 'seasia', label: 'SE Asia / Indonesia', bbox: '95,-12,140,8' },
  { id: 'congo', label: 'Congo Basin', bbox: '10,-15,30,5' },
  { id: 'california', label: 'California', bbox: '-125,32,-114,42' },
  { id: 'mediterranean', label: 'Mediterranean', bbox: '-10,30,40,50' },
];

const LAYERS: Array<{ id: AgniLayer; label: string; hint: string }> = [
  { id: 'aqua', label: 'MODIS Aqua counts', hint: 'Original Aqua detection counts — reference layer.' },
  { id: 'snpp', label: 'VIIRS SNPP counts', hint: 'Original Suomi-NPP detection counts (from Jan 2012).' },
  { id: 'harmonized', label: 'Harmonized estimates', hint: 'RF-B Aqua-scale estimates on approved joint-positive support only — not a complete corrected VIIRS series.' },
];

const DAYNIGHTS: Array<{ id: AgniDayNight; label: string }> = [
  { id: 'known', label: 'Day + Night' },
  { id: 'day', label: 'Day only' },
  { id: 'night', label: 'Night only' },
  { id: 'unknown', label: 'Unknown DN' },
];

const FIRE_TYPES: Array<{ id: AgniFireType; label: string }> = [
  { id: '0', label: "Type 0 — presumed vegetation (source-reported)" },
  { id: '1', label: 'Type 1 — volcano' },
  { id: '2', label: 'Type 2 — other static source' },
  { id: '3', label: 'Type 3 — offshore' },
  { id: 'all', label: 'All fire types' },
];

/**
 * AgniCalendar page: descriptive month x year calendar of satellite-detected
 * activity on the 10 km harmonized grid. Missing cells are unavailable data,
 * never confirmed fire-free months. Not a forecast.
 */
export const AgniCalendarPage: React.FC<{ onShowOverlay?: (overlay: AnalysisOverlay) => void; mapScope?: { bbox?: string; aoi?: string }; mapAreaName?: string }> = ({
  onShowOverlay,
  mapScope,
  mapAreaName,
}) => {
  const [status, setStatus] = useState<AgniStatus | null>(null);
  const [countries, setCountries] = useState<string[]>([]);
  const [country, setCountry] = useState('');
  const [region, setRegion] = useState(REGIONS[0]);
  const [layer, setLayer] = useState<AgniLayer>('aqua');
  const [daynight, setDaynight] = useState<AgniDayNight>('known');
  const [fireType, setFireType] = useState<AgniFireType>('0');
  const [rows, setRows] = useState<AgniMonthRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ year: number; month: number } | null>(null);
  const [cells, setCells] = useState<AgniCellRow[]>([]);
  const [cellsLoading, setCellsLoading] = useState(false);
  const [mapLoading, setMapLoading] = useState(false);
  const valueLabel = layer === 'harmonized' ? 'estimated Aqua-equivalent detections (EXPLORATORY)' : 'observed detections';
  const [useMapArea, setUseMapArea] = useState(Boolean(mapScope));
  const [startYear, setStartYear] = useState(2002);
  const [endYear, setEndYear] = useState(2025);
  const [intelligence, setIntelligence] = useState<Awaited<ReturnType<typeof agniApi.intelligence>> | null>(null);
  const [comparison, setComparison] = useState<Awaited<ReturnType<typeof agniApi.comparison>> | null>(null);
  const [provenance, setProvenance] = useState<Awaited<ReturnType<typeof agniApi.provenance>> | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  useEffect(() => {
    agniApi.status().then(setStatus).catch(() => setStatus(null));
    agniApi.countries().then((d) => setCountries(d.countries)).catch(() => setCountries([]));
    agniApi.provenance().then(setProvenance).catch(() => setProvenance(null));
  }, []);

  const params = useMemo(
    () => ({
      layer,
      daynight,
      fire_type: fireType,
      country: useMapArea ? undefined : country || undefined,
      // A country selection overrides the region bbox (majority-vote cell mapping).
      bbox: useMapArea ? (mapScope?.aoi ? undefined : mapScope?.bbox) : country ? undefined : region.bbox,
      aoi: useMapArea ? mapScope?.aoi : undefined,
      start_year: startYear,
      end_year: endYear,
    }),
    [layer, daynight, fireType, country, region, useMapArea, mapScope?.bbox, mapScope?.aoi, startYear, endYear]
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setRows([]);
    setSelected(null);
    setError(null);
    agniApi
      .calendar(params)
      .then((d) => {
        if (!cancelled) setRows(d.rows);
      })
      .catch((e: Error) => {
        if (!cancelled) {
          setRows([]);
          setError(e.message);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [params]);

  useEffect(() => {
    if (!selected) { setIntelligence(null); setComparison(null); return; }
    let cancelled = false;
    setIntelligence(null); setComparison(null); setDetailError(null);
    Promise.all([agniApi.intelligence({ ...params, year: selected.year }), agniApi.comparison({ ...params, ...selected })])
      .then(([i, c]) => { if (!cancelled) { setIntelligence(i); setComparison(c); } })
      .catch((e: Error) => { if (!cancelled) setDetailError(e.message); });
    return () => { cancelled = true; };
  }, [selected, params]);

  useEffect(() => {
    if (!selected) {
      setCells([]);
      return;
    }
    let cancelled = false;
    setCellsLoading(true);
    agniApi
      .cells({ ...params, year: selected.year, month: selected.month, limit: 15 })
      .then((d) => {
        if (!cancelled) setCells(d.rows);
      })
      .catch((e: Error) => {
        if (!cancelled) { setCells([]); setDetailError(e.message); }
      })
      .finally(() => {
        if (!cancelled) setCellsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selected, params]);

  // Pivot rows into year -> month -> row for the heatmap.
  const { years, grid, maxValue } = useMemo(() => {
    const byYear = new Map<number, Map<number, AgniMonthRow>>();
    let max = 0;
    for (const r of rows) {
      if (!byYear.has(r.year)) byYear.set(r.year, new Map());
      byYear.get(r.year)!.set(r.month, r);
      if (r.detections != null && r.detections > max) max = r.detections;
    }
    const ys = Array.from({ length: Math.max(0, endYear - startYear + 1) }, (_, i) => startYear + i);
    const g = ys.map((y) => ({
      year: y,
      months: MONTH_NAMES.map((_, i) => byYear.get(y)?.get(i + 1) ?? null),
    }));
    return { years: ys, grid: g, maxValue: max };
  }, [rows, startYear, endYear]);

  const intensity = (v: number | null | undefined) => {
    if (v == null || maxValue <= 0) return 0;
    return Math.min(1, Math.log1p(v) / Math.log1p(maxValue));
  };

  const showOnMap = async () => {
    if (!selected || !onShowOverlay) return;
    setMapLoading(true);
    try {
      const d = await agniApi.cellsGeoJson({ ...params, year: selected.year, month: selected.month, limit: 2000 });
      const geojson: OverlayFeatureCollection = {
        type: 'FeatureCollection',
        features: d.features.map((f) => ({
          type: 'Feature' as const,
          geometry: f.geometry,
          properties: { ...f.properties, overlay_kind: 'agnicells' },
        })),
        metadata: {
          kind: 'agnicells',
          title: `AgniCalendar cells ${selected.year}-${String(selected.month).padStart(2, '0')}`,
          legend: FIRE_LEGEND,
          sensors_kept_separate: true,
          feature_count: d.features.length,
          skipped_geometry: 0,
          note: 'Top cells by detection count for one UTC month on the 10 km harmonized grid. Cell polygons approximate grid boundaries — detection aggregates, not fire perimeters or burned area.',
        },
      };
      const ym = `${selected.year}-${String(selected.month).padStart(2, '0')}`;
      const csv = [
        '# AgniCalendar cell overlay',
        `# year,${selected.year}`,
        `# month,${selected.month}`,
        `# layer,${d.layer}`,
        `# daynight,${d.daynight}`,
        `# fire_type,${d.fire_type}`,
        `# truncated,${d.truncated}`,
        `# ${FIRE_LEGEND}`,
        'cell_id,center_lat,center_lon,detections,frp_sum_mw',
        ...d.features.map((f) =>
          [
            f.properties.cell_id,
            f.properties.center_lat,
            f.properties.center_lon,
            f.properties.detections,
            f.properties.frp_sum_mw,
          ]
            .map((v) => (v == null ? '' : String(v).replace(/"/g, '""')))
            .join(',')
        ),
      ].join('\n');
      onShowOverlay({
        kind: 'agnicells',
        title: `AgniCalendar ${ym} (${d.features.length} cells${d.truncated ? '+' : ''})`,
        description: `${d.features.length} top 10 km grid cell(s) by detection count for ${ym} (${d.layer}/${d.daynight}, fire_type ${d.fire_type}${d.truncated ? '; result capped — more cells exist' : ''}). Detection aggregates, not fire perimeters.`,
        geojson,
        csv,
        bounds: overlayBounds(geojson),
        notes: [
          FIRE_LEGEND,
          'AgniCalendar harmonized grid: 10 km EPSG:8857 cells x UTC month. Missing cell-months are unavailable data, not zero fire.',
          d.truncated ? 'Overlay shows the top cells only; additional active cells exist beyond the cap.' : 'All cells returned for this scope/month are drawn.',
        ],
      });
    } finally {
      setMapLoading(false);
    }
  };

  const selectCls =
    'bg-raised border border-line rounded-control px-2.5 py-1.5 text-xs text-fg focus:outline-none focus:ring-1 focus:ring-accent';

  return (
    <div className="space-y-6 page-enter">
      {/* Header */}
      <div className="bg-surface border border-line rounded-card p-5 sm:p-6">
        <div className="flex items-start gap-3">
          <div className="h-9 w-9 rounded-control bg-gradient-to-br from-violet-500 to-fuchsia-500 flex items-center justify-center shrink-0">
            <Grid3x3 className="h-4.5 w-4.5 text-white" aria-hidden="true" />
          </div>
          <div className="space-y-1">
            <h2 className="text-base font-bold text-fg tracking-tight">AgniCalendar — Harmonized Fire Calendar</h2>
            <p className="text-xs text-fg-muted max-w-3xl">
              Monthly satellite-detection activity on the 10 km harmonized grid (EPSG:8857), 2002–2025.
              A descriptive calendar of detected activity — <span className="text-fg">not a forecast</span>.
              Grey cells are unavailable data, not confirmed fire-free months.
            </p>
          </div>
        </div>
      </div>

      {/* Controls */}
      <div className="bg-surface border border-line rounded-card p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-2xs font-semibold text-fg-muted uppercase tracking-wide" htmlFor="agni-country">Country</label>
          <select id="agni-country" className={selectCls} value={country} onChange={(e) => { setCountry(e.target.value); setUseMapArea(false); }}>
            <option value="">— region bbox —</option>
            {countries.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>

          <label className="text-2xs font-semibold text-fg-muted uppercase tracking-wide" htmlFor="agni-region">Region</label>
          <select id="agni-region" className={selectCls} value={region.id} disabled={Boolean(country) || useMapArea} onChange={(e) => setRegion(REGIONS.find((r) => r.id === e.target.value) ?? REGIONS[0])}>
            {REGIONS.map((r) => (
              <option key={r.id} value={r.id}>{r.label}</option>
            ))}
          </select>

          <label className="text-2xs font-semibold text-fg-muted uppercase tracking-wide" htmlFor="agni-layer">Layer</label>
          <select id="agni-layer" className={selectCls} value={layer} onChange={(e) => setLayer(e.target.value as AgniLayer)}>
            {LAYERS.map((l) => (
              <option key={l.id} value={l.id}>{l.label}</option>
            ))}
          </select>

          <label className="text-2xs font-semibold text-fg-muted uppercase tracking-wide" htmlFor="agni-dn">Day/Night</label>
          <select id="agni-dn" className={selectCls} value={daynight} onChange={(e) => setDaynight(e.target.value as AgniDayNight)}>
            {DAYNIGHTS.map((d) => (
              <option key={d.id} value={d.id}>{d.label}</option>
            ))}
          </select>

          <label className="text-2xs font-semibold text-fg-muted uppercase tracking-wide" htmlFor="agni-ft">Fire type</label>
          <select id="agni-ft" className={selectCls} value={fireType} onChange={(e) => setFireType(e.target.value as AgniFireType)}>
            {FIRE_TYPES.map((f) => (
              <option key={f.id} value={f.id}>{f.label}</option>
            ))}
          </select>

          <a
            href={agniApi.exportUrl(params)}
            className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-control bg-accent hover:bg-accent-hover text-accent-fg text-xs font-semibold transition-colors"
          >
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
            Export CSV
          </a>
        </div>
        <p className="text-2xs text-fg-subtle flex items-center gap-1.5">
          <Layers className="h-3 w-3" aria-hidden="true" />
          {LAYERS.find((l) => l.id === layer)?.hint}
        </p>
      </div>

      {/* Status strip */}
      <div className="bg-surface border border-line rounded-card p-4 flex flex-wrap items-center gap-3 text-xs">
        {mapScope && <label><input type="checkbox" checked={useMapArea} onChange={(e) => setUseMapArea(e.target.checked)} /> Use map AOI: {mapAreaName ?? 'Selected area'}</label>}
        <label>From year <input aria-label="Agni start year" className="bg-canvas border border-line rounded-control p-1 w-20" type="number" min={2002} max={endYear} value={startYear} onChange={(e) => { const n = Number(e.target.value); if (n >= 2002 && n <= endYear) setStartYear(n); }} /></label>
        <label>To year <input aria-label="Agni end year" className="bg-canvas border border-line rounded-control p-1 w-20" type="number" min={startYear} max={2025} value={endYear} onChange={(e) => { const n = Number(e.target.value); if (n >= startYear && n <= 2025) setEndYear(n); }} /></label>
        <p>UTC-month grain. AOI uses grid-cell centres; country uses majority-vote lookup. Counts do not measure complete satellite coverage.</p>
      </div>
      {status?.available && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: 'Rows', value: status.rows?.toLocaleString() ?? '—' },
            { label: 'Coverage', value: `${status.min_month ?? '—'} → ${status.max_month ?? '—'}` },
            { label: 'Grid', value: '10 km · EPSG:8857' },
            { label: 'Layer from', value: status.layers[layer]?.available_from ?? '—' },
          ].map((s) => (
            <div key={s.label} className="stat-card">
              <div className="text-2xs text-fg-muted uppercase tracking-wide">{s.label}</div>
              <div className="text-sm font-bold text-fg numeric mt-0.5">{s.value}</div>
            </div>
          ))}
        </div>
      )}

      {!loading && !error && <MonthlyActivityExplorer rows={rows} startYear={startYear} endYear={endYear} layer={layer} onInspect={setSelected} />}

      {/* Heatmap */}
      <section className="bg-surface border border-line rounded-card p-5 space-y-3" aria-label="Month year activity calendar">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-fg">Month × year activity</h3>
          <span className="text-2xs text-fg-muted">
            {loading ? 'Loading…' : `${rows.length} month records · click a cell for top grid cells`}
          </span>
        </div>
        {error && <p className="text-xs text-danger">{error}</p>}
        {!error && (
          <div className="overflow-x-auto">
            <table className="w-full border-separate" style={{ borderSpacing: 2 }}>
              <thead>
                <tr>
                  <th className="text-2xs text-fg-muted text-left pr-2 w-10">Mo</th>
                  {grid.map((g) => (
                    <th key={g.year} className="text-2xs text-fg-muted font-medium">{String(g.year).slice(2)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {MONTH_NAMES.map((name, mi) => (
                  <tr key={name}>
                    <td className="text-2xs text-fg-muted pr-2">{name}</td>
                    {grid.map((g) => {
                      const cell = g.months[mi];
                      const v = cell?.detections ?? null;
                      const isSel = selected?.year === g.year && selected?.month === mi + 1;
                      return (
                        <td key={g.year}>
                          <button
                            type="button"
                            disabled={loading || !cell}
                            title={
                              cell
                                ? `${g.year}-${String(mi + 1).padStart(2, '0')}: ${v?.toLocaleString(undefined, { maximumFractionDigits: 1 }) ?? '—'} ${valueLabel} · ${cell.cells_with_data.toLocaleString()} cells${cell.partial_coverage ? ' · partial coverage' : ''}`
                                : `${g.year}-${String(mi + 1).padStart(2, '0')}: no data (unavailable, not zero)`
                            }
                            onClick={() => cell && setSelected(isSel ? null : { year: g.year, month: mi + 1 })}
                            className={`h-7 w-full min-w-6 rounded-sm transition-transform ${isSel ? 'ring-2 ring-accent scale-105' : 'hover:scale-105'} ${
                              v == null ? 'bg-raised/60' : ''
                            }`}
                            style={
                              v == null
                                ? undefined
                                : {
                                    backgroundColor: `rgba(245, 158, 11, ${0.12 + 0.75 * intensity(v)})`,
                                  }
                            }
                            aria-label={`${g.year} ${name}: ${v == null ? 'no data' : `${v.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${valueLabel}`}`}
                          >
                            {cell?.partial_coverage && v != null && (
                              <span className="text-[8px] text-fg-subtle">◦</span>
                            )}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-2xs text-fg-subtle">
          Intensity = log-scaled detection sum for the selected layer/day-night/fire-type. ◦ marks partial coverage (Jan 2012 SNPP/harmonized).
        </p>
      </section>

      {selected && <section className="bg-surface border border-line rounded-card p-5 space-y-3" aria-label="Historical baseline comparison">
        <h3 className="text-sm font-bold">Historical monthly comparison — {selected.year}-{String(selected.month).padStart(2, '0')}</h3>
        {detailError && <p role="alert" className="text-danger text-xs">{detailError}</p>}
        {!intelligence && !detailError && <p className="text-xs">Loading historical comparison…</p>}
        {intelligence && <>
          <p className="text-xs">{intelligence.method}</p><p className="text-xs text-fg-muted">{intelligence.limitation}</p>
          {intelligence.comparisons.filter((c) => c.month === selected.month).map((c) => <div key={c.month} className="text-sm space-y-1">
            <p>Selected {layer === 'harmonized' ? 'estimate' : 'observations'}: {c.observed?.toLocaleString() ?? 'Unknown'} · Historical median: {c.baseline_median?.toLocaleString() ?? 'Unavailable'}</p>
            <p>Baseline years: {c.baseline_years.join(', ') || 'None'} · n={c.valid_years} · Percentile: {c.percentile?.toFixed(1) ?? 'Unavailable'} · {c.status.replaceAll('_', ' ')}</p>
          </div>)}
          <p className="text-xs">Historically most active months (target year excluded): {intelligence.season.peak_months.map((m) => MONTH_NAMES[m - 1]).join(', ') || 'Insufficient history'}</p>
          <div className="overflow-x-auto"><table className="w-full text-xs"><caption>Year-to-year, selected calendar month; missing is unknown</caption><thead><tr><th>Year</th><th>{layer === 'harmonized' ? 'Estimate' : 'Detections'}</th><th>Observed cells</th></tr></thead><tbody>{rows.filter((r) => r.month === selected.month).map((r) => <tr key={r.year}><td>{r.year}</td><td>{r.detections?.toLocaleString() ?? 'Unknown'}</td><td>{r.cells_with_data}</td></tr>)}</tbody></table></div>
        </>}
      </section>}
      {comparison && <section className="bg-surface border border-line rounded-card p-5 space-y-3" aria-label="Harmonization comparison">
        <h3 className="text-sm font-bold">Harmonized Historical Data — EXPLORATORY conditional estimates</h3>
        <p className="text-xs">{comparison.note}</p>
        <div className="overflow-x-auto"><table className="w-full text-xs"><thead><tr><th>DN</th><th>Aqua all</th><th>SNPP all</th><th>Aqua supported</th><th>SNPP supported</th><th>Aqua-equivalent estimate</th><th>Supported rows</th></tr></thead><tbody>{comparison.rows.map((r) => <tr key={r.daynight}>{[r.daynight, r.aqua_all_observed, r.snpp_all_observed, r.aqua_supported, r.snpp_supported, r.aqua_equivalent_estimate, `${r.supported_cell_month_types}/${r.source_cell_month_types}`].map((v, i) => <td className="p-2" key={i}>{v == null ? 'Unknown' : typeof v === 'number' ? v.toLocaleString(undefined, { maximumFractionDigits: 1 }) : v}</td>)}</tr>)}</tbody></table></div>
        {comparison.rows.map((r) => <p key={r.daynight} className="text-2xs text-fg-muted">{r.daynight}: FRP MW Aqua {r.aqua_frp_sum_mw?.toLocaleString() ?? 'Unknown'}; SNPP {r.snpp_frp_sum_mw?.toLocaleString() ?? 'Unknown'}. Versions Aqua {r.aqua_versions || 'UNKNOWN'}; SNPP {r.snpp_versions || 'UNKNOWN'}. Product status {r.product_status || 'UNKNOWN'}. Quality {r.quality_flags || 'No reported flag'}.</p>)}
      </section>}
      <section className="bg-surface border border-line rounded-card p-5 space-y-2 text-xs" aria-label="Model provenance">
        <h3 className="text-sm font-bold">Model provenance and sensor availability</h3>
        <p>Model: {provenance?.model_id ?? 'Unavailable'} · Reference {provenance?.reference_sensor ?? 'UNKNOWN'} · Predictor {provenance?.predictor_sensor ?? 'UNKNOWN'} · Training years {provenance?.training_years?.join(', ') ?? 'UNKNOWN'}</p>
        <p className="break-all">Artifact pair SHA-256: {provenance?.model_pair_sha256 ?? 'Unavailable'}</p>
        <p>{provenance?.reason ?? 'Provenance could not be loaded; no validation metrics claimed.'}</p>
        <p>{status && Object.entries(status.layers).map(([name, l]) => `${name}: from ${l.available_from ?? 'unavailable'}`).join(' · ')}</p>
        <p>No Terra, NOAA20/21 or NRT inference. {FIRE_LEGEND}</p>
      </section>
      {/* Top cells for selected month */}
      {selected && (
        <section className="bg-surface border border-line rounded-card p-5 space-y-3">
          <h3 className="text-sm font-bold text-fg flex items-center gap-2">
            Top cells — {selected.year}-{String(selected.month).padStart(2, '0')}
            <a className="text-xs text-accent underline" href={agniApi.cellMonthExportUrl({ ...params, ...selected })}>Export all selected cell-month aggregates</a>
            {onShowOverlay && (
              <button
                type="button"
                onClick={() => void showOnMap()}
                disabled={mapLoading}
                className="ml-auto inline-flex items-center gap-1.5 rounded-control border border-line bg-raised px-2.5 py-1 text-2xs font-semibold text-fg-muted hover:text-fg disabled:opacity-50"
                title="Draw the top cells for this month on the map"
              >
                <MapIcon className="h-3.5 w-3.5" aria-hidden="true" />
                {mapLoading ? 'Loading…' : 'Show on map'}
              </button>
            )}
          </h3>
          {cellsLoading ? (
            <p className="text-xs text-fg-muted">Loading cells…</p>
          ) : cells.length === 0 ? (
            <p className="text-xs text-fg-muted">No supported cells for this selection.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-2xs text-fg-muted uppercase tracking-wide">
                    <th className="py-1.5 pr-3">Cell</th>
                    <th className="py-1.5 pr-3">Lat, Lon</th>
                    <th className="py-1.5 pr-3 text-right">{layer === 'harmonized' ? 'Aqua-equivalent estimate (EXPLORATORY)' : 'Observed detections'}</th>
                    <th className="py-1.5 text-right">FRP sum (MW)</th>
                  </tr>
                </thead>
                <tbody>
                  {cells.map((c) => (
                    <tr key={c.cell_id} className="border-t border-line/60">
                      <td className="py-1.5 pr-3 font-mono text-2xs text-fg-muted">{c.cell_id}</td>
                      <td className="py-1.5 pr-3 numeric">{c.lat.toFixed(2)}, {c.lon.toFixed(2)}</td>
                      <td className="py-1.5 pr-3 text-right font-semibold text-fg numeric">{c.value?.toLocaleString(undefined, { maximumFractionDigits: 1 }) ?? '—'}</td>
                      <td className="py-1.5 text-right text-fg-muted numeric">{c.frp_sum_mw != null ? c.frp_sum_mw.toLocaleString(undefined, { maximumFractionDigits: 0 }) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* Caveats */}
      <section className="bg-surface border border-line rounded-card p-5 space-y-2">
        <div className="flex items-center gap-2">
          <Info className="h-4 w-4 text-accent" aria-hidden="true" />
          <h3 className="text-sm font-bold text-fg">How to read this calendar</h3>
        </div>
        <ul className="list-disc list-inside space-y-1 text-2xs text-fg-muted">
          {(status?.caveats ?? [
            'Satellite thermal anomaly detection counts, not unique fires, burned area or ground truth.',
            'NULL/missing means unavailable data — never a verified zero.',
            'DAY, NIGHT and UNKNOWN-DN are reported separately.',
            'Harmonized estimates are model outputs on approved support only.',
            'Descriptive calendar of satellite-detected activity — not a forecast.',
          ]).map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      </section>
    </div>
  );
};

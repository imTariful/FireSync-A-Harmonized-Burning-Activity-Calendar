/**
 * Geographic Analysis workspace.
 *
 * Real computations only: density per 1000 km², candidate hotspot clusters, per-day coverage and
 * region-normalised comparison. Capabilities that need a dataset this deployment does not ship
 * (land cover, terrain, population, borders) are listed as unavailable — never as zero results.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Globe2, Loader2, AlertTriangle, FileText, Download, Layers, MapPinned, Sparkles } from 'lucide-react';
import {
  intelligenceApi,
  type ClustersResponse,
  type CoverageResponse,
  type DatasetStatusResponse,
  type DensityResponse,
  type RegionsResponse,
  type ReportResponse,
  type CompareResponse,
  type WeatherResponse,
} from '../api/intelligence';
import { STUDY_REGIONS } from '../utils/spatial';
import { api } from '../api/client';
import { FIRE_LEGEND } from '../types/ai';
import {
  buildClusterOverlay,
  buildDensityOverlay,
  type AnalysisOverlay,
} from '../utils/geoOverlays';
import type { GeographicLayerId } from '../utils/aiFeatureCatalog';
import { HistoricalCountryRankings } from '../components/geo/HistoricalCountryRankings';
import { SeasonalRiskCard } from '../components/seasonal/SeasonalRiskCard';

interface Props {
  bbox: string;
  sensors: 'ALL' | 'MODIS' | 'VIIRS';
  startDate: string;
  endDate: string;
  days: number;
  areaName: string;
  /** Hand a server-derived overlay to the existing map. Geometry is never built anywhere else. */
  onShowOverlay?: (overlay: AnalysisOverlay) => void;
  /** Deep link from the AI Intelligence hub. */
  initialLayer?: GeographicLayerId;
  /** Increment to scroll the report section into view. */
  focusReportRequest?: number;
  /** Called after a report-focus request has been handled, so it is not repeated later. */
  onReportFocusHandled?: () => void;
}

type LayerId = GeographicLayerId;

const LAYERS: Array<{ id: LayerId; label: string }> = [
  { id: 'density', label: 'Detection density' },
  { id: 'clusters', label: 'Candidate clusters' },
  { id: 'coverage', label: 'Coverage' },
  { id: 'regions', label: 'Region comparison' },
  { id: 'compare', label: 'What changed' },
  { id: 'weather', label: 'Weather & fire' },
];

export const GeographicAnalysisPage: React.FC<Props> = ({
  bbox,
  sensors,
  startDate,
  endDate,
  days,
  areaName,
  onShowOverlay,
  initialLayer,
  focusReportRequest,
  onReportFocusHandled,
}) => {
  const [layer, setLayer] = useState<LayerId>(initialLayer ?? 'density');
  const reportRef = useRef<HTMLElement>(null);
  const [density, setDensity] = useState<DensityResponse | null>(null);
  const [clusters, setClusters] = useState<ClustersResponse | null>(null);
  const [coverage, setCoverage] = useState<CoverageResponse | null>(null);
  const [regions, setRegions] = useState<RegionsResponse | null>(null);
  const [comparison, setComparison] = useState<CompareResponse | null>(null);
  const [weather, setWeather] = useState<WeatherResponse | null>(null);
  const [daysA, setDaysA] = useState(1);
  const [daysB, setDaysB] = useState(1);
  const [datasets, setDatasets] = useState<DatasetStatusResponse | null>(null);
  const [report, setReport] = useState<ReportResponse | null>(null);
  const [explanation, setExplanation] = useState<{ text: string | null; reason: string | null } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [language, setLanguage] = useState<'en' | 'bn'>('en');

  useEffect(() => {
    intelligenceApi
      .datasets()
      .then(setDatasets)
      .catch(() => setDatasets(null));
  }, []);

  useEffect(() => {
    if (initialLayer) setLayer(initialLayer);
  }, [initialLayer]);

  useEffect(() => {
    if (!focusReportRequest) return;
    reportRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    onReportFocusHandled?.();
    // The callback is intentionally not a dependency: it only acknowledges this one-shot request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusReportRequest]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setExplanation(null);
    try {
      if (layer === 'density') {
        setDensity(await intelligenceApi.density(bbox, days, sensors));
      } else if (layer === 'clusters') {
        setClusters(await intelligenceApi.clusters(bbox, days, sensors));
      } else if (layer === 'coverage') {
        setCoverage(await intelligenceApi.coverage(bbox, days));
      } else if (layer === 'compare') {
        if (daysA + daysB > 5) {
          setComparison(null);
          setError('The recent and baseline windows together must fit inside the live 5-day NRT window.');
          return;
        }
        setComparison(await intelligenceApi.compare(bbox, daysA, daysB, sensors));
      } else if (layer === 'weather') {
        const result = await intelligenceApi.weather(bbox, days);
        setWeather(result);
        setExplanation({ text: result.explanation, reason: result.ai.reason });
      } else {
        const picks = STUDY_REGIONS.slice(0, 3).map((r) => ({
          id: r.id,
          name: r.name,
          bbox: `${r.bbox.west},${r.bbox.south},${r.bbox.east},${r.bbox.north}`,
        }));
        setRegions(await intelligenceApi.compareRegions(picks, days));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The analysis request failed.');
    } finally {
      setLoading(false);
    }
  }, [bbox, days, daysA, daysB, layer, sensors]);

  useEffect(() => {
    void load();
  }, [load]);

  const explain = async () => {
    // The weather route already returns its own AI narrative; the generic topic endpoint has no weather topic.
    if (layer === 'regions' || layer === 'compare' || layer === 'weather') return;
    try {
      const result = await intelligenceApi.geographicAnalysis(bbox, days, layer);
      setExplanation({ text: result.explanation, reason: result.ai.reason });
    } catch (err) {
      setExplanation({ text: null, reason: err instanceof Error ? err.message : 'The explanation failed.' });
    }
  };

  const generateReport = async () => {
    try {
      const result = await intelligenceApi.report(bbox, days, { sensors, language });
      setReport(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The report could not be generated.');
    }
  };

  const downloadReport = () => {
    if (!report) return;
    const blob = new Blob([report.report.markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `firesync-report-${startDate}-to-${endDate}.md`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const densityOverlay = useMemo(() => {
    if (!density) return null;
    return buildDensityOverlay({
      cells: density.density.top_cells,
      cellSizeKm: density.density.cell_size_km,
      cellsOmitted: density.density.cells_omitted,
      bbox: density.bbox,
      window: density.window,
      sensors: density.sensors,
      source: density.source,
    });
  }, [density]);

  const clusterOverlay = useMemo(() => {
    if (!clusters) return null;
    return buildClusterOverlay({
      clusters: clusters.clusters.clusters,
      bbox: clusters.bbox,
      window: clusters.window,
      sensors: clusters.sensors,
      source: clusters.source,
    });
  }, [clusters]);

  const downloadOverlayCsv = (overlay: AnalysisOverlay) => {
    const blob = new Blob([overlay.csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `firesync-${overlay.kind}-overlay-${startDate}-to-${endDate}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const clusterList = clusters?.clusters.clusters ?? [];

  const compareEmpty =
    comparison !== null &&
    ((comparison.a.by_sensor.MODIS === 0 && comparison.a.by_sensor.VIIRS === 0) ||
      (comparison.b.by_sensor.MODIS === 0 && comparison.b.by_sensor.VIIRS === 0));
  const compareRows = comparison
    ? [
        {
          label: 'MODIS detections',
          recent: comparison.a.by_sensor.MODIS,
          baseline: comparison.b.by_sensor.MODIS,
          change: comparison.change.MODIS,
        },
        {
          label: 'VIIRS detections',
          recent: comparison.a.by_sensor.VIIRS,
          baseline: comparison.b.by_sensor.VIIRS,
          change: comparison.change.VIIRS,
        },
        {
          label: 'Active 1 km cells',
          recent: comparison.a.active_1km_cells,
          baseline: comparison.b.active_1km_cells,
          change: comparison.change.active_1km_cells,
        },
      ]
    : [];

  return (
    <div className="space-y-5 page-enter">
      <section className="bg-surface border border-line rounded-card p-5 sm:p-6 space-y-2">
        <div className="flex items-start gap-3">
          <div className="h-8 w-8 rounded-control bg-gradient-to-br from-sky-500 to-cyan-500 flex items-center justify-center shrink-0">
            <Globe2 className="h-4 w-4 text-white" aria-hidden="true" />
          </div>
          <div>
            <h2 className="text-base font-bold text-fg tracking-tight">Geographic Analysis</h2>
            <p className="text-xs text-fg-muted mt-0.5">
              {areaName} · {startDate} to {endDate} · sensor filter {sensors}
            </p>
          </div>
        </div>
        <p className="text-2xs text-fg-subtle">
          Distances, areas, densities and clusters are computed on the server from NASA FIRMS detections.
          Satellite thermal anomalies, not confirmed wildfires or burned area.
        </p>
      </section>

      <section className="bg-surface border border-line rounded-card p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Layers className="h-4 w-4 text-accent" aria-hidden="true" />
          <h3 className="text-sm font-bold text-fg">Analysis layers</h3>
        </div>
        <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Geographic analysis layers">
          {LAYERS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={layer === entry.id}
              onClick={() => {
                setLayer(entry.id);
                setExplanation(null);
              }}
              className={`px-3 py-1.5 rounded-control text-xs font-semibold ${
                layer === entry.id ? 'bg-accent text-accent-fg' : 'text-fg-muted hover:bg-raised border border-line'
              }`}
            >
              {entry.label}
            </button>
          ))}
        </div>

        {loading && (
          <p className="text-xs text-fg-subtle inline-flex items-center gap-1.5">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> Computing from live detections…
          </p>
        )}
        {error && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}

        {layer === 'density' && density && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {[
                { label: 'MODIS detections', value: density.density.by_sensor.MODIS.toLocaleString() },
                { label: 'VIIRS detections', value: density.density.by_sensor.VIIRS.toLocaleString() },
                { label: 'Area', value: `${density.density.area_km2.toLocaleString()} km²` },
                { label: 'Active 1 km cells', value: density.density.active_cells.toLocaleString() },
              ].map((stat) => (
                <div key={stat.label} className="bg-canvas border border-line rounded-control p-2.5">
                  <div className="text-fg-subtle text-2xs font-mono uppercase tracking-wider">{stat.label}</div>
                  <div className="text-lg font-bold font-mono text-fg mt-0.5">{stat.value}</div>
                </div>
              ))}
            </div>
            <p className="text-2xs text-fg-muted font-mono">
              Density per 1000 km² — MODIS {density.density.densities_per_1000_km2.MODIS}, VIIRS{' '}
              {density.density.densities_per_1000_km2.VIIRS}
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-2xs">
                <caption className="sr-only">Densest 1 km cells</caption>
                <thead className="text-fg-subtle font-mono uppercase">
                  <tr>
                    <th className="text-left py-1">Cell</th>
                    <th className="text-right">Lat</th>
                    <th className="text-right">Lon</th>
                    <th className="text-right">MODIS</th>
                    <th className="text-right">VIIRS</th>
                  </tr>
                </thead>
                <tbody className="font-mono text-fg-muted">
                  {density.density.top_cells.map((cell) => (
                    <tr key={cell.cell_id} className="border-t border-line">
                      <td className="py-1">{cell.cell_id}</td>
                      <td className="text-right">{cell.center_lat}</td>
                      <td className="text-right">{cell.center_lon}</td>
                      <td className="text-right">{cell.modis}</td>
                      <td className="text-right">{cell.viirs}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {density.density.cells_omitted > 0 && (
              <p className="text-2xs text-fg-subtle">
                {density.density.cells_omitted} further cells are not listed; the totals above cover all of them.
                Only the listed cells are drawn on the map.
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => densityOverlay && onShowOverlay?.(densityOverlay)}
                disabled={!densityOverlay || densityOverlay.geojson.features.length === 0 || !onShowOverlay}
                className="btn btn-secondary text-xs gap-1.5 disabled:opacity-50"
                title={onShowOverlay ? 'Draw only the returned density cells on the existing map' : 'Map view is not available here'}
              >
                <MapPinned className="h-3.5 w-3.5" aria-hidden="true" /> Show cells on map
              </button>
              {densityOverlay && (
                <button
                  type="button"
                  onClick={() => downloadOverlayCsv(densityOverlay)}
                  className="text-2xs text-accent hover:underline inline-flex items-center gap-1"
                >
                  <Download className="h-3 w-3" aria-hidden="true" /> Overlay CSV
                </button>
              )}
            </div>
            {densityOverlay && <p className="text-2xs text-fg-subtle">{densityOverlay.description}</p>}
          </div>
        )}

        {layer === 'clusters' && clusters && (
          <div className="space-y-2">
            <p className="text-2xs text-fg-muted">
              {clusterList.length} candidate group(s). Groups are spatial-temporal clusters of satellite
              thermal anomalies, not confirmed wildfires or fire perimeters.
            </p>
            {clusterList.length === 0 ? (
              <p className="text-xs text-warning">
                No candidate hotspot group met the link rule in this window. This is not evidence that no fire occurred.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-2xs">
                  <caption className="sr-only">
                    Candidate hotspot groups with MODIS and VIIRS detections counted separately
                  </caption>
                  <thead className="text-fg-subtle font-mono uppercase">
                    <tr>
                      <th className="text-left py-1">Group</th>
                      <th className="text-right">MODIS</th>
                      <th className="text-right">VIIRS</th>
                      <th className="text-right">Duration (h)</th>
                      <th className="text-right">Trend</th>
                      <th className="text-left pl-2">First (UTC)</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono text-fg-muted">
                    {clusterList.slice(0, 15).map((c) => (
                      <tr key={c.id} className="border-t border-line">
                        <td className="py-1">{c.id}</td>
                        <td className="text-right">{c.by_sensor.MODIS}</td>
                        <td className="text-right">{c.by_sensor.VIIRS}</td>
                        <td className="text-right">{c.duration_hours}</td>
                        <td className="text-right">{c.evolution.phase.replace('_', ' ')}</td>
                        <td className="pl-2">{c.first_detection_utc}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {clusterList.length > 0 && (
              <div className="space-y-1">
                <p className="text-2xs font-mono uppercase tracking-wider text-fg-subtle">
                  Per-day detections (M = MODIS, V = VIIRS)
                </p>
                {clusterList.slice(0, 8).map((c) => (
                  <p key={`${c.id}-daily`} className="text-2xs text-fg-subtle font-mono">
                    <span className="text-fg-muted">{c.id}</span> · {c.evolution.phase.replace('_', ' ')} ·{' '}
                    {c.daily_counts.map((d) => `${d.date.slice(5)} M${d.MODIS}/V${d.VIIRS}`).join('  →  ')}
                  </p>
                ))}
                <p className="text-2xs text-fg-subtle">
                  Trend describes detection timing inside each candidate group only — not fire growth or a
                  perimeter. A group seen on a single overpass is labelled single pass.
                </p>
              </div>
            )}
            {clusters.clusters.truncated && (
              <p className="text-2xs text-warning">
                Only the first {clusters.clusters.analysed_detections} detections were analysed; group counts are lower bounds.
              </p>
            )}
            {clusters.clusters.notes.map((note) => (
              <p key={note} className="text-2xs text-fg-subtle">
                {note}
              </p>
            ))}
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => clusterOverlay && onShowOverlay?.(clusterOverlay)}
                disabled={
                  !clusterOverlay ||
                  clusterOverlay.geojson.features.length === 0 ||
                  !onShowOverlay ||
                  clusterList.length === 0
                }
                className="btn btn-secondary text-xs gap-1.5 disabled:opacity-50"
                title={
                  onShowOverlay
                    ? 'Draw the candidate group bounding boxes on the existing map'
                    : 'Map view is not available here'
                }
              >
                <MapPinned className="h-3.5 w-3.5" aria-hidden="true" /> Show boxes on map
              </button>
              {clusterOverlay && (
                <button
                  type="button"
                  onClick={() => downloadOverlayCsv(clusterOverlay)}
                  className="text-2xs text-accent hover:underline inline-flex items-center gap-1"
                >
                  <Download className="h-3 w-3" aria-hidden="true" /> Overlay CSV
                </button>
              )}
            </div>
            {clusterOverlay && <p className="text-2xs text-fg-subtle">{clusterOverlay.description}</p>}
          </div>
        )}

        {layer === 'compare' && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-end gap-3">
              <label className="text-2xs text-fg-subtle" htmlFor="compare-days-a">
                Recent window
                <select
                  id="compare-days-a"
                  value={daysA}
                  onChange={(event) => setDaysA(Number(event.target.value))}
                  className="ml-2 rounded-control border border-line bg-canvas px-2 py-1 text-xs text-fg"
                >
                  {[1, 2, 3, 4, 5].map((n) => (
                    <option key={n} value={n}>
                      {n} day{n === 1 ? '' : 's'}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-2xs text-fg-subtle" htmlFor="compare-days-b">
                Baseline window
                <select
                  id="compare-days-b"
                  value={daysB}
                  onChange={(event) => setDaysB(Number(event.target.value))}
                  className="ml-2 rounded-control border border-line bg-canvas px-2 py-1 text-xs text-fg"
                >
                  {[1, 2, 3, 4, 5].map((n) => (
                    <option key={n} value={n}>
                      {n} day{n === 1 ? '' : 's'}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <p className="text-2xs text-fg-subtle">
              The recent window ends today; the baseline window is the same number of days immediately
              before it. Both must fit inside the live 1–5 day NRT window.
            </p>

            {daysA + daysB > 5 && (
              <p role="alert" className="text-xs text-danger">
                The two windows together exceed the live 5-day NRT window. Choose a smaller recent or
                baseline window.
              </p>
            )}

            {comparison && compareEmpty && (
              <p className="text-xs text-warning">
                {comparison.a.by_sensor.MODIS === 0 && comparison.a.by_sensor.VIIRS === 0
                  ? 'No observation record in the recent window. This is missing coverage, not zero fire.'
                  : 'No observation record in the baseline window. This is missing coverage, not zero fire.'}
              </p>
            )}

            {comparison && !compareEmpty && (
              <>
                <p className="text-2xs text-fg-muted font-mono">
                  Recent: {comparison.window_a.start_date} to {comparison.window_a.end_date} (
                  {comparison.window_a.days} day(s)) · Baseline: {comparison.window_b.start_date} to{' '}
                  {comparison.window_b.end_date} ({comparison.window_b.days} day(s))
                </p>
                <div className="overflow-x-auto">
                  <table className="w-full text-2xs">
                    <caption className="sr-only">
                      Change between the recent and baseline windows, per sensor
                    </caption>
                    <thead className="text-fg-subtle font-mono uppercase">
                      <tr>
                        <th className="text-left py-1">Measure</th>
                        <th className="text-right">Recent</th>
                        <th className="text-right">Baseline</th>
                        <th className="text-right">Change</th>
                        <th className="text-right">Change %</th>
                      </tr>
                    </thead>
                    <tbody className="font-mono text-fg-muted">
                      {compareRows.map((row) => (
                        <tr key={row.label} className="border-t border-line">
                          <td className="py-1">{row.label}</td>
                          <td className="text-right">{row.recent.toLocaleString()}</td>
                          <td className="text-right">{row.baseline.toLocaleString()}</td>
                          <td className="text-right">
                            {row.change.absolute > 0 ? `+${row.change.absolute}` : row.change.absolute}
                          </td>
                          <td className="text-right">
                            {row.change.percent === null
                              ? 'not defined (zero baseline)'
                              : `${row.change.percent > 0 ? '+' : ''}${row.change.percent}%`}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="text-2xs text-fg-muted font-mono">
                  Per day — MODIS recent {comparison.normalized.a_per_day.MODIS}, baseline{' '}
                  {comparison.normalized.b_per_day.MODIS} · VIIRS recent{' '}
                  {comparison.normalized.a_per_day.VIIRS}, baseline{' '}
                  {comparison.normalized.b_per_day.VIIRS}
                </p>
                <p className="text-2xs text-fg-subtle">{comparison.coverage_note}</p>
                {comparison.notes.map((note) => (
                  <p key={note} className="text-2xs text-fg-subtle">
                    {note}
                  </p>
                ))}
                <p className="text-2xs text-fg-subtle">{FIRE_LEGEND}</p>
              </>
            )}
          </div>
        )}

        {layer === 'weather' && weather && (
          <div className="space-y-3">
            {!weather.analysis.weather.available ? (
              <p className="text-xs text-warning">
                Weather data unavailable: {weather.analysis.weather.reason} No correlations are shown rather than
                invented values.
              </p>
            ) : (
              <>
                <p className="text-2xs text-fg-muted font-mono">
                  {weather.analysis.weather.provider} · {weather.analysis.weather.api} API · point{' '}
                  {weather.analysis.weather.point?.latitude}, {weather.analysis.weather.point?.longitude} ·{' '}
                  {weather.analysis.weather.days.length} day(s) · retrieved{' '}
                  {weather.analysis.weather.retrieved_at?.slice(0, 16).replace('T', ' ')} UTC
                </p>
                <div className="overflow-x-auto">
                  <table className="w-full text-2xs">
                    <caption className="sr-only">
                      Daily weather observations beside per-sensor detection counts
                    </caption>
                    <thead className="text-fg-subtle font-mono uppercase">
                      <tr>
                        <th className="text-left py-1">Date</th>
                        <th className="text-right">Tmax °C</th>
                        <th className="text-right">Tmin °C</th>
                        <th className="text-right">Precip mm</th>
                        <th className="text-right">Wind km/h</th>
                        <th className="text-right">RH %</th>
                        <th className="text-right">MODIS</th>
                        <th className="text-right">VIIRS</th>
                      </tr>
                    </thead>
                    <tbody className="font-mono text-fg-muted">
                      {weather.analysis.weather.days.map((w) => {
                        const fire = weather.analysis.fire_daily.find((d) => d.date === w.date);
                        return (
                          <tr key={w.date} className="border-t border-line">
                            <td className="py-1">{w.date}</td>
                            <td className="text-right">{w.temperature_2m_max_c ?? '–'}</td>
                            <td className="text-right">{w.temperature_2m_min_c ?? '–'}</td>
                            <td className="text-right">{w.precipitation_mm ?? '–'}</td>
                            <td className="text-right">{w.wind_speed_10m_max_kmh ?? '–'}</td>
                            <td className="text-right">{w.relative_humidity_2m_mean_pct ?? '–'}</td>
                            <td className="text-right">
                              {fire?.status === 'observed' ? fire.MODIS : 'no record'}
                            </td>
                            <td className="text-right">
                              {fire?.status === 'observed' ? fire.VIIRS : 'no record'}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <p className="text-2xs text-fg-subtle">
                  {weather.analysis.paired_days} paired day(s) used for correlations. Days without an
                  observation record are excluded — missing coverage is not zero fire.
                </p>
                {weather.analysis.correlations.length > 0 && (
                  <div className="overflow-x-auto">
                    <table className="w-full text-2xs">
                      <caption className="sr-only">
                        Pearson correlation between each weather variable and per-sensor daily detections
                      </caption>
                      <thead className="text-fg-subtle font-mono uppercase">
                        <tr>
                          <th className="text-left py-1">Variable</th>
                          <th className="text-right">MODIS r</th>
                          <th className="text-right">VIIRS r</th>
                          <th className="text-right">Pairs</th>
                        </tr>
                      </thead>
                      <tbody className="font-mono text-fg-muted">
                        {weather.analysis.correlations.map((c) => (
                          <tr key={c.variable} className="border-t border-line">
                            <td className="py-1">
                              {c.label} ({c.unit})
                            </td>
                            <td className="text-right">{c.MODIS.r ?? 'n/a'}</td>
                            <td className="text-right">{c.VIIRS.r ?? 'n/a'}</td>
                            <td className="text-right">{Math.min(c.MODIS.pairs, c.VIIRS.pairs)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
            {weather.analysis.notes.map((note) => (
              <p key={note} className="text-2xs text-fg-subtle">
                {note}
              </p>
            ))}
          </div>
        )}

        {layer === 'coverage' && coverage && (
          <div className="space-y-2">
            <p className="text-2xs text-fg-muted">
              Observed days: {coverage.coverage.observed_days} · no observation record:{' '}
              {coverage.coverage.no_record_days} · single-sensor days:{' '}
              {coverage.coverage.single_sensor_days}. A day without a record is missing data, not zero fire;
              a single-sensor day may be an overpass gap.
            </p>
            <ul className="space-y-1">
              {coverage.coverage.days.map((day) => (
                <li key={day.date} className="flex items-center justify-between text-2xs font-mono border-t border-line py-1">
                  <span className="text-fg">{day.date}</span>
                  <span className={day.status === 'observed' ? 'text-fg-muted' : 'text-warning'}>
                    {day.status === 'observed'
                      ? `MODIS ${day.MODIS} · VIIRS ${day.VIIRS}${day.single_sensor ? ' · one sensor only' : ''}`
                      : 'no observation record'}
                  </span>
                </li>
              ))}
            </ul>
            {coverage.ingestion && (
              <div className="rounded-control border border-line bg-canvas p-2.5 space-y-1">
                <p className="text-2xs font-mono uppercase tracking-wider text-fg-subtle">
                  Ingestion records ({coverage.ingestion.storage}
                  {coverage.ingestion.durable ? ', durable' : ', not durable'})
                </p>
                <p className="text-2xs text-fg-muted font-mono">
                  Jobs — completed {coverage.ingestion.job_counts.completed} · failed{' '}
                  {coverage.ingestion.job_counts.failed} · running {coverage.ingestion.job_counts.running} ·
                  pending {coverage.ingestion.job_counts.pending}
                </p>
                {coverage.ingestion.recent_jobs.length > 0 && (
                  <ul className="space-y-0.5">
                    {coverage.ingestion.recent_jobs.slice(0, 5).map((job) => (
                      <li key={job.id} className="text-2xs font-mono text-fg-subtle">
                        <span className={job.status === 'failed' ? 'text-danger' : 'text-fg-muted'}>
                          {job.status}
                        </span>{' '}
                        · {(job.source_products ?? []).join('+') || 'no products'} ·{' '}
                        {job.retrieved_at?.slice(0, 16).replace('T', ' ') ?? 'no timestamp'}
                        {job.error_message ? ` · ${job.error_message.slice(0, 80)}` : ''}
                      </li>
                    ))}
                  </ul>
                )}
                <p className="text-2xs text-fg-subtle">{coverage.ingestion.note}</p>
              </div>
            )}
            {coverage.coverage.source_errors.length > 0 && (
              <p className="text-2xs text-danger">Source errors: {coverage.coverage.source_errors.join(' | ')}</p>
            )}
          </div>
        )}

        {layer === 'regions' && regions && (
          <div className="space-y-2">
            <div className="overflow-x-auto">
              <table className="w-full text-2xs">
                <thead className="text-fg-subtle font-mono uppercase">
                  <tr>
                    <th className="text-left py-1">Region</th>
                    <th className="text-right">MODIS</th>
                    <th className="text-right">VIIRS</th>
                    <th className="text-right">Area km²</th>
                    <th className="text-right">MODIS /1000 km²</th>
                    <th className="text-right">VIIRS /1000 km²</th>
                  </tr>
                </thead>
                <tbody className="font-mono text-fg-muted">
                  {regions.regions.map((r) => (
                    <tr key={r.region_id} className="border-t border-line">
                      <td className="py-1">{r.name}</td>
                      <td className="text-right">{r.by_sensor.MODIS}</td>
                      <td className="text-right">{r.by_sensor.VIIRS}</td>
                      <td className="text-right">{r.area_km2.toLocaleString()}</td>
                      <td className="text-right">{r.densities_per_1000_km2.MODIS}</td>
                      <td className="text-right">{r.densities_per_1000_km2.VIIRS}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {regions.notes.map((note) => (
              <p key={note} className="text-2xs text-fg-subtle">
                {note}
              </p>
            ))}
          </div>
        )}

        {layer !== 'regions' && layer !== 'compare' && layer !== 'weather' && (
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={explain} className="btn btn-secondary text-xs gap-1.5">
              <Sparkles className="h-3.5 w-3.5" aria-hidden="true" /> Explain with AI
            </button>
            <a
              className="text-2xs text-accent hover:underline inline-flex items-center gap-1"
              href={api.getExportCsvUrl({ dataset: 'all', bbox, start_date: startDate, end_date: endDate })}
              download
            >
              <Download className="h-3 w-3" aria-hidden="true" /> Export detections (CSV)
            </a>
          </div>
        )}

        {explanation && (
          <div className="rounded-card border border-line bg-canvas p-3 space-y-1">
            <p className="text-2xs font-mono uppercase text-fg-subtle">AI geographic explanation</p>
            <p className="text-xs text-fg-muted leading-relaxed whitespace-pre-line">
              {explanation.text ?? explanation.reason}
            </p>
          </div>
        )}
      </section>

      <section ref={reportRef} className="bg-surface border border-line rounded-card p-4 space-y-3">
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-accent" aria-hidden="true" />
          <h3 className="text-sm font-bold text-fg">Report</h3>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-2xs text-fg-subtle" htmlFor="report-language">
            Explanation language
            <select
              id="report-language"
              value={language}
              onChange={(event) => setLanguage(event.target.value === 'bn' ? 'bn' : 'en')}
              className="ml-2 rounded-control border border-line bg-canvas px-2 py-1 text-xs text-fg"
            >
              <option value="en">English</option>
              <option value="bn">বাংলা</option>
            </select>
          </label>
          <button type="button" onClick={generateReport} className="btn btn-primary text-xs">
            Generate report
          </button>
          {report && (
            <button type="button" onClick={downloadReport} className="btn btn-secondary text-xs gap-1.5">
              <Download className="h-3.5 w-3.5" aria-hidden="true" /> Download .md
            </button>
          )}
        </div>
        {report && (
          <div className="space-y-2">
            <p className="text-2xs text-fg-subtle">{report.report.pdf_note}</p>
            <pre className="max-h-72 overflow-auto rounded-control border border-line bg-canvas p-3 text-2xs text-fg-muted whitespace-pre-wrap">
              {report.report.markdown}
            </pre>
          </div>
        )}
      </section>

      {/* ── Historical archive country rankings (separate from live layers above) ── */}
      <HistoricalCountryRankings />
      <SeasonalRiskCard />

      <section className="bg-surface border border-line rounded-card p-4 space-y-2">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-warning" aria-hidden="true" />
          <h3 className="text-sm font-bold text-fg">Dataset availability</h3>
        </div>
        {datasets ? (
          <ul className="space-y-1.5">
            {datasets.datasets.map((d) => (
              <li key={d.id} className="text-2xs border-t border-line pt-1.5 first:border-0 first:pt-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className={`badge text-2xs ${d.configured ? 'badge-info' : 'badge-warn'}`}>
                    {d.configured ? 'configured' : 'not configured'}
                  </span>
                  <span className="text-fg font-semibold">{d.name}</span>
                  <span className="text-fg-subtle font-mono">{d.resolution}</span>
                </div>
                <p className="text-fg-subtle mt-0.5">{d.note}</p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-2xs text-fg-subtle">Dataset status could not be read.</p>
        )}
      </section>
    </div>
  );
};

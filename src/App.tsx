/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState, useMemo, useRef } from 'react';
import { MotionConfig } from 'motion/react';
import { Navbar } from './components/layout/Navbar';
import { FilterBar } from './components/filters/FilterBar';
import { OverviewPage } from './pages/OverviewPage';
import { HotspotExplorerPage } from './pages/HotspotExplorerPage';
import { CalendarPage, type CalendarView } from './pages/CalendarPage';
import { SensorComparisonPage } from './pages/SensorComparisonPage';
import { MethodologyPage } from './pages/MethodologyPage';
import { ExportsPage } from './pages/ExportsPage';
import { GeographicAnalysisPage } from './pages/GeographicAnalysisPage';
import { SettingsPage } from './pages/SettingsPage';
import {
  CanonicalObservation,
  DailyActivitySummary,
  FilterState,
  CalibrationModelMetrics,
} from './types/fire';
import { AreaChip, AreaEmptyState } from './components/area/AreaChip';
import type { SourceMetadata } from './api/client';
import type { AnalysisOverlay } from './utils/geoOverlays';
import { AiInvestigatorPanel } from './components/ai/AiInvestigatorPanel';
import { AiIntelligencePage } from './pages/AiIntelligencePage';
import type { AiApplyFiltersAction, AiFocusRegionAction, AiRequestContext } from './types/ai';
import type { AiTab, GeographicLayerId } from './utils/aiFeatureCatalog';
import { STUDY_REGIONS } from './utils/spatial';
import {
  DEFAULT_AREA,
  WORLD_AREA,
  archiveCoverageFromTotal,
  areaFromQuickRegion,
  areaToScope,
  bboxToString,
  type Area,
  type ArchiveCoverage,
} from './utils/area';
import { api, liveObservationQuery, type AnalyticsSummaryResponse } from './api/client';
import {
  clampToLiveWindow,
  clampedLiveWindowNotice,
  defaultFilters,
  LIVE_MAX_DAYS,
} from './utils/filterValidation';

type Kpis = AnalyticsSummaryResponse['kpis'];

export default function App() {
  const [activeTab, setActiveTab] = useState<string>(() => {
    // The map (Hotspot Explorer) is the landing screen; Overview is a secondary page.
    return 'hotspots';
  });
  // THE area of the app. The Explorer's region chips and place search set it; Overview, Calendar, Comparison and
  // Exports read it. There is no second region selector.
  const [area, setArea] = useState<Area>(DEFAULT_AREA);
  // User-selected area: null initially so the whole world is shown without pre-selecting Bangladesh.
  const [selectedArea, setSelectedArea] = useState<Area | null>(null);
  // A date picked in the Calendar: the Explorer shows the archive detections of that day (in `area`) until dismissed.
  const [pinnedDate, setPinnedDate] = useState<string | null>(null);
  // Data source: live 5-day NRT window vs the local 2000-2025 historical archive.
  const [sourceMode, setSourceMode] = useState<'live' | 'historical'>('live');
  const [calendarView, setCalendarView] = useState<CalendarView>('daily');
  const [historicalDate, setHistoricalDate] = useState<string | null>(null);
  // Bumped when another page asks the Explorer to open its Area section ("Change on map").
  const [openAreaRequest, setOpenAreaRequest] = useState(0);
  // Whether the loaded archive has any rows for `area` (independent of the date / sensor filters).
  const [archiveCoverage, setArchiveCoverage] = useState<ArchiveCoverage>('unknown');

  const [filters, setFilters] = useState<FilterState>(() => defaultFilters());

  const [observations, setObservations] = useState<CanonicalObservation[]>([]);
  /** Rows matching the filters across the whole live response (the list above is capped for the browser). */
  const [observationTotal, setObservationTotal] = useState(0);
  const [dailySummaries, setDailySummaries] = useState<DailyActivitySummary[]>([]);
  const [kpis, setKpis] = useState<Kpis>({
    total_modis_detections: 0,
    total_viirs_detections: 0,
    total_raw_detections: 0,
    active_spatial_temporal_bins: 0,
    harmonized_activity_units: 0,
    total_frp_mw: 0,
    modis_frp_mw: 0,
    viirs_frp_mw: 0,
    data_coverage_completeness_pct: null,
    active_days: 0,
    most_recent_successful_ingestion: null,
  });

  // Placeholder shown until the API answers (or if it fails). Deliberately claims nothing:
  // no metrics, no periods, status exploratory. The real numbers come from /analytics/calibration.
  const [calibrationMetrics, setCalibrationMetrics] = useState<CalibrationModelMetrics>({
    model_id: 'not loaded',
    model_version: 'not loaded',
    algorithm: 'Awaiting server evidence',
    target_grid_km: 1.0,
    sample_size_paired_cells: 0,
    training_period: 'not evaluated',
    validation_period: 'not evaluated',
    mae: null,
    rmse: null,
    mean_bias: null,
    r_squared: null,
    calibration_slope: null,
    calibration_intercept: null,
    status: 'INSUFFICIENT',
    limitations: ['Calibration metrics have not been loaded yet.'],
  });

  const [loading, setLoading] = useState<boolean>(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dataMeta, setDataMeta] = useState<SourceMetadata | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiRequest, setAiRequest] = useState<{ tab: AiTab; nonce: number } | null>(null);
  const [geoRequest, setGeoRequest] = useState<GeographicLayerId | null>(null);
  const [geoReportRequest, setGeoReportRequest] = useState(0);
  const [clusterFocus, setClusterFocus] = useState<{
    latitude: number;
    longitude: number;
    nonce: number;
  } | null>(null);
  /** A hotspot clicked on the map, pinned into the AI Investigator evidence card. */
  const [aiEvidence, setAiEvidence] = useState<{
    observation: CanonicalObservation;
    nonce: number;
  } | null>(null);
  /** Server-derived geographic overlay (density cells or candidate group boxes) drawn on the one map. */
  const [analysisOverlay, setAnalysisOverlay] = useState<AnalysisOverlay | null>(null);
  const requestIdRef = useRef(0);
  const mainRef = useRef<HTMLElement>(null);

  // The area and sensor the user is looking at. Used for every request AND for exports, so a download
  // always matches what is on screen.
  const sensorScope =
    filters.sensorMode === 'MODIS_ONLY' ? 'MODIS' : filters.sensorMode === 'VIIRS_ONLY' ? 'VIIRS' : undefined;
  // The area the data pages are scoped to: the region chosen on the map, or the whole world when none is
  // chosen — the same area the globe is showing, so a page can never sit on a different country than the map.
  const pageArea = selectedArea ?? WORLD_AREA;
  const scope = useMemo(() => areaToScope(pageArea, sensorScope), [pageArea, sensorScope]);

  // The live NRT window the pages can actually serve for the chosen dates, and the notice shown on every
  // data page when those dates had to be clamped into it.
  const servedRange = useMemo(
    () => clampToLiveWindow(filters.startDate, filters.endDate),
    [filters.startDate, filters.endDate]
  );
  const clampNotice = useMemo(
    () => clampedLiveWindowNotice(filters.startDate, filters.endDate),
    [filters.startDate, filters.endDate]
  );

  const loadData = () => {
    // Ignore answers from older requests when the filters change quickly.
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setLoadError(null);

    const baseQuery = liveObservationQuery(filters, scope);

    Promise.all([
      api.getHotspots({
        ...baseQuery,
        limit: 1000,
      }),
      api.getCalendar(baseQuery),
      api.getAnalyticsSummary(baseQuery),
      api.getCalibrationMetrics(baseQuery),
    ])
      .then(([hotspotsRes, calendarRes, analyticsRes, calibRes]) => {
        if (requestId !== requestIdRef.current) return;
        setObservations(hotspotsRes.observations || []);
        setObservationTotal(hotspotsRes.total ?? hotspotsRes.observations?.length ?? 0);
        setDailySummaries(calendarRes.daily_summaries || []);
        setDataMeta({
          data_source: hotspotsRes.data_source,
          provenance_status: hotspotsRes.provenance_status,
          retrieved_at: hotspotsRes.retrieved_at,
          cached: hotspotsRes.cached,
          source_errors: [...(hotspotsRes.source_errors || []), ...(calendarRes.source_errors || [])],
          truncated: Boolean(hotspotsRes.truncated || calendarRes.truncated),
        });
        if (analyticsRes.kpis) {
          setKpis(analyticsRes.kpis);
        }
        if (calibRes) {
          setCalibrationMetrics(calibRes);
        }
      })
      .catch((err) => {
        if (requestId !== requestIdRef.current) return;
        console.error('Failed to load FireSync data:', err);
        setLoadError(err instanceof Error ? err.message : 'Could not load data from the server.');
      })
      .finally(() => {
        if (requestId === requestIdRef.current) setLoading(false);
      });
  };

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageArea, filters]);

  // An overlay belongs to the area / filters it was computed for. Changing either clears it instead of
  // leaving geometry that no longer matches the shared filters on the map.
  useEffect(() => {
    setAnalysisOverlay(null);
  }, [pageArea, filters]);

  // Does live NASA FIRMS have ANY detections for this area? Asked over the whole live window and without the
  // date / sensor filters, so a narrow filter can never be mistaken for "no data covers this area".
  useEffect(() => {
    let cancelled = false;
    setArchiveCoverage('unknown');
    api
      .getHotspots({ source: 'live', days: LIVE_MAX_DAYS, bbox: scope.bbox, limit: 1 })
      .then((r) => {
        if (!cancelled) setArchiveCoverage(archiveCoverageFromTotal(r?.total));
      })
      .catch(() => {
        if (!cancelled) setArchiveCoverage('unknown');
      });
    return () => {
      cancelled = true;
    };
  }, [scope.bbox]);

  // Calendar "show on map": the Explorer pins that day. Dates outside the live window
  // switch to the historical archive so the map shows the REAL stored detections.
  const handleNavigateToMapWithDate = (date: string) => {
    const daysAgo = (Date.now() - new Date(`${date}T00:00:00Z`).getTime()) / 86_400_000;
    if (daysAgo > LIVE_MAX_DAYS) {
      setSourceMode('historical');
      setHistoricalDate(date);
      setPinnedDate(null);
    } else {
      setPinnedDate(date);
      setHistoricalDate(null);
    }
    setActiveTab('hotspots');
  };

  // "Area: … · Change on map" on the other pages.
  const handleChangeAreaOnMap = () => {
    setOpenAreaRequest((n) => n + 1);
    setActiveTab('hotspots');
  };

  const noArchive = archiveCoverage === 'none';

  // ---- AI map actions: the assistant may only change state through these typed handlers.
  const applyAiFilters = (action: AiApplyFiltersAction) => {
    setFilters((previous) => {
      const next = { ...previous };
      if (action.sensors) {
        next.sensorMode =
          action.sensors === 'MODIS' ? 'MODIS_ONLY' : action.sensors === 'VIIRS' ? 'VIIRS_ONLY' : 'ALL';
      }
      if (typeof action.min_frp === 'number') next.minFRP = action.min_frp;
      if (typeof action.min_confidence === 'number') next.minConfidence = action.min_confidence;
      if (typeof action.days === 'number') {
        const end = new Date();
        const start = new Date(end.getTime());
        start.setUTCDate(start.getUTCDate() - (Math.min(Math.max(action.days, 1), LIVE_MAX_DAYS) - 1));
        const range = clampToLiveWindow(start.toISOString().slice(0, 10), end.toISOString().slice(0, 10));
        next.startDate = range.start;
        next.endDate = range.end;
      }
      return next;
    });
  };

  const focusAiRegion = (action: AiFocusRegionAction) => {
    const region = STUDY_REGIONS.find((r) => r.id === action.region_id);
    if (!region) return;
    const nextArea = areaFromQuickRegion(region);
    setSelectedArea(nextArea);
    setArea(nextArea);
    setActiveTab('hotspots');
  };

  const focusAiCluster = (target: { latitude: number; longitude: number }) => {
    setClusterFocus((prev) => ({ ...target, nonce: (prev?.nonce ?? 0) + 1 }));
    setActiveTab('hotspots');
    setAiOpen(false);
  };

  // "AI evidence card" on a clicked hotspot: open the investigator on the Evidence tab with that record.
  const explainWithAi = (observation: CanonicalObservation) => {
    setAiEvidence((prev) => ({ observation, nonce: (prev?.nonce ?? 0) + 1 }));
    setAiRequest((prev) => ({ tab: 'evidence', nonce: (prev?.nonce ?? 0) + 1 }));
    setAiOpen(true);
  };

  const openAiTool = (tab: AiTab) => {
    setAiRequest((previous) => ({ tab, nonce: (previous?.nonce ?? 0) + 1 }));
    setAiOpen(true);
  };

  const openGeographicLayer = (layer: GeographicLayerId) => {
    setGeoRequest(layer);
    setActiveTab('geographic');
  };

  const openGeographicReport = () => {
    setGeoReportRequest((previous) => previous + 1);
    setActiveTab('geographic');
  };

  const showAnalysisOverlay = (overlay: AnalysisOverlay) => {
    setAnalysisOverlay(overlay);
    setActiveTab('hotspots');
  };

  // Live window length for the geographic workspace; always a finite 1..5 value.
  const geoDays = (() => {
    const start = servedRange.start;
    const end = servedRange.end;
    if (!start || !end) return 1;
    const span = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1;
    return Number.isFinite(span) ? Math.min(Math.max(span, 1), LIVE_MAX_DAYS) : 1;
  })();

  const aiContext: AiRequestContext = {
    area_name: pageArea.name,
    bbox: scope.bbox,
    sensors:
      filters.sensorMode === 'MODIS_ONLY' ? 'MODIS' : filters.sensorMode === 'VIIRS_ONLY' ? 'VIIRS' : 'ALL',
    start_date: servedRange.start,
    end_date: servedRange.end,
    active_view: activeTab,
  };

  const areaChip = <AreaChip area={pageArea} onChange={handleChangeAreaOnMap} />;
  const areaEmpty = <AreaEmptyState onChange={handleChangeAreaOnMap} />;

  return (
    <MotionConfig reducedMotion="user">
    <div className="min-h-screen bg-canvas text-fg flex flex-col font-sans selection:bg-accent selection:text-accent-fg">
      {/* Skip link: first tab stop, keyboard only */}
      <a
        href="#main-content"
        className="skip-link"
        onClick={(e) => {
          e.preventDefault();
          mainRef.current?.focus();
        }}
      >
        Skip to main content
      </a>

      {/* Top Navigation */}
      <Navbar
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        selectedArea={selectedArea}
        onOpenArea={() => {
          setActiveTab('hotspots');
          setOpenAreaRequest((n) => n + 1);
        }}
        onClearArea={() => {
          setSelectedArea(null);
          setArea(WORLD_AREA);
        }}
      />

      {/* Main Container */}
      <main
        id="main-content"
        ref={mainRef}
        tabIndex={-1}
        className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-5 focus:outline-none"
      >
        {/* Area (set on the map) + date / sensor filters, available across the data views */}
        {['overview', 'calendar', 'comparison', 'exports', 'geographic', 'ai'].includes(activeTab) && (
          <>
            {areaChip}
            {(activeTab !== 'calendar' || calendarView === 'daily') && <FilterBar filters={filters} setFilters={setFilters} totalMatches={observationTotal} />}
            {clampNotice && (activeTab !== 'calendar' || calendarView === 'daily') && (
              <p role="status" className="rounded-card border border-info/40 bg-surface p-3 text-xs text-fg-muted">
                {clampNotice}
              </p>
            )}
            {dataMeta?.truncated && (
              <p role="status" className="rounded-card border border-amber/40 bg-surface p-3 text-xs text-amber-500">
                Notice: Results are capped/truncated. Zoom in or narrow your date range for complete observations.
              </p>
            )}
            {Boolean(dataMeta?.source_errors?.length) && (
              <p role="status" className="rounded-card border border-amber/40 bg-surface p-3 text-xs text-amber-500">
                Some satellite sources reported errors: {dataMeta!.source_errors.join('; ')}
              </p>
            )}
          </>
        )}

        {loadError && (
          <div role="alert" className="rounded-card border border-danger/60 bg-surface p-3 text-sm text-danger">
            Could not load data: {loadError}. The numbers on this page may be out of date.
          </div>
        )}

        {/* View Router */}
        {activeTab === 'overview' &&
          (noArchive ? (
            areaEmpty
          ) : (
            <OverviewPage dailySummaries={dailySummaries} area={pageArea} onNavigate={setActiveTab} kpis={kpis} />
          ))}

        {activeTab === 'hotspots' && (
          <HotspotExplorerPage
            archiveObservations={observations}
            area={area}
            selectedArea={selectedArea}
            onAreaChange={(newArea) => {
              setSelectedArea(newArea);
              setArea(newArea);
            }}
            pinnedDate={pinnedDate}
            onClearPinnedDate={() => setPinnedDate(null)}
            openAreaRequest={openAreaRequest}
            focusCluster={clusterFocus}
            onExplainWithAi={explainWithAi}
            analysisOverlay={analysisOverlay}
            onClearAnalysisOverlay={() => setAnalysisOverlay(null)}
            sourceMode={sourceMode}
            historicalDate={historicalDate}
            filters={filters}
            onSourceModeChange={(m) => {
              setSourceMode(m);
              if (m === 'historical' && !historicalDate) setHistoricalDate('2019-07-01');
            }}
            onHistoricalDateChange={setHistoricalDate}
          />
        )}

        {activeTab === 'calendar' && (
          <CalendarPage
            dailySummaries={dailySummaries}
            area={pageArea}
            filters={filters}
            scope={scope}
            onNavigateToMapWithDate={handleNavigateToMapWithDate}
            sourceMode={sourceMode}
            onSourceModeChange={setSourceMode}
            view={calendarView}
            onViewChange={setCalendarView}
            selectedArea={selectedArea}
            onShowOverlay={showAnalysisOverlay}
          />
        )}

        {activeTab === 'comparison' &&
          (noArchive ? (
            areaEmpty
          ) : (
            <SensorComparisonPage scope={scope} filters={filters} calibrationMetrics={calibrationMetrics} />
          ))}

        {activeTab === 'geographic' && (
          <GeographicAnalysisPage
            bbox={scope.bbox ?? bboxToString(pageArea.bbox)}
            sensors={
              filters.sensorMode === 'MODIS_ONLY' ? 'MODIS' : filters.sensorMode === 'VIIRS_ONLY' ? 'VIIRS' : 'ALL'
            }
            startDate={servedRange.start}
            endDate={servedRange.end}
            days={geoDays}
            areaName={pageArea.name}
            onShowOverlay={showAnalysisOverlay}
            initialLayer={geoRequest ?? undefined}
            focusReportRequest={geoReportRequest}
            onReportFocusHandled={() => setGeoReportRequest(0)}
          />
        )}

        {activeTab === 'ai' && (
          <AiIntelligencePage
            context={aiContext}
            onOpenAiTool={openAiTool}
            onOpenGeographicLayer={openGeographicLayer}
            onOpenGeographicReport={openGeographicReport}
            onNavigate={setActiveTab}
          />
        )}

        {activeTab === 'methodology' && <MethodologyPage />}

        {activeTab === 'exports' && (
          <ExportsPage
            filters={filters}
            scope={scope}
            area={pageArea}
            observationCount={observationTotal}
            displayRange={servedRange}
            noArchive={noArchive}
            onChangeAreaOnMap={handleChangeAreaOnMap}
          />
        )}

        {activeTab === 'settings' && <SettingsPage area={pageArea} onRefreshData={loadData} />}
      </main>

      {/* Global AI investigator: one entry point, not a button per feature. */}
      {!aiOpen && (
        <button
          type="button"
          onClick={() => {
            setAiRequest(null);
            setAiOpen(true);
          }}
          className="btn btn-primary fixed bottom-4 right-4 z-40 shadow-elev-2 gap-2"
          aria-label="Open the FireSync AI investigator"
        >
          AI Investigator
        </button>
      )}
      <AiInvestigatorPanel
        open={aiOpen}
        onClose={() => setAiOpen(false)}
        context={aiContext}
        detections={observations}
        onApplyFilters={applyAiFilters}
        onFocusRegion={focusAiRegion}
        onFocusCluster={focusAiCluster}
        requestedTab={aiRequest?.tab}
        requestNonce={aiRequest?.nonce}
        requestedObservation={aiEvidence?.observation ?? null}
        observationNonce={aiEvidence?.nonce ?? 0}
        onOpenHub={() => {
          setAiOpen(false);
          setActiveTab('ai');
        }}
      />

      {/* Footer */}
      <footer className="border-t border-line bg-canvas text-fg-muted text-xs py-6 mt-8">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-col sm:flex-row items-center justify-between gap-3">
          <div>
            <span className="font-semibold text-fg">FireSync</span> — NASA Space Apps Challenge 2026 • Team: BOT Battalion
          </div>
          <div className="text-fg-subtle text-2xs text-center sm:text-right">
            Active-fire hotspots indicate satellite thermal anomalies, not unique wildfires or burned area.
          </div>
        </div>
      </footer>
    </div>
    </MotionConfig>
  );
}

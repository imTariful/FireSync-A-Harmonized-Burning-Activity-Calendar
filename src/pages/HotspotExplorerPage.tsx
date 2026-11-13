import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Compass, Layers, MapPinned, SlidersHorizontal } from 'lucide-react';
import { CanonicalObservation, FilterState } from '../types/fire';
import { FireGlobe } from '../components/map/FireGlobe';
import { ExplorerPanel } from '../components/explorer/ExplorerPanel';
import { PanelSection } from '../components/explorer/PanelSection';
import { ExplorerToolbar, ToolbarAction } from '../components/explorer/ExplorerToolbar';
import { HarmonizeDrawer, prefetchHarmonize } from '../components/explorer/HarmonizeDrawer';
import { FirstRunHint, useFirstRunHint } from '../components/explorer/FirstRunHint';
import { TimelineBar } from '../components/explorer/TimelineBar';
import { useTimelinePlayback } from '../components/explorer/useTimelinePlayback';
import { buildTimelineAxis, indexTimeline, stepCutoffMs } from '../utils/timeline';
import { selectVisibleDetections, timelineFractionFromStep, timelineStepFromFraction } from '../utils/shareHelpers';
import { useInitialShareParams, useUrlWriter } from '../components/explorer/useUrlState';
import { ShareMenu } from '../components/explorer/ShareMenu';
import type { GlobeShareApi, GlobeShareBridge, GlobeShareInitial, GlobeViewReport } from '../components/explorer/shareBridge';
import { DetectionList } from '../components/explorer/DetectionList';
import { FOCUS_TARGET_IDS, GlobeSlots, PanelSectionId } from '../components/explorer/types';
import type { Area } from '../utils/area';
import type { DataSourceDecision } from '../utils/dataSource';
import type { AnalysisOverlay } from '../utils/geoOverlays';
import type { DataSourceMode } from './CalendarPage';
import { historyApi } from '../api/history';

interface HotspotExplorerPageProps {
  /** THE area of the app; the chips and the place search change it. */
  area: Area;
  selectedArea?: Area | null;
  onAreaChange: (area: Area) => void;
  /** A date picked in the Calendar (live detections of that day, current area), or null. */
  pinnedDate: string | null;
  onClearPinnedDate: () => void;
  /** Bumped by other pages ("Area: … · Change on map"): opens the Area section. */
  openAreaRequest?: number;
  /** Detections the app already loaded for `area`: the map's archive fallback when live data is unavailable. */
  archiveObservations?: CanonicalObservation[];
  /** A candidate group selected in the AI panel: fly the map to its centroid. */
  focusCluster?: { latitude: number; longitude: number; nonce: number } | null;
  /** A hotspot clicked on the map and sent to the AI Investigator evidence card. */
  onExplainWithAi?: (observation: CanonicalObservation) => void;
  /** Server-derived density or candidate-group geometry to draw on the existing map. */
  analysisOverlay?: AnalysisOverlay | null;
  onClearAnalysisOverlay?: () => void;
  /** Live = 5-day NRT window; Historical = local 2000-2025 archive day picker. */
  sourceMode?: DataSourceMode;
  historicalDate?: string | null;
  onSourceModeChange?: (mode: DataSourceMode) => void;
  onHistoricalDateChange?: (date: string | null) => void;
  filters?: FilterState;
}

const SMALL_QUERY = '(max-width: 639px)';
/** Panel width (w-80) plus its left margin: the camera centres on what is left of it. */
const PANEL_INSET_PX = 336;
const BOTTOM_INSET_DESKTOP_PX = 200;
const BOTTOM_INSET_SMALL_PX = 270;
/** Moderate lift when timeline is open: clears the timeline card without pushing the globe off the top */
const TIMELINE_BOTTOM_LIFT_PX = 70;

export const HotspotExplorerPage: React.FC<HotspotExplorerPageProps> = ({
  area,
  selectedArea,
  onAreaChange,
  pinnedDate,
  onClearPinnedDate,
  openAreaRequest = 0,
  archiveObservations = [],
  focusCluster = null,
  onExplainWithAi,
  analysisOverlay = null,
  onClearAnalysisOverlay,
  sourceMode = 'live',
  historicalDate = null,
  onSourceModeChange,
  onHistoricalDateChange,
  filters,
}) => {
  // Live detections currently on the map (the globe decides what is available; see utils/dataSource.ts).
  const [observations, setObservations] = useState<CanonicalObservation[]>([]);
  const [sourceLabel, setSourceLabel] = useState('');
  const onDataSource = useCallback((_d: DataSourceDecision, label: string) => setSourceLabel(label), []);

  // Share link: read once, on mount, and applied before the map loads anything (FireGlobe gets it as its
  // initial camera / days / layers / view). The timeline position is applied after the first data load (below).
  const urlInit = useInitialShareParams();
  const [shareInitial] = useState<GlobeShareInitial | null>(() =>
    urlInit.fromUrl
      ? {
          camera: urlInit.hasCamera
            ? { lat: urlInit.state.lat, lng: urlInit.state.lng, zoom: urlInit.state.zoom }
            : undefined,
          days: urlInit.hasDays ? urlInit.state.days : undefined,
          layers: urlInit.hasLayers ? urlInit.state.layers : undefined,
          view: urlInit.hasView ? (urlInit.state.view ?? 'globe') : undefined,
        }
      : null
  );
  // Latest view reported by the map (set when a move ends or a layer / day / basemap / view changes).
  const [mapReport, setMapReport] = useState<GlobeViewReport | null>(null);
  const shareApiRef = useRef<GlobeShareApi | null>(null);
  const shareBridge = useMemo<GlobeShareBridge>(
    () => ({ initial: shareInitial, onViewChange: setMapReport, apiRef: shareApiRef }),
    [shareInitial]
  );

  const [selectedObs, setSelectedObs] = useState<CanonicalObservation | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const pageSize = 8;

  const filtered = observations.filter((obs) => {
    if (!searchTerm) return true;
    const term = searchTerm.toLowerCase();
    return (
      obs.satellite.toLowerCase().includes(term) ||
      obs.sensor.toLowerCase().includes(term) ||
      obs.acq_date.includes(term) ||
      obs.source_record_id.toLowerCase().includes(term)
    );
  });

  const totalPages = Math.ceil(filtered.length / pageSize) || 1;
  const pagedList = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  // ---------------------------------------------------------------------------
  // Layout shell (UI-only state)
  // Two dedicated panels: one for Area & Search, one for Map View & Layers
  // ---------------------------------------------------------------------------
  const [areaPanelOpen, setAreaPanelOpen] = useState(false);
  const [mapViewPanelOpen, setMapViewPanelOpen] = useState(false);
  const [focusReq, setFocusReq] = useState<{ id: string; n: number } | null>(null);
  const hint = useFirstRunHint();

  const areaPanelRef = useRef<HTMLElement>(null);
  const mapViewPanelRef = useRef<HTMLElement>(null);
  const openControlsRef = useRef<HTMLButtonElement>(null);
  const helpRef = useRef<HTMLButtonElement>(null);
  const harmonizeBtnRef = useRef<HTMLButtonElement>(null);
  const [harmonizeOpen, setHarmonizeOpen] = useState(false);

  // Timeline (UI-only). It reads the loaded observations but never changes what Harmonize, the list or the
  // export receive: only FireGlobe gets a display cutoff. Computed only while the bar is open.
  const timelineBtnRef = useRef<HTMLButtonElement>(null);
  // A link with a timeline position opens the bar; the position itself is applied once data has loaded.
  const [timelineOpen, setTimelineOpen] = useState(urlInit.hasTimeline);
  const shareBtnRef = useRef<HTMLButtonElement>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [timelineBarH, setTimelineBarH] = useState(0);
  const timelineAxis = useMemo(
    () => (timelineOpen ? buildTimelineAxis(observations, Date.now()) : null),
    [timelineOpen, observations]
  );
  const timelineIndex = useMemo(
    () => (timelineAxis ? indexTimeline(observations, timelineAxis) : null),
    [timelineAxis, observations]
  );
  // A new axis (new area / new data) resets playback to the last step, paused.
  const playback = useTimelinePlayback(timelineAxis?.steps.length ?? 0, timelineAxis);
  const timeCutoffMs =
    timelineAxis && timelineAxis.steps.length > 0 ? stepCutoffMs(timelineAxis, playback.step) : null;

  // Timeline position from the link: applied once, after the first axis with data exists (clamped to its range).
  const [timelineApplied, setTimelineApplied] = useState(!urlInit.hasTimeline);
  const timelineStepCount = timelineAxis?.steps.length ?? 0;
  useEffect(() => {
    if (timelineApplied) return;
    if (!timelineOpen) {
      setTimelineApplied(true); // the user closed it before data arrived: nothing to apply
      return;
    }
    if (timelineStepCount === 0) return;
    playback.seek(timelineStepFromFraction(urlInit.state.timeline, timelineStepCount));
    setTimelineApplied(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timelineApplied, timelineOpen, timelineStepCount]);

  // Keep the address bar in step with the map (debounced replaceState). While the link's timeline position
  // is still pending, the URL keeps that value instead of the not-yet-applied default.
  const urlTimeline = timelineOpen
    ? timelineStepCount > 0
      ? timelineApplied
        ? timelineFractionFromStep(playback.step, timelineStepCount)
        : urlInit.state.timeline
      : timelineApplied
        ? null
        : urlInit.state.timeline
    : null;
  useUrlWriter({
    enabled: true,
    view: mapReport,
    timeline: urlTimeline,
    aoi: area.polygon,
    suspended: playback.playing,
  });

  // Visible detections = ALL detections on the map whose sensor layer is on and, with a timeline cutoff, with
  // time <= cutoff. Harmonize and the detection list keep receiving all of them.
  const visibleDetections = useMemo(
    () => (shareOpen ? selectVisibleDetections(observations, mapReport?.layers ?? ['modis', 'viirs'], timeCutoffMs) : []),
    [shareOpen, observations, mapReport, timeCutoffMs]
  );

  // Portal targets for FireGlobe's controls
  const [slotArea, setSlotArea] = useState<HTMLElement | null>(null);
  const [slotMapView, setSlotMapView] = useState<HTMLElement | null>(null);
  const slots = useMemo<GlobeSlots>(() => ({ area: slotArea, mapView: slotMapView }), [slotArea, slotMapView]);

  // Fill the viewport below the (sticky) top bar. Its height differs between the wide and narrow
  // layouts, so measure it instead of hard-coding it.
  const [topOffset, setTopOffset] = useState(64);
  useEffect(() => {
    const header = document.querySelector('header');
    if (!header) return;
    const measure = () => setTopOffset(Math.round(header.getBoundingClientRect().height));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(header);
    return () => ro.disconnect();
  }, []);

  // The explorer owns the whole screen: stop the page behind it from scrolling.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  useEffect(() => {
    if (!focusReq) return;
    document.getElementById(focusReq.id)?.focus();
  }, [focusReq]);

  // Another page or Navbar asked to change the area on the map: open the Area panel.
  useEffect(() => {
    if (openAreaRequest <= 0) return;
    setAreaPanelOpen(true);
    setMapViewPanelOpen(false);
    setFocusReq((r) => ({ id: FOCUS_TARGET_IDS.area, n: (r?.n ?? 0) + 1 }));
  }, [openAreaRequest]);

  const isSmall = () => window.matchMedia(SMALL_QUERY).matches;

  // Space the panel and the bottom stack take, so the camera centres on the rest.
  const [small, setSmall] = useState(() => (typeof window !== 'undefined' ? isSmall() : false));
  useEffect(() => {
    const mql = window.matchMedia(SMALL_QUERY);
    const on = () => setSmall(mql.matches);
    mql.addEventListener('change', on);
    return () => mql.removeEventListener('change', on);
  }, []);
  const insets = useMemo(
    () => ({
      left: 0,
      bottom:
        (small ? BOTTOM_INSET_SMALL_PX : BOTTOM_INSET_DESKTOP_PX) +
        (timelineOpen ? TIMELINE_BOTTOM_LIFT_PX : 0),
    }),
    [small, timelineOpen]
  );

  // On phones a selected detection opens the inspector sheet; make room for it.
  useEffect(() => {
    if (selectedObs && isSmall()) {
      setAreaPanelOpen(false);
      setMapViewPanelOpen(false);
    }
  }, [selectedObs]);

  useEffect(() => {
    setCurrentPage(1);
  }, [observations]);

  const closeHarmonize = useCallback(() => {
    setHarmonizeOpen(false);
    requestAnimationFrame(() => harmonizeBtnRef.current?.focus());
  }, []);

  const closeShare = useCallback(() => {
    setShareOpen(false);
    requestAnimationFrame(() => shareBtnRef.current?.focus());
  }, []);

  const closeTimeline = useCallback(() => {
    setTimelineOpen(false);
    setTimelineBarH(0);
    playback.reset();
    requestAnimationFrame(() => timelineBtnRef.current?.focus());
  }, [playback]);

  const onToolbar = (action: ToolbarAction) => {
    if (action === 'share') {
      if (shareOpen) closeShare();
      else setShareOpen(true);
      return;
    }
    if (action === 'timeline') {
      if (timelineOpen) {
        closeTimeline();
        return;
      }
      if (window.matchMedia('(max-width: 767px)').matches) {
        setAreaPanelOpen(false);
        setMapViewPanelOpen(false);
      }
      setTimelineOpen(true);
      return;
    }
    if (action === 'harmonize') {
      if (harmonizeOpen) {
        closeHarmonize();
        return;
      }
      setHarmonizeOpen(true);
      return;
    }
    if (action === 'help') {
      hint.open();
      return;
    }
    if (action === 'mapview') {
      if (mapViewPanelOpen) {
        setMapViewPanelOpen(false);
      } else {
        setMapViewPanelOpen(true);
        setAreaPanelOpen(false);
        setFocusReq((r) => ({ id: FOCUS_TARGET_IDS.mapview, n: (r?.n ?? 0) + 1 }));
      }
      return;
    }
    if (action === 'area') {
      if (areaPanelOpen) {
        setAreaPanelOpen(false);
      } else {
        setAreaPanelOpen(true);
        setMapViewPanelOpen(false);
        setFocusReq((r) => ({ id: FOCUS_TARGET_IDS.area, n: (r?.n ?? 0) + 1 }));
      }
      return;
    }
  };

  const dismissHint = () => {
    hint.dismiss();
    helpRef.current?.focus();
  };

  return (
    <div
      className="explorer-shell fixed inset-x-0 bottom-0 z-40 overflow-hidden bg-canvas"
      style={{ top: topOffset, '--timeline-h': `${timelineOpen ? timelineBarH + 8 : 0}px` } as React.CSSProperties}
    >
      <h1 className="sr-only">Interactive Hotspot Explorer</h1>

      {/* The one map: 3D Globe or World map (same instance, only the projection changes) */}
      <div className="absolute inset-0">
        <FireGlobe
          area={area}
          selectedArea={selectedArea}
          onAreaChange={onAreaChange}
          archiveObservations={archiveObservations}
          pinnedDate={pinnedDate}
          historicalDate={sourceMode === 'historical' ? historicalDate : null}
          onClearPinnedDate={onClearPinnedDate}
          onObservationsChange={setObservations}
          onDataSourceChange={onDataSource}
          selectedObservation={selectedObs}
          onSelectObservation={(obs) => setSelectedObs(obs)}
          focusCluster={focusCluster}
          onExplainWithAi={onExplainWithAi}
          analysisOverlay={analysisOverlay}
          onClearAnalysisOverlay={onClearAnalysisOverlay}
          slots={slots}
          timeCutoffMs={timeCutoffMs}
          timelineOpen={timelineOpen}
          share={shareBridge}
          insets={insets}
          filters={filters}
        />
      </div>

      {/* Live | Historical source switch + archive date picker */}
      {onSourceModeChange && (
        <div className="absolute z-20 top-2.5 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-surface/90 backdrop-blur-md border border-line rounded-control px-2 py-1.5 shadow-elev-2">
          <div className="inline-flex rounded-control border border-line overflow-hidden" role="group" aria-label="Data source">
            {(['live', 'historical'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => onSourceModeChange(m)}
                className={`px-2.5 py-1 text-2xs font-semibold transition-colors ${
                  sourceMode === m ? 'bg-accent text-accent-fg' : 'bg-surface text-fg-muted hover:text-fg'
                }`}
              >
                {m === 'live' ? 'Live' : 'Historical'}
              </button>
            ))}
          </div>
          {sourceMode === 'historical' && onHistoricalDateChange && (
            <HistoricalDatePicker value={historicalDate} onChange={onHistoricalDateChange} />
          )}
        </div>
      )}

      {/* Re-open button while panels are collapsed */}
      {!areaPanelOpen && !mapViewPanelOpen && (
        <button
          ref={openControlsRef}
          type="button"
          onClick={() => setAreaPanelOpen(true)}
          aria-label="Open area and search controls"
          className="absolute z-20 left-2.5 top-2.5 min-h-touch min-w-touch inline-flex items-center justify-center rounded-control bg-surface/40 hover:bg-surface/60 backdrop-blur-md border border-line-strong/40 text-accent shadow-elev-2 transition-colors cursor-pointer"
        >
          <SlidersHorizontal className="h-5 w-5" aria-hidden="true" />
        </button>
      )}

      {/* 1. Dedicated Area & Search Panel */}
      <ExplorerPanel
        ref={areaPanelRef}
        title="Area & Search"
        open={areaPanelOpen}
        onClose={() => setAreaPanelOpen(false)}
      >
        <div id="panel-section-area" className="p-3">
          <div ref={setSlotArea} />
        </div>
      </ExplorerPanel>

      {/* 2. Dedicated Map View & Layers Panel */}
      <ExplorerPanel
        ref={mapViewPanelRef}
        title="Map View & Layers"
        open={mapViewPanelOpen}
        onClose={() => setMapViewPanelOpen(false)}
      >
        <div id="panel-section-mapview" className="p-3 space-y-4">
          <div>
            <div ref={setSlotMapView} />
          </div>
          <div className="pt-3 border-t border-line">
            <h3 className="text-xs font-semibold text-fg-subtle uppercase tracking-wider mb-2">
              Detections ({filtered.length.toLocaleString()})
            </h3>
            <DetectionList
              items={pagedList}
              total={filtered.length}
              selectedId={selectedObs?.id}
              searchTerm={searchTerm}
              onSearchTerm={(v) => {
                setSearchTerm(v);
                setCurrentPage(1);
              }}
              page={currentPage}
              totalPages={totalPages}
              pageSize={pageSize}
              onPage={setCurrentPage}
              onInspect={(o) => setSelectedObs(o)}
            />
          </div>
        </div>
      </ExplorerPanel>

      {harmonizeOpen && (
        <HarmonizeDrawer observations={observations} loading={false} sourceLabel={sourceLabel} onClose={closeHarmonize} />
      )}

      {timelineOpen && timelineAxis && timelineIndex && (
        <TimelineBar
          axis={timelineAxis}
          index={timelineIndex}
          step={playback.step}
          playing={playback.playing}
          speedMs={playback.speedMs}
          onToggle={playback.toggle}
          onStepBy={playback.stepBy}
          onSeek={playback.seek}
          onSpeed={playback.setSpeedMs}
          onClose={closeTimeline}
          onHeight={setTimelineBarH}
        />
      )}

      {shareOpen && (
        <ShareMenu
          detections={visibleDetections}
          getView={() => shareApiRef.current?.getView() ?? null}
          timeline={urlTimeline}
          timelineCutoffMs={timeCutoffMs}
          aoi={area.polygon}
          capture={() =>
            shareApiRef.current ? shareApiRef.current.capture() : Promise.reject(new Error('The map is not ready.'))
          }
          anchorRef={shareBtnRef}
          onClose={closeShare}
        />
      )}

      <ExplorerToolbar
        onAction={onToolbar}
        helpButtonRef={helpRef}
        harmonizeButtonRef={harmonizeBtnRef}
        harmonizeOpen={harmonizeOpen}
        onHarmonizePrefetch={prefetchHarmonize}
        timelineButtonRef={timelineBtnRef}
        timelineOpen={timelineOpen}
        shareButtonRef={shareBtnRef}
        shareOpen={shareOpen}
      />

      {hint.visible && <FirstRunHint onDismiss={dismissHint} />}
    </div>
  );
};

/** Archive date picker: bounds come from the real store coverage, not assumptions. */
const HistoricalDatePicker: React.FC<{ value: string | null; onChange: (date: string | null) => void }> = ({
  value,
  onChange,
}) => {
  const [bounds, setBounds] = useState<{ min: string; max: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    historyApi
      .status()
      .then((st) => {
        if (cancelled || !st.available) return;
        const mins = Object.values(st.sensors).map((s) => s.min_date).filter((d): d is string => Boolean(d));
        const maxs = Object.values(st.sensors).map((s) => s.max_date).filter((d): d is string => Boolean(d));
        if (mins.length && maxs.length) {
          setBounds({ min: mins.sort()[0], max: maxs.sort().reverse()[0] });
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  return (
    <input
      type="date"
      value={value ?? ''}
      min={bounds?.min}
      max={bounds?.max}
      onChange={(e) => onChange(e.target.value || null)}
      className="bg-surface border border-line rounded-control px-2 py-1 text-2xs text-fg font-mono"
      aria-label="Historical archive date"
    />
  );
};

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import * as maplibregl from 'maplibre-gl';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import {
  AlertTriangle,
  Globe2,
  Loader2,
  Map as MapIcon,
  MapPin,
  RefreshCw,
  RotateCcw,
  Search,
  X,
} from 'lucide-react';
import { BoundingBox, CanonicalObservation, FilterState } from '../../types/fire';
import { useViewportFires, ViewportState } from '../../hooks/useViewportFires';
import { useHistoricalFires } from '../../hooks/useHistoricalFires';
import type { Area } from '../../utils/area';
import { areaFromPlace, areaFromQuickRegion } from '../../utils/area';
import { dataSourceChipText, dataSourceLabel, decideDataSource, type DataSourceDecision } from '../../utils/dataSource';
import { SENSOR_COLOR, SENSOR_NAMES, type SensorName } from '../../utils/sensorStyle';
import { countBySensor, snapDays } from '../../utils/shareHelpers';
import type { MapView } from '../../utils/urlState';
import {
  POINTS_FADE_START_ZOOM,
  POINTS_FULL_ZOOM,
  clusterClickLayerId,
  clusterSourceId,
  fireLayerIds,
  fireLayers,
  fireSources,
  heatSourceId,
  pointClickLayerId,
  sensorLayerIds,
} from '../explorer/fireLayers';
import { ExplorerLegend, SensorSwatch } from '../explorer/ExplorerLegend';
import {
  bboxFromSamples,
  bboxesKey,
  bboxesSpan,
  MAX_LOAD_SPAN_DEG,
  MIN_LOAD_ZOOM,
  minZoomForLngSpan,
  shouldLoadViewport,
  viewportToBboxes,
} from '../../utils/geo';
import { FIRE_BIOME_GROUPS, QUICK_REGIONS, QuickRegion } from '../../utils/fireRegions';
import { GeocodeError, NOMINATIM_ATTRIBUTION, PlaceResult, searchPlaces } from '../../utils/geocode';
import { GlobeInspector } from './GlobeInspector';
import { FOCUS_TARGET_IDS, GlobeSlots } from '../explorer/types';
import {
  BasemapDef,
  BasemapId,
  DEFAULT_BASEMAP,
  FALLBACK_NOTICE,
  FIRST_FIRE_LAYER_ID,
  buildBasemap,
  nextErrorCount,
  satelliteDate,
  shouldFallBackToDark,
} from '../explorer/basemap';
import { BasemapNotice, BasemapSwitcher } from '../explorer/BasemapSwitcher';
import { canStepGibsDate, stepGibsDate } from '../../utils/gibs';
import { observationsAtOrBefore } from '../../utils/timeline';
import type { GlobeShareBridge, GlobeViewReport } from '../explorer/shareBridge';
import {
  ANALYSIS_FILL_LAYER_ID,
  ANALYSIS_LINE_LAYER_ID,
  ANALYSIS_SOURCE_ID,
  type AnalysisOverlay,
} from '../../utils/geoOverlays';

// Vite pre-bundles maplibre-gl, so its default worker path breaks ("Worker failed to load").
// Point MapLibre at the real worker file explicitly (the worker must be loaded explicitly).
maplibregl.setWorkerUrl(maplibreWorkerUrl);

const SENSORS = SENSOR_NAMES;
type Sensor = SensorName;
const DAY_OPTIONS: readonly number[] = [1, 2, 3, 5];

// Home views. The map camera is padded by the space the panel / legend / toolbar take (see `insets`), so these
// are zooms for the free area; the whole globe fits in it (checked at 1440x900 and 390x844).
const HOME_CENTER: [number, number] = [60, 20];
const HOME_ZOOM_DESKTOP = 1.7;
const HOME_ZOOM_SMALL = 0.75;
const WORLD_HOME_CENTER: [number, number] = [15, 20];
const WORLD_HOME_ZOOM_DESKTOP = 1.0;
const WORLD_HOME_ZOOM_SMALL = 0.2;
/** Space (px) the explorer UI takes inside the map, so the camera centres on what is left. */
export interface MapInsets {
  left: number;
  bottom: number;
}
const VIEWPORT_DEBOUNCE_MS = 600;
const SPIN_STEP_MS = 2000;
const SPIN_DEG_PER_STEP = 12; // 6 deg/s: one turn per minute
const SPIN_MAX_ZOOM = 3;
const SMALL_SCREEN_CAP = 8000; // max detections per satellite source on phones

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia(query).matches : false
  );
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

const EMPTY_FC = { type: 'FeatureCollection' as const, features: [] };

/** Registers the fire sources and layers (definitions: components/explorer/fireLayers.ts). */
function addFireLayers(map: maplibregl.Map, small: boolean): void {
  for (const src of fireSources(small)) {
    map.addSource(src.id, {
      type: 'geojson',
      data: EMPTY_FC,
      attribution: 'Fire data: NASA FIRMS',
      ...(src.cluster ? { cluster: true, clusterMaxZoom: src.clusterMaxZoom, clusterRadius: src.clusterRadius } : {}),
    });
  }
  for (const layer of fireLayers(small)) {
    map.addLayer(layer as unknown as maplibregl.LayerSpecification);
  }
}

interface FireGlobeProps {
  /** THE area of the app (chips and place search set it). */
  area: Area;
  selectedArea?: Area | null;
  onAreaChange: (area: Area) => void;
  /** Archive detections for `area` and the active date range: shown when live data is unavailable or empty. */
  archiveObservations: CanonicalObservation[];
  /** A date picked in the Calendar: the archive of that day is shown (and flown to) until cleared. */
  pinnedDate: string | null;
  /**
   * Historical mode: a real archive date (YYYY-MM-DD). When set, the map draws
   * detections from the local historical store for that day instead of live FIRMS.
   */
  historicalDate?: string | null;
  onClearPinnedDate: () => void;
  /** Receives the detections currently on the map (live or archive) for the list, Harmonize and Share. */
  onObservationsChange?: (observations: CanonicalObservation[]) => void;
  /** Receives where those detections come from (and the live window), for labels outside the map. */
  onDataSourceChange?: (decision: DataSourceDecision, label: string) => void;
  selectedObservation?: CanonicalObservation | null;
  onSelectObservation?: (observation: CanonicalObservation) => void;
  /** Opens a clicked detection in the AI Investigator evidence card. */
  onExplainWithAi?: (observation: CanonicalObservation) => void;
  /** A candidate group selected in the AI panel: fly the map to its centroid. */
  focusCluster?: { latitude: number; longitude: number; nonce: number } | null;
  /** Server-derived density cells or candidate-group boxes. The map only draws this geometry. */
  analysisOverlay?: AnalysisOverlay | null;
  onClearAnalysisOverlay?: () => void;
  /** Where to render the area / map-view controls (the explorer side panel); state stays in this component. */
  slots?: GlobeSlots;
  /**
   * Timeline cutoff (epoch ms). When a number, only detections at or before it are drawn. null / omitted: the
   * normal, unfiltered view. Display only: it never re-fetches, moves the camera or touches layer toggles.
   */
  timeCutoffMs?: number | null;
  /** Whether the timeline playback bar is open: when open, the legend is hidden to keep the globe clear. */
  timelineOpen?: boolean;
  /** Share / URL bridge (initial view from a link, view-change reports, imperative handle). Optional. */
  share?: GlobeShareBridge;
  /** Space the panel and bottom stack take, so the camera centres on the free area. */
  insets?: MapInsets;
  /**
   * App-level filters applied as client-side post-filters on fetched observations, so the map stays
   * consistent with the hotspot list, analytics, and calendar pages.
   */
  filters?: FilterState;
}

export const FireGlobe: React.FC<FireGlobeProps> = ({
  area,
  selectedArea,
  onAreaChange,
  archiveObservations,
  pinnedDate,
  historicalDate = null,
  onClearPinnedDate,
  onObservationsChange,
  onDataSourceChange,
  selectedObservation,
  onSelectObservation,
  onExplainWithAi,
  focusCluster,
  analysisOverlay = null,
  onClearAnalysisOverlay,
  slots,
  timeCutoffMs = null,
  timelineOpen = false,
  share,
  insets = { left: 0, bottom: 0 },
  filters,
}) => {
  const small = useMediaQuery('(max-width: 640px)');
  const smallRef = useRef(small);
  smallRef.current = small;

  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const spinningRef = useRef(false);
  /** After a programmatic jump: how many times we may still zoom in to make the landed view loadable. */
  const pendingFitRef = useRef(0);
  const viewportTimerRef = useRef<number | undefined>(undefined);
  const obsByIdRef = useRef<Map<string, CanonicalObservation>>(new Map());
  const inspectorIdRef = useRef<string | null>(null);
  const onSelectRef = useRef(onSelectObservation);
  onSelectRef.current = onSelectObservation;

  const [initialBasemap] = useState<BasemapDef>(() => buildBasemap(DEFAULT_BASEMAP));
  const [basemap, setBasemap] = useState<BasemapId>(DEFAULT_BASEMAP);
  // Satellite imagery day (UTC). Defaults to the newest allowed day, the same one initialBasemap uses.
  const [imageryDate, setImageryDate] = useState<string>(() => satelliteDate());
  const [basemapNotice, setBasemapNotice] = useState<string | null>(null);
  const appliedBasemapRef = useRef<BasemapDef>(initialBasemap);
  const tileErrorsRef = useRef(0);

  const [mapReady, setMapReady] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  const [viewport, setViewport] = useState<ViewportState | null>(null);
  // View handed in from a share link: read once, before anything loads.
  const initialRef = useRef(share?.initial ?? null);
  const shareRef = useRef(share);
  shareRef.current = share;
  const [days, setDays] = useState<number>(() =>
    initialRef.current?.days !== undefined ? snapDays(initialRef.current.days, DAY_OPTIONS) : 1
  );

  // 3D Globe or flat World map: one map instance, only the projection changes.
  const [view, setView] = useState<MapView>(() => initialRef.current?.view ?? 'globe');
  const viewRef = useRef(view);
  viewRef.current = view;
  const [sensorOn, setSensorOn] = useState<Record<Sensor, boolean>>(() => {
    const l = initialRef.current?.layers;
    return l ? { MODIS: l.includes('modis'), VIIRS: l.includes('viirs') } : { MODIS: true, VIIRS: true };
  });
  const [inspector, setInspector] = useState<CanonicalObservation | null>(null);

  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [places, setPlaces] = useState<PlaceResult[]>([]);
  const searchAbortRef = useRef<AbortController | null>(null);

  const fires = useViewportFires(viewport, days, small ? SMALL_SCREEN_CAP : undefined);
  const historical = useHistoricalFires(
    historicalDate ? viewport : null,
    historicalDate,
    small ? SMALL_SCREEN_CAP : undefined
  );

  // Which detections are on the map: live NASA FIRMS for the view, or the archive (see utils/dataSource.ts).
  // On the initial/global view when no place is selected and zoomed out, bundled sample data is not loaded onto the globe.
  const isGlobalView = (!selectedArea || fires.needsZoom) && !pinnedDate && fires.observations.length === 0;

  const archiveForView = useMemo(() => {
    if (isGlobalView) return [];
    return pinnedDate ? archiveObservations.filter((o) => o.acq_date === pinnedDate) : archiveObservations;
  }, [archiveObservations, pinnedDate, isGlobalView]);

  const decision = useMemo(
    () => decideDataSource({ pinnedDate, liveStatus: fires.status, liveCount: fires.observations.length }),
    [pinnedDate, fires.status, fires.observations.length]
  );
  const rawLoaded = historicalDate
    ? historical.observations
    : pinnedDate
      ? (fires.observations.some((o) => o.acq_date === pinnedDate)
          ? fires.observations.filter((o) => o.acq_date === pinnedDate)
          : archiveForView)
      : decision.source === 'live'
        ? fires.observations
        : archiveForView;

  const loaded = useMemo(() => {
    let result = rawLoaded;
    if (pinnedDate) {
      result = result.filter((o) => o.acq_date === pinnedDate);
    }
    if (filters?.minFRP !== undefined && filters.minFRP > 0) {
      result = result.filter((o) => o.frp_mw == null || o.frp_mw >= filters.minFRP!);
    }
    if (filters?.minConfidence !== undefined && filters.minConfidence > 0) {
      result = result.filter((o) => {
        if (typeof o.confidence === 'number') return o.confidence >= filters.minConfidence!;
        if (o.confidence === 'high' || o.confidence === 'h') return 80 >= filters.minConfidence!;
        if (o.confidence === 'nominal' || o.confidence === 'n') return 50 >= filters.minConfidence!;
        if (o.confidence === 'low' || o.confidence === 'l') return 20 >= filters.minConfidence!;
        return true;
      });
    }
    if (filters?.satellite && filters.satellite !== 'ALL') {
      result = result.filter((o) => o.satellite.toLowerCase() === filters.satellite!.toLowerCase());
    }
    if (filters?.dayNight && filters.dayNight !== 'ALL') {
      result = result.filter((o) => o.daynight === filters.dayNight);
    }
    if (filters?.sensorMode === 'MODIS_ONLY') {
      result = result.filter((o) => o.sensor === 'MODIS');
    } else if (filters?.sensorMode === 'VIIRS_ONLY') {
      result = result.filter((o) => o.sensor === 'VIIRS');
    }
    return result;
  }, [rawLoaded, pinnedDate, filters]);
  const sourceLabel = historicalDate
    ? `Historical archive, ${historicalDate}`
    : isGlobalView
      ? `NASA FIRMS (${days} day${days === 1 ? '' : 's'})`
      : dataSourceLabel(decision, days, pinnedDate);
  const chipText = isGlobalView ? null : dataSourceChipText(decision);

  // The raw server error is for the console only; the user sees the chip.
  useEffect(() => {
    if (fires.status === 'error') console.warn('[FireGlobe] live fire data unavailable:', fires.error);
  }, [fires.status, fires.error]);
  useEffect(() => {
    if (fires.warnings.length) console.warn('[FireGlobe] live fire data warnings:', fires.warnings);
  }, [fires.warnings]);
  const legendNotes = useMemo(() => {
    const n: string[] = [];
    if (historicalDate && historical.truncated) {
      n.push('Very large historical day: only the highest-FRP detections are shown. Zoom in or pick a smaller area for the full picture.');
    }
    if (historicalDate && historical.status === 'error') {
      n.push(`Historical archive query failed: ${historical.error ?? 'unknown error'}`);
    }
    if (decision.source === 'live' && fires.truncated) {
      n.push('Very large result: only the highest-FRP detections per satellite are shown. Zoom in for the full picture.');
    }
    if (decision.source === 'live' && fires.warnings.length) {
      n.push('Some live sources did not answer, so this view may be incomplete.');
    }
    return n;
  }, [decision.source, fires.truncated, fires.warnings, historicalDate, historical.truncated, historical.status, historical.error]);

  // Timeline: the detections up to the cutoff (null when no timeline is active). Recomputed once per step.
  const timeShown = useMemo(
    () => (timeCutoffMs === null ? null : observationsAtOrBefore(loaded, timeCutoffMs)),
    [loaded, timeCutoffMs]
  );
  const loadedCounts = useMemo(() => countBySensor(loaded), [loaded]);
  const shownCounts = useMemo(() => (timeShown ? countBySensor(timeShown) : loadedCounts), [timeShown, loadedCounts]); // per sensor, never summed

  // ---------------------------------------------------------------------------
  // Camera helpers
  // ---------------------------------------------------------------------------
  const stopSpin = useCallback(() => {
    spinningRef.current = false;
  }, []);

  const flyToBbox = useCallback(
    (b: BoundingBox) => {
      const map = mapRef.current;
      if (!map) return;
      stopSpin();
      pendingFitRef.current = 2;
      const east = b.east < b.west ? b.east + 360 : b.east; // crosses the antimeridian
      const cam = map.cameraForBounds(
        [
          [b.west, b.south],
          [east, b.north],
        ],
        { padding: 32, maxZoom: 9 }
      );
      // Make sure the landing view is zoomed in enough for fires to load on this screen width.
      const floor =
        minZoomForLngSpan(map.getContainer().clientWidth, undefined, (b.south + b.north) / 2) + 0.05;
      const zoom = Math.max(cam?.zoom ?? 5, floor);
      const center = cam?.center ?? [(b.west + east) / 2, (b.south + b.north) / 2];
      map.flyTo({ center, zoom, essential: true });
    },
    [stopSpin]
  );

  const flyToPlace = useCallback(
    (p: PlaceResult) => {
      const map = mapRef.current;
      if (!map) return;
      if (p.bbox) flyToBbox(p.bbox);
      else {
        stopSpin();
        pendingFitRef.current = 2;
        map.flyTo({
          center: [p.lng, p.lat],
          zoom: Math.max(8, minZoomForLngSpan(map.getContainer().clientWidth, undefined, p.lat) + 0.05),
          essential: true,
        });
      }
    },
    [flyToBbox, stopSpin]
  );

  // What the share bridge reports. Refs, so the map handlers never see stale values.
  const viewMetaRef = useRef({ days, sensorOn, basemap, imageryDate, view });
  viewMetaRef.current = { days, sensorOn, basemap, imageryDate, view };
  const readView = useCallback((): GlobeViewReport | null => {
    const map = mapRef.current;
    if (!map) return null;
    const c = map.getCenter();
    const m = viewMetaRef.current;
    return {
      lat: c.lat,
      lng: c.lng,
      zoom: map.getZoom(),
      days: m.days,
      layers: SENSORS.filter((s) => m.sensorOn[s]).map((s) => s.toLowerCase() as 'modis' | 'viirs'),
      basemap: m.basemap,
      view: m.view,
      imageryDate: m.imageryDate,
    };
  }, []);
  const reportView = useCallback(() => {
    const v = readView();
    if (v) shareRef.current?.onViewChange?.(v);
  }, [readView]);

  // One repaint, then read the canvas inside that same render event (the only moment its pixels are valid
  // without preserveDrawingBuffer). Uses public API only: triggerRepaint + a one-off 'render' listener.
  const captureCanvas = useCallback(
    () =>
      new Promise<HTMLCanvasElement>((resolve, reject) => {
        const map = mapRef.current;
        if (!map) {
          reject(new Error('The map is not ready.'));
          return;
        }
        const timer = window.setTimeout(() => {
          map.off('render', onRender);
          reject(new Error('No frame was painted in time.'));
        }, 4000);
        function onRender() {
          window.clearTimeout(timer);
          try {
            const src = map!.getCanvas();
            const copy = document.createElement('canvas');
            copy.width = src.width;
            copy.height = src.height;
            const ctx = copy.getContext('2d');
            if (!ctx) throw new Error('2D canvas not available.');
            ctx.drawImage(src, 0, 0);
            resolve(copy);
          } catch (e) {
            reject(e);
          }
        }
        map.once('render', onRender);
        map.triggerRepaint();
      }),
    []
  );

  const spinStep = useCallback(() => {
    const map = mapRef.current;
    if (!map || !spinningRef.current) return;
    if (map.getZoom() > SPIN_MAX_ZOOM) {
      spinningRef.current = false;
      return;
    }
    const c = map.getCenter();
    map.easeTo({ center: [c.lng + SPIN_DEG_PER_STEP, c.lat], duration: SPIN_STEP_MS, easing: (t) => t });
  }, []);

  const resetView = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    setInspector(null);
    inspectorIdRef.current = null;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const globe = viewRef.current === 'globe';
    spinningRef.current = globe && !reduced; // the flat map never spins
    map.flyTo({
      center: globe ? HOME_CENTER : WORLD_HOME_CENTER,
      zoom: globe
        ? smallRef.current
          ? HOME_ZOOM_SMALL
          : HOME_ZOOM_DESKTOP
        : smallRef.current
          ? WORLD_HOME_ZOOM_SMALL
          : WORLD_HOME_ZOOM_DESKTOP,
      essential: true,
    });
  }, []);

  // ---------------------------------------------------------------------------
  // Map setup (once)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const container = containerRef.current;
    if (!container || mapRef.current) return;

    const style: maplibregl.StyleSpecification = {
      version: 8,
      projection: { type: initialRef.current?.view === 'map' ? 'mercator' : 'globe' },
      sky: {
        'sky-color': '#0b1d4a',
        'horizon-color': '#3b82f6',
        'fog-color': '#0b1220',
        'sky-horizon-blend': 0.6,
        'horizon-fog-blend': 0.6,
        'fog-ground-blend': 0.5,
        'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 5, 1, 7, 0],
      },
      // Initial basemap (Satellite by default). Fire layers are added later, so they sit above it.
      // The 'globe-underlay' raster sits below the GIBS layer and has global coverage, so it fills
      // any areas where GIBS daily True Color tiles are missing (e.g. the North Pole swath gap).
      sources: {
        'globe-underlay': {
          type: 'raster',
          tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}'],
          tileSize: 256,
          maxzoom: 16,
          attribution: '',
        },
        [initialBasemap.sourceId]: initialBasemap.source,
      },
      layers: [
        { id: 'space', type: 'background', paint: { 'background-color': '#0a1020' } },
        // Always-on global underlay: covers polar/incomplete GIBS areas
        { id: 'globe-underlay', type: 'raster', source: 'globe-underlay', paint: { 'raster-opacity': 1 } },
        initialBasemap.layer,
      ],
    };

    let map: maplibregl.Map;
    try {
      map = new maplibregl.Map({
        container,
        style,
        // A share link may carry the camera; otherwise the normal home view.
        center: initialRef.current?.camera
          ? [initialRef.current.camera.lng, initialRef.current.camera.lat]
          : HOME_CENTER,
        zoom:
          initialRef.current?.camera?.zoom ?? (smallRef.current ? HOME_ZOOM_SMALL : HOME_ZOOM_DESKTOP),
        maxPitch: 0, // no tilting in either view: the globe and the World map are both north-up
        dragRotate: false,
        // Always-visible credits (NASA GIBS, NASA FIRMS, basemap): a strip along the bottom edge, not a hidden (i).
        attributionControl: { compact: false },
      });
    } catch (e) {
      setMapError(e instanceof Error ? e.message : 'The 3D globe could not start.');
      return;
    }
    mapRef.current = map;

    map.touchZoomRotate.disableRotation();
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

    // Visible area measured from unprojected screen points (corners, edge midpoints, centre).
    const measureViewport = () => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      const samples = [0, 0.5, 1].flatMap((fx) =>
        [0, 0.5, 1].map((fy) => map.unproject([fx * w, fy * h]))
      );
      const box = bboxFromSamples(samples, map.getCenter().lng);
      const b = map.getBounds();
      return viewportToBboxes(
        box ?? { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() }
      );
    };
    // The globe shows more longitude per zoom level than a flat map, and it varies with latitude,
    // so instead of predicting it: if a jump landed on a view that is too wide to load, zoom in by
    // exactly the measured excess (at most twice).
    const nudgeIfTooWide = (): boolean => {
      const boxes = measureViewport();
      const zoom = map.getZoom();
      if (shouldLoadViewport(zoom, boxes)) {
        pendingFitRef.current = 0;
        return false;
      }
      const { lngSpan, latSpan } = bboxesSpan(boxes);
      const excess = Math.max(lngSpan, latSpan) / (MAX_LOAD_SPAN_DEG * 0.85);
      const target = Math.max(zoom + Math.log2(Math.max(excess, 1)), MIN_LOAD_ZOOM + 0.1);
      pendingFitRef.current -= 1;
      if (target - zoom < 0.02) return false;
      map.easeTo({ zoom: target, duration: 600 });
      return true;
    };
    const computeViewport = () => {
      const boxes = measureViewport();
      setViewport({ boxes, zoom: map.getZoom(), key: bboxesKey(boxes) });
    };
    const scheduleViewport = () => {
      window.clearTimeout(viewportTimerRef.current);
      viewportTimerRef.current = window.setTimeout(computeViewport, VIEWPORT_DEBOUNCE_MS);
    };

    // Any user interaction ends the idle rotation.
    for (const ev of ['mousedown', 'touchstart', 'wheel'] as const) map.on(ev, () => stopSpin());
    container.addEventListener('keydown', stopSpin);

    map.on('movestart', () => window.clearTimeout(viewportTimerRef.current));
    map.on('moveend', () => {
      if (spinningRef.current) {
        spinStep(); // idle rotation: keep turning, no data loading while it spins
        return;
      }
      if (pendingFitRef.current > 0 && nudgeIfTooWide()) return;
      reportView();
      scheduleViewport();
    });
    map.on('resize', scheduleViewport);

    map.on('error', (e) => {
      // Tile/glyph hiccups must not break the page; they are logged for debugging.
      console.warn('[FireGlobe] map error:', e.error?.message ?? e);
      // Repeated tile errors on a NASA basemap: switch to Dark so the globe is never blank.
      const active = appliedBasemapRef.current;
      if ((e as unknown as { sourceId?: string }).sourceId !== active.sourceId) return;
      tileErrorsRef.current = nextErrorCount(tileErrorsRef.current, 'error');
      if (shouldFallBackToDark(active.id, tileErrorsRef.current)) {
        tileErrorsRef.current = 0;
        setBasemapNotice(FALLBACK_NOTICE);
        setBasemap('dark');
      }
    });
    // A successfully loaded basemap tile resets the consecutive-error counter.
    map.on('data', (e) => {
      const ev = e as unknown as { dataType?: string; sourceId?: string; tile?: unknown };
      if (ev.dataType === 'source' && ev.tile && ev.sourceId === appliedBasemapRef.current.sourceId) {
        tileErrorsRef.current = nextErrorCount(tileErrorsRef.current, 'ok');
      }
    });

    map.on('load', () => {
      addFireLayers(map, smallRef.current);

      for (const sensor of SENSORS) {
        const src = clusterSourceId(sensor);

        // A click on a cloud (an invisible cluster target) zooms into it.
        map.on('click', clusterClickLayerId(sensor), async (e) => {
          const f = e.features?.[0];
          const clusterId = f?.properties?.cluster_id as number | undefined;
          if (clusterId === undefined || f?.geometry.type !== 'Point') return;
          stopSpin();
          try {
            const zoom = await (map.getSource(src) as maplibregl.GeoJSONSource).getClusterExpansionZoom(clusterId);
            map.easeTo({ center: f.geometry.coordinates as [number, number], zoom: zoom + 1 });
          } catch {
            // cluster may have been re-computed while the user clicked
          }
        });

        map.on('click', pointClickLayerId(sensor), (e) => {
          const f = e.features?.[0];
          // A lone detection is still invisible while zoomed out (cloud only): clicking it zooms in, like a cloud.
          if (map.getZoom() < POINTS_FADE_START_ZOOM && f?.geometry.type === 'Point') {
            stopSpin();
            map.easeTo({ center: f.geometry.coordinates as [number, number], zoom: POINTS_FULL_ZOOM + 0.5 });
            return;
          }
          // Sensors are drawn in order, so the one on top wins: a small VIIRS dot inside a large MODIS pixel
          // opens the VIIRS detection, not the MODIS pixel under it.
          const above = SENSORS.slice(SENSORS.indexOf(sensor) + 1).map(pointClickLayerId);
          if (above.length && map.queryRenderedFeatures(e.point, { layers: above }).length > 0) return;
          const hitId = f?.properties?.id as string | undefined;
          const obs = hitId ? obsByIdRef.current.get(hitId) : undefined;
          if (!obs) return;
          inspectorIdRef.current = obs.id;
          setInspector(obs);
          onSelectRef.current?.(obs);
        });

        for (const layer of [clusterClickLayerId(sensor), pointClickLayerId(sensor)]) {
          map.on('mouseenter', layer, () => (map.getCanvas().style.cursor = 'pointer'));
          map.on('mouseleave', layer, () => (map.getCanvas().style.cursor = ''));
        }
      }

      // Clicking empty globe while zoomed out flies in to that spot.
      map.on('click', (e) => {
        if (map.queryRenderedFeatures(e.point, { layers: fireLayerIds().filter((l) => !!map.getLayer(l)) }).length > 0) return;
        if (map.getZoom() >= MIN_LOAD_ZOOM) return;
        stopSpin();
        map.easeTo({
          center: e.lngLat,
          zoom: Math.max(map.getZoom() + 2, MIN_LOAD_ZOOM + 0.5),
          duration: 900,
        });
      });

      setMapReady(true);
      computeViewport();
      // A view that came from a share link must stay where the link put it (unless it's zoomed out at home level).
      const isHomeZoom = (initialRef.current?.camera?.zoom ?? 0) <= SPIN_MAX_ZOOM;
      if ((!initialRef.current || isHomeZoom) && viewRef.current === 'globe' && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        spinningRef.current = true;
        spinStep();
      }
    });

    return () => {
      window.clearTimeout(viewportTimerRef.current);
      container.removeEventListener('keydown', stopSpin);
      spinningRef.current = false;
      map.remove();
      mapRef.current = null;
      setMapReady(false);
    };
  }, [spinStep, stopSpin, reportView]);

  // Share bridge: imperative handle, and a report when the day range, a sensor layer or the basemap changes.
  const apiRef = share?.apiRef;
  useEffect(() => {
    if (!apiRef) return;
    apiRef.current = { getView: readView, capture: captureCanvas };
    return () => {
      apiRef.current = null;
    };
  }, [apiRef, readView, captureCanvas]);
  const shareKey = `${days}|${sensorOn.MODIS}|${sensorOn.VIIRS}|${basemap}|${view}`;
  const lastShareKeyRef = useRef(shareKey);
  useEffect(() => {
    if (lastShareKeyRef.current === shareKey) return; // unchanged since mount: nothing to report
    lastShareKeyRef.current = shareKey;
    reportView();
  }, [shareKey, reportView]);

  // ---------------------------------------------------------------------------
  // Push detections into the per-sensor sources (properties kept minimal: id + frp)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    obsByIdRef.current = new Map(loaded.map((o) => [o.id, o]));
    onObservationsChange?.(loaded);

    const map = mapRef.current;
    if (!map || !mapReady) return;
    // With a timeline cutoff, setData runs once per step with the filtered features, so the cluster counts
    // are recomputed in the source (layer filters would not update them).
    const shown = timeShown ?? loaded;
    for (const sensor of SENSORS) {
      const data: Parameters<maplibregl.GeoJSONSource['setData']>[0] = {
        type: 'FeatureCollection',
        features: shown
          .filter((o) => o.sensor === sensor)
          .map((o) => ({
            type: 'Feature' as const,
            geometry: { type: 'Point' as const, coordinates: [o.longitude, o.latitude] },
            properties: { id: o.id, frp_mw: o.frp_mw },
          })),
      };
      for (const name of [clusterSourceId(sensor), heatSourceId(sensor)]) {
        (map.getSource(name) as maplibregl.GeoJSONSource | undefined)?.setData(data);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, mapReady, timeShown]);

  // Tell the page what is on the map and where it comes from (labels for Harmonize).
  useEffect(() => {
    onDataSourceChange?.(decision, sourceLabel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [decision, sourceLabel]);

  // 3D Globe <-> World map: the same map instance, only the projection changes. Camera, basemap, layers,
  // timeline cutoff, selection and capture are untouched. The World map is north-up and does not spin.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    map.setProjection({ type: view === 'globe' ? 'globe' : 'mercator' });
    if (view === 'map') {
      spinningRef.current = false;
      map.setPitch(0);
      map.setBearing(0);
    }
    map.triggerRepaint();
  }, [view, mapReady]);

  // The camera centres on the area the panel, legend and toolbar leave free.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    map.easeTo({ padding: { left: insets.left, bottom: insets.bottom, top: 0, right: 0 }, duration: 250 });
  }, [insets.left, insets.bottom, mapReady]);

  // A date pinned from the Calendar: fly to that day's archive detections (or to the area when it has none).
  const areaRef = useRef(area);
  areaRef.current = area;
  const archiveRef = useRef(archiveObservations);
  archiveRef.current = archiveObservations;
  useEffect(() => {
    if (!pinnedDate || !mapReady) return;
    const day = archiveRef.current.filter((o) => o.acq_date === pinnedDate);
    if (day.length === 0) {
      flyToBbox(areaRef.current.bbox);
      return;
    }
    const lats = day.map((o) => o.latitude);
    const lngs = day.map((o) => o.longitude);
    const pad = 0.05;
    flyToBbox({
      west: Math.min(...lngs) - pad,
      east: Math.max(...lngs) + pad,
      south: Math.min(...lats) - pad,
      north: Math.max(...lats) + pad,
    });
  }, [pinnedDate, mapReady, flyToBbox]);

  // Basemap or imagery-date switch: only the base raster source/layer change. Fire sources, layers, data and the
  // camera are not touched. The new layer is inserted below the first fire layer, then the old one is removed.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const prev = appliedBasemapRef.current;
    const next = buildBasemap(basemap, undefined, imageryDate);
    if (prev.sourceId === next.sourceId) return; // same source (the id contains the date): nothing to swap
    if (!map.getSource(next.sourceId)) map.addSource(next.sourceId, next.source);
    if (!map.getLayer(next.layerId)) {
      // Keep the raster below any analysis overlay as well as below the fire layers, so switching
      // the basemap can never paint over the overlay.
      const beforeId = map.getLayer(ANALYSIS_FILL_LAYER_ID)
        ? ANALYSIS_FILL_LAYER_ID
        : map.getLayer(FIRST_FIRE_LAYER_ID)
          ? FIRST_FIRE_LAYER_ID
          : undefined;
      map.addLayer(next.layer, beforeId);
    }
    if (prev.layerId !== next.layerId && map.getLayer(prev.layerId)) map.removeLayer(prev.layerId);
    if (prev.sourceId !== next.sourceId && map.getSource(prev.sourceId)) map.removeSource(prev.sourceId);
    appliedBasemapRef.current = next;
    tileErrorsRef.current = 0;
  }, [basemap, imageryDate, mapReady]);

  // Analysis overlay: exactly the geometry handed over by the Geographic Analysis page. It is inserted
  // below the fire layers (so detections stay clickable) and above the basemap (see the effect above).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    if (!analysisOverlay) {
      if (map.getLayer(ANALYSIS_LINE_LAYER_ID)) map.removeLayer(ANALYSIS_LINE_LAYER_ID);
      if (map.getLayer(ANALYSIS_FILL_LAYER_ID)) map.removeLayer(ANALYSIS_FILL_LAYER_ID);
      if (map.getSource(ANALYSIS_SOURCE_ID)) map.removeSource(ANALYSIS_SOURCE_ID);
      return;
    }

    stopSpin();
    const data = analysisOverlay.geojson as unknown as Parameters<maplibregl.GeoJSONSource['setData']>[0];
    const source = map.getSource(ANALYSIS_SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
    if (source) source.setData(data);
    else map.addSource(ANALYSIS_SOURCE_ID, { type: 'geojson', data });

    const beforeId = map.getLayer(FIRST_FIRE_LAYER_ID) ? FIRST_FIRE_LAYER_ID : undefined;
    const color =
      analysisOverlay.kind === 'density'
        ? '#38bdf8'
        : analysisOverlay.kind === 'agnicells'
          ? '#a78bfa'
          : '#f59e0b';
    if (!map.getLayer(ANALYSIS_FILL_LAYER_ID)) {
      map.addLayer(
        {
          id: ANALYSIS_FILL_LAYER_ID,
          type: 'fill',
          source: ANALYSIS_SOURCE_ID,
          paint: { 'fill-color': color, 'fill-opacity': 0.18 },
        },
        beforeId
      );
    } else {
      map.setPaintProperty(ANALYSIS_FILL_LAYER_ID, 'fill-color', color);
    }
    if (!map.getLayer(ANALYSIS_LINE_LAYER_ID)) {
      map.addLayer(
        {
          id: ANALYSIS_LINE_LAYER_ID,
          type: 'line',
          source: ANALYSIS_SOURCE_ID,
          paint: { 'line-color': color, 'line-width': 1.5, 'line-opacity': 0.95 },
        },
        beforeId
      );
    } else {
      map.setPaintProperty(ANALYSIS_LINE_LAYER_ID, 'line-color', color);
    }

    const bounds = analysisOverlay.bounds;
    if (!bounds) return;
    const [[west, south], [east, north]] = bounds;
    if (east - west <= 180) {
      map.fitBounds(
        [
          [west, south],
          [east, north],
        ],
        { padding: 72, maxZoom: 10, duration: 900 }
      );
      return;
    }
    // A geometry split at ±180° has min/max longitudes 360° apart. Fitting that would zoom out to the
    // whole world, so centre on the first feature's reported centroid instead.
    const first = analysisOverlay.geojson.features[0];
    const lat = Number(first?.properties.centroid_lat ?? first?.properties.center_lat);
    const lon = Number(first?.properties.centroid_lon ?? first?.properties.center_lon);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      map.easeTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), 6), duration: 900 });
    }
  }, [analysisOverlay, mapReady, stopSpin]);

  const chooseBasemap = useCallback((id: BasemapId) => {
    setBasemapNotice(null); // a manual choice (including "try again") clears the notice
    setBasemap(id);
  }, []);

  // Date arrows: one day per tap, clamped. The clock is read here (UI layer), never in the pure helpers.
  const stepImageryDate = useCallback((delta: -1 | 1) => {
    setImageryDate((d) => stepGibsDate(d, delta, { now: new Date() }));
  }, []);
  const canStepBack = canStepGibsDate(imageryDate, -1, { now: new Date() });
  const canStepForward = canStepGibsDate(imageryDate, 1, { now: new Date() });

  // Sensor visibility: switching a sensor off hides all of its layers (cloud, glow, targets, points, ring).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    for (const sensor of SENSORS) {
      for (const layerId of sensorLayerIds(sensor)) {
        if (map.getLayer(layerId)) map.setLayoutProperty(layerId, 'visibility', sensorOn[sensor] ? 'visible' : 'none');
      }
    }
  }, [mapReady, sensorOn]);

  // The page table can select a detection: show it and fly there (not when the click came from the map).
  useEffect(() => {
    if (!selectedObservation) return;
    if (selectedObservation.id === inspectorIdRef.current) return;
    inspectorIdRef.current = selectedObservation.id;
    setInspector(selectedObservation);
    const map = mapRef.current;
    if (map) {
      stopSpin();
      map.flyTo({
        center: [selectedObservation.longitude, selectedObservation.latitude],
        zoom: Math.max(map.getZoom(), 8),
        essential: true,
      });
    }
  }, [selectedObservation, stopSpin]);

  // A candidate group selected in the AI panel: fly the map to its centroid. The nonce makes a
  // repeated click on the same group a new request; the map is never moved without a user action.
  useEffect(() => {
    if (!focusCluster) return;
    const map = mapRef.current;
    if (!map || !mapReady) return;
    stopSpin();
    map.easeTo({
      center: [focusCluster.longitude, focusCluster.latitude],
      zoom: Math.max(map.getZoom(), 9),
      duration: 900,
    });
  }, [focusCluster, mapReady, stopSpin]);

  useEffect(() => () => searchAbortRef.current?.abort(), []);

  // ---------------------------------------------------------------------------
  // Place search
  // ---------------------------------------------------------------------------
  const runSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    if (q.length < 2) {
      setSearchError('Type at least 2 characters.');
      return;
    }
    searchAbortRef.current?.abort();
    const ac = new AbortController();
    searchAbortRef.current = ac;
    setSearching(true);
    setSearchError(null);
    try {
      const found = await searchPlaces(q, ac.signal);
      if (ac.signal.aborted) return;
      setPlaces(found);
      if (found.length === 0) setSearchError(`No place found for "${q}".`);
      else choosePlace(found[0]);
    } catch (err) {
      if (ac.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
      setPlaces([]);
      setSearchError(err instanceof GeocodeError ? err.message : 'Place search failed. Try again.');
    } finally {
      if (!ac.signal.aborted) setSearching(false);
    }
  };

  // Area changes and camera moves go together: the chips and the search set the app's area AND fly there.
  const choosePlace = (p: PlaceResult) => {
    onAreaChange(areaFromPlace(p));
    flyToPlace(p);
  };

  const pickRegion = (r: QuickRegion) => {
    setPlaces([]);
    setSearchError(null);
    onAreaChange(areaFromQuickRegion(r));
    flyToBbox(r.bbox);
  };



  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  const updatedLabel = useMemo(() => {
    if (!fires.retrievedAt) return null;
    const d = new Date(fires.retrievedAt);
    return Number.isNaN(d.getTime())
      ? null
      : d.toLocaleString([], { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' });
  }, [fires.retrievedAt]);

  const showEmpty =
    pinnedDate !== null
      ? archiveForView.length === 0
      : decision.reason === 'live-empty' && archiveForView.length === 0;

  const inSlot = (el: HTMLElement | null | undefined, node: React.ReactNode) =>
    el ? createPortal(node, el) : null;

  const chip =
    'min-h-touch px-3 rounded-full border text-xs font-medium transition-colors';

  return (
    // Fills whatever its parent gives it (the page makes the parent full-viewport).
    // Pitfall kept: the map container below must stay w-full h-full.
    <div
      className="firesync-map relative w-full h-full overflow-hidden [&_.maplibregl-ctrl-group_button]:h-11! [&_.maplibregl-ctrl-group_button]:w-11!"
      style={{ background: 'radial-gradient(ellipse at center, #0b1d4a 0%, #060c1a 70%)' }}
    >
      <div
        ref={containerRef}
        className="w-full h-full"
        tabIndex={0}
        aria-label={`Interactive ${view === 'globe' ? '3D globe' : 'world map'} of satellite fire detections`}
      />

      {mapError && (
        <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-accent bg-canvas/90 z-30">
          <div className="max-w-sm space-y-2">
            <AlertTriangle className="h-6 w-6 mx-auto" aria-hidden="true" />
            <p>The map could not start in this browser (WebGL is needed).</p>
            <p className="text-xs text-fg-muted">{mapError}</p>
          </div>
        </div>
      )}

      {/* Status chips (non-blocking) - positioned below the top-center controls to prevent overlap */}
      <div
        className="absolute top-14 left-1/2 -translate-x-1/2 z-10 flex flex-col items-center gap-2 w-[min(calc(100%-7rem),28rem)] pointer-events-none"
        aria-live="polite"
      >
        {pinnedDate && (
          <div className="pointer-events-auto bg-surface/95 border border-accent/60 text-fg text-xs rounded-full pl-3 pr-1 py-1 flex items-center gap-2 shadow-elev-2">
            <span>
              Showing archive for <span className="numeric font-semibold">{pinnedDate}</span>
            </span>
            <span className="text-fg-muted" aria-hidden="true">
              ·
            </span>
            <button
              type="button"
              onClick={onClearPinnedDate}
              className="min-h-touch px-3 rounded-full bg-raised hover:bg-overlay text-accent font-medium flex items-center gap-1"
            >
              <X className="h-3 w-3" aria-hidden="true" />
              <span>Back to live</span>
            </button>
          </div>
        )}

        {!pinnedDate && !historicalDate && fires.status === 'loading' && (
          <div className="bg-surface/95 border border-accent/40 text-accent text-xs rounded-full px-3 py-1.5 flex items-center gap-2 shadow-elev-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            <span>Loading live fires for this area…</span>
          </div>
        )}
        {chipText && (
          <div
            role="status"
            className="pointer-events-auto bg-surface/95 border border-line-strong text-fg text-xs rounded-full pl-3 pr-1 py-1 flex items-center gap-2 shadow-elev-2"
          >
            <span>{chipText}</span>
            {decision.reason === 'live-error' && (
              <button
                type="button"
                onClick={fires.retry}
                aria-label="Try live data again"
                className="min-h-touch px-3 rounded-full bg-raised hover:bg-overlay flex items-center gap-1 font-medium"
              >
                <RefreshCw className="h-3 w-3" aria-hidden="true" />
                <span>Retry</span>
              </button>
            )}
          </div>
        )}
        {basemapNotice && <BasemapNotice message={basemapNotice} onDismiss={() => setBasemapNotice(null)} />}
        {analysisOverlay && (
          <div
            role="status"
            className="pointer-events-auto max-w-full bg-surface/95 border border-accent/60 text-fg text-xs rounded-full pl-3 pr-1 py-1 flex items-center gap-2 shadow-elev-2"
            title={analysisOverlay.description}
          >
            <MapIcon className="h-3.5 w-3.5 text-accent shrink-0" aria-hidden="true" />
            <span className="truncate">Overlay: {analysisOverlay.title}</span>
            {onClearAnalysisOverlay && (
              <>
                <span className="text-fg-muted shrink-0" aria-hidden="true">
                  ·
                </span>
                <button
                  type="button"
                  onClick={onClearAnalysisOverlay}
                  className="min-h-touch px-3 rounded-full bg-raised hover:bg-overlay text-accent font-medium flex items-center gap-1 shrink-0"
                  aria-label="Clear analysis overlay"
                >
                  <X className="h-3 w-3" aria-hidden="true" />
                  <span>Clear</span>
                </button>
              </>
            )}
          </div>
        )}
        {showEmpty && (
          <div className="bg-surface/95 border border-line-strong text-fg text-xs rounded-card px-3 py-1.5 shadow-elev-2 text-center">
            {pinnedDate
              ? `No archive detections for ${pinnedDate} in this area.`
              : `No fire detections in this area in the last ${days} day${days > 1 ? 's' : ''}.`}
          </div>
        )}
      </div>

      {/* The one legend (counts per sensor, what size and cloud mean) — hidden when timeline is open */}
      {!timelineOpen && (
        <ExplorerLegend
          counts={shownCounts}
          ofCounts={timeShown ? loadedCounts : null}
          sourceLabel={sourceLabel}
          updatedLabel={decision.source === 'live' ? updatedLabel : null}
          cached={fires.cached}
          notes={legendNotes}
          className={inspector ? 'max-sm:hidden' : ''}
        />
      )}

      {inspector && (
        <GlobeInspector
          observation={inspector}
          onExplainWithAi={onExplainWithAi}
          onClose={() => {
            setInspector(null);
            inspectorIdRef.current = null;
          }}
        />
      )}

      {/* Area section: place search, region chips, Reset view */}
      {inSlot(
        slots?.area,
        <div className="space-y-3">
          <form onSubmit={runSearch} className="flex items-stretch gap-2" role="search">
            <div className="relative flex-1 min-w-0">
              <Search className="h-4 w-4 text-fg-subtle absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden="true" />
              <input
                id={FOCUS_TARGET_IDS.area}
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Place or country (e.g. Dhaka)"
                aria-label="Search a place or country"
                className="w-full min-h-touch bg-raised border border-line-strong rounded-control pl-9 pr-3 text-xs text-fg placeholder:text-fg-subtle"
              />
            </div>
            <button
              type="submit"
              disabled={searching}
              className="min-h-touch px-4 rounded-control bg-accent hover:bg-accent-hover disabled:opacity-60 text-accent-fg font-semibold text-xs transition-colors flex items-center gap-1.5"
            >
              {searching ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <MapPin className="h-3.5 w-3.5" aria-hidden="true" />}
              <span>Go</span>
            </button>
          </form>
          {(places.length > 0 || searchError) && (
            <div className="text-xs space-y-1" aria-live="polite">
              {searchError && <div className="text-accent">{searchError}</div>}
              {places.length > 1 && (
                <ul className="space-y-0.5">
                  {places.map((p, i) => (
                    <li key={`${p.lat},${p.lng},${i}`}>
                      <button
                        type="button"
                        onClick={() => choosePlace(p)}
                        className="w-full min-h-touch text-left px-2 rounded-control text-fg hover:bg-raised truncate"
                        title={p.name}
                      >
                        {i === 0 && <span className="text-accent mr-1" aria-hidden="true">●</span>}
                        {p.name}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {places.length > 0 && <div className="text-2xs text-fg-subtle">{NOMINATIM_ATTRIBUTION}</div>}
            </div>
          )}

          {/* NASA Global Fire Regimes (Biomes) */}
          <div className="space-y-3.5" role="group" aria-label="NASA Global Fire Regimes">
            <div className="flex items-center justify-between text-2xs font-semibold text-fg-subtle uppercase tracking-wider pb-1 border-b border-line">
              <span>NASA Global Fire Regimes</span>
              <button
                type="button"
                onClick={resetView}
                className="text-2xs text-accent hover:underline flex items-center gap-1 cursor-pointer"
                title="Reset camera to whole Earth 3D globe"
              >
                <RotateCcw className="h-3 w-3" aria-hidden="true" />
                <span>Whole World</span>
              </button>
            </div>

            {FIRE_BIOME_GROUPS.map((group) => (
              <div key={group.id} className="space-y-1.5">
                <div className="flex items-center justify-between text-2xs font-semibold text-fg-muted">
                  <span className="flex items-center gap-1.5">
                    <span>{group.icon}</span>
                    <span>{group.title}</span>
                  </span>
                  <span className="text-[10px] text-accent/80 font-normal">{group.tag}</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {group.regions.map((r) => {
                    const active = selectedArea ? selectedArea.id === r.id : false;
                    return (
                      <button
                        key={r.id}
                        type="button"
                        onClick={() => pickRegion(r)}
                        aria-pressed={active}
                        className={`${chip} ${
                          active
                            ? 'bg-accent border-accent text-accent-fg font-semibold'
                            : 'border-line-strong text-fg hover:bg-raised'
                        }`}
                      >
                        {r.name}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
          {selectedArea && selectedArea.kind !== 'preset' && (
            <p className="text-fg-muted">
              Area: <span className="text-fg font-medium">{selectedArea.name}</span>
            </p>
          )}
          <button
            type="button"
            onClick={resetView}
            className="min-h-touch px-3 rounded-control bg-raised hover:bg-overlay text-fg text-xs font-medium flex items-center gap-2 transition-colors"
          >
            <RotateCcw className="h-3.5 w-3.5 text-info" aria-hidden="true" />
            <span>Reset view</span>
          </button>
        </div>
      )}

      {/* Map view section: 3D Globe | World map, basemap, sensor layers, live window */}
      {inSlot(
        slots?.mapView,
        <div className="space-y-3">
          <div>
            <div id="map-view-label" className="text-2xs uppercase tracking-wide text-fg-subtle mb-1">
              View
            </div>
            <div className="grid grid-cols-2 gap-1" role="group" aria-labelledby="map-view-label">
              {(
                [
                  ['globe', '3D Globe', Globe2],
                  ['map', 'World map', MapIcon],
                ] as const
              ).map(([id, label, Icon], i) => (
                <button
                  key={id}
                  id={i === 0 ? FOCUS_TARGET_IDS.mapview : undefined}
                  type="button"
                  onClick={() => setView(id)}
                  aria-pressed={view === id}
                  className={`min-h-touch rounded-control text-xs font-medium transition-colors inline-flex items-center justify-center gap-1.5 ${
                    view === id ? 'bg-accent text-accent-fg' : 'bg-raised text-fg hover:bg-overlay'
                  }`}
                >
                  <Icon className="h-4 w-4" aria-hidden="true" />
                  <span>{label}</span>
                </button>
              ))}
            </div>
          </div>

          <BasemapSwitcher
            value={basemap}
            onChange={chooseBasemap}
            imageryDate={imageryDate}
            onDateStep={stepImageryDate}
            canStepBack={canStepBack}
            canStepForward={canStepForward}
          />

          <div>
            <div className="text-2xs uppercase tracking-wide text-fg-subtle mb-0.5">Sensors</div>
            {SENSORS.map((sensor) => (
              <label key={sensor} className="flex items-center gap-3 min-h-touch text-fg cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={sensorOn[sensor]}
                  onChange={(e) => setSensorOn((p) => ({ ...p, [sensor]: e.target.checked }))}
                  className="h-5 w-5 accent-[var(--accent)] cursor-pointer"
                />
                <SensorSwatch sensor={sensor} />
                <span>
                  {sensor} <span className="text-fg-subtle">({sensor === 'MODIS' ? '1 km' : '375 m'})</span>
                </span>
              </label>
            ))}
          </div>

          <div>
            <div id="live-window-label" className="text-2xs uppercase tracking-wide text-fg-subtle mb-1">
              Last N days (live window)
            </div>
            <div className="grid grid-cols-4 gap-1" role="group" aria-labelledby="live-window-label">
              {DAY_OPTIONS.map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setDays(d)}
                  aria-pressed={days === d}
                  className={`min-h-touch rounded-control text-xs font-medium transition-colors ${
                    days === d ? 'bg-accent text-accent-fg' : 'bg-raised text-fg hover:bg-overlay'
                  }`}
                >
                  {d} day{d > 1 ? 's' : ''}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

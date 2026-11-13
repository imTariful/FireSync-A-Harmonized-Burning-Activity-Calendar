/**
 * The small contract between FireGlobe (which owns the camera, the day range and the sensor toggles) and the
 * explorer page (which owns the URL and the Share menu). Types only: no runtime code, no MapLibre import.
 */
import type { MutableRefObject } from 'react';
import type { LayerId, MapView } from '../../utils/urlState';
import type { BasemapId } from './basemap';

/** View applied once, when the globe is created (read from the URL by the page). */
export interface GlobeShareInitial {
  /** Camera centre and zoom. Absent: keep the normal home view. */
  camera?: { lat: number; lng: number; zoom: number };
  /** Look-back days; FireGlobe snaps it to one of its own day options. */
  days?: number;
  /** Sensor layers that start switched on. */
  layers?: LayerId[];
  /** Map view to start in (globe is the default). */
  view?: MapView;
}

/** What FireGlobe currently shows. MODIS and VIIRS stay separate layers. */
export interface GlobeViewReport {
  lat: number;
  lng: number;
  zoom: number;
  days: number;
  layers: LayerId[];
  basemap: BasemapId;
  /** 3D Globe or flat World map. */
  view: MapView;
  /** Satellite imagery day (YYYY-MM-DD, UTC); only meaningful when basemap is 'satellite'. */
  imageryDate?: string;
}

/** Imperative handle FireGlobe fills in (and clears on unmount). */
export interface GlobeShareApi {
  /** The view right now, or null while the map does not exist. */
  getView: () => GlobeViewReport | null;
  /**
   * A 2D copy of the map canvas, taken inside one render event (the map keeps its default
   * preserveDrawingBuffer = false). Rejects when the map is missing, no frame is painted in time, or the
   * browser refuses to read the canvas.
   */
  capture: () => Promise<HTMLCanvasElement>;
}

export interface GlobeShareBridge {
  /** Read once at mount. When set, the idle globe rotation does not start. */
  initial?: GlobeShareInitial | null;
  /**
   * Called when a move ends (never per animation frame, never while the idle rotation spins) and when the
   * day range, a sensor layer or the basemap changes.
   */
  onViewChange?: (view: GlobeViewReport) => void;
  apiRef?: MutableRefObject<GlobeShareApi | null>;
}

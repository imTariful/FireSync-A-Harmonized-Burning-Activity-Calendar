/**
 * DOM nodes inside the explorer side panel that FireGlobe renders its controls into
 * (via React portals). FireGlobe keeps owning that state; the panel only provides the spot.
 */
export interface GlobeSlots {
  /** Area section: place search, region chips, Reset view. */
  area: HTMLElement | null;
  /** Map view section: 3D Globe | World map, basemap, sensor layers, Last N days. */
  mapView: HTMLElement | null;
}

/** The three panel sections. */
export type PanelSectionId = 'area' | 'mapview' | 'detections';

/** Element ids the toolbar focuses after it opens the panel (rendered by FireGlobe). */
export const FOCUS_TARGET_IDS = {
  area: 'explorer-place-search',
  mapview: 'explorer-view-first',
} as const;

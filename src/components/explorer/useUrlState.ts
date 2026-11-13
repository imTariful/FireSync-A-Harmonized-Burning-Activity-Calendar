import { useEffect, useRef, useState } from 'react';
import type { AoiPolygon } from '../../types/fire';
import { parseShareParams, type ParsedShareParams, type ShareState } from '../../utils/shareHelpers';
import { URL_WRITE_DEBOUNCE_MS, nextUrl } from './urlWrite';
import type { GlobeViewReport } from './shareBridge';

/**
 * The share link, read ONCE on mount (the page applies it before the globe loads anything).
 * Never throws; malformed or hostile query strings give defaults, unknown params are ignored.
 */
export function useInitialShareParams(): ParsedShareParams {
  const [parsed] = useState(() =>
    parseShareParams(typeof window === 'undefined' ? '' : window.location.search),
  );
  return parsed;
}

function replaceUrl(state: ShareState | null): void {
  try {
    const l = window.location;
    const next = nextUrl({ pathname: l.pathname, search: l.search, hash: l.hash }, state);
    if (next === `${l.pathname}${l.search}${l.hash}`) return;
    // replaceState: one history entry for the whole session, however much the user pans.
    window.history.replaceState(window.history.state, '', next);
  } catch {
    // Sandboxed frame / SecurityError: the link just does not update.
  }
}

export interface UrlWriterInput {
  /** False when the explorer is not on screen: the view params are removed once and nothing more is written. */
  enabled: boolean;
  /** Latest view reported by the globe; null until the first move or change (then the URL is left as it is). */
  view: GlobeViewReport | null;
  /** Timeline position 0..1, or null when the timeline is not active. */
  timeline: number | null;
  /** Polygon AOI to keep in the link, or undefined for none. */
  aoi?: AoiPolygon;
  /** True while the timeline plays: a step per second must not become an address-bar write per step. */
  suspended?: boolean;
}

/** Debounced `history.replaceState` of the current view. */
export function useUrlWriter({ enabled, view, timeline, aoi, suspended = false }: UrlWriterInput): void {
  useEffect(() => {
    if (!enabled || !view || suspended) return;
    const id = window.setTimeout(() => {
      replaceUrl({
        lat: view.lat,
        lng: view.lng,
        zoom: view.zoom,
        days: view.days,
        layers: view.layers,
        timeline,
        view: view.view,
        aoi,
      });
    }, URL_WRITE_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [enabled, view, timeline, aoi, suspended]);

  // Leaving the explorer: do not leave a link behind that no longer matches what is on screen.
  useEffect(() => () => replaceUrl(null), []); // the explorer unmounts (another page opens): clear the link
  const wasEnabled = useRef(enabled);
  useEffect(() => {
    if (wasEnabled.current && !enabled) replaceUrl(null);
    wasEnabled.current = enabled;
  }, [enabled]);
}

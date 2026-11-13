import { SensorDot } from '../SensorDot';
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Camera, Download, FileJson, Link2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { AoiPolygon, CanonicalObservation } from '../../types/fire';
import { EXPORT_DISCLAIMER, detectionsToCsv, detectionsToGeoJsonString } from '../../utils/export';
import {
  VISIBLE_DETECTIONS_DEFINITION,
  buildShareFilename,
  buildShareUrl,
  countBySensor,
  type ShareFileExt,
} from '../../utils/shareHelpers';
import type { GlobeViewReport } from './shareBridge';
import { CAPTURE_FAILED_MESSAGE, captureAttribution, captureGlobePng, downloadBlob } from './capture';

export interface ShareMenuProps {
  /** The visible detections, already selected by the page (selectVisibleDetections). */
  detections: readonly CanonicalObservation[];
  /** The globe's current view, read fresh at click time. */
  getView: () => GlobeViewReport | null;
  /** Timeline position 0..1 for the link, or null when the timeline is not active. */
  timeline: number | null;
  /** Active timeline cutoff (epoch ms), or null. */
  timelineCutoffMs: number | null;
  /** Polygon AOI currently shared by every page, or undefined. */
  aoi?: AoiPolygon;
  /** A 2D copy of the map canvas (GlobeShareApi.capture). */
  capture: () => Promise<HTMLCanvasElement>;
  /** The Share button: clicks on it are not "outside" clicks. */
  anchorRef: React.RefObject<HTMLElement | null>;
  /** Esc, outside click or the Close button. The page returns focus to the Share button. */
  onClose: () => void;
}

const itemCls =
  'w-full min-h-touch inline-flex items-center gap-3 px-3 rounded-control text-left text-xs font-medium text-fg hover:bg-raised aria-disabled:text-fg-subtle aria-disabled:cursor-not-allowed aria-disabled:hover:bg-transparent';

/** Defined at module level: a component defined inside ShareMenu would remount on every status change and drop focus. */
const Item: React.FC<{
  icon: LucideIcon;
  label: string;
  hint?: string;
  onClick: () => void;
  disabled?: boolean;
  refEl?: React.Ref<HTMLButtonElement>;
}> = ({ icon: Icon, label, hint, onClick, disabled, refEl }) => (
  <button
    ref={refEl}
    type="button"
    aria-disabled={disabled || undefined}
    onClick={disabled ? undefined : onClick}
    className={itemCls}
  >
    <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
    <span className="min-w-0">
      <span className="block">{label}</span>
      {hint && <span className="block text-2xs font-normal text-fg-subtle">{hint}</span>}
    </span>
  </button>
);

/** Copy text to the clipboard: async API first, then a hidden textarea. Resolves false when both fail. */
async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // permission denied / insecure context: try the fallback
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

export const ShareMenu: React.FC<ShareMenuProps> = ({
  detections,
  getView,
  timeline,
  timelineCutoffMs,
  aoi,
  capture,
  anchorRef,
  onClose,
}) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const firstRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [manualLink, setManualLink] = useState<string | null>(null);

  const counts = countBySensor(detections);
  const nothing = detections.length === 0;

  // Move focus into the menu on open.
  useEffect(() => {
    firstRef.current?.focus();
  }, []);

  // Esc closes; so does a pointer press outside the menu (the Share button toggles by itself).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    const onPointer = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (rootRef.current?.contains(t) || anchorRef.current?.contains(t)) return;
      onClose();
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onPointer, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onPointer, true);
    };
  }, [onClose, anchorRef]);

  const filename = useCallback(
    (ext: ShareFileExt, view: GlobeViewReport | null) =>
      buildShareFilename({ view, days: view?.days ?? 1, ext, now: new Date() }),
    []
  );

  const copyLink = async () => {
    setManualLink(null);
    const view = getView();
    if (!view) {
      setStatus('The globe is not ready yet. Try again in a moment.');
      return;
    }
    const url = buildShareUrl(window.location.origin, window.location.pathname, {
      lat: view.lat,
      lng: view.lng,
      zoom: view.zoom,
      days: view.days,
      layers: view.layers,
      timeline,
      view: view.view,
      aoi,
    });
    if (await copyText(url)) {
      setStatus('Link copied to the clipboard.');
    } else {
      // Last resort: show the link selected so it can be copied by hand. No blocking alert.
      setManualLink(url);
      setStatus('Could not copy automatically. The link is shown below: select it and copy it.');
    }
  };

  const saveText = (ext: 'csv' | 'geojson') => {
    if (nothing) return;
    const view = getView();
    const text = ext === 'csv' ? detectionsToCsv(detections) : detectionsToGeoJsonString(detections);
    const blob = new Blob([text], {
      type: ext === 'csv' ? 'text/csv;charset=utf-8' : 'application/geo+json;charset=utf-8',
    });
    const name = filename(ext, view);
    setStatus(downloadBlob(blob, name) ? `Downloaded ${name}.` : 'The browser blocked the download.');
  };

  const capturePng = async () => {
    if (busy) return;
    setBusy(true);
    setStatus('Capturing the map…');
    try {
      const view = getView();
      const blob = await captureGlobePng(capture, {
        viewTime: new Date(),
        counts,
        attribution: captureAttribution(view?.basemap ?? 'satellite', view?.imageryDate),
        days: view?.days,
        timelineCutoffMs,
      });
      const name = filename('png', view);
      setStatus(downloadBlob(blob, name) ? `Downloaded ${name}.` : 'The browser blocked the download.');
    } catch (e) {
      // Tainted canvas, no frame in time, WebGL refused: tell the user, keep the app running.
      console.warn('[ShareMenu] capture failed:', e);
      setStatus(CAPTURE_FAILED_MESSAGE);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      ref={rootRef}
      role="group"
      aria-labelledby={titleId}
      className="glass-panel absolute z-40 bottom-[var(--above-toolbar)] left-1/2 -translate-x-1/2 w-[min(22rem,calc(100%-1rem))] rounded-card bg-surface/80 backdrop-blur-xl border border-line-strong/60 shadow-elev-3 p-2 space-y-1 popup-enter"
    >
      <h2 id={titleId} className="px-2 pt-1 text-2xs font-semibold uppercase tracking-wider text-fg-subtle">
        Share &amp; export
      </h2>

      <div className="px-2 pb-1 text-xs text-fg space-y-1" data-testid="share-counts">
        <p>
          <SensorDot sensor="MODIS" className="mr-1" />
          <span className="font-semibold">MODIS</span>{' '}
          <span className="numeric">{counts.MODIS.toLocaleString()}</span>
          <span className="text-fg-subtle"> · </span>
          <SensorDot sensor="VIIRS" className="mr-1" />
          <span className="font-semibold">VIIRS</span>{' '}
          <span className="numeric">{counts.VIIRS.toLocaleString()}</span>
          <span className="text-fg-subtle"> visible detections, counted separately</span>
        </p>
        <p className="text-2xs text-fg-subtle">{VISIBLE_DETECTIONS_DEFINITION}</p>
      </div>

      <Item icon={Link2} label="Copy link" hint="Same view, layers and day range" onClick={copyLink} refEl={firstRef} />
      <Item
        icon={Camera}
        label={busy ? 'Capturing…' : 'Capture PNG'}
        hint="Map image with legend, credits and counts"
        onClick={capturePng}
        disabled={busy}
      />
      <Item
        icon={Download}
        label="Download CSV"
        hint={nothing ? 'Nothing visible to export' : 'One row per detection, with a sensor column'}
        onClick={() => saveText('csv')}
        disabled={nothing}
      />
      <Item
        icon={FileJson}
        label="Download GeoJSON"
        hint={nothing ? 'Nothing visible to export' : 'Points; the legend sentence is in the metadata'}
        onClick={() => saveText('geojson')}
        disabled={nothing}
      />

      {manualLink && (
        <input
          readOnly
          value={manualLink}
          aria-label="Link to copy"
          onFocus={(e) => e.currentTarget.select()}
          className="w-full min-h-touch bg-raised border border-line-strong rounded-control px-3 text-xs text-fg"
        />
      )}

      <p className="px-2 text-2xs text-fg-subtle">{EXPORT_DISCLAIMER}</p>

      {/* Polite live region: confirmations and errors, never a blocking alert. */}
      <p role="status" aria-live="polite" className="px-2 pb-1 min-h-[1.25rem] text-xs text-accent">
        {status}
      </p>

      <button
        type="button"
        onClick={onClose}
        className="w-full min-h-touch rounded-control text-xs font-medium text-fg-muted hover:text-fg hover:bg-raised"
      >
        Close
      </button>
    </div>
  );
};

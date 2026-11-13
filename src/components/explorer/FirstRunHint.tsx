import { SensorDot } from '../SensorDot';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';

const STORAGE_KEY = 'firesync.explorer.hintDismissed.v1';

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false; // storage blocked or unavailable: show the hint, never crash
  }
}

function writeDismissed(): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, '1');
  } catch {
    // private mode / blocked storage: the hint simply shows again next visit
  }
}

/** Visible on first visit; Help re-opens it. Dismissal is remembered in localStorage. */
export function useFirstRunHint() {
  const [visible, setVisible] = useState<boolean>(() => !readDismissed());
  const dismiss = useCallback(() => {
    writeDismissed();
    setVisible(false);
  }, []);
  const open = useCallback(() => setVisible(true), []);
  return { visible, dismiss, open };
}

interface FirstRunHintProps {
  onDismiss: () => void;
}

export const FIRST_RUN_LEGEND = 'Satellite thermal anomalies, not confirmed wildfires or burned area.';

export const FirstRunHint: React.FC<FirstRunHintProps> = ({ onDismiss }) => {
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    buttonRef.current?.focus();
  }, []);

  return (
    <div
      role="dialog"
      aria-labelledby="explorer-hint-title"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onDismiss();
        }
      }}
      className="glass-panel absolute z-40 left-3 right-3 top-1/2 -translate-y-1/2 mx-auto max-w-md max-h-[70%] overflow-y-auto rounded-card bg-surface/75 backdrop-blur-xl border border-line-strong/60 shadow-elev-3 p-4 text-sm text-fg-muted"
    >
      <div className="flex items-start justify-between gap-2">
        <h2 id="explorer-hint-title" className="text-base font-bold text-fg">
          How to read this globe
        </h2>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss hint"
          className="-mt-2 -mr-2 min-h-touch min-w-touch inline-flex items-center justify-center rounded-control text-fg-muted hover:text-fg hover:bg-raised"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
      <ul className="mt-2 space-y-2 list-disc pl-5">
        <li>
          <span className="text-fg font-semibold">Spin it:</span> drag the globe to turn it. It rotates by itself until you touch it.
        </li>
        <li>
          <span className="text-fg font-semibold">Zoom in:</span> scroll, pinch or use the + button. Detections load for the area you are looking at, so zoom in until the “zoom in to load” message goes away.
        </li>
        <li>
          <span className="text-fg font-semibold">Colors:</span>{' '}
          <SensorDot sensor="MODIS" className="mr-1" />
          <span className="font-semibold">MODIS</span> (crimson, large dots: 1 km pixels) and{' '}
          <SensorDot sensor="VIIRS" className="mr-1" />
          <span className="font-semibold">VIIRS</span> (yellow, small dots: 375 m pixels) are different instruments. They are always shown and counted separately, never added together. Zoomed out you see a soft cloud (brighter where fires are more intense); zoom in and it turns into individual points.
        </li>
      </ul>
      <p className="mt-3 rounded-control bg-raised border border-line px-3 py-2 text-fg">{FIRST_RUN_LEGEND}</p>
      <div className="mt-3 flex justify-end">
        <button
          ref={buttonRef}
          type="button"
          onClick={onDismiss}
          className="min-h-touch px-5 rounded-control bg-accent hover:bg-accent-hover text-accent-fg font-semibold text-sm transition-colors"
        >
          Got it
        </button>
      </div>
    </div>
  );
};

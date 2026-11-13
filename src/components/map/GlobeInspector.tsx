import { SensorDot } from '../SensorDot';
import React, { useEffect, useRef } from 'react';
import { Sparkles, X } from 'lucide-react';
import { CanonicalObservation } from '../../types/fire';

interface GlobeInspectorProps {
  observation: CanonicalObservation;
  onClose: () => void;
  /** Opens this detection in the AI Investigator evidence card. */
  onExplainWithAi?: (observation: CanonicalObservation) => void;
}

const Cell: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="bg-canvas/90 p-2.5 rounded-control border border-line min-w-0">
    <div className="text-fg-subtle font-mono text-2xs uppercase tracking-wider">{label}</div>
    <div className="font-mono tabular-nums text-fg text-[11px] mt-0.5 break-words">{children}</div>
  </div>
);

/**
 * Compact hotspot details: right-hand drawer on desktop (below the zoom buttons, above the bottom
 * toolbar), full-width bottom sheet on phones (covers the toolbar until closed).
 * Not modal: Escape closes it, and focus moves to it when it opens so keyboard users land inside.
 */
export const GlobeInspector: React.FC<GlobeInspectorProps> = ({ observation: o, onClose, onExplainWithAi }) => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, [o.id]);

  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="dialog"
      aria-label="Hotspot details"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
      className="absolute z-[35] inset-x-0 bottom-[var(--attr-h)] max-h-[60%] rounded-t-card sm:inset-x-auto sm:right-3 sm:top-28 sm:bottom-[var(--above-toolbar)] sm:w-80 sm:max-h-none sm:rounded-card bg-surface/95 backdrop-blur-md border border-line-strong shadow-elev-3 p-3.5 overflow-y-auto overscroll-contain text-xs text-fg focus:outline-none"
    >
      <div className="flex items-center justify-between pb-2.5 border-b border-line">
        <div className="flex items-center space-x-2">
          <SensorDot sensor={o.sensor} />
          <span className="font-mono text-xs font-bold uppercase tracking-wider text-fg">{o.sensor}</span>
          <span className="text-line-strong">·</span>
          <span className="font-semibold text-fg text-sm">{o.satellite}</span>
        </div>
        <button
          onClick={onClose}
          aria-label="Close details"
          className="-m-1.5 min-h-touch min-w-touch inline-flex items-center justify-center text-fg-muted hover:text-fg rounded-control hover:bg-raised transition cursor-pointer"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="mt-3 space-y-2">
        <div className="bg-canvas/90 p-3 rounded-control border border-line flex justify-between items-center">
          <span className="text-fg-muted font-medium">Fire Radiative Power</span>
          <span className="text-accent font-bold text-base font-mono tabular-nums">{o.frp_mw} MW</span>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Cell label="Acquired (UTC)">
            {o.acq_date} {o.acq_time} ({o.daynight === 'D' ? 'day' : 'night'})
          </Cell>
          <Cell label="Coordinates">
            {Number(o.latitude).toFixed(4)}°, {Number(o.longitude).toFixed(4)}°
          </Cell>
          <Cell label="Confidence">
            {String(o.confidence)} ({o.confidence_category})
          </Cell>
          <Cell label="Pixel size">
            {o.scan} × {o.track} km
          </Cell>
        </div>

        {(o.bright_ti4 || o.brightness) && (
          <div className="bg-canvas/90 p-2.5 rounded-control border border-line text-fg-muted font-mono tabular-nums text-2xs">
            {o.bright_ti4 ? `VIIRS I4 ${o.bright_ti4} K · I5 ${o.bright_ti5 ?? '–'} K` : `Brightness ${o.brightness} K`}
          </div>
        )}

        <div className="bg-canvas/90 p-2.5 rounded-control border border-line space-y-0.5">
          <div className="text-fg-subtle font-mono text-2xs uppercase tracking-wider">NASA FIRMS product</div>
          <div className="text-accent font-mono text-[11px]">{o.product}</div>
          <div className="text-2xs text-fg-subtle truncate" title={o.record_hash}>
            Hash: {o.record_hash}
          </div>
        </div>

        {onExplainWithAi && (
          <button
            type="button"
            onClick={() => onExplainWithAi(o)}
            className="w-full inline-flex items-center justify-center gap-1.5 rounded-control border border-accent/50 bg-accent/10 px-2.5 py-1.5 text-2xs font-semibold text-accent hover:bg-accent/20 transition cursor-pointer"
          >
            <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
            AI evidence card
          </button>
        )}

        <p className="text-2xs text-fg-subtle">
          A satellite thermal anomaly, not a confirmed wildfire or burned area.
        </p>
      </div>
    </div>
  );
};

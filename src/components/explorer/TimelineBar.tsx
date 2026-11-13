import { SENSOR_COLOR } from '../../utils/sensorStyle';
import React, { useEffect, useMemo, useRef } from 'react';
import { Pause, Play, SkipBack, SkipForward, X } from 'lucide-react';
import type { TimelineAxis, TimelineIndex, TimelineStep } from '../../utils/timeline';
import type { CanonicalObservation, SensorType } from '../../types/fire';
import { SPEED_OPTIONS } from './useTimelinePlayback';

const SENSORS: readonly SensorType[] = ['MODIS', 'VIIRS'];

/** The one sentence the bar must always show. */
export const TIMELINE_NOTE =
  'Playback shows when satellites observed, not how fires spread; the current UTC day is still incomplete.';

const pad = (n: number) => String(n).padStart(2, '0');
const dateOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const hmOf = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};

/** "2026-11-06 14:00–15:00 UTC" (the end shows its date when the step crosses UTC midnight). */
export function formatStepRange(step: Pick<TimelineStep, 'startMs' | 'endMs'>): string {
  const sameDay = dateOf(step.startMs) === dateOf(step.endMs);
  const end = sameDay ? hmOf(step.endMs) : `${dateOf(step.endMs)} ${hmOf(step.endMs)}`;
  return `${dateOf(step.startMs)} ${hmOf(step.startMs)}–${end} UTC`;
}

/** Text for aria-valuetext: the timestamp plus what kind of step it is. */
export function stepValueText(step: TimelineStep): string {
  const kind = !step.hasData ? ', no data loaded for this window' : step.partial ? ', still incomplete' : '';
  return `${formatStepRange(step)} acquisition time${kind}`;
}

interface TimelineBarProps {
  axis: TimelineAxis;
  index: TimelineIndex<CanonicalObservation>;
  step: number;
  playing: boolean;
  speedMs: number;
  onToggle: () => void;
  onStepBy: (delta: number) => void;
  onSeek: (index: number) => void;
  onSpeed: (ms: number) => void;
  onClose: () => void;
  /** Reports the bar's height (px) so overlays above it can make room. */
  onHeight?: (px: number) => void;
}

const iconBtn =
  'min-h-touch min-w-touch inline-flex items-center justify-center rounded-control text-fg-muted hover:text-fg hover:bg-raised disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent';

const HATCH =
  'repeating-linear-gradient(135deg, transparent 0, transparent 2px, rgb(0 0 0 / 0.6) 2px, rgb(0 0 0 / 0.6) 4px)';

/** One thin track: one cell per step. Heights are relative to this sensor's own busiest step. */
const Track: React.FC<{ axis: TimelineAxis; sensor: SensorType; current: number; max: number }> = ({
  axis,
  sensor,
  current,
  max,
}) => (
  <div
    aria-hidden="true"
    className="grid h-4 items-end gap-px flex-1 min-w-0"
    style={{ gridTemplateColumns: `repeat(${axis.steps.length}, minmax(0, 1fr))` }}
  >
    {axis.steps.map((s) => {
      const count = s[sensor].count;
      const played = s.index <= current;
      const isCurrent = s.index === current;
      const base = `relative h-full flex items-end ${isCurrent ? 'outline outline-1 outline-fg' : ''}`;
      if (!s.hasData) {
        // "No data": nothing was loaded for this window. Dashed outline, no fill: not "no activity".
        return (
          <div
            key={s.index}
            className={`${base} border border-dashed border-line-strong ${played ? '' : 'opacity-50'}`}
            title={`${formatStepRange(s)}: no data loaded`}
          />
        );
      }
      const h = count > 0 && max > 0 ? Math.max(2, Math.round((count / max) * 16)) : 0;
      return (
        <div
          key={s.index}
          className={`${base} border-b border-line ${played ? '' : 'opacity-40'}`}
          title={`${formatStepRange(s)}: ${sensor} ${count}${s.partial ? ' (incomplete)' : ''}`}
        >
          {h > 0 && (
            <div
              className="w-full"
              style={{
                height: h,
                backgroundColor: SENSOR_COLOR[sensor],
                backgroundImage: s.partial ? HATCH : undefined,
              }}
            />
          )}
        </div>
      );
    })}
  </div>
);

/**
 * Bottom playback bar (an overlay above the toolbar; it never resizes the map).
 * MODIS and VIIRS get separate tracks and separate counts: nothing is ever summed across sensors.
 * Counts: "this step" and "so far" (cumulative up to the current step), per sensor.
 */
export const TimelineBar: React.FC<TimelineBarProps> = ({
  axis,
  index,
  step,
  playing,
  speedMs,
  onToggle,
  onStepBy,
  onSeek,
  onSpeed,
  onClose,
  onHeight,
}) => {
  const rootRef = useRef<HTMLElement>(null);
  const playRef = useRef<HTMLButtonElement>(null);
  const n = axis.steps.length;
  const cur = n > 0 ? axis.steps[Math.min(step, n - 1)] : null;
  const curIdx = cur ? cur.index : 0;

  useEffect(() => {
    playRef.current?.focus();
  }, []);

  useEffect(() => {
    const el = rootRef.current;
    if (!el || !onHeight) return;
    const report = () => onHeight(Math.round(el.getBoundingClientRect().height));
    report();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [onHeight]);

  const maxOf = useMemo(
    () => ({
      MODIS: axis.steps.reduce((m, s) => Math.max(m, s.MODIS.count), 0),
      VIIRS: axis.steps.reduce((m, s) => Math.max(m, s.VIIRS.count), 0),
    }),
    [axis],
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const t = e.target as HTMLElement;
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key === ' ' || e.code === 'Space') {
      if (t.closest('button')) return; // a focused button handles Space itself
      e.preventDefault();
      onToggle();
      return;
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      if (t instanceof HTMLInputElement && t.type === 'range') return; // the slider steps natively
      e.preventDefault();
      onStepBy(e.key === 'ArrowLeft' ? -1 : 1);
    }
  };

  const empty = n === 0;

  return (
    <section
      ref={rootRef}
      aria-label="Timeline playback"
      onKeyDown={onKeyDown}
      className="glass-panel absolute z-30 inset-x-2 bottom-[var(--above-toolbar)] sm:inset-x-auto sm:left-1/2 sm:-translate-x-1/2 sm:w-[min(40rem,calc(100%-2rem))] max-h-[min(24rem,55%)] overflow-y-auto overscroll-contain rounded-card bg-surface/75 hover:bg-surface/85 backdrop-blur-xl border border-line-strong/60 shadow-elev-3 px-2 pt-1.5 pb-2 text-xs text-fg transition-colors"
    >
      {/* Close is last in DOM order but sits top-right */}
      <div className="pr-12 min-h-touch flex flex-col justify-center">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-bold">Timeline</span>
          {cur && (
            <span className="numeric text-fg" data-testid="timeline-timestamp">
              {formatStepRange(cur)}
            </span>
          )}
        </div>
        <div className="text-2xs text-fg-muted">
          {empty
            ? 'No detections are loaded yet. Load an area, then use the timeline.'
            : !cur?.hasData
              ? 'Acquisition time (UTC). No data was loaded for this window; that is not “no fire activity”.'
              : cur.partial
                ? 'Acquisition time (UTC). This window is not finished yet (hatched).'
                : 'Acquisition time (UTC).'}
        </div>
      </div>

      <div className="flex items-center gap-0.5">
        <button
          ref={playRef}
          type="button"
          onClick={onToggle}
          disabled={n < 2}
          aria-label={playing ? 'Pause playback' : 'Play'}
          className={`${iconBtn} text-accent`}
        >
          {playing ? <Pause className="h-5 w-5" aria-hidden="true" /> : <Play className="h-5 w-5" aria-hidden="true" />}
        </button>
        <button
          type="button"
          onClick={() => onStepBy(-1)}
          disabled={empty || curIdx <= 0}
          aria-label="Previous step"
          className={iconBtn}
        >
          <SkipBack className="h-4 w-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => onStepBy(1)}
          disabled={empty || curIdx >= n - 1}
          aria-label="Next step"
          className={iconBtn}
        >
          <SkipForward className="h-4 w-4" aria-hidden="true" />
        </button>
        <input
          type="range"
          min={0}
          max={Math.max(0, n - 1)}
          step={1}
          value={curIdx}
          disabled={n < 2}
          onChange={(e) => onSeek(Number(e.target.value))}
          aria-label="Timeline position"
          aria-valuetext={cur ? stepValueText(cur) : 'no data'}
          className="flex-1 min-w-0 min-h-touch accent-[var(--accent)] cursor-pointer disabled:cursor-not-allowed"
        />
      </div>

      {!empty && (
        <div className="mt-1 space-y-1">
          {SENSORS.map((sensor) => {
            const here = cur ? cur[sensor].count : 0;
            const sofar = index.cumulative[sensor][curIdx] ?? 0;
            return (
              <div key={sensor} className="flex items-center gap-2" data-testid={`timeline-track-${sensor}`}>
                <span className="w-14 shrink-0 flex items-center gap-1 font-semibold">
                  <span style={{ color: SENSOR_COLOR[sensor] }} aria-hidden="true">
                    ●
                  </span>
                  {sensor}
                </span>
                <Track axis={axis} sensor={sensor} current={curIdx} max={maxOf[sensor]} />
                <span className="numeric w-[4.75rem] shrink-0 text-right text-fg" title="this step · shown so far">
                  {cur?.hasData ? here.toLocaleString() : '–'} · {sofar.toLocaleString()}
                </span>
              </div>
            );
          })}
          <p className="text-2xs text-fg-muted">
            Numbers: this step · shown so far, per sensor, never added together. Bar height is relative to each
            sensor’s own busiest step. <span aria-hidden="true">▨</span> hatched = window still incomplete.{' '}
            <span aria-hidden="true">▯</span> dashed = no data loaded.
          </p>
        </div>
      )}

      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
        <div className="flex items-center gap-1" role="group" aria-label="Playback speed, time per step">
          {SPEED_OPTIONS.map((o) => (
            <button
              key={o.ms}
              type="button"
              aria-pressed={speedMs === o.ms}
              onClick={() => onSpeed(o.ms)}
              className={`min-h-touch min-w-touch px-2 rounded-control text-2xs font-medium ${
                speedMs === o.ms ? 'bg-accent text-accent-fg' : 'bg-raised text-fg hover:bg-overlay'
              }`}
            >
              {o.label}
            </button>
          ))}
          <span className="text-2xs text-fg-subtle">per step</span>
        </div>
        <p className="flex-1 min-w-[12rem] text-2xs text-fg">{TIMELINE_NOTE}</p>
      </div>
      {axis.skipped > 0 && (
        <p className="text-2xs text-fg-muted">
          {axis.skipped.toLocaleString()} detection{axis.skipped > 1 ? 's' : ''} without a valid time stay hidden while
          the timeline is open.
        </p>
      )}

      <button
        type="button"
        onClick={onClose}
        aria-label="Close timeline"
        className={`${iconBtn} absolute top-1 right-1`}
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </section>
  );
};

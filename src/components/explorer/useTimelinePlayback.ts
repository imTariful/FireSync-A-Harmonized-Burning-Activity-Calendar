import { useCallback, useEffect, useState } from 'react';

/** Playback speeds: one step every 0.6 s or every 1.2 s. */
export const SPEED_OPTIONS = [
  { ms: 600, label: '0.6 s' },
  { ms: 1200, label: '1.2 s' },
] as const;
export const DEFAULT_SPEED_MS = 1200;

export interface TimelinePlayback {
  /** Current step index, always within [0, stepCount - 1] (0 when there are no steps). */
  step: number;
  playing: boolean;
  speedMs: number;
  /** True when the current step is the last one. */
  atEnd: boolean;
  /** Play / pause. Pressing play at the end restarts from the first step (an explicit user action). */
  toggle: () => void;
  pause: () => void;
  /** Move by `delta` steps (clamped). Pauses playback: the user took control. */
  stepBy: (delta: number) => void;
  /** Jump to a step (clamped). Pauses playback. */
  seek: (index: number) => void;
  setSpeedMs: (ms: number) => void;
  /** Back to the last step (the full view), paused. */
  reset: () => void;
}

/**
 * Playback state for the timeline. Pure UI state: it never touches data, the map or the camera.
 * - Never starts by itself: `playing` is only set by toggle().
 * - Stops on the last step (no silent loop) and when the tab becomes hidden.
 * - `resetKey` (e.g. the axis object): when it changes (new area / new data) the step goes back to the
 *   last step, paused, in the same render, so a stale index never reaches the map.
 */
export function useTimelinePlayback(stepCount: number, resetKey: unknown): TimelinePlayback {
  const last = Math.max(0, stepCount - 1);
  const [step, setStep] = useState(last);
  const [playing, setPlaying] = useState(false);
  const [speedMs, setSpeedMs] = useState<number>(DEFAULT_SPEED_MS);

  const [prevKey, setPrevKey] = useState(resetKey);
  if (prevKey !== resetKey) {
    setPrevKey(resetKey);
    setStep(last);
    setPlaying(false);
  }

  const current = Math.min(step, last);

  // Advance one step per interval. setData on the map happens once per step, never per frame.
  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => setStep((s) => Math.min(s + 1, last)), speedMs);
    return () => window.clearInterval(id);
  }, [playing, speedMs, last]);

  // Pause on the last step instead of looping.
  useEffect(() => {
    if (playing && current >= last) setPlaying(false);
  }, [playing, current, last]);

  // Pause when the tab is hidden.
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) setPlaying(false);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  const toggle = useCallback(() => {
    if (playing) {
      setPlaying(false);
      return;
    }
    if (last < 1) return; // nothing to play
    if (current >= last) setStep(0);
    setPlaying(true);
  }, [playing, current, last]);

  const pause = useCallback(() => setPlaying(false), []);

  const seek = useCallback(
    (index: number) => {
      setPlaying(false);
      if (!Number.isFinite(index)) return;
      setStep(Math.max(0, Math.min(last, Math.round(index))));
    },
    [last],
  );

  const stepBy = useCallback(
    (delta: number) => {
      setPlaying(false);
      setStep(Math.max(0, Math.min(last, current + delta)));
    },
    [current, last],
  );

  const reset = useCallback(() => {
    setPlaying(false);
    setStep(last);
  }, [last]);

  return { step: current, playing, speedMs, atEnd: current >= last, toggle, pause, stepBy, seek, setSpeedMs, reset };
}

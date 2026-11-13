import React, { Suspense, useMemo, useState } from 'react';
import type { CanonicalObservation } from '../../types/fire';
import { ExplorerDrawer } from './ExplorerDrawer';
import { HarmonizeSkeleton } from './HarmonizeSkeleton';

const loadHarmonizeContent = () => import('./HarmonizeContent');

/** Start fetching the chunk early (toolbar hover/focus). Safe to call repeatedly; failures surface on open. */
export function prefetchHarmonize(): void {
  void loadHarmonizeContent().catch(() => undefined);
}

interface BoundaryProps {
  fallback: React.ReactNode;
  children: React.ReactNode;
}

/** Suspense does not catch a failed chunk download; without this the drawer would go blank. */
class ChunkBoundary extends React.Component<BoundaryProps, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

interface HarmonizeDrawerProps {
  /** The detections already loaded for the current view; MODIS/VIIRS are separated inside the lazy chunk. */
  observations: readonly CanonicalObservation[];
  loading: boolean;
  /** Which data source feeds the panel, e.g. "3D Globe · live, by area". */
  sourceLabel: string;
  onClose: () => void;
}

export const HarmonizeDrawer: React.FC<HarmonizeDrawerProps> = ({ observations, loading, sourceLabel, onClose }) => {
  // A new lazy() per attempt, because React.lazy caches a rejected import forever.
  const [attempt, setAttempt] = useState(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const Content = useMemo(() => React.lazy(loadHarmonizeContent), [attempt]);

  const failed = (
    <div role="alert" className="p-3 space-y-2 text-xs text-fg">
      <p>The harmonization panel could not be loaded. Check your connection and try again.</p>
      <button
        type="button"
        onClick={() => setAttempt((n) => n + 1)}
        className="min-h-touch px-3 rounded-control bg-raised border border-line-strong text-fg font-medium hover:bg-overlay"
      >
        Try again
      </button>
    </div>
  );

  return (
    <ExplorerDrawer title="Harmonize MODIS & VIIRS" onClose={onClose}>
      <p className="px-3 pt-3 text-2xs text-fg-subtle">
        Uses the detections already loaded for this view ({sourceLabel}). No extra data is requested.
      </p>
      <ChunkBoundary key={attempt} fallback={failed}>
        <Suspense fallback={<HarmonizeSkeleton />}>
          <Content observations={observations} loading={loading} />
        </Suspense>
      </ChunkBoundary>
    </ExplorerDrawer>
  );
};

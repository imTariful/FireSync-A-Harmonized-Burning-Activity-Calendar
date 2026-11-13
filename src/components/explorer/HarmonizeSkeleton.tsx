import React from 'react';

/** Placeholder shown while the harmonization chunk loads. The pulse only runs when motion is allowed. */
export const HarmonizeSkeleton: React.FC = () => (
  <div role="status" aria-live="polite" className="p-3 space-y-3">
    <span className="sr-only">Loading the MODIS and VIIRS harmonization panel…</span>
    <div aria-hidden="true" className="space-y-3">
      <div className="h-6 w-28 rounded-full bg-raised motion-safe:animate-pulse" />
      <div className="grid grid-cols-2 gap-2">
        <div className="h-16 rounded-control bg-raised motion-safe:animate-pulse" />
        <div className="h-16 rounded-control bg-raised motion-safe:animate-pulse" />
      </div>
      <div className="h-32 rounded-card bg-raised motion-safe:animate-pulse" />
      <div className="h-11 rounded-card bg-raised motion-safe:animate-pulse" />
      <div className="h-11 rounded-card bg-raised motion-safe:animate-pulse" />
    </div>
  </div>
);

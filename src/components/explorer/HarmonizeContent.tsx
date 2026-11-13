import React, { useMemo } from 'react';
import type { CanonicalObservation } from '../../types/fire';
import { HarmonizationPanel } from '../harmonize/HarmonizationPanel';
import { splitBySensor } from '../../utils/harmonizeView';

interface HarmonizeContentProps {
  /** Detections already loaded for the current view (mixed list; split here, never summed). */
  observations: readonly CanonicalObservation[];
  loading: boolean;
}

/**
 * Lazy-loaded unit: the panel AND the harmonizeView/matching code it needs live in this one chunk,
 * so the Explorer's main bundle does not pull them in. No fetching here: pure props -> panel.
 */
const HarmonizeContent: React.FC<HarmonizeContentProps> = ({ observations, loading }) => {
  const { modis, viirs } = useMemo(() => splitBySensor(observations), [observations]);
  return <HarmonizationPanel modis={modis} viirs={viirs} loading={loading} />;
};

export default HarmonizeContent;

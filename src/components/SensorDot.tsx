import React from 'react';
import { SENSOR_COLOR, type SensorName } from '../utils/sensorStyle';

/** Small colour dot for a sensor next to a NEUTRAL text label (crimson text on dark surfaces is too low in contrast). */
export const SensorDot: React.FC<{ sensor: SensorName; className?: string }> = ({ sensor, className = '' }) => (
  <span
    aria-hidden="true"
    className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${className}`}
    style={{ backgroundColor: SENSOR_COLOR[sensor] }}
  />
);

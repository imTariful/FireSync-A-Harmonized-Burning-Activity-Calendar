/**
 * Spatial calculation and equal-area gridding utilities for FireSync.
 * Ensures equal-area spatial binning (1 km x 1 km cells) rather than naive degree squares.
 */

import { BoundingBox } from '../types/fire';

const EARTH_RADIUS_KM = 6371.0088;
const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

/**
 * Standard reference latitude for cylindrical equal-area projection in tropical/subtropical fire zones.
 * Default 23.5° (Tropic of Cancer, standard for S/SE Asia study regions).
 */
const DEFAULT_STD_PARALLEL = 23.5;

/**
 * Projects (lat, lon) to Cylindrical Equal-Area planar coordinates (x, y) in kilometers.
 * Preserves true surface area across all grid cells.
 */
export function projectToEqualAreaKm(
  lat: number,
  lon: number,
  lon0 = 0,
  stdParallelDeg = DEFAULT_STD_PARALLEL
): { xKm: number; yKm: number } {
  const phi = lat * DEG_TO_RAD;
  const lambda = lon * DEG_TO_RAD;
  const lambda0 = lon0 * DEG_TO_RAD;
  const phi0 = stdParallelDeg * DEG_TO_RAD;
  const cosPhi0 = Math.cos(phi0);

  // Equal-area projection formulas:
  // x = R * (lambda - lambda0) * cos(phi0)
  // y = R * sin(phi) / cos(phi0)
  const xKm = EARTH_RADIUS_KM * (lambda - lambda0) * cosPhi0;
  const yKm = (EARTH_RADIUS_KM * Math.sin(phi)) / cosPhi0;

  return { xKm, yKm };
}

/**
 * Inverts Cylindrical Equal-Area planar coordinates (x, y) in km back to (lat, lon).
 */
export function invertEqualAreaKm(
  xKm: number,
  yKm: number,
  lon0 = 0,
  stdParallelDeg = DEFAULT_STD_PARALLEL
): { lat: number; lon: number } {
  const phi0 = stdParallelDeg * DEG_TO_RAD;
  const cosPhi0 = Math.cos(phi0);

  const sinPhi = (yKm * cosPhi0) / EARTH_RADIUS_KM;
  // clamp sinPhi between -1 and 1
  const clampedSinPhi = Math.max(-1, Math.min(1, sinPhi));
  const lat = Math.asin(clampedSinPhi) * RAD_TO_DEG;

  const lambda = (xKm / (EARTH_RADIUS_KM * cosPhi0)) + (lon0 * DEG_TO_RAD);
  const lon = lambda * RAD_TO_DEG;

  return { lat, lon };
}

/**
 * Computes 1-km equal-area grid indices for a given geographic point.
 */
export function computeGridCellIndex(
  lat: number,
  lon: number,
  cellSizeKm = 1.0,
  lon0 = 0
): { gridX: number; gridY: number; cellKey: string } {
  const { xKm, yKm } = projectToEqualAreaKm(lat, lon, lon0);
  const gridX = Math.floor(xKm / cellSizeKm);
  const gridY = Math.floor(yKm / cellSizeKm);
  const cellKey = `cell_${gridX}_${gridY}`;
  return { gridX, gridY, cellKey };
}

/**
 * Computes the geographic center coordinate of an equal-area cell index.
 */
export function getCellCenterCoordinate(
  gridX: number,
  gridY: number,
  cellSizeKm = 1.0,
  lon0 = 0
): { lat: number; lon: number } {
  const xCenterKm = (gridX + 0.5) * cellSizeKm;
  const yCenterKm = (gridY + 0.5) * cellSizeKm;
  return invertEqualAreaKm(xCenterKm, yCenterKm, lon0);
}

/**
 * Calculates Great Circle (Haversine) distance between two points in km.
 */
export function haversineDistanceKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const dLat = (lat2 - lat1) * DEG_TO_RAD;
  const dLon = (lon2 - lon1) * DEG_TO_RAD;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * DEG_TO_RAD) *
      Math.cos(lat2 * DEG_TO_RAD) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_KM * c;
}

/**
 * Tests whether a point falls within a geographic bounding box.
 */
export function isPointInBbox(
  lat: number,
  lon: number,
  bbox: BoundingBox
): boolean {
  return (
    lat >= bbox.south &&
    lat <= bbox.north &&
    lon >= bbox.west &&
    lon <= bbox.east
  );
}

/**
 * Standard pre-configured study regions.
 */
export const STUDY_REGIONS = [
  {
    id: 'bangladesh',
    name: 'Bangladesh (Demonstration Region)',
    country: 'Bangladesh',
    bbox: { west: 88.0, south: 20.5, east: 92.8, north: 26.7 },
    description: 'NASA Space Apps primary focus region. Dry-season agricultural residue burning and forest fringes.',
    center: [90.3563, 23.685] as [number, number],
    defaultZoom: 7,
  },
  {
    id: 'indochina',
    name: 'Southeast Asia (Indochina Peninsula)',
    country: 'Regional (Myanmar/Thailand/Laos/Cambodia)',
    bbox: { west: 92.0, south: 9.0, east: 109.5, north: 28.5 },
    description: 'High-intensity seasonal biomass burning and shifting agriculture.',
    center: [100.5, 18.0] as [number, number],
    defaultZoom: 5.5,
  },
  {
    id: 'amazon_arc',
    name: 'Amazon Arc of Deforestation',
    country: 'Brazil / Bolivia',
    bbox: { west: -66.0, south: -15.0, east: -48.0, north: -3.0 },
    description: 'Tropical forest clearing and pasture maintenance fires.',
    center: [-57.0, -9.0] as [number, number],
    defaultZoom: 5.5,
  },
  {
    id: 'california',
    name: 'Western North America (California)',
    country: 'United States',
    bbox: { west: -124.5, south: 32.5, east: -114.1, north: 42.0 },
    description: 'Chaparral and montane forest seasonal wildfire regimes.',
    center: [-119.5, 37.0] as [number, number],
    defaultZoom: 6,
  },
];

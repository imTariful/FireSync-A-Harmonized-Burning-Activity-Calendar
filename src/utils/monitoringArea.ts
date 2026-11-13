import type { BoundingBox } from '../types/fire';

export interface MonitoringSelection {
  name: string;
  bbox: BoundingBox;
  note?: string;
}

/** The watch API accepts one non-wrapping rectangle, not a dateline-crossing region. */
export function validMonitoringBox(box: BoundingBox): boolean {
  return Object.values(box).every(Number.isFinite) && box.west >= -180 && box.east <= 180 &&
    box.south >= -85 && box.north <= 85 && box.west < box.east && box.south < box.north;
}

export function parseMonitoringBox(value: string): BoundingBox | null {
  const parts = value.split(',');
  if (parts.length !== 4 || parts.some((p) => !p.trim())) return null;
  const [west, south, east, north] = parts.map(Number);
  const box = { west, south, east, north };
  return validMonitoringBox(box) ? box : null;
}

/** Approximate width in km; latitude-dependent longitude span, never silently clipped. */
export function monitoringBoxFromTap(lng: number, lat: number, widthKm = 10): BoundingBox | null {
  if (![lng, lat, widthKm].every(Number.isFinite) || widthKm <= 0 || Math.abs(lat) >= 85) return null;
  const halfLat = widthKm / (2 * 111.195);
  const halfLng = halfLat / Math.cos(lat * Math.PI / 180);
  const box = { west: lng - halfLng, south: lat - halfLat, east: lng + halfLng, north: lat + halfLat };
  return validMonitoringBox(box) ? box : null;
}

export function monitoringBoxFromCorners(a: { lng: number; lat: number }, b: { lng: number; lat: number }): BoundingBox | null {
  const box = { west: Math.min(a.lng, b.lng), south: Math.min(a.lat, b.lat), east: Math.max(a.lng, b.lng), north: Math.max(a.lat, b.lat) };
  // A drag across the date line must be split into separate monitors rather than nearly the whole globe.
  return validMonitoringBox(box) && box.east - box.west <= 180 ? box : null;
}

export function monitoringRectangle(box: BoundingBox, properties: Record<string, string | boolean> = {}) {
  return {
    type: 'Feature' as const,
    properties,
    geometry: { type: 'Polygon' as const, coordinates: [[
      [box.west, box.south], [box.east, box.south], [box.east, box.north], [box.west, box.north], [box.west, box.south],
    ]] },
  };
}

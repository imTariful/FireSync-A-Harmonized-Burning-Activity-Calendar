/**
 * Polygon AOI geometry (pure, no DOM).
 *
 * Coordinates use GeoJSON order: [longitude, latitude]. Bounding boxes remain a cheap
 * preliminary filter; this module performs the actual point-in-polygon test.
 *
 * Boundary points are treated as inside, consistently. Antimeridian-crossing rings are
 * handled by unwrapping vertex longitudes relative to the query longitude, so a polygon
 * drawn from 170°E to -170°W does not accidentally include the whole world.
 */

import type { AoiPolygon, BoundingBox } from '../types/fire';

export type PolygonValidation =
  | { ok: true; polygon: AoiPolygon }
  | { ok: false; reason: string };

const EPS = 1e-12;

function wrapDelta(d: number): number {
  return ((((d + 180) % 360) + 360) % 360) - 180;
}

function unwrapLon(lon: number, ref: number): number {
  return ref + wrapDelta(lon - ref);
}

/** Validates and normalises an open or closed ring. A closing vertex is not required. */
export function validatePolygon(input: unknown): PolygonValidation {
  if (!Array.isArray(input)) return { ok: false, reason: 'Polygon must be an array of [lon, lat] vertices.' };
  if (input.length < 3) return { ok: false, reason: 'A polygon needs at least 3 vertices.' };

  const points: AoiPolygon = [];
  for (const raw of input) {
    if (!Array.isArray(raw) || raw.length !== 2) {
      return { ok: false, reason: 'Every vertex must be [lon, lat].' };
    }
    const lon = Number(raw[0]);
    const lat = Number(raw[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
      return { ok: false, reason: 'Polygon coordinates must be finite numbers.' };
    }
    if (lon < -180 || lon > 180 || lat < -90 || lat > 90) {
      return { ok: false, reason: 'Polygon coordinates are outside longitude [-180,180] / latitude [-90,90].' };
    }
    points.push([lon, lat]);
  }

  // Drop an explicit closing vertex; the algorithms treat the ring as closed.
  if (
    points.length > 3 &&
    Math.abs(points[0][0] - points[points.length - 1][0]) < EPS &&
    Math.abs(points[0][1] - points[points.length - 1][1]) < EPS
  ) {
    points.pop();
  }

  // Reject degenerate rings (zero area on the local tangent plane).
  if (Math.abs(signedArea(points)) < 1e-12) {
    return { ok: false, reason: 'Polygon has zero area (vertices are collinear or duplicated).' };
  }
  return { ok: true, polygon: points };
}

function signedArea(points: AoiPolygon): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

function pointOnSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): boolean {
  // F37 fix: a zero-length edge (ax===bx, ay===by) must NOT match arbitrary query points.
  // Test as a point-to-point distance check instead of a line-segment check.
  const lenSq = (bx - ax) * (bx - ax) + (by - ay) * (by - ay);
  if (lenSq < EPS * EPS) {
    // Degenerate edge: only the exact endpoint matches.
    return Math.abs(px - ax) < EPS && Math.abs(py - ay) < EPS;
  }
  const cross = (px - ax) * (by - ay) - (py - ay) * (bx - ax);
  if (Math.abs(cross) > 1e-10) return false;
  const dot = (px - ax) * (bx - ax) + (py - ay) * (by - ay);
  if (dot < -EPS) return false;
  return dot <= lenSq + EPS;
}

/**
 * Point-in-polygon using the even-odd ray-casting rule. Boundary points count as inside.
 * The ring is unwrapped relative to its FIRST vertex (not the query point), and the query
 * longitude is unwrapped into the same frame. This keeps a small antimeridian-crossing ring
 * small instead of letting it span the whole globe.
 */
export function isPointInPolygon(lat: number, lon: number, polygon: AoiPolygon): boolean {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (polygon.length < 3) return false;

  const ref = polygon[0][0];
  const xs = polygon.map(([vLon]) => unwrapLon(vLon, ref));
  const ys = polygon.map(([, vLat]) => vLat);
  const px = unwrapLon(lon, ref);
  let inside = false;

  for (let i = 0, j = xs.length - 1; i < xs.length; j = i++) {
    const xi = xs[i];
    const yi = ys[i];
    const xj = xs[j];
    const yj = ys[j];

    if (pointOnSegment(px, lat, xi, yi, xj, yj)) return true;

    const intersects = yi > lat !== yj > lat;
    if (intersects) {
      const xCross = ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
      if (px < xCross) inside = !inside;
    }
  }
  return inside;
}

/** Bounding box of the polygon. If the ring crosses the antimeridian, the full longitude range is used. */
export function polygonBbox(polygon: AoiPolygon): BoundingBox {
  const lons = polygon.map((p) => p[0]);
  const lats = polygon.map((p) => p[1]);
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);
  const crosses = maxLon - minLon > 180;
  return {
    west: crosses ? -180 : minLon,
    south: Math.min(...lats),
    east: crosses ? 180 : maxLon,
    north: Math.max(...lats),
  };
}

/** Compact URL-safe encoding: `lon,lat;lon,lat;...` with 4 decimal places. */
export function encodePolygon(polygon: AoiPolygon): string {
  return polygon.map(([lon, lat]) => `${Number(lon.toFixed(4))},${Number(lat.toFixed(4))}`).join(';');
}

export function decodePolygon(value: string | null | undefined): AoiPolygon | null {
  if (!value || typeof value !== 'string') return null;
  const parts = value.split(';').filter((p) => p.trim() !== '');
  const points = parts.map((part) => {
    const [lon, lat] = part.split(',').map(Number);
    return [lon, lat] as [number, number];
  });
  const result = validatePolygon(points);
  return result.ok ? result.polygon : null;
}

export function filterByPolygon<T extends { latitude: number; longitude: number }>(
  observations: readonly T[],
  polygon: AoiPolygon | null | undefined
): T[] {
  if (!polygon || polygon.length < 3) return [...observations];
  return observations.filter((o) => isPointInPolygon(o.latitude, o.longitude, polygon));
}

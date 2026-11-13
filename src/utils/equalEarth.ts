/**
 * EPSG:8857 "WGS 84 / Equal Earth Greenwich" forward/inverse projection.
 *
 * The AgniCalendar dataset stores 10 km cells on this grid (origin 0,0 m).
 * cell_id encodes `r{floor(y/10000)}_c{floor(x/10000)}`; `grid_row`/`grid_col`
 * carry the same integer indices, so a lat/lon bounding box can be converted
 * to an integer row/col range for cheap filtering, and cell centers can be
 * converted back to lat/lon for map display.
 *
 * Implementation follows EPSG Guidance Note 7-2 method "Equal Earth" (EPSG:1078)
 * on the WGS84 ellipsoid (a = 6378137 m, e^2 = 0.00669437999014).
 */

const A = 6378137;
const E2 = 0.00669437999014;
const E = Math.sqrt(E2);
const SQRT3_2 = Math.sqrt(3) / 2;

const A1 = 1.340264;
const A2 = -0.081106;
const A3 = 0.000893;
const A4 = 0.003796;

/** Authalic quantity q(phi) from EPSG GN 7-2. */
function authalicQ(phi: number): number {
  const s = Math.sin(phi);
  return (
    (1 - E2) *
    (s / (1 - E2 * s * s) - (1 / (2 * E)) * Math.log((1 - E * s) / (1 + E * s)))
  );
}

const QP = authalicQ(Math.PI / 2);
const RQ = A * Math.sqrt(QP / 2);

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Forward: geodetic lon/lat (degrees) -> EPSG:8857 easting/northing (metres). */
export function equalEarthForward(lonDeg: number, latDeg: number): { x: number; y: number } {
  const lam = (clamp(lonDeg, -180, 180) * Math.PI) / 180;
  const phi = clamp(latDeg, -90, 90) * (Math.PI / 180);

  const q = authalicQ(phi);
  const beta = Math.asin(clamp(q / QP, -1, 1)); // authalic latitude
  const theta = Math.asin(clamp((Math.sqrt(3) / 2) * Math.sin(beta), -1, 1));

  const t2 = theta * theta;
  const t6 = t2 * t2 * t2;
  // Denominator series shared by both axes (derivative of the northing polynomial).
  const denom = A1 + 3 * A2 * t2 + t6 * (7 * A3 + 9 * A4 * t2);

  const x = (RQ * 2 * lam * Math.cos(theta)) / (Math.sqrt(3) * denom);
  const y = RQ * theta * (A1 + A2 * t2 + t6 * (A3 + A4 * t2));
  return { x, y };
}

/**
 * Inverse: EPSG:8857 easting/northing (metres) -> geodetic lon/lat (degrees).
 * Solves the northing equation for the parametric latitude theta by Newton
 * iteration, then recovers authalic and geodetic latitude.
 */
export function equalEarthInverse(x: number, y: number): { lon: number; lat: number } {
  // theta0 = y / RQ (equatorial approximation); Newton on g(theta) = theta*P(theta) - y/RQ.
  // Valid |theta| <= asin(sqrt(3)/2) = pi/3 (the poles); clamp so out-of-range
  // input degrades to the pole instead of diverging.
  const THETA_MAX = Math.asin(Math.sqrt(3) / 2);
  let theta = clamp(y / RQ, -THETA_MAX, THETA_MAX);
  for (let i = 0; i < 12; i++) {
    const t2 = theta * theta;
    const t6 = t2 * t2 * t2;
    const p = A1 + A2 * t2 + t6 * (A3 + A4 * t2);
    const g = theta * p - y / RQ;
    const dg = A1 + 3 * A2 * t2 + t6 * (7 * A3 + 9 * A4 * t2);
    if (Math.abs(dg) < 1e-12) break;
    theta = clamp(theta - g / dg, -THETA_MAX, THETA_MAX);
  }

  const t2 = theta * theta;
  const t6 = t2 * t2 * t2;
  const denom = A1 + 3 * A2 * t2 + t6 * (7 * A3 + 9 * A4 * t2);

  // theta -> authalic latitude beta -> geodetic latitude phi.
  const sinBeta = clamp((2 * Math.sin(theta)) / Math.sqrt(3), -1, 1);
  const beta = Math.asin(sinBeta);

  // Authalic -> geodetic latitude: solve authalicQ(phi) = QP*sin(beta).
  // authalicQ is monotonic in phi, so bisection is robust and fast enough for
  // cell-centroid use (this path is not hot).
  const targetQ = QP * Math.sin(beta);
  let lo = -Math.PI / 2;
  let hi = Math.PI / 2;
  let phi = beta;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (authalicQ(mid) < targetQ) lo = mid;
    else hi = mid;
  }
  phi = (lo + hi) / 2;

  const cosTheta = Math.cos(theta);
  const lam =
    Math.abs(cosTheta) < 1e-9
      ? 0
      : (x * Math.sqrt(3) * denom) / (RQ * 2 * cosTheta);
  return { lon: clamp((lam * 180) / Math.PI, -180, 180), lat: (phi * 180) / Math.PI };
}

export const GRID_RESOLUTION_M = 10_000;

/** Cell index for a projected coordinate: floor division, negatives included. */
export function gridIndex(coordM: number): number {
  return Math.floor(coordM / GRID_RESOLUTION_M);
}

/** Center of a grid cell (metres) for grid_row/grid_col indices. */
export function cellCenterM(row: number, col: number): { x: number; y: number } {
  return {
    x: (col + 0.5) * GRID_RESOLUTION_M,
    y: (row + 0.5) * GRID_RESOLUTION_M,
  };
}

/** Lat/lon of a grid cell centre (for map display). */
export function cellCenterLatLon(row: number, col: number): { lon: number; lat: number } {
  const { x, y } = cellCenterM(row, col);
  return equalEarthInverse(x, y);
}

/**
 * Lon/lat of the four corners of a grid cell, in projected-metre order:
 * (west,south) -> (east,south) -> (east,north) -> (west,north).
 * Equal Earth cells are squares in projected space but curved in lon/lat;
 * these corners approximate the cell boundary for map display.
 */
export function cellCornersLatLon(
  row: number,
  col: number
): Array<{ lon: number; lat: number }> {
  const x0 = col * GRID_RESOLUTION_M;
  const y0 = row * GRID_RESOLUTION_M;
  const corners: Array<[number, number]> = [
    [x0, y0],
    [x0 + GRID_RESOLUTION_M, y0],
    [x0 + GRID_RESOLUTION_M, y0 + GRID_RESOLUTION_M],
    [x0, y0 + GRID_RESOLUTION_M],
  ];
  return corners.map(([x, y]) => equalEarthInverse(x, y));
}

export interface GridRange {
  rowMin: number;
  rowMax: number;
  colMin: number;
  colMax: number;
}

/**
 * Convert a lon/lat bounding box to inclusive grid_row/grid_col ranges.
 * Equal Earth is pseudocylindrical: northing depends only on latitude, so the
 * row range is exact. Easting scales with cos(theta); using the latitude in
 * range nearest the equator gives the widest possible easting span, so the
 * column range is a conservative superset (boundary cells may be included).
 */
export function bboxToGridRange(
  west: number,
  south: number,
  east: number,
  north: number
): GridRange {
  const ySouth = equalEarthForward(0, south).y;
  const yNorth = equalEarthForward(0, north).y;
  const yMin = Math.min(ySouth, yNorth);
  const yMax = Math.max(ySouth, yNorth);

  // Easting x = lambda * g(phi) where g shrinks with |latitude|. The region's
  // x-extremes therefore occur at the longitude edges evaluated at the
  // equator-nearest and pole-farthest latitudes inside the box. Checking both
  // longitude edges at {south, north, equator-if-inside} covers every case and
  // yields a conservative superset of the projected bbox (boundary cells may
  // be included; none are missed).
  const lats = south <= 0 && north >= 0 ? [south, 0, north] : [south, north];
  let xMin = Infinity;
  let xMax = -Infinity;
  for (const lat of lats) {
    for (const lon of [west, east]) {
      const x = equalEarthForward(lon, lat).x;
      if (x < xMin) xMin = x;
      if (x > xMax) xMax = x;
    }
  }

  return {
    rowMin: gridIndex(yMin),
    rowMax: gridIndex(yMax),
    colMin: gridIndex(xMin),
    colMax: gridIndex(xMax),
  };
}

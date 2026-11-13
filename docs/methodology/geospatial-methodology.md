# Geospatial Methodology

This document describes FireSync's geospatial processing, coordinate transformations, and spatial indexing methodology.

---

## Coordinate Systems

### Input Coordinates

**Source:** NASA FIRMS CSV files  
**Format:** Decimal degrees (WGS 84)  
**Fields:** `latitude`, `longitude`

**Valid Range:**
- Latitude: -90° to +90°
- Longitude: -180° to +180°

### Equal-Area Projection

**Projection:** Cylindrical Equal-Area  
**Standard Parallel (φ₀):** 23.5°N (optimized for Bangladesh)  
**Purpose:** Equal-area grid cells for unbiased spatial aggregation

**Limitations:**
- **Not globally appropriate** — Polar distortion at high latitudes
- **Optimized for Bangladesh** — Standard parallel chosen for demonstration region
- **Requires redesign** for global deployment (e.g., discrete global grid)

---

## Polygon AOI (Area of Interest)

The map explorer can draw a polygon AOI. The same AOI is shared across pages and carried
in the URL as `aoi=lon,lat;lon,lat;...`.

**Implementation:** `src/utils/polygon.ts`

- Vertices use GeoJSON order `[longitude, latitude]`.
- A ring needs at least 3 vertices and non-zero area; an explicit closing vertex is accepted.
- The bbox remains a cheap preliminary filter. Actual filtering uses point-in-polygon.
- Boundary points count as inside, consistently.
- Antimeridian-crossing rings are unwrapped relative to the first vertex so a small ring
  does not become the whole globe.
- The polygon's bbox spans the full longitude range when the ring crosses the antimeridian.
- Invalid AOI input returns HTTP 400 rather than being silently ignored.

The URL encoding rounds coordinates to 4 decimal places.

---

## Spatial Grid

### Grid Cell Definition

**Resolution:** 1 km × 1 km  
**Coordinate System:** Projected equal-area (km)  
**Cell ID:** Computed from projected coordinates

**Indexing:**
```
cell_id = floor(projected_x / cell_size) + "_" + floor(projected_y / cell_size)
```

**Purpose:**
- Aggregate MODIS and VIIRS detections into comparable 1-km cells
- Enable spatial-temporal pairing for calibration
- Support density-based visualization

### 1-km Cell Justification

**MODIS nominal resolution:** ~1 km at nadir, up to 2 km × 4.8 km at scan edge  
**VIIRS nominal resolution:** ~375 m at nadir, up to ~800 m at scan edge

**Rationale:**
- MODIS and VIIRS cannot be directly compared at native resolutions
- 1-km cell approximates MODIS resolution
- VIIRS sub-pixel sensitivity accounted for in scaling factor (β)

---

## Coordinate Transformation

### Forward Projection (Geographic → Equal-Area)

**Function:** `projectToEqualAreaKm(latitude, longitude)`

**Formula:**
```
x = (longitude - lon₀) * (π/180) * R * cos(φ₀)
y = (latitude - lat₀) * (π/180) * R
```

Where:
- R = Earth radius (~6371 km)
- φ₀ = Standard parallel (23.5°N)
- lat₀, lon₀ = Reference point (Bangladesh center)

### Inverse Projection (Equal-Area → Geographic)

**Function:** `invertEqualAreaKm(x, y)`

**Formula:**
```
latitude = lat₀ + (y / R) * (180/π)
longitude = lon₀ + (x / (R * cos(φ₀))) * (180/π)
```

### Verification

**Test:** Round-trip transformation should return original coordinates within floating-point tolerance.

**Status:** ✅ PASS — All spatial tests passing

---

## Spatial-Temporal Aggregation

### Cell-Level Pairing

**Objective:** Identify 1-km cells with both MODIS and VIIRS observations on the same day.

**Process:**
1. Project all observations to equal-area coordinates
2. Compute grid cell ID for each observation
3. Group by (cell_id, date)
4. Count MODIS and VIIRS detections per cell per day
5. Identify cells with both sensors (paired cells)

**Output:**
- MODIS count per cell per day
- VIIRS count per cell per day
- Total FRP per cell per day
- Harmonized activity units (BAU) per cell per day

### Daily Summaries

**Objective:** Construct continuous day-by-day sequence for analysis.

**Process:**
1. Identify all dates in range
2. For each date, aggregate all cells
3. Handle missing dates (preserve observation opportunity)
4. Compute daily totals

**Current Issue:** Missing observation opportunity tracking — Cannot distinguish "no fire" from "no observation"

---

## Spatial Validation

### Haversine Distance

**Function:** `haversineDistanceKm(lat1, lon1, lat2, lon2)`

**Purpose:** Calculate great-circle distance between coordinates.

**Formula:**
```
a = sin²(Δφ/2) + cos(φ₁)·cos(φ₂)·sin²(Δλ/2)
c = 2·atan2(√a, √(1−a))
d = R·c
```

**Status:** ✅ PASS — Tested and accurate

### Bounding Box Validation

**Function:** `isPointInBbox(lat, lon, bbox)`

**Purpose:** Check if coordinates are within specified bounds.

**Parameters:**
- bbox: {west, south, east, north}

**Status:** ✅ PASS — Tested and accurate

---

## Global Limitations

### Current Projection Limitations

**Issue:** Cylindrical equal-area projection with φ₀ = 23.5°N is not suitable for global use.

**Problems:**
1. **Polar distortion** — Extreme distortion at high latitudes
2. **Dateline crossing** — Not handled correctly
3. **Unequal cell area** — Equal-area property degrades far from standard parallel
4. **Optimized for Bangladesh** — Not appropriate for Amazon, Arctic, etc.

### Required Global Solution

**Options:**
1. **Discrete Global Grid (DGG)** — Equal-area hexagonal or triangular grid
2. **Regional projections** — Different standard parallels per region
3. **Geodesic grid** — Icosahedral-based equal-area grid

**Recommended:** Discrete Global Grid (e.g., H3 hexagonal grid) for true global coverage.

---

## Regional Processing

### Study Regions

**Current regions configured:**
- World (default)
- Bangladesh
- Indochina (Southeast Asia)
- Amazon Arc (Brazil/Bolivia)
- California (Western North America)
- Central Africa, Eastern Australia, Mediterranean Europe, Canada boreal, Siberia

**Processing:**
- Each region has its own bounding box
- Standard parallel should be adjusted per region
- Spatial indexing computed per region

**Status:** live NRT queries work worldwide. A local historical archive
(MODIS 2000–2025, VIIRS SNPP 2012–2025) provides multi-year coverage when the
pipeline has been run on the local FIRMS ZIPs; it is not part of the runtime store.

---

## Data Quality Checks

### Coordinate Validation

**Checks:**
- Latitude within [-90, 90]
- Longitude within [-180, 180]
- No NaN or null values
- Requested bbox/AOI filtering

**Status:** implemented and covered by tests. No record-level pass percentage is claimed for
the live world response.

### Duplicate Detection

**Method:** SHA-256 hash of canonical record fields

**Status:** implemented for the store/ingestion path and covered by tests.

### Spatial Outliers

**Method:** check whether coordinates are inside the requested bbox and AOI.

**Status:** implemented and tested, including antimeridian-crossing AOIs. The live world
request uses the full globe, so no smaller-region containment is claimed for it.

---

## Future Improvements

### Short-Term

1. **Document projection limitations** — Add warning about polar unsuitability
2. **Add dateline crossing tests** — Even if not currently needed
3. **Implement observation opportunity tracking** — Critical for scientific validity

### Long-Term (Global)

1. **Replace cylindrical projection** with discrete global grid
2. **Implement regional projections** with per-region standard parallels
3. **Add country attribution** — Map cells to country codes
4. **Implement multi-resolution grids** — 1-km, 5-km, 10-km for different use cases
5. **Add coastal handling** — Special handling for coastal observations

---

## References

- **Snyder, J. P. (1987).** Map Projections: A Working Manual. USGS Professional Paper 1395.
- **NASA FIRMS.** Fire Information for Resource Management System.
- **MODIS Collection 6.1 User Guide.** NASA Land Processes Distributed Active Archive Center.
- **VIIRS 375m Active Fire Product User Guide.** NASA Land Processes Distributed Active Archive Center.

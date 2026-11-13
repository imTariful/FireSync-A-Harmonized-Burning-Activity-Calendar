# Attributions and data-source notices

Status of this file: reconciled against the current code on 2026-11-10.
Every "used" entry below was confirmed by grepping `src/`, `server.ts` and `index.html`.
Entries that are **not** used by the code are listed separately so they are not claimed by mistake.

## Required legend sentence

The map legends (`src/components/explorer/ExplorerLegend.tsx`, rendered by `FireGlobe.tsx`) shows this exact sentence.
Keep it verbatim anywhere FireSync detections are shown, exported or presented:

> Satellite thermal anomalies, not confirmed wildfires or burned area.

## Used by the code

### NASA FIRMS (fire detections)

- **What:** Active-fire detections from NASA FIRMS (Fire Information for Resource Management System, NASA LANCE / ESDIS).
- **How FireSync uses it:** The Express server calls the FIRMS area API
  (`https://firms.modaps.eosdis.nasa.gov/api/area/csv/<MAP_KEY>/<SOURCE>/<bbox>/<days>`) from `src/server/firmsHandler.ts`.
  Sources requested by the live path (`FIRMS_SOURCES` in `src/utils/firms.ts`): `MODIS_NRT`, `VIIRS_NOAA20_NRT`, `VIIRS_NOAA21_NRT`.
  MODIS and VIIRS are kept as separate sensors and are not merged or summed.
- **Credential:** A free FIRMS MAP_KEY is read on the server only (`FIRMS_MAP_KEY`). It is never sent to the browser and is masked in logs and errors.
- **In-app credit:** Map attribution strings include "NASA FIRMS" (`FireGlobe.tsx`, basemap sources in `basemap.ts`).
- **Citation:** NASA asks users to cite the specific FIRMS/LANCE product. Take the exact citation and DOI from the product page on
  https://www.earthdata.nasa.gov/ (for example, the NOAA-20 VIIRS 375 m NRT page lists DOI `10.5067/FIRMS/VIIRS/VJ114IMGT_NRT.002`).
  The repository no longer carries a bundled archive citation string; the live source and product IDs are shown in the
  API response and export metadata. Verify the exact citation against NASA's current product pages before submission.
- **Suomi NPP:** NASA announced that Suomi NPP data delivery ends in early November 2026 (the pages I found say 1 Nov in one place and
  2 Nov 2026, 13:00 UTC in others, "subject to change"). The live path above does not request Suomi NPP. No historical Suomi NPP
  records are bundled in the runtime store; the old sample archive was removed on 2026-11-10.

### NASA GIBS (basemap imagery)

- **What:** NASA Global Imagery Browse Services (GIBS) WMTS raster tiles.
- **Where:** `src/utils/gibs.ts` builds the tile URLs and MapLibre sources; the Explorer
  can use GIBS basemap and true-color layers.
- **In-app attribution:** `Imagery: NASA EOSDIS GIBS` (from `GIBS_CONFIG.attribution`).
- **Status:** URL construction is unit-tested; live tile availability has not been
  verified in a browser/network session. If GIBS tiles fail, the code falls back to the
  non-GIBS basemap.

### MapLibre GL JS (map and globe rendering)

- **What:** `maplibre-gl` 6.16.0 (per `package-lock.json`), license BSD-3-Clause (as recorded in the lockfile).
- **Where:** `FireGlobe.tsx` (map attribution strip) and `ExplorerLegend.tsx`.
- **Also loaded at runtime:** map label glyphs from `https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf` (`FireGlobe.tsx`).
  This is MapLibre's public demo-tile host; I did not check its terms or availability guarantees.

### Esri "World Dark Gray Base" raster tiles

- **Confirmed in code:** both `FireGlobe.tsx` (map attribution strip) and `ExplorerLegend.tsx` request
  `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`.
- **Attribution string in code:** "© Esri, HERE, Garmin, © OpenStreetMap contributors" (plus the FIRMS credit).
- **Not verified:** Esri's current terms for using this public tile endpoint outside an Esri account/product. Check before any use beyond the demo.

### OpenStreetMap

- Credited through the Esri basemap string above (the code credits "© OpenStreetMap contributors" next to it) and through Nominatim below.
  FireSync does not request OpenStreetMap map tiles directly.

### OpenStreetMap Nominatim (place search)

- **Where:** `src/utils/geocode.ts`, called from the search box in `FireGlobe.tsx`. Endpoint: `https://nominatim.openstreetmap.org/search`.
- **Usage policy followed in code** (policy: https://operations.osmfoundation.org/policies/nominatim/): search runs on submit only (no search-as-you-type),
  requests are spaced at least 1 s apart, in-flight requests are aborted, and results are attributed.
- **In-app attribution text (exact):** `Search © OpenStreetMap contributors (Nominatim)`, shown under the results.
- **Known limit:** browsers cannot set a custom `User-Agent`; the browser's own `Referer` is sent (comment in `geocode.ts`).
  I did not verify that this satisfies the Nominatim identification requirement for a hosted deployment.

### Google Fonts

- `index.html` loads **JetBrains Mono** and **Plus Jakarta Sans** from `fonts.googleapis.com` / `fonts.gstatic.com`. Both are open-licensed fonts on Google Fonts;
  I did not check the exact license text of each family.

## Not used by the code (do not claim)

- **NASA Worldview application:** FireSync uses GIBS tiles, not the Worldview app or its
  layers as a product.
- **PostgreSQL/PostGIS, Redis:** referenced by docs and `docker-compose.yml` as optional
  profiles, but the Express server does not use them (see
  `docs/architecture/system-architecture.md`).

## Legacy bibliography carried from the source guide

The earlier guide credited NASA Near Real-Time and Archive Fire Information for
Resource Management System (FIRMS), NASA Goddard Space Flight Center, and listed
[MODIS C6.1](https://doi.org/10.5067/FIRMS/MODIS/C6.1) and
[VIIRS 375 m](https://doi.org/10.5067/FIRMS/VIIRS/375M).
These generic references are preserved as bibliography; their product scope and
resolution were not re-verified during documentation consolidation. Use the exact
product/version citation from NASA's product page when preparing a submission.

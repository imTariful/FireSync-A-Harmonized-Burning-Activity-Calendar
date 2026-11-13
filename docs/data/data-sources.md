# Data sources and product references

FireSync keeps live NRT, the country observation archive and the frozen monthly
AgniCalendar product separate. Check their status endpoints before a demo; a fresh
clone does not contain the large local historical datasets.

Satellite thermal anomalies, not confirmed wildfires or burned area.

## Data paths used by the app

| Path | Source and population | Resolution / role |
|---|---|---|
| Live `/api/v1/fires` and `source=live` | FIRMS `MODIS_NRT`, `VIIRS_NOAA20_NRT`, `VIIRS_NOAA21_NRT` | Rolling 1–5 UTC days; source observations and per-sensor aggregates |
| Local `/api/v1/history/*` | Official download ZIPs, MODIS Terra/Aqua and VIIRS Suomi-NPP | Historical observations and separate daily/monthly aggregates |
| Local `/api/v1/agnicalendar/*` | Frozen Aqua/SNPP cell-month product and approved conditional RF-B outputs | 10 km EPSG:8857, monthly only; supported estimates are labelled EXPLORATORY |

Suomi-NPP history is retained separately from the current NOAA-20/21 live path.
The SNPP RF-B model is not applied to NOAA-20/21, Terra or live NRT. Original source
counts and conditional estimates are different quantities and are never added.

Use the [historical archive guide](../historical-archive.md) for ZIP import/coverage,
[AgniCalendar guide](../agnicalendar.md) for monthly selection and baselines, and
[model provenance](model-provenance.md) for the frozen policy, hashes and validation gaps.

## Sensors and fields

MODIS has a nominal 1 km nadir footprint; VIIRS has a nominal 375 m nadir footprint.
Actual scan/track dimensions vary. Neither sensor's pixel is a fire perimeter.

Preserve native coordinates, UTC acquisition date/time, satellite, product/version,
confidence, day/night, FRP, source identifiers and retrieval time. FRP is measured in
MW; it is not burned area or radiated energy. Scan/track describe pixel dimensions,
not scan angles. See the [canonical schema](data-schema.md) for application fields.

MODIS numeric confidence and VIIRS categorical confidence are different scales.
Do not average them into a probability or interpret them as wildfire severity.
Preserve native values and disclose any application filtering. The dated research
record below distinguishes code behavior from independently verified NASA definitions.

## Acquisition, provenance and interpretation

- Get a server-side MAP_KEY through [NASA FIRMS](https://firms.modaps.eosdis.nasa.gov/api/map_key/).
  The [README](../../README.md#quick-start) owns app startup/configuration.
- Short-window download and validation commands, supported pipeline product IDs,
  resume rules and source statuses live in the [pipeline guide](../pipeline.md).
  Bulk archives use the official download/Earthdata workflow.
- Live requests share a 30-minute cache, two upstream workers and a process-local
  transaction budget. That budget is not coordinated across multiple deployments.
- Preserved bytes receive SHA-256 hashes and manifests. Hash equality proves integrity,
  not NASA authenticity. Reuse with a mismatched checksum fails.
- Missing records, empty successful responses and source failures have different meanings.
  Neither missing nor no-reported-detection periods prove no fire. Acquisition time is
  not ignition time; incomplete current periods are not complete historical periods.
- Cloud, overpass and source-availability gaps prevent a completeness claim without
  independent observation-opportunity evidence. NRT is provisional monitoring information.

For required display credits, product-specific citation guidance, map providers,
fonts and outstanding terms checks, use the [attribution notices](attributions.md).
Do not substitute a generic DOI for the actual exported product's citation.

## Research record — 2026-11-12

The following source checks were recorded during the earlier audit. They retain their
original date and access limitations; this documentation cleanup did not re-fetch them.

Fetched primary sources; some Earthdata pages returned HTTP 403. This is partial research, not a claim that inaccessible attribute tables were reviewed.

| Official source | Verified information |
|---|---|
| [FIRMS](https://firms.modaps.eosdis.nasa.gov/) | Live MODIS Aqua/Terra and VIIRS NOAA-20/21; global delivery described as within three hours of observation, not ignition; regional RT differs. |
| [API index](https://firms.modaps.eosdis.nasa.gov/api/) | Area CSV, availability, missing data; country endpoints explicitly unavailable. API version displayed 4.2.8. |
| [Area API](https://firms.modaps.eosdis.nasa.gov/api/area) | `/api/area/csv/[MAP_KEY]/[SOURCE]/[west,south,east,north or world]/[1..5]/[optional YYYY-MM-DD]`; explicit date starts a forward window; omitted date ends today. MODIS_NRT/SP, VIIRS_SNPP/NOAA20/NOAA21_NRT/SP enumerated. RT/URT removed upon NRT replacement or after six hours; RT within 60 minutes; URT under 60 seconds for much of US/Canada, not a worldwide SLA. |
| [MAP_KEY](https://firms.modaps.eosdis.nasa.gov/api/map_key/) | Free email registration; 5000 transactions per ten-minute interval; larger requests may cost multiple transactions. Keys stay server-side. |
| [Active fire](https://firms.modaps.eosdis.nasa.gov/active_fire/) | Page fetched but no readable content returned; no independent claims drawn from it. |
| [Archive](https://firms.modaps.eosdis.nasa.gov/download/) | Older-than-seven-day CSV/SHP/JSON; Earthdata/email authentication; standard science data replace NRT with approximately five-month lag. MODIS from 2000-11-01, SNPP 2012-01-20 to 2026-11-02, NOAA20 from 2018-04-01, NOAA21 from 2023-03-01. |
| [NASA transition notice](https://firms2.modaps.eosdis.nasa.gov/content/notifications/firms2/news.html) | SNPP observation delivery ceased November 2, 2026; transition to NOAA-20/21. Existing source selection is appropriate; its November 1 comment is stale. |
| [Availability](https://firms.modaps.eosdis.nasa.gov/api/data_availability/) | `/api/data_availability/csv/[MAP_KEY]/[SENSOR]`; enumeration does not guarantee current observations. |
| [Missing data](https://firms.modaps.eosdis.nasa.gov/api/missing_data/) | Missing days separated by platform/type; NRT shown after last standard date. Table itself failed to load during research. Cannot claim complete coverage. |
| [Earthdata](https://www.earthdata.nasa.gov/) | HTTP 403 in this environment. Official linked FAQ, MODIS/SNPP attribute redirects, NOAA20/21 attribute pages and citation destination also blocked. |
| [Challenge](https://www.spaceappschallenge.org/2026/challenges/modis-and-viirs-hot-spots/) | Web burning calendar with harmonized records, historical patterns, unusual conditions and critical periods for an AOI. Does not establish model validity or authorize forecast claims. |

Observation attributes preserved by the existing integration: lat/lon, acquisition date/HHMM UTC, satellite, sensor/product, native confidence, FRP MW, DN, version, retrieval time, source identifiers. MODIS numeric and VIIRS categorical confidence are different scales; do not average them into a probability or treat confidence as wildfire severity. Exact official confidence threshold definitions and current licensing/citation text remain UNVERIFIED because linked Earthdata tables were blocked. Existing code bins MODIS at 30/80 and VIIRS l/n/h; that is an implementation fact, not newly verified NASA guidance. Before public release, verify [NASA-linked attribution](https://firms.modaps.eosdis.nasa.gov/) and the source-specific product DOI rather than inventing a license.

NRT is provisional monitoring information. Keep it separate from frozen historical data; preserve raw versions and UNKNOWN processing status. No-detection and missing-data periods do not establish no fire. Overpass acquisition is not ignition time. Incomplete current-day/month counts are not comparable to complete historical monthly totals. Cloud/overpass/coverage constraints prevent pre-ignition warning claims. Do not apply the SNPP RF-B model to NOAA20/21, Terra or live NRT.

## Further reading

The earlier source guide also cites Giglio et al., *Collection 6 MODIS Active Fire
Product User's Guide* (2016); Schroeder et al., *VIIRS 375m Active Fire Product User's
Guide* (2014); and Justice et al., *The MODIS Fire Products* (2002). Use the
source-specific official pages above when preparing submission citations.

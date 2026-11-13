# FireSync — Calendar & Monitoring

**Team:** BOT Battalion

**Challenge:** NASA Space Apps 2026 — Harmonization of MODIS and VIIRS Hot Spots

**License:** Apache-2.0

## What this build does

FireSync displays NASA FIRMS satellite observations with separate **MODIS** and **VIIRS**
layers, counts and exports. Hotspot Explorer is the starting screen; the initial area is
World. Use a regional selection for a readable demo and smaller, less likely capped requests.

- **Overview:** daily observation/FRP charts and an explanation of the data workflow.
- **Calendar → Daily calendar:** live UTC-day activity, or the separate global historical
  archive. The historical chart explicitly identifies its global scope.
- **Calendar → Monthly AgniCalendar:** the local 10-km cell-month dataset, country/region
  selection, historical comparisons, map overlays and CSV downloads.
- **Calendar → Early monitoring:** search or select an area on an inline map; save a
  per-sensor threshold and view in-app alerts. The scheduler runs while the server runs.
- **Sensor Comparison:** separate count/FRP comparisons, footprint diagrams and real paired
  cell-day diagnostics. **Geographic Analysis**, **More → Methodology**, **Data & Exports**,
  **Settings** and the optional AI Investigator remain available.

**Satellite thermal anomalies, not confirmed wildfires or burned area.** Missing records
are unavailable observations, not proof of zero fire. MODIS and VIIRS raw counts are not
added into a unique-fire count. FRP is reported in MW, not burned area or radiated energy.

The live 1-km cell-day **BAU** index uses an **EXPLORATORY** fixed weighting, not a fitted,
validated fire-count model. The separate AgniCalendar RF-B estimates use approved
joint-positive support on a 10-km monthly grid. They are not a complete corrected VIIRS
series and must not be joined to live BAU as one continuous series. Historical patterns
and monitoring thresholds do not predict future fires.

## Quick start

Run commands from the repository directory containing `package.json` and `server.ts`.
Use Node **20.19+ (20.x) or 22.12+**; CI uses Node 22. Local maintenance checks used Node
24.19.0 and npm 11.17.0. Python is only needed for the optional data pipelines.

```sh
npm ci
```

Create a local configuration only if `.env` does not already exist:

```powershell
# Windows PowerShell
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
```

On macOS/Linux, use `test -f .env || cp .env.example .env`. Get and configure a FIRMS key
using the [configuration guide](docs/guides/configuration.md#firms_map_key), then set
`FIRMS_MAP_KEY` in that local file for live data. Keep credentials server-side and out of
commits, screenshots and recordings.

```sh
npm run dev
```

Open **http://localhost:3000**. This one command runs Express APIs and Vite together;
there is no separate frontend/backend startup. `PORT` overrides 3000, so use the URL
printed by the server if your local configuration changes it. For this workspace's
port 300, set `$env:PORT='300'` in PowerShell before starting. Use one development instance
at a time; parallel instances can collide on Vite's HMR port (`24678`).

Without a FIRMS key, live requests report an unavailable/not-configured state. There is
no synthetic runtime fallback. Existing local historical datasets can still be used
through their explicitly labeled archive views; a fresh clone does not include them.

## Demo configuration and local data

| Feature | Requirement |
|---|---|
| Live MODIS / VIIRS | `FIRMS_MAP_KEY`; network access to NASA FIRMS. Current source identifiers in this build: `MODIS_NRT`, `VIIRS_NOAA20_NRT`, `VIIRS_NOAA21_NRT`. |
| Basemaps / place search | WebGL, network access to the map/imagery provider and OpenStreetMap Nominatim. |
| Historical daily archive | Local Parquet under `data/historical/parquet`, or `FIRESYNC_HISTORICAL_PARQUET`. MODIS and Suomi-NPP VIIRS remain separate. |
| Monthly AgniCalendar | Local `Harmonized Data Set/AgniCalendar_Global_Harmonized_CellMonth` partitions, or `FIRESYNC_AGNICALENDAR_PARQUET`; country lookup uses `FIRESYNC_AGNI_CELL_COUNTRY`. |
| Persistent monitoring | Optional `FIRESYNC_WATCHLIST_PATH`, e.g. `./data/store/watchlists.json`. Otherwise watches/alerts are in memory and lost on restart. Delivery is in-app only. |
| Observation/job persistence | Optional `FIRESYNC_STORE_PATH`, e.g. `./data/store/observations.json`. This store is separate from the bulk archive and starts empty unless restored. |
| Optional AI explanation | `FIRESYNC_AI_ENABLED=true` and server-side `GROQ_API_KEY`. Deterministic maps, charts and monitoring do not require a model call. |

Large datasets are gitignored. Do not rebuild/import them before a demo if the status
endpoints already report availability. See [Historical archive](docs/historical-archive.md)
and [AgniCalendar](docs/agnicalendar.md) for their existing data workflows. The basic
`data_pipeline/run_pipeline.py` uses Python's standard library; historical builders also
need Python 3.13 with `duckdb`, as described in the archive guide.

For a **code-only upload**, keep the large datasets and real `.env` excluded. The
[data-path layout](docs/guides/configuration.md#local-data-paths-for-a-code-only-upload)
documents the default folders and overrides. Run from the repository root; missing
local products remain explicitly unavailable while the app starts normally.

Useful preflight endpoints:

- `/api/v1/health` — server/storage state.
- `/api/v1/data-availability` — live configuration and local observation-store state.
- `/api/v1/history/status` and `/api/v1/agnicalendar/status` — separate local dataset status.
- `/api/v1/watchlists` — monitor storage, scheduler and delivery metadata.

## Short judging demo

1. **Hotspot Explorer → Region:** choose a named region such as **California / US West**.
   Select a live window and inspect a real point. MODIS is crimson; VIIRS is yellow.
   Dot size represents the nominal sensor footprint; FRP drives intensity. Read current
   source/count/truncation labels rather than announcing fixed counts.
2. **Overview:** switch the chart between counts and FRP. Toggle a sensor legend and
   inspect a date with the slider or **View data**. Satellite/FRP filters also apply to
   the live calendar, sensor comparison and their downloads.
3. **Sensor Comparison:** highlight a footprint and inspect a paired cell. Explain that
   raw pixels are not unique fires and read the actual calibration status/limitations.
4. **Calendar:** show Daily calendar, then **Monthly AgniCalendar** if its local data is
   available. Select a year/month and use **Inspect this month below** or the existing
   map/export action. Monthly records do not provide daily or weekly results.
5. **Early monitoring** optionally shows map-based area selection and a threshold.
   Do not promise an immediate new-observation alert during a short recording.
6. **More → Data & Exports:** download the scoped calendar/hotspot CSV and show its source
   metadata. Finish with **Methodology** and the limitations.

The [three-minute storyboard](docs/pitch/storyboard.md) gives a recording sequence.
If a service fails, show its honest error state. Use a local archive only as a separately
labeled historical view when available; do not present it as live data.

## Checks and production startup

```sh
npm run lint
npm test
npm run build
```

Tests use deterministic fixtures/mocked network responses; fixtures are not runtime demo
data. Run memory-heavy checks sequentially. Passing checks do not establish scientific
validation or replace a browser recording rehearsal.

After building, start the full production app:

```powershell
# Windows PowerShell
$env:NODE_ENV='production'
npm start
```

For a development session in the same shell, set `$env:NODE_ENV='development'` before
`npm run dev`. On macOS/Linux, use `NODE_ENV=production npm start`. Production serves
`dist/` and exits clearly if the frontend build is absent. `npm run preview` serves the
Vite frontend only; use Express (`npm start`) for the complete API-backed demo.

## Limits, references and credits

- Live NRT is a rolling **1–5 UTC-day** window. A broad world request can be capped;
  zoom/narrow the region and respect the truncation/source-error labels.
- The daily historical aggregate is global. Archive AOI/export parity is not guaranteed;
  the AgniCalendar product has its own documented grid-centre/country scope rules.
- Calibration is exploratory/in-sample unless the app explicitly reports that its
  independent validation requirements were met. Missing metrics stay unavailable.
- PostGIS/Redis are optional compose profiles, not application storage integrations.
- Live sources, map tiles and AI can fail independently. No bundled/synthetic observation
  mode is supplied. Confirm the actual configuration and datasets before recording.

## Documentation

| Need | Maintained entry point |
|---|---|
| Use the app | [User guide](docs/guides/user-guide.md) and [judging storyboard](docs/pitch/storyboard.md) |
| Configure or deploy | [Configuration](docs/guides/configuration.md), [deployment and Docker](docs/guides/deployment.md) |
| Import local data | [Pipeline](docs/pipeline.md), [historical archive](docs/historical-archive.md), [AgniCalendar](docs/agnicalendar.md) |
| Understand sources | [Products and NASA research](docs/data/data-sources.md), [attribution notices](docs/data/attributions.md), [model provenance](docs/data/model-provenance.md) |
| Review the method | [Harmonization](docs/methodology/sensor-harmonization.md), [scientific validation](docs/methodology/scientific-validation.md), [limitations](docs/methodology/limitations.md) |
| Develop integrations | [API reference](docs/api/api-reference.md), [system architecture](docs/architecture/system-architecture.md) |
| Verify a change | [Testing and smoke checks](docs/testing/testing-strategy.md) |
| Interpret older evidence | [Evidence notes](reports/evidence/README.md), [dated reports and archive index](reports/remediation/README.md) |

## Credits

**Sources and acknowledgments:** NASA FIRMS (active-fire observations), NASA EOSDIS GIBS
(imagery), Esri and its contributors (street/dark maps), OpenStreetMap contributors /
Nominatim (place search), MapLibre GL JS, React, Vite, Tailwind CSS, DuckDB and Lucide.
Groq supplies the optional AI service. Follow the source attribution shown in the app.

Built by **BOT Battalion**. Licensed under **Apache-2.0**.

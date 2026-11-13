# Testing and verification

Use the [README](../../README.md#quick-start) to install and configure FireSync.
Run the existing checks sequentially from the repository root:

```sh
npm run lint
npm test
npm run build
```

`lint` runs TypeScript with no emit. Tests use Node's runner through `tsx`;
the `package.json` test script explicitly lists each file. Add new tests there.
The build creates `dist/`. Read actual command output for counts and failures;
historical reports are dated evidence, not the current test status.

## Automated coverage

| Area | Contracts exercised |
|---|---|
| Live API and ingestion | Validation, source errors, cache/retry/budgets, key masking, raw-file preservation and job states |
| Query and export parity | AOI, dates, satellite, confidence and FRP filters; CSV metadata and formula sanitization |
| Calendar and statistics | Missing dates stay missing, nullable statistics, eligible history and target-year exclusion |
| Monthly AgniCalendar | Exact year/scope, supported estimates, provenance, cell-centre selection and streaming exports |
| Monitoring | Area geometry, per-sensor thresholds, deduplication, partial-source rejection and scheduler history |
| Components | Calendar navigation, inline map controls, charts, sensor diagrams, legends, sharing and evidence labels |
| Geometry and analytics | Projection, matching, polygons, antimeridian handling, anomaly statistics and calibration constraints |

Network calls in the automated suite are mocked. Synthetic fixtures exercise distinct
edge cases and are not runtime observations. The historical calibration JSON used by
the evidence panel describes a removed demo fixture; see its
[interpretation notes](../../reports/evidence/README.md).

## Python checks

There is no committed Python unit-test suite. Syntax and a planning-only run can be
checked without downloading or rebuilding a dataset:

```sh
python -m compileall -q data_pipeline
python data_pipeline/run_pipeline.py --region bangladesh --start 2024-01-01 --end 2024-01-12 --dry-run
```

The dry run should plan three windows and make no requests or output files.
For command-level acceptance/rejection, empty-input, checksum-mismatch or missing-key
checks, use isolated temporary raw/output/report/queue paths. Never point a synthetic
fixture run at the team's preserved data directories. A failed download must stay
failed; an empty successful response is a different state.

The [pipeline guide](../pipeline.md) owns CLI options and status meanings.
The [AgniCalendar guide](../agnicalendar.md#reproducing-the-local-data-checks) owns
real local-product audit commands; those scripts overwrite their documented evidence
outputs and require the actual datasets.

## App and judging smoke check

Follow the [README demo](../../README.md#short-judging-demo) and
[recording storyboard](../pitch/storyboard.md):

1. Check health, live configuration and each local dataset's status.
2. Select a small region and live window in Hotspot Explorer. Inspect actual source,
   cap/error labels, map tiles, per-sensor markers and the observation detail panel.
3. Inspect Overview and Sensor Comparison; change dates, source/satellite and FRP
   filters, then compare the corresponding calendar and downloads.
4. Inspect Daily Calendar and the separate historical/monthly views when available.
   Choose a month, inspect its map cells and download the regional CSV.
5. In Early monitoring, search/tap/draw an area and inspect thresholds and status.
   Preserve existing watches. An immediate new-observation alert is not guaranteed.
6. Check console/network errors, mobile layout, keyboard chart controls and external
   imagery. Build and use the README production startup to check asset resolution.

API probes and static component rendering do not verify browser interaction or WebGL
tiles. There is no committed Playwright/Cypress suite; desktop/mobile behavior,
provider availability, container execution and sustained load need separate checks.
Report blocked checks with their concrete reason.

## CI and interpretation

[CI](../../.github/workflows/ci.yml) uses Node 22, installs with `npm ci`, then runs
lint and tests without secrets or NASA requests. Production builds, Python checks,
real datasets and a browser rehearsal are additional local/release checks.

Passing tests do not establish source authenticity, equal satellite exposure,
scientific calibration accuracy or future-fire prediction. Raw MODIS/VIIRS counts
stay separate, missing values remain unavailable, and an undefined R² stays null.
Use the [methodology](../methodology/scientific-validation.md) for validation criteria.

Older measured diagnostics and limitations remain in the
[remediation history](../../reports/remediation/README.md) and
[model provenance](../data/model-provenance.md). Check their dates before quoting them.

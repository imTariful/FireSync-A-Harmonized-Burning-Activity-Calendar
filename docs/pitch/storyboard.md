# FireSync: three-minute demo storyboard

Team: **BOT Battalion**. Challenge: **Harmonization of MODIS and VIIRS Hot Spots**.
Target duration: three minutes; rehearse the timing before recording.

## Preflight

Follow [README setup and configuration](../../README.md#quick-start). Start the complete
app with `npm run dev` at http://localhost:3000, or the configured `PORT`.

- Keep `.env` and credentials off screen. Live data needs the server-side FIRMS key.
- Warm a small region's live window once; counts change with acquisition dates and sources.
- Check `/api/v1/history/status` and `/api/v1/agnicalendar/status` before including local
  history. Those datasets exist on the team's configured machine, not in a fresh clone.
- Keep MODIS and VIIRS separate. Read actual values/statuses from the app; do not use
  fixed observation counts or calibration scores in the narration.
- Use the same region, dates and sensor selection across live views. Respect a partial or
  truncated response. A successful zero-result query is different from a failed request.

## Recording sequence

| Time | Screen and action | Explain |
|---|---|---|
| 0:00–0:35 | **Hotspot Explorer → Region**, e.g. California / US West; choose a live window and inspect a real detection. | MODIS is crimson, VIIRS yellow. Dot size follows sensor footprint; FRP drives intensity. A satellite thermal anomaly is not a confirmed wildfire or burned area. |
| 0:35–1:00 | **Overview:** counts/FRP measure, sensor legend toggle, period slider and **View data**. | Different instruments can report different pixel counts for the same scene. The separate raw counts must not be summed into a fire count. |
| 1:00–1:35 | **Sensor Comparison:** footprint focus and paired-cell inspection. | The schematic uses a common spatial scale. The scatter shows actual raw cell-day counts, not an invented fitted line. Read the returned calibration status; the fixed coefficient is exploratory. |
| 1:35–2:20 | **Calendar → Daily calendar**, then **Monthly AgniCalendar** when available; choose a year/month and inspect it. | Live data uses UTC days. The historical daily chart is global. AgniCalendar is a separate 10-km monthly product, with conditional EXPLORATORY estimates and explicitly unavailable records. It does not provide daily/weekly predictions. |
| 2:20–2:40 | Optionally **Early monitoring**: find a place or draw a rectangle; explain a threshold. | The existing scheduler checks newly reported observations while the server runs. Alerts are in-app only. Acquisition time is not ignition time; do not promise an immediate alert during the recording. |
| 2:40–3:00 | **More → Data & Exports:** download a scoped CSV; finish on **Methodology**. | Exports retain source metadata and formula-injection protection. Explain the current scientific limitations rather than claiming validated fire prediction. |

## If a dependency fails

Show the actual error or unavailable state. Continue with methodology, diagrams and any
independently available local history, clearly labeled as historical. Do not substitute
synthetic records, relabel history as live data or interpret missing observations as zero.

## Claims to avoid

- A complete global census when a source/response is capped or partial.
- Confirmed incidents, burned area or unique-fire counts inferred from hotspot pixels.
- A validated model, a measured accuracy score or future predictions without the app's
  corresponding independent evidence. An unavailable R² is not a score of zero.
- NOAA-20/21 coverage in the Suomi-NPP-only historical VIIRS archive.
- Email/push alerts, always-on monitoring, durable storage without configuration, or
  PostGIS/Redis integration. Those are not implied by the local running server.

This storyboard reflects repository behavior, not a verified official judging checklist.
The exact challenge brief/participant instructions must be checked separately when supplied.

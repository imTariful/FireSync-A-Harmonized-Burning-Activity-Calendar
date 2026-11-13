# Remediation Reports — Index

**Date:** 2026-11-10
**Project:** FireSync — Harmonized Fire Activity Intelligence
**Primary API:** Express 4 (`server.ts`, `src/server/app.ts`)
**Runtime shape:** World default, live NASA FIRMS NRT (rolling 1–5 days), empty local
store by default, no bundled archive, calibration `INSUFFICIENT`

This folder preserves dated remediation evidence from 2026-11-09/10. Its counts and
availability statements describe those runs. For current setup and app behavior, use
the [README](../../README.md); for current checks, use the
[testing guide](../../docs/testing/testing-strategy.md). Run those commands again
before claiming a current pass.

| Report | Purpose |
|---|---|
| [INITIAL_AUDIT.md](INITIAL_AUDIT.md) | Baseline architecture, confirmed defects, scientific limitations, security findings, priorities (historical snapshot) |
| [IMPLEMENTATION_LOG.md](IMPLEMENTATION_LOG.md) | Phase-by-phase record of changes and commands, including the global live/no-mock round |
| [SECURITY_REMEDIATION.md](SECURITY_REMEDIATION.md) | Secret handling, key masking, Docker credentials, manual actions |
| [PROVENANCE_REPORT.md](PROVENANCE_REPORT.md) | Live NRT provenance, empty local store, manifests, SHA-256 semantics, reproducibility |
| [SCIENTIFIC_VALIDATION_REPORT.md](SCIENTIFIC_VALIDATION_REPORT.md) | Actual calibration/holdout results, R² handling, status definitions, what would be required for validation |
| [DATA_COVERAGE_REPORT.md](DATA_COVERAGE_REPORT.md) | Live world coverage, local store, missing-data semantics, historical-pipeline status |
| [BACKEND_ARCHITECTURE.md](BACKEND_ARCHITECTURE.md) | Express as primary API, shared live service, storage adapters, Python pipeline boundary, FastAPI status, deployment |
| [FINAL_VERIFICATION_REPORT.md](FINAL_VERIFICATION_REPORT.md) | Required category/result table and the actual commands/results |

## Recorded status at the time of remediation

| Item | Status |
|---|---|
| TypeScript | PASS |
| Tests | 422/422 pass, 36 files |
| Production build | PASS |
| Global live NRT | VERIFIED (world 1-day aggregate: 103,131 detections, 58,265 bins, 0 source errors) |
| Local store at startup | EMPTY; `UNVERIFIED` with explicit reason |
| Bundled archive | REMOVED on 2026-11-10; no runtime seed |
| Live NRT ingestion | VERIFIED (31 records, 3 raw CSVs, 3/3 SHA-256 match) |
| Historical archive ingestion | NOT RUN (standard-science FIRMS/Earthdata download) |
| Calibration | INSUFFICIENT (in-sample R² `0`; not validation) |
| Temporal holdout | INSUFFICIENT (1,423/611 cells, but same-day data fails temporal separation) |
| R² when undefined | `null`, never `0` |
| Polygon AOI | PASS |
| Calendar missing-data semantics | PASS |
| API integrity | PASS |
| Docker startup | NOT TESTED |
| Browser E2E | NOT CONFIGURED |

## Important distinctions

- **Passing tests do not establish scientific validity.** The test suite checks behaviour,
  not whether the calibration model is correct.
- **An implemented pipeline does not mean every path was exercised.** The NRT Area API
  verification on 2026-11-10 did not exercise the separate bulk historical archive path.
- **A checksum proves file integrity, not NASA authenticity.** Authenticity requires the
  official source and publication metadata.
- **`EXPLORATORY` is not `VALIDATED`.** The fixed 0.294 factor is an assumption, not a
  fitted or validated global or Bangladesh coefficient.
- **Live is not historical.** The live path covers the rolling last 1–5 days only. Older
  requests return `400 LIVE_WINDOW`; there is no archive fallback.
- **An empty store is not zero fire.** It means no observations have been ingested.
  Missing dates are drawn as "no observation record", never as zero activity.
- **A capped map is not a complete count.** The map requests a capped world overview and
  reports `truncated: true`; use the aggregate endpoints for complete counts.

## Earlier archived documents

These original documents retain historical claims and planning assumptions; they are
not current setup, test results, calibration evidence or submission instructions.
Their full content is preserved for the team. The [judging storyboard](../../docs/pitch/storyboard.md)
owns the current recording sequence, and [evidence notes](../evidence/README.md) explain
the retained JSON/CSV diagnostics.

| Archived document | Historical purpose |
|---|---|
| [Change history](../archive/change-history.md) | Earlier Bengali development handoffs and corrections |
| [Global architecture audit](../archive/global-audit.md) | Earlier expansion proposal, assumptions and infrastructure estimates |
| [Test inventory](../archive/test_inventory.md) | Pre-remediation planning inventory, including hypothetical tests |
| [Test execution](../archive/test_execution_report.md) | Earlier fixture-era manual checks |
| [System quality](../archive/system-quality-report.md) | Earlier quality assessment |
| [Scientific assessment](../archive/scientific-validation-report.md) | Earlier exploratory diagnostic interpretation |
| [Executive summary](../archive/executive-summary.md) | Earlier project-scope and readiness summary |
| [Acceptance assessment](../archive/final_acceptance_report.md) | Earlier engineering/data readiness assessment |

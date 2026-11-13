# Initial Audit — FireSync Remediation

> **Historical baseline (2026-11-09, before remediation).** This audit describes the
> repository as it existed before the fixes. The bundled 30-observation archive mentioned
> below was removed on 2026-11-10; the runtime store now starts empty and live NASA FIRMS
> NRT is the only observation source. Read the findings as a defect record, not as current
> behavior. Current state: `FINAL_VERIFICATION_REPORT.md`.

**Project:** FireSync — Harmonized Fire Activity Intelligence
**Repository:** `E:\New folder\Bot_Battelion\Bot_Battelion`
**Audit date:** 2026-11-09
**Audit type:** retrospective baseline (written after inspection, before remediation changes)
**Primary API:** Express 4 (`server.ts`, `src/server/`)

---

## 1. Baseline architecture

| Layer | Implementation |
|---|---|
| Frontend | React 19, TypeScript, Vite, Tailwind, MapLibre GL |
| Primary API | Express 4, routes originally in `server.ts` |
| Live FIRMS | `src/utils/firms.ts`, `src/server/firmsHandler.ts`, NRT products |
| Analytics | `spatial.ts`, `harmonization.ts`, `matching.ts`, `anomaly.ts`, `calendarStats.ts` |
| Bundled data | `src/data/nasa_firms_archive.ts` — 30 observations |
| Persistence | in-memory canonical store |
| Python pipeline | `data_pipeline/` (duplicated fetchers, Redis skeleton) |
| Optional backend | FastAPI skeleton in `backend/app/` |
| Deployment | Docker Compose with hardcoded DB password and Vite always mounted |

### Pages
Overview, Hotspot Explorer, Calendar, Sensor Comparison, Methodology, Exports, Settings.

### Baseline checks (independently run before remediation)
- `npm install`: completed
- `npm run lint`: pass
- `npm test`: **392 passed / 392, 33 test files**
- `npm run build`: pass (large-chunk warning only)

These are the baseline results. They do not establish scientific validity.

---

## 2. Confirmed defects

### Scientific / data integrity
| ID | Defect | Evidence |
|---|---|---|
| A | Methodology claimed a fitted `β = 0.294 ± 0.038` and temporal holdout validation | Code uses a fixed coefficient; no fit or holdout evidence |
| D | R² returned `0` when reference variance was zero | `ssTot === 0` branch returned 0, conflating undefined with zero |
| E | Bundled archive presented as NASA data without provenance | 30 records, no raw files, manifests or checksums |
| — | Fixed coefficient described as empirical Bangladesh calibration | 9 paired cells, zero MODIS variance |
| — | Missing calendar dates implicitly treated as zero activity | Calendar filled/coloured absent days like quiet days |
| — | Observation coverage reported as 100% | `observation_coverage_pct` defaulted to 100 |
| — | Calibration metrics displayed as validated in the UI | Placeholder metrics `R² 0.884, n=8` in App state |

### Fake / misleading behaviour
| ID | Defect | Evidence |
|---|---|---|
| C | Ingestion endpoint fabricated success | Hardcoded `records_imported: 4`, random checksum, pre-filled jobs |
| — | Settings ingestion controls simulated success | No real FIRMS execution path |
| — | Job records were seeded/placeholder | Fake IDs and terminal states |
| — | FastAPI `/health` claimed `"database": "configured"` | No database integration exists |

### Application bugs
| ID | Defect | Evidence |
|---|---|---|
| B | Sensor Comparison fetched `comparisonData` but did not render it | Page showed static/placeholder content |
| F | Stale documentation | README, CHANGES, API, Docker and methodology contradicted code |
| — | AOI drawing absent | Only bbox filtering existed |
| — | Calendar export omitted AOI | Export scope was bbox/sensor only |
| — | CSV metadata missing provenance/model scope | Exports lacked manifest rows |
| — | Production server always mounted Vite | Docker runtime needed Vite; no static serving |
| — | Python pipeline used invalid 30-day Area API windows | API limit is 1–5 days NRT / 1–10 days SP |
| — | Duplicate FIRMS fetch implementations | `fetch_firms_data.py` + `firms_api_client.py` + server |
| — | Python pipeline required unavailable `requests`/`redis` | No third-party packages installed |

### Security
| Finding | Severity | Notes |
|---|---|---|
| Hardcoded PostgreSQL password in `docker-compose.yml` | High | Replaced with mandatory env var |
| `.env.example` could encourage real key use | Medium | Placeholders only; `.env` gitignored |
| FastAPI config had default DB URL with password | High | Removed default |
| API key could appear in URLs/errors | Medium | Added masking in server and pipeline |
| No auth/CORS allow-list | Medium | Not implemented; documented as limitation |
| `.env` file present | Low | 0 bytes; gitignored; no real key found |

Git history was inspected during the final verification. `.env` was never tracked, and no
FIRMS MAP_KEY pattern was found in history. An older `docker-compose.yml` revision did
contain `POSTGRES_PASSWORD: password`; that credential must never be reused, and any
database that used it should be treated as compromised. If the project was ever pushed
elsewhere, the owner must still assume any previously shared FIRMS key is compromised and
rotate it through NASA FIRMS.

---

## 3. Scientific limitations found

1. **Sample size:** 30 observations, 8 dates, 13 daily 1 km cells, 9 paired MODIS+VIIRS cells.
2. **Zero reference variance:** every MODIS count in paired cells is 1, so R² is undefined.
3. **No provenance:** raw NASA files and download manifests are absent for the bundled archive.
4. **Fixed coefficients:** 0.294 and 0.005 are literature/exploratory assumptions, not fitted.
5. **No independent validation:** temporal holdout has 6 training / 3 validation cells.
6. **No observation-opportunity model:** missing dates cannot be distinguished from no-fire days.
7. **Co-detections only:** paired cells do not represent non-detection opportunities.
8. **MODIS reference is not ground truth.**

---

## 4. Dependency graph of fixes

```
Security (key masking, compose password, .env)
  └─> Honest ingestion service (no fake jobs)
        ├─> Real persistence adapter
        └─> API tests

R² null + calibration statuses
  └─> Harmonization API/UI/CSV
        └─> Methodology/docs reconciliation

Archive provenance flag
  └─> Exports, health, UI banners
        └─> Provenance report

Polygon AOI utility
  └─> Shared URL state
        ├─> Explorer drawing
        ├─> App requests (all pages)
        └─> Exports

Python pipeline rewrite
  └─> Manifests/checksums
        └─> Coverage/quality reports
              └─> Documentation
```

---

## 5. Prioritisation

| Priority | Work | Rationale |
|---|---|---|
| P0 | Remove fake ingestion; secure secrets; fix R² | Prevents false scientific/security claims |
| P1 | Real pipeline; provenance | Core challenge requirement |
| P2 | Calibration semantics and Sensor Comparison | Central scientific objective |
| P3 | Polygon AOI and shared state | Challenge requirement; affects all pages |
| P4 | Calendar/coverage honesty | Prevents missing = zero |
| P5 | Persistence, API integrity, Docker | Reproducibility and deployability |
| P6 | Exports and documentation | Transparency and auditability |
| P7 | Full verification | Required evidence |

---

## 6. What this audit does not claim

- No real NASA download was possible (no `FIRMS_MAP_KEY`).
- No Docker build/startup was performed in this environment.
- No browser/network verification of GIBS tiles or iOS Safari was performed.
- The baseline test count was 392; the final suite is larger and reported separately in
  `FINAL_VERIFICATION_REPORT.md`.

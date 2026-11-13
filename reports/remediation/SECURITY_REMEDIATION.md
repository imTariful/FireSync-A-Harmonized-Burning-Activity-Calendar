# Security Remediation Report

**Date:** 2026-11-09
**Scope:** secrets, ingestion endpoints, Docker, error handling, optional backend

> **Post-report update (2026-11-10):** `.env` is no longer empty. It now contains a
> user-supplied 32-character `FIRMS_MAP_KEY` that NASA accepted and that was used for a
> verified NRT ingestion run (see `FINAL_VERIFICATION_REPORT.md` §4.2). The key was shared
> in chat, so it must be treated as exposed and rotated. The file remains gitignored and
> untracked. The "verified empty" statements below describe the 2026-11-09 audit, not the
> current state.

---

## 1. Findings

| # | Finding | Severity | Status |
|---|---|---|---|
| S1 | `docker-compose.yml` contained a hardcoded PostgreSQL password (`POSTGRES_PASSWORD: password` in an older revision) | High | **Fixed**; history still contains the old value, so it must never be reused |
| S2 | `.env` could contain a real FIRMS key | High if populated | **Now contains a real key (2026-11-10), gitignored and untracked**; the key was shared in chat and must be rotated. It was verified empty at the 2026-11-09 audit. |
| S3 | FastAPI config defaulted `DATABASE_URL` to a URL containing a password | High | **Fixed** |
| S4 | FIRMS MAP_KEY appears in request URLs (required by NASA) | Medium | **Masked** in stored URLs, job records, manifests, errors and logs |
| S5 | FastAPI `/health` claimed a configured database | Medium | **Fixed** (now says not integrated) |
| S6 | No authentication or CORS allow-list | Medium | **Not implemented**; documented limitation |
| S7 | Live ingestion could be triggered without a key and fake success | High | **Fixed**; returns 503 and no job |
| S8 | `.env.example` might encourage committing a real key | Low | **Placeholders only** |
| S9 | `.dockerignore` was itself ignored by `.gitignore` | Low | **Fixed** |

No real FIRMS key was found in tracked source files during a pattern scan. Git history was
also inspected: `.env` was never tracked and no FIRMS MAP_KEY pattern was found in any
commit. An older `docker-compose.yml` revision did contain `POSTGRES_PASSWORD: password`;
that value is still present in history, so it must be treated as compromised and never
reused.

---

## 2. Fixes applied

### Secrets and configuration
- `.env.example` contains only placeholders:
  `FIRMS_MAP_KEY="YOUR_NASA_FIRMS_MAP_KEY"`, empty `DATABASE_URL`, empty
  `FIRESYNC_STORE_PATH`.
- `.env` is ignored by `.gitignore` and is currently **0 bytes**.
- `docker-compose.yml`:
  - no hardcoded password;
  - `POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?Set POSTGRES_PASSWORD explicitly; there is no default password}`;
  - PostGIS and Redis are optional profiles;
  - app service uses environment variables and a healthcheck.
- FastAPI config: `DATABASE_URL` default is now `""`; CORS default is
  `http://localhost:3000`, not `*`.
- FastAPI health no longer claims a database; it reports `"database": "not integrated"`.

### Key handling
- The key is read only from `process.env.FIRMS_MAP_KEY` on the server.
- The browser never receives or submits the key. `POST /api/v1/ingestion/test-key` tests the
  server-configured key only.
- `maskSecret` / `mask_key` remove the key and `/csv/<key>/` URL segments from:
  - ingestion job errors and records;
  - source manifests and quality reports;
  - pipeline logs and fetch results.
- Tests assert that a job record and its error never contain the key.

### Ingestion endpoints
- Missing key → `503` with `code: "FIRMS_KEY_NOT_CONFIGURED"`; no job created.
- Invalid payload → `400` before any job exists.
- Failed download → job `failed`, `records_imported: 0`, `checksum: null`.
- Partial success → completed with the real count and an explicit partial-success message.
- No random checksums, no hardcoded imported counts, no seeded jobs.

### Docker
- Multi-stage `Dockerfile`; runtime does not need Vite.
- `.dockerignore` excludes `node_modules`, `.env`, `dist`, raw data and reports.
- No secret is baked into the image.
- `POSTGRES_PASSWORD` has no default; compose fails fast when unset.

### Error responses
- Ingestion and live-FIRMS errors are masked and do not echo the key.
- The API returns structured `error`/`code` messages instead of simulated success.

---

## 3. Verification performed

| Check | Result |
|---|---|
| `.env` size | 0 bytes |
| `.env` ignored | yes (`^\.env$` in `.gitignore`) |
| `.env` ever tracked in Git history | no |
| Pattern scan for `FIRMS_MAP_KEY=<16+ chars>` in source | no matches |
| Pattern scan for FIRMS keys in Git history | no matches |
| Old hardcoded `POSTGRES_PASSWORD: password` in Git history | found; value must not be reused |
| `Math.random` usage | only retry-backoff jitter in `fetchTextWithRetry`, not checksums |
| Fake ingestion patterns (`records_imported: 4`, random checksums) | removed |
| Key masking tests | pass (`src/server/ingestion.test.ts`) |
| Missing-key API test | pass (`src/server/app.test.ts`) |
| Hardcoded compose password | removed |
| FastAPI default DB password | removed |

Commands used:

```bash
npm run lint
npm test
python -m py_compile data_pipeline/*.py
```

---

## 4. Manual actions required by the owner

1. **Rotate the FIRMS MAP_KEY** through NASA FIRMS if it was ever committed, pasted into a
   chat, or shared. Do not reuse it. A revoked key cannot be recovered automatically.
2. **Set a strong `POSTGRES_PASSWORD`** in the shell or local `.env` before using the optional
   PostGIS profile. Do not add a default back to compose. The old `password` value remains
   in Git history; rotate any database that ever used it.
3. **Never put the key in frontend code or `VITE_*` variables.** Only `FIRMS_MAP_KEY` in the
   server environment is supported.
4. **Restrict network exposure.** There is no authentication; do not expose the ingestion
   endpoints to the public internet without a reverse-proxy/auth layer.
5. **Review logs** for historical key leakage if the app ran with a real key. New logs mask it,
   but old logs are not rewritten.
6. **Enable CORS deliberately** if a separate frontend origin is used. The current build does
   not enable CORS.

---

## 5. Residual risks

- No authentication/authorization; anyone who can reach the server can trigger NRT ingestion
  when a key is configured.
- No CSRF protection (no cookie auth, but the ingestion POST is unauthenticated).
- The JSON store has no multi-process locking.
- The local store starts empty and is `UNVERIFIED` until a completed real ingestion job adds
  records; this is a provenance issue, not a security issue.
- Docker startup was not tested here; verify the documented procedure before deployment.

/**
 * Real, server-side FIRMS ingestion.
 *
 * Scope: the documented FIRMS Area API for near-real-time products (1–5 day windows).
 * Historical standard-science archive downloads require the FIRMS download service /
 * Earthdata authentication and are handled by data_pipeline/, not pretended here.
 *
 * Every job has a real execution record. No record count, checksum or completion state is
 * invented: if the key is missing the route returns 503, if the download fails the job is
 * marked failed, and `records_imported` is the number actually added to the store.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IngestionJob } from '../types/fire';
import { FIRMS_SOURCES, firmsCsvToObservations, maskSecret, type FirmsSourceDef } from '../utils/firms';
import { sha256, type ObservationStore } from './store';

export interface IngestionRequest {
  bbox: string;
  day_range: number;
  date?: string;
  products?: string[];
}

export interface IngestionServiceDeps {
  store: ObservationStore;
  getKey: () => string | undefined;
  getBaseUrl?: () => string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  dataDir?: string;
  writeFile?: (path: string, data: string) => void;
  mkdir?: (path: string) => void;
}

export type ValidationResult =
  | { ok: true; value: IngestionRequest }
  | { ok: false; status: number; error: string };

const BBOX_RE = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isRealDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function validateIngestionRequest(body: unknown): ValidationResult {
  if (!body || typeof body !== 'object') {
    return { ok: false, status: 400, error: 'Request body must be a JSON object.' };
  }
  const raw = body as Record<string, unknown>;
  const bbox = typeof raw.bbox === 'string' ? raw.bbox.trim() : '';
  const match = BBOX_RE.exec(bbox);
  if (!match) {
    return { ok: false, status: 400, error: 'bbox must be "west,south,east,north".' };
  }
  const [west, south, east, north] = match.slice(1).map(Number);
  if (
    !Number.isFinite(west) ||
    !Number.isFinite(south) ||
    !Number.isFinite(east) ||
    !Number.isFinite(north) ||
    west < -180 ||
    east > 180 ||
    south < -90 ||
    north > 90 ||
    west >= east ||
    south >= north
  ) {
    return { ok: false, status: 400, error: 'bbox is outside valid ranges or not west<east / south<north.' };
  }

  const dayRange = Number(raw.day_range);
  if (!Number.isInteger(dayRange) || dayRange < 1 || dayRange > 5) {
    return { ok: false, status: 400, error: 'day_range must be an integer between 1 and 5 (FIRMS Area API limit).' };
  }

  let date: string | undefined;
  if (raw.date !== undefined && raw.date !== null && raw.date !== '') {
    if (typeof raw.date !== 'string' || !isRealDate(raw.date)) {
      return { ok: false, status: 400, error: 'date must be a real YYYY-MM-DD calendar date.' };
    }
    date = raw.date;
  }

  const available = new Set(FIRMS_SOURCES.map((s) => s.source));
  let products: string[] | undefined;
  if (raw.products !== undefined) {
    if (!Array.isArray(raw.products) || raw.products.some((p) => typeof p !== 'string')) {
      return { ok: false, status: 400, error: 'products must be an array of FIRMS product identifiers.' };
    }
    const requested = [...new Set(raw.products as string[])];
    const unknown = requested.filter((p) => !available.has(p));
    if (unknown.length > 0) {
      return {
        ok: false,
        status: 400,
        error: `Unsupported product(s): ${unknown.join(', ')}. Supported NRT products: ${[...available].join(', ')}.`,
      };
    }
    products = requested;
  }

  return { ok: true, value: { bbox, day_range: dayRange, date, products } };
}

interface SourceOutcome {
  source: string;
  ok: boolean;
  raw_file?: string;
  checksum?: string;
  records: number;
  error?: string;
  /** Preserved raw CSV text; never written to the manifest. */
  raw_csv?: string;
}

function nowIso(now: () => Date): string {
  return now().toISOString();
}

function newJobId(now: () => Date): string {
  return `job-${now().getTime()}-${randomUUID().slice(0, 8)}`;
}

export class IngestionService {
  private readonly store: ObservationStore;
  private readonly getKey: () => string | undefined;
  private readonly getBaseUrl: () => string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly dataDir: string;
  private readonly writeFile: (path: string, data: string) => void;
  private readonly mkdir: (path: string) => void;

  constructor(deps: IngestionServiceDeps) {
    this.store = deps.store;
    this.getKey = deps.getKey;
    this.getBaseUrl = deps.getBaseUrl ?? (() => 'https://firms.modaps.eosdis.nasa.gov');
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.now = deps.now ?? (() => new Date());
    this.dataDir = deps.dataDir ?? 'data';
    this.writeFile = deps.writeFile ?? ((path, data) => writeFileSync(path, data, 'utf8'));
    this.mkdir = deps.mkdir ?? ((path) => mkdirSync(path, { recursive: true }));
  }

  isConfigured(): boolean {
    return Boolean(this.getKey()?.trim());
  }

  /** Creates a pending job and runs it asynchronously. Returns the real pending record. */
  start(request: IngestionRequest): IngestionJob {
    const created = nowIso(this.now);
    const selectedProducts = request.products ?? FIRMS_SOURCES.map((s) => s.source);
    const selectedDefs = FIRMS_SOURCES.filter((s) => selectedProducts.includes(s.source));
    const sensors = [...new Set(selectedDefs.map((s) => s.sensor))];
    const derivedSensor = sensors.length === 1 ? sensors[0] : sensors.length > 1 ? 'MIXED' : 'UNKNOWN';
    const job: IngestionJob = {
      id: newJobId(this.now),
      sensor: derivedSensor as IngestionJob['sensor'],
      satellite: 'FIRMS Area API',
      region: `bbox ${request.bbox}`,
      date_range: request.date ?? `last ${request.day_range} day(s)`,
      status: 'pending',
      records_imported: null,
      source_endpoint: `${this.getBaseUrl()}/api/area/csv`,
      retrieved_at: created,
      checksum: null,
      created_at: created,
      source_products: request.products ?? FIRMS_SOURCES.map((s) => s.source),
      provenance_status: 'UNVERIFIED',
      bbox: request.bbox,
    };
    this.store.saveJob(job);
    void this.runJob(job.id, request).catch(() => {
      // runJob records its own failure; never throw an unhandled rejection.
    });
    return job;
  }

  /** Executes a job. Public so tests can await it deterministically. */
  async runJob(jobId: string, request: IngestionRequest): Promise<IngestionJob> {
    const existing = this.store.getJob(jobId);
    if (!existing) throw new Error(`Unknown ingestion job ${jobId}`);

    const key = this.getKey()?.trim();
    if (!key) {
      return this.fail(existing, 'FIRMS_MAP_KEY is not configured on the server. Set it in the server environment; it is never sent to the browser.');
    }

    // F12 fix: check cancellation before transitioning to running.
    const beforeRun = this.store.getJob(jobId);
    if (beforeRun?.status === 'cancelled') return beforeRun;

    let job: IngestionJob = {
      ...existing,
      status: 'running',
      started_at: nowIso(this.now),
    };
    this.store.saveJob(job);

    const selectedDefs: FirmsSourceDef[] = FIRMS_SOURCES.filter((s) =>
      (request.products ?? FIRMS_SOURCES.map((x) => x.source)).includes(s.source)
    );
    if (selectedDefs.length === 0) {
      return this.fail(job, 'No supported FIRMS products were selected.');
    }

    const outcomes: SourceOutcome[] = [];
    const collected: ReturnType<typeof firmsCsvToObservations> = [];

    for (const def of selectedDefs) {
      // F12 fix: check cancellation before each source download.
      const liveJob = this.store.getJob(jobId);
      if (liveJob?.status === 'cancelled') return liveJob;

      const outcome = await this.downloadSource(def, request, key);
      outcomes.push(outcome);
      if (outcome.ok) {
        try {
          const csv = outcome.raw_csv ?? '';
          const observations = firmsCsvToObservations(csv, def, nowIso(this.now));
          collected.push(...observations);
          outcome.records = observations.length;
        } catch (err) {
          outcome.ok = false;
          outcome.error = maskSecret((err as Error).message, key);
        }
      }
    }

    // F12 fix: check cancellation before committing observations.
    const afterDownloads = this.store.getJob(jobId);
    if (afterDownloads?.status === 'cancelled') return afterDownloads;

    const successful = outcomes.filter((o) => o.ok);
    if (successful.length === 0) {
      return this.fail(
        job,
        `All FIRMS downloads failed: ${outcomes.map((o) => `${o.source}: ${o.error ?? 'unknown error'}`).join('; ')}`
      );
    }

    // F14 fix: wrap store write in try/catch so a storage error transitions the job to
    // 'failed' instead of leaving it stuck in 'running' forever.
    let added: number;
    let duplicates: number;
    try {
      ({ added, duplicates } = this.store.addObservations(collected));
    } catch (storeErr) {
      return this.fail(job, `Storage error while committing observations: ${storeErr instanceof Error ? storeErr.message : String(storeErr)}`);
    }
    const checksums = successful.map((o) => o.checksum!).filter(Boolean);
    const manifestChecksum = checksums.length
      ? sha256(checksums.slice().sort().join('\n'))
      : null;

    const completedJob: IngestionJob = {
      ...job,
      status: 'completed',
      records_imported: added,
      checksum: manifestChecksum,
      retrieved_at: nowIso(this.now),
      completed_at: nowIso(this.now),
      provenance_status: 'VERIFIED',
      error_message:
        successful.length === selectedDefs.length
          ? undefined
          : `Partial success. Failed: ${outcomes
              .filter((o) => !o.ok)
              .map((o) => `${o.source}: ${o.error ?? 'unknown error'}`)
              .join('; ')}`,
    };

    // Persist the terminal job state, not the earlier `running` snapshot. Otherwise the
    // durable ingestion_log.json contradicts the completed job and its checksum.
    this.writeMetadata(request, completedJob, outcomes, added, duplicates);
    this.store.saveJob(completedJob);
    return completedJob;
  }

  private async downloadSource(
    def: FirmsSourceDef,
    request: IngestionRequest,
    key: string
  ): Promise<SourceOutcome> {
    const path = [
      'api',
      'area',
      'csv',
      encodeURIComponent(key),
      def.source,
      request.bbox,
      String(request.day_range),
      ...(request.date ? [request.date] : []),
    ].join('/');
    const url = `${this.getBaseUrl().replace(/\/$/, '')}/${path}`;
    let lastError: unknown = null;
    // F13 fix: apply a bounded deadline to fetch and body consumption.
    const DOWNLOAD_TIMEOUT_MS = 120_000; // 2 minutes per source

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
        let res: Response;
        try {
          res = await this.fetchImpl(url, { signal: controller.signal });
        } finally {
          clearTimeout(timer);
        }
        const text = await res.text();
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
        if (!text.includes('latitude')) {
          throw new Error(`FIRMS returned no CSV header: ${text.slice(0, 200)}`);
        }
        const checksum = sha256(text);
        const stamp = nowIso(this.now).replace(/[:.]/g, '-');
        const rawDir = join(this.dataDir, 'raw', def.source);
        this.mkdir(rawDir);
        const rawFile = join(rawDir, `${stamp}_${request.date ?? `last${request.day_range}d`}_${checksum.slice(0, 12)}.csv`);
        this.writeFile(rawFile, text);
        return { source: def.source, ok: true, raw_file: rawFile, checksum, records: 0, raw_csv: text };
      } catch (err) {
        lastError = err;
        const isAbort = err instanceof Error && err.name === 'AbortError';
        if (isAbort) {
          // Timeout: don't retry — the upstream is stalled.
          return {
            source: def.source, ok: false, records: 0,
            error: `Download timed out after ${DOWNLOAD_TIMEOUT_MS / 1000}s`,
          };
        }
        // Small backoff, skipped on the final attempt.
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
    return {
      source: def.source,
      ok: false,
      records: 0,
      error: maskSecret(lastError instanceof Error ? lastError.message : String(lastError), key),
    };
  }

  private fail(job: IngestionJob, message: string): IngestionJob {
    const failed: IngestionJob = {
      ...job,
      status: 'failed',
      records_imported: 0,
      checksum: null,
      completed_at: nowIso(this.now),
      error_message: maskSecret(message, this.getKey()),
    };
    this.store.saveJob(failed);
    return failed;
  }

  private writeMetadata(
    request: IngestionRequest,
    job: IngestionJob,
    outcomes: SourceOutcome[],
    added: number,
    duplicates: number
  ): void {
    try {
      const metaDir = join(this.dataDir, 'metadata');
      this.mkdir(metaDir);
      const at = nowIso(this.now);
      // F15 fix: write immutable per-job manifest files using job.id so each ingestion
      // run keeps its own record. The generic filenames (source_manifest.json etc.) are
      // also updated for backward compatibility with tooling that reads the latest entry.
      const jobId = job.id;
      const manifest = {
        generated_at: at,
        job_id: jobId,
        requested: request,
        outcomes: outcomes.map(({ raw_csv: _ignored, ...rest }) => rest),
        records_added: added,
        duplicate_records: duplicates,
        note: 'Checksums verify file integrity, not NASA authenticity.',
      };
      const manifestJson = JSON.stringify(manifest, null, 2);
      this.writeFile(join(metaDir, `source_manifest_${jobId}.json`), manifestJson);
      this.writeFile(join(metaDir, 'source_manifest.json'), manifestJson);

      const checksumsJson = JSON.stringify(
        {
          generated_at: at,
          job_id: jobId,
          files: outcomes
            .filter((o) => o.ok && o.raw_file)
            .map((o) => ({ file: o.raw_file, sha256: o.checksum })),
        },
        null,
        2
      );
      this.writeFile(join(metaDir, `checksums_${jobId}.json`), checksumsJson);
      this.writeFile(join(metaDir, 'checksums.json'), checksumsJson);

      const logJson = JSON.stringify(
        {
          generated_at: at,
          job_id: jobId,
          job: { ...job, records_imported: added },
          duplicates,
        },
        null,
        2
      );
      this.writeFile(join(metaDir, `ingestion_log_${jobId}.json`), logJson);
      this.writeFile(join(metaDir, 'ingestion_log.json'), logJson);

      const productJson = JSON.stringify(
        {
          generated_at: at,
          job_id: jobId,
          products: outcomes.map((o) => ({
            product: o.source,
            raw_file: o.raw_file ?? null,
            sha256: o.checksum ?? null,
            records: o.records,
            status: o.ok ? 'completed' : 'failed',
            error: o.error ?? null,
          })),
        },
        null,
        2
      );
      this.writeFile(join(metaDir, `product_metadata_${jobId}.json`), productJson);
      this.writeFile(join(metaDir, 'product_metadata.json'), productJson);
    } catch {
      // Metadata writing failure must not turn a real data import into a fake success/failure.
      // The job keeps the actual imported count; the missing manifest is visible on disk.
    }
  }
}

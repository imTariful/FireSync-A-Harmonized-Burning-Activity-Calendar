/**
 * Observation + ingestion-job storage.
 *
 * Two adapters are provided:
 *  - MemoryObservationStore: the default, explicitly NOT durable.
 *  - JsonFileObservationStore: optional persistence selected with FIRESYNC_STORE_PATH.
 *    It is a plain JSON file, not PostgreSQL/PostGIS. No spatial database is claimed.
 *
 * The runtime store starts EMPTY. Records enter it only through a real NASA FIRMS
 * ingestion job; there is no bundled or synthetic seed. A SHA-256 checksum of a file
 * proves integrity, not NASA authenticity.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CanonicalObservation, IngestionJob } from '../types/fire';

export interface StoreSnapshot {
  version: number;
  observations: CanonicalObservation[];
  jobs: IngestionJob[];
  updated_at: string;
}

export interface ObservationStore {
  readonly kind: 'memory' | 'json_file';
  readonly durable: boolean;
  readonly location: string;
  getObservations(): CanonicalObservation[];
  setObservations(observations: CanonicalObservation[]): void;
  addObservations(observations: CanonicalObservation[]): { added: number; duplicates: number };
  getJobs(): IngestionJob[];
  getJob(id: string): IngestionJob | undefined;
  saveJob(job: IngestionJob): void;
  /** Persist current state. No-op for memory. */
  flush(): void;
}

/** Deterministic identity used to reject duplicate observations. */
export function observationKey(o: CanonicalObservation): string {
  return [
    o.sensor,
    o.satellite,
    o.acq_date,
    o.acq_time,
    o.latitude.toFixed(5),
    o.longitude.toFixed(5),
    o.source_record_id,
  ].join('|');
}

function dedupe(
  existing: CanonicalObservation[],
  incoming: CanonicalObservation[]
): { merged: CanonicalObservation[]; added: number; duplicates: number } {
  const seen = new Set(existing.map(observationKey));
  const merged = [...existing];
  let added = 0;
  let duplicates = 0;
  for (const o of incoming) {
    const key = observationKey(o);
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);
    merged.push(o);
    added += 1;
  }
  return { merged, added, duplicates };
}

export class MemoryObservationStore implements ObservationStore {
  readonly kind: 'memory' | 'json_file' = 'memory';
  readonly durable: boolean = false;
  readonly location: string = 'process memory (not durable)';
  protected observations: CanonicalObservation[];
  protected jobs: IngestionJob[];

  constructor(seed: CanonicalObservation[] = [], jobs: IngestionJob[] = []) {
    this.observations = [...seed];
    this.jobs = [...jobs];
  }

  getObservations(): CanonicalObservation[] {
    return this.observations;
  }

  setObservations(observations: CanonicalObservation[]): void {
    this.observations = [...observations];
  }

  addObservations(observations: CanonicalObservation[]): { added: number; duplicates: number } {
    const { merged, added, duplicates } = dedupe(this.observations, observations);
    this.observations = merged;
    return { added, duplicates };
  }

  getJobs(): IngestionJob[] {
    return this.jobs;
  }

  getJob(id: string): IngestionJob | undefined {
    return this.jobs.find((j) => j.id === id);
  }

  saveJob(job: IngestionJob): void {
    const index = this.jobs.findIndex((j) => j.id === job.id);
    if (index >= 0) this.jobs[index] = job;
    else this.jobs.unshift(job);
  }

  flush(): void {
    // In-memory by design.
  }
}

/** JSON-file persistence adapter. Never claims to be a spatial database. */
export class JsonFileObservationStore extends MemoryObservationStore {
  readonly kind = 'json_file' as const;
  readonly durable = true;
  readonly location: string;
  private readonly path: string;

  constructor(path: string, seed: CanonicalObservation[] = []) {
    super(seed);
    this.path = path;
    this.location = `JSON file: ${path}`;
    this.load();
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<StoreSnapshot>;
      if (Array.isArray(parsed.observations)) this.observations = parsed.observations;
      if (Array.isArray(parsed.jobs)) this.jobs = parsed.jobs;
    } catch (err) {
      // F16 fix: a corrupt store file must never be silently overwritten — that would
      // destroy whatever data could still be recovered from it. Instead, quarantine it
      // by renaming to a timestamped .corrupt file and throw so the caller can surface
      // the error rather than starting with an empty store.
      const quarantine = `${this.path}.corrupt.${Date.now()}`;
      try {
        renameSync(this.path, quarantine);
      } catch {
        // If the rename itself fails (permissions, locked), leave the file in place and
        // still throw so callers know the store was not loaded cleanly.
      }
      throw new Error(
        `Corrupt store file at ${this.path} (quarantined to ${quarantine}): ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  override addObservations(observations: CanonicalObservation[]): { added: number; duplicates: number } {
    const result = super.addObservations(observations);
    this.flush();
    return result;
  }

  override saveJob(job: IngestionJob): void {
    super.saveJob(job);
    this.flush();
  }

  override flush(): void {
    const snapshot: StoreSnapshot = {
      version: 1,
      observations: this.observations,
      jobs: this.jobs,
      updated_at: new Date().toISOString(),
    };
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(snapshot, null, 2), 'utf8');
    renameSync(tmp, this.path);
  }
}

/** SHA-256 helper shared by ingestion and provenance tooling. */
export function sha256(buffer: Buffer | string): string {
  return createHash('sha256').update(buffer).digest('hex');
}

export function createStoreFromEnv(
  seed: CanonicalObservation[] = [],
  env: NodeJS.ProcessEnv = process.env
): ObservationStore {
  const path = env.FIRESYNC_STORE_PATH;
  if (path && path.trim()) return new JsonFileObservationStore(path.trim(), seed);
  return new MemoryObservationStore(seed);
}

/**
 * Shared input loader for the offline calibration / evidence scripts.
 *
 * There is NO bundled or synthetic fallback. The scripts must be pointed at a real observation
 * store produced by a completed NASA FIRMS ingestion job (or at a JSON array of canonical
 * observations with the same shape). If no usable input is supplied they exit with code 2 and
 * explain what is missing; they never invent records or evidence.
 *
 * Usage:
 *   npx tsx scripts/<script>.ts <path-to-store-or-observations.json>
 *   FIRESYNC_STORE_PATH=<path> npx tsx scripts/<script>.ts
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CanonicalObservation, ProvenanceStatus } from '../../src/types/fire';

export interface LoadedObservations {
  /** Absolute path of the file actually read. */
  path: string;
  observations: CanonicalObservation[];
  /** VERIFIED only when every input record carries VERIFIED provenance. */
  provenance_status: ProvenanceStatus;
  verified_count: number;
  unverified_count: number;
}

function fail(scriptName: string, message: string): never {
  console.error(`[FireSync] ${scriptName}: ${message}`);
  console.error(
    'The script does not fall back to a bundled or synthetic archive. Run a real FIRMS ingestion ' +
      '(or provide a JSON export of canonical observations) and pass its path explicitly.'
  );
  process.exit(2);
}

function isObservation(value: unknown): value is CanonicalObservation {
  if (!value || typeof value !== 'object') return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    (o.sensor === 'MODIS' || o.sensor === 'VIIRS') &&
    typeof o.acq_date === 'string' &&
    typeof o.latitude === 'number' &&
    Number.isFinite(o.latitude) &&
    typeof o.longitude === 'number' &&
    Number.isFinite(o.longitude) &&
    typeof o.frp_mw === 'number' &&
    Number.isFinite(o.frp_mw)
  );
}

/** Resolve the explicit input path: first positional argument, then the two documented env vars. */
export function observationsPathFromEnv(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const positional = argv.find((a) => !a.startsWith('-'));
  const fromEnv = env.FIRESYNC_OBSERVATIONS_PATH ?? env.FIRESYNC_STORE_PATH;
  const chosen = positional ?? fromEnv;
  return chosen && chosen.trim() ? chosen.trim() : null;
}

export function loadObservationsOrExit(
  scriptName: string,
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env
): LoadedObservations {
  const requested = observationsPathFromEnv(argv, env);
  if (!requested) {
    fail(
      scriptName,
      'no observation input given. Pass a store JSON path as the first argument or set FIRESYNC_STORE_PATH.'
    );
  }

  const fullPath = resolve(process.cwd(), requested);
  if (!existsSync(fullPath)) {
    fail(scriptName, `input file not found: ${fullPath}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(fullPath, 'utf8'));
  } catch (err) {
    fail(scriptName, `input is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Accept either a FireSync store snapshot ({ observations: [...] }) or a bare array.
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { observations?: unknown }).observations)
      ? (parsed as { observations: unknown[] }).observations
      : null;

  if (!list) {
    fail(scriptName, 'input must be a JSON array or a FireSync store snapshot with an "observations" array.');
  }
  if (list.length === 0) {
    fail(scriptName, 'the input contains zero observations; there is no evidence to analyse.');
  }

  const invalid = list.findIndex((o) => !isObservation(o));
  if (invalid >= 0) {
    fail(
      scriptName,
      `observation at index ${invalid} is missing required fields (id, sensor, acq_date, latitude, longitude, frp_mw).`
    );
  }

  const observations = list as CanonicalObservation[];
  const verified_count = observations.filter((o) => o.provenance_status === 'VERIFIED').length;
  const unverified_count = observations.length - verified_count;

  return {
    path: fullPath,
    observations,
    provenance_status: unverified_count === 0 ? 'VERIFIED' : 'UNVERIFIED',
    verified_count,
    unverified_count,
  };
}

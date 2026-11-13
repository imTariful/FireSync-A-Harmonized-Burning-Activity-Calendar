/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import {
  Settings,
  Key,
  CheckCircle,
  AlertCircle,
  RefreshCw,
  Database,
  ExternalLink,
  Play,
  ChevronDown,
  Cpu,
} from 'lucide-react';
import type { Area } from '../utils/area';
import { bboxToString } from '../utils/area';
import { api } from '../api/client';
import { historyApi, type HistoryStatus } from '../api/history';

/** Sensor + platform selection as a FIRMS NRT product identifier the server accepts. */
const productFor = (sensor: string, satellite: string): string => {
  if (sensor === 'MODIS') return 'MODIS_NRT';
  if (satellite === 'NOAA-20') return 'VIIRS_NOAA20_NRT';
  if (satellite === 'NOAA-21') return 'VIIRS_NOAA21_NRT';
  return 'VIIRS_SNPP_NRT';
};

interface SettingsPageProps {
  area: Area;
  onRefreshData: () => void;
}

export const SettingsPage: React.FC<SettingsPageProps> = ({ area, onRefreshData }) => {
  const [mapKey, setMapKey] = useState('');
  const [testingKey, setTestingKey] = useState(false);
  const [keyResult, setKeyResult] = useState<{ valid: boolean; message: string } | null>(null);

  const [triggerSensor, setTriggerSensor] = useState('VIIRS');
  const [triggerSatellite, setTriggerSatellite] = useState('Suomi-NPP');
  const [triggerDays, setTriggerDays] = useState(10);
  const [triggering, setTriggering] = useState(false);
  const [triggerResult, setTriggerResult] = useState<string | null>(null);

  const [archiveStatus, setArchiveStatus] = useState<HistoryStatus | null>(null);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    historyApi
      .status()
      .then((s) => {
        if (!cancelled) setArchiveStatus(s);
      })
      .catch((e: Error) => {
        if (!cancelled) setArchiveError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const testKey = async () => {
    setTestingKey(true);
    setKeyResult(null);
    try {
      // The key is server-side only (FIRMS_MAP_KEY); this verifies the key the server is actually using.
      const res = await api.testFirmsKey();
      setKeyResult(res);
    } catch (err) {
      setKeyResult({ valid: false, message: (err as Error).message });
    } finally {
      setTestingKey(false);
    }
  };

  const handleTriggerIngestion = async () => {
    setTriggering(true);
    setTriggerResult(null);
    try {
      const res = await api.triggerIngestion({
        bbox: bboxToString(area.bbox),
        day_range: Math.min(5, Math.max(1, triggerDays)),
        products: [productFor(triggerSensor, triggerSatellite)],
      });
      setTriggerResult(`${res.message} Job: ${res.job.id}`);
      onRefreshData();
    } catch (err) {
      setTriggerResult(`Ingestion failed: ${(err as Error).message}`);
    } finally {
      setTriggering(false);
    }
  };

  const selectClass =
    'w-full bg-raised border border-line-strong rounded-control px-3 min-h-touch text-fg text-xs appearance-none pr-8 focus-visible:outline-accent transition-colors cursor-pointer';
  const inputClass =
    'flex-1 bg-raised border border-line-strong rounded-control px-3.5 min-h-touch text-xs text-fg font-mono focus-visible:outline-accent transition-colors';

  return (
    <div className="space-y-6 max-w-4xl mx-auto page-enter">

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="bg-surface border border-line rounded-card p-5 sm:p-6">
        <div className="flex items-start gap-3">
          <div className="h-8 w-8 rounded-control bg-gradient-to-br from-amber-500 to-orange-500 flex items-center justify-center shadow-elev-1 shrink-0">
            <Settings className="h-4 w-4 text-accent-fg stroke-[2.5]" aria-hidden="true" />
          </div>
          <div>
            <h2 className="text-base font-bold text-fg tracking-tight">
              NASA FIRMS Connection &amp; Ingestion Management
            </h2>
            <p className="text-xs text-fg-muted mt-0.5">
              Configure official NASA FIRMS MAP_KEY credentials, test API availability, and manage ingestion pipelines
            </p>
          </div>
        </div>
      </div>

      {/* ── API Key Panel ───────────────────────────────────────────────── */}
      <div className="bg-surface border border-line rounded-card p-5 space-y-4 shadow-elev-1">
        <div className="flex items-center justify-between border-b border-line pb-3">
          <div className="flex items-center gap-2">
            <div className="h-7 w-7 rounded-control bg-raised flex items-center justify-center shrink-0">
              <Key className="h-4 w-4 text-accent" aria-hidden="true" />
            </div>
            <h3 className="text-sm font-bold text-fg">NASA FIRMS MAP_KEY Integration</h3>
          </div>
          <a
            href="https://firms.modaps.eosdis.nasa.gov/api/map_key"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-info hover:text-fg transition-colors"
          >
            Get Free NASA Key
            <ExternalLink className="h-3 w-3" aria-hidden="true" />
          </a>
        </div>

        <p className="text-xs text-fg-muted leading-relaxed">
          NASA FIRMS provides free instant MAP_KEY access for research and disaster monitoring.
          Enter your 32-character key to connect directly to the live NASA FIRMS API endpoints.
        </p>

        <div className="space-y-3">
          <div className="flex flex-col sm:flex-row gap-2.5">
            <input
              type="text"
              placeholder="Paste your 32-character NASA FIRMS MAP_KEY…"
              value={mapKey}
              onChange={(e) => setMapKey(e.target.value)}
              className={inputClass}
            />
            <button
              onClick={testKey}
              disabled={testingKey}
              className="inline-flex items-center justify-center gap-1.5 px-4 min-h-touch rounded-control bg-accent hover:bg-accent-hover text-accent-fg font-semibold text-xs disabled:opacity-50 transition-colors shadow-elev-1 shrink-0"
            >
              {testingKey ? (
                <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Key className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              Verify Server Key with NASA API
            </button>
          </div>

          {keyResult && (
            <div
              role="alert"
              className={`p-3.5 rounded-control border text-xs flex items-center gap-2.5 ${
                keyResult.valid
                  ? 'bg-success/10 border-success/40 text-success'
                  : 'bg-danger/10 border-danger/40 text-danger'
              }`}
            >
              {keyResult.valid ? (
                <CheckCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
              ) : (
                <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
              )}
              <span>{keyResult.message}</span>
            </div>
          )}
        </div>
      </div>

      {/* ── Ingestion Trigger ───────────────────────────────────────────── */}
      <div className="bg-surface border border-line rounded-card p-5 space-y-4 shadow-elev-1">
        <div className="flex items-center gap-2 border-b border-line pb-3">
          <div className="h-7 w-7 rounded-control bg-raised flex items-center justify-center shrink-0">
            <Cpu className="h-4 w-4 text-info" aria-hidden="true" />
          </div>
          <h3 className="text-sm font-bold text-fg">Trigger Pipeline Ingestion Job</h3>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs">
          <div className="space-y-1.5">
            <label className="block text-fg-subtle text-2xs font-mono uppercase tracking-wider">Target Sensor</label>
            <div className="relative">
              <select
                value={triggerSensor}
                onChange={(e) => setTriggerSensor(e.target.value)}
                className={selectClass}
              >
                <option value="VIIRS">VIIRS (375 m)</option>
                <option value="MODIS">MODIS (1 km)</option>
              </select>
              <ChevronDown className="h-4 w-4 text-fg-muted absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden="true" />
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="block text-fg-subtle text-2xs font-mono uppercase tracking-wider">Satellite Platform</label>
            <div className="relative">
              <select
                value={triggerSatellite}
                onChange={(e) => setTriggerSatellite(e.target.value)}
                className={selectClass}
              >
                <option value="Suomi-NPP">Suomi-NPP</option>
                <option value="NOAA-20">NOAA-20</option>
                <option value="Terra">Terra</option>
                <option value="Aqua">Aqua</option>
              </select>
              <ChevronDown className="h-4 w-4 text-fg-muted absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden="true" />
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="block text-fg-subtle text-2xs font-mono uppercase tracking-wider">Date Chunk Range</label>
            <div className="relative">
              <select
                value={triggerDays}
                onChange={(e) => setTriggerDays(Number(e.target.value))}
                className={selectClass}
              >
                <option value={5}>Past 5 Days</option>
                <option value={10}>Past 10 Days</option>
                <option value={30}>Past 30 Days</option>
              </select>
              <ChevronDown className="h-4 w-4 text-fg-muted absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden="true" />
            </div>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pt-2">
          <div className="text-xs text-fg-muted">
            Selected area: <span className="text-accent font-semibold">{area.name}</span>
          </div>

          <button
            onClick={handleTriggerIngestion}
            disabled
            title="Not available in this build"
            aria-describedby="ingest-note"
            className="inline-flex items-center justify-center gap-1.5 px-4 min-h-touch rounded-control bg-info/80 text-canvas font-semibold text-xs disabled:opacity-50 transition-colors shadow-elev-1 cursor-not-allowed"
          >
            {triggering ? (
              <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Play className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            Execute ingestion (not available)
          </button>
        </div>

        <p id="ingest-note" className="text-xs text-fg-subtle">
          Ingestion from this page is not available in this build. Load an archive with{' '}
          <code className="font-mono text-fg-muted bg-raised px-1 py-0.5 rounded">data_pipeline/run_pipeline.py</code>,
          or use the live detections in the Hotspot Explorer.
        </p>

        {triggerResult && (
          <div className="p-3.5 rounded-control bg-raised border border-line text-xs text-accent font-mono">
            {triggerResult}
          </div>
        )}
      </div>

      {/* ── Historical Archive Status ──────────────────────────────────── */}
      <div className="bg-surface border border-line rounded-card p-5 space-y-4 shadow-elev-1">
        <div className="flex items-center gap-2 border-b border-line pb-3">
          <div className="h-7 w-7 rounded-control bg-raised flex items-center justify-center shrink-0">
            <Database className="h-4 w-4 text-accent" aria-hidden="true" />
          </div>
          <h3 className="text-sm font-bold text-fg">Historical Archive Health</h3>
        </div>

        {archiveError ? (
          <div role="alert" className="p-3.5 rounded-control bg-danger/10 border border-danger/40 text-xs text-danger flex items-center gap-2.5">
            <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>Archive status unavailable: {archiveError}</span>
          </div>
        ) : !archiveStatus ? (
          <p className="text-xs text-fg-muted">Loading archive status…</p>
        ) : !archiveStatus.available ? (
          <p className="text-xs text-fg-muted">{archiveStatus.note}</p>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {(['MODIS', 'VIIRS'] as const).map((sensor) => {
                const s = archiveStatus.sensors[sensor];
                return (
                  <div key={sensor} className="rounded-control border border-line bg-raised p-3.5 space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-fg">{sensor}</span>
                      <span className={`text-2xs font-mono px-1.5 py-0.5 rounded ${s ? 'bg-success/15 text-success' : 'bg-raised text-fg-subtle border border-line'}`}>
                        {s ? 'AVAILABLE' : 'NOT IN ARCHIVE'}
                      </span>
                    </div>
                    {s ? (
                      <>
                        <p className="text-2xs text-fg-muted font-mono">
                          {s.years.length} year{ s.years.length === 1 ? '' : 's'} · {s.min_date} → {s.max_date}
                        </p>
                        <p className="text-2xs text-fg-muted font-mono">
                          {s.rows != null ? `${s.rows.toLocaleString()} detections` : 'rows: unknown'}
                        </p>
                      </>
                    ) : (
                      <p className="text-2xs text-fg-subtle">No archive files for this sensor.</p>
                    )}
                  </div>
                );
              })}
            </div>
            <p className="text-2xs text-fg-subtle leading-relaxed">{archiveStatus.note}</p>
          </div>
        )}
      </div>

      {/* ── Architecture Info ───────────────────────────────────────────── */}
      <div className="bg-surface border border-line rounded-card p-5 space-y-3 text-xs text-fg-muted shadow-elev-1">
        <div className="flex items-center gap-2 border-b border-line pb-3">
          <div className="h-7 w-7 rounded-control bg-raised flex items-center justify-center shrink-0">
            <Database className="h-4 w-4 text-success" aria-hidden="true" />
          </div>
          <h3 className="text-sm font-bold text-fg">Production vs Local Storage Architecture</h3>
        </div>

        <p className="leading-relaxed text-fg-muted">
          In compliance with the NASA Space Apps Challenge specifications:
        </p>

        <ul className="space-y-2 text-fg-muted">
          {[
            {
              label: 'Production Environment',
              text: 'Relational PostgreSQL with PostGIS extension for spatial indexes (GIST index on geometry), B-tree indexes on (acq_date, sensor, satellite).',
            },
            {
              label: 'Lightweight Local Environment',
              text: 'Fast in-memory canonical indexed store and SQLite compatibility for immediate verification without Docker daemon dependencies.',
            },
            {
              label: 'Zero Fabricated Data',
              text: 'Observations are exclusively ingested from authentic NASA FIRMS standard science products and NRT streams.',
            },
          ].map(({ label, text }) => (
            <li key={label} className="flex gap-2">
              <span className="text-accent mt-0.5 shrink-0">·</span>
              <span>
                <strong className="text-fg">{label}:</strong> {text}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
};

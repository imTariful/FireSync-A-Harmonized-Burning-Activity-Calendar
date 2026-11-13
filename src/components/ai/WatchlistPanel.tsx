/**
 * Watchlists and alerts tab of the AI Investigator.
 *
 * Watchlists are saved bbox + threshold conditions evaluated by deterministic server code.
 * Alerts are delivered in-app only (this list); there is no push or email channel, and the
 * panel says so instead of implying monitoring reaches anyone outside the app.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Bell, BellOff, Loader2, Pause, Play, Plus, Trash2, CheckCheck } from 'lucide-react';
import type { AiRequestContext } from '../../types/ai';
import { MonitoringAreaMap } from '../calendar/MonitoringAreaMap';
import { parseMonitoringBox, type MonitoringSelection } from '../../utils/monitoringArea';
import { bboxToString } from '../../utils/area';
import {
  watchlistApi,
  type WatchAlert,
  type WatchCondition,
  type Watchlist,
  type WatchlistsMeta,
  type WatchlistsResponse,
} from '../../api/watchlists';

interface Props {
  context: AiRequestContext;
  monitoringArea?: { name: string; bbox: string; polygon: boolean };
  inlineAreaSelection?: boolean;
}

const inputCls =
  'w-full rounded-control border border-line bg-canvas px-2 py-1.5 text-xs text-fg placeholder:text-fg-subtle';

function conditionLabel(w: Watchlist): string {
  const c = w.condition;
  const frp = c.min_frp_mw !== undefined ? `, FRP ≥ ${c.min_frp_mw} MW` : '';
  return `${c.sensors} · ${c.trigger === 'clusters' ? 'potential cluster' : 'per sensor'} ≥${c.min_detections} in ${c.days}d${frp}`;
}

export const WatchlistPanel: React.FC<Props> = ({ context, monitoringArea, inlineAreaSelection }) => {
  const [data, setData] = useState<WatchlistsResponse | null>(null);
  const [meta, setMeta] = useState<WatchlistsMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [bbox, setBbox] = useState(context.bbox ?? '');
  const [days, setDays] = useState(1);
  const [sensors, setSensors] = useState<WatchCondition['sensors']>('ALL');
  const [minDetections, setMinDetections] = useState(5);
  const [minFrp, setMinFrp] = useState('');
  const [trigger, setTrigger] = useState<'detections' | 'clusters'>('detections');
  const [localArea, setLocalArea] = useState<MonitoringSelection | null | undefined>(undefined);
  const inheritedArea = useMemo(() => {
    const box = monitoringArea && parseMonitoringBox(monitoringArea.bbox);
    return box ? { name: monitoringArea.name, bbox: box, note: monitoringArea.polygon ? 'This rectangle includes locations outside your drawn polygon.' : undefined } : null;
  }, [monitoringArea?.bbox, monitoringArea?.name, monitoringArea?.polygon]);
  const pickedArea = localArea === undefined ? inheritedArea : localArea;
  const watchBbox = inlineAreaSelection ? pickedArea ? bboxToString(pickedArea.bbox) : '' : bbox;
  const [explanations, setExplanations] = useState<Record<string, { text: string | null; reason: string | null }>>({});

  const refresh = useCallback(async () => {
    try {
      const res = await watchlistApi.list();
      setData(res);
      setMeta(res.meta);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Watchlists could not be loaded.');
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 60_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The action failed.');
    } finally {
      setBusy(null);
    }
  };

  const create = () =>
    run('create', async () => {
      const frp = minFrp.trim() === '' ? undefined : Number(minFrp);
      await watchlistApi.create({
        name: name.trim(),
        bbox: watchBbox.trim(),
        condition: {
          sensors,
          days,
          min_detections: minDetections,
          trigger,
          ...(frp !== undefined && Number.isFinite(frp) ? { min_frp_mw: frp } : {}),
        },
      });
      setName('');
    });

  const explain = async (alert: WatchAlert) => {
    setBusy(`explain-${alert.id}`);
    setError(null);
    try {
      const res = await watchlistApi.explainAlert(alert.id);
      setExplanations((prev) => ({
        ...prev,
        [alert.id]: { text: res.explanation, reason: res.ai.reason },
      }));
    } catch (err) {
      setExplanations((prev) => ({
        ...prev,
        [alert.id]: { text: null, reason: err instanceof Error ? err.message : 'The explanation failed.' },
      }));
    } finally {
      setBusy(null);
    }
  };

  const watchlists = data?.watchlists ?? [];
  const alerts = data?.alerts ?? [];

  return (
    <div className="space-y-4">
      <div className="rounded-control border border-line bg-canvas p-2.5 space-y-1.5">
        <p className="text-2xs text-fg-subtle">
          {meta ? (
            <>
              Storage: {meta.storage}
              {meta.durable ? ' (durable)' : ' (not durable)'} · scheduler:{' '}
              {meta.scheduler.running ? `every ${meta.scheduler.interval_minutes} min` : 'not running'} ·{' '}
              {meta.delivery === 'in_app_only' ? 'in-app alerts only' : meta.delivery}
            </>
          ) : (
            'Loading watchlist status…'
          )}
        </p>
        <p className="text-2xs text-fg-subtle">{meta?.note}</p>
      </div>

      {error && (
        <p role="alert" className="text-2xs text-danger">
          {error}
        </p>
      )}

      <section className="space-y-2">
        <h3 className="text-2xs font-mono uppercase tracking-wider text-fg-subtle">New watchlist</h3>
        <label className="block text-xs">Alert on
          <select className={inputCls} aria-label="Watchlist trigger" value={trigger} onChange={(e) => setTrigger(e.target.value as typeof trigger)}>
            <option value="detections">Newly reported detections (threshold per sensor)</option>
            <option value="clusters">Potential clusters of newly reported detections (5 km / 24 h)</option>
          </select>
        </label>
        <p className="text-2xs text-fg-subtle">First check establishes the initial reported observations. Later alerts require new observation fingerprints; acquisition time is not ignition time. Monitoring runs only while this server runs.</p>
        <input
          className={inputCls}
          placeholder="Name (e.g. North district fields)"
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
          aria-label="Watchlist name"
        />
        {inlineAreaSelection ? (
          <MonitoringAreaMap value={pickedArea} watchlists={watchlists} onChange={(selection) => {
            setLocalArea(selection);
            if (selection) setName((previous) => previous || selection.name.slice(0, 80));
          }} />
        ) : <input
          className={`${inputCls} font-mono`}
          placeholder="bbox west,south,east,north"
          value={bbox}
          onChange={(e) => setBbox(e.target.value)}
          aria-label="Watchlist bounding box"
        />}
        <div className="grid grid-cols-2 gap-2">
          <label className="text-2xs text-fg-subtle">
            Sensors
            <select
              className={`${inputCls} mt-0.5`}
              value={sensors}
              onChange={(e) => setSensors(e.target.value as WatchCondition['sensors'])}
            >
              <option value="ALL">ALL</option>
              <option value="MODIS">MODIS</option>
              <option value="VIIRS">VIIRS</option>
            </select>
          </label>
          <label className="text-2xs text-fg-subtle">
            Days (1-5)
            <select
              className={`${inputCls} mt-0.5`}
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
            >
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <label className="text-2xs text-fg-subtle">
            Min detections
            <input
              className={`${inputCls} mt-0.5`}
              type="number"
              min={1}
              value={minDetections}
              onChange={(e) => setMinDetections(Math.max(1, Number(e.target.value) || 1))}
            />
          </label>
          <label className="text-2xs text-fg-subtle">
            Min FRP MW (optional)
            <input
              className={`${inputCls} mt-0.5`}
              type="number"
              min={0}
              placeholder="any"
              value={minFrp}
              onChange={(e) => setMinFrp(e.target.value)}
            />
          </label>
        </div>
        <button
          type="button"
          onClick={create}
          disabled={busy === 'create' || !name.trim() || !watchBbox.trim()}
          className="inline-flex items-center min-h-11 px-4 py-2 rounded-control bg-accent text-accent-fg font-semibold text-xs gap-1.5 disabled:opacity-60"
        >
          {busy === 'create' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
          Save watchlist
        </button>
      </section>

      <section className="space-y-2">
        <h3 className="text-2xs font-mono uppercase tracking-wider text-fg-subtle">
          Watchlists ({watchlists.length})
        </h3>
        {watchlists.length === 0 && (
          <p className="text-2xs text-fg-subtle">No watchlists yet. Save one above to start monitoring.</p>
        )}
        {watchlists.map((w) => (
          <div key={w.id} className="rounded-control border border-line bg-canvas p-2.5 space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-fg flex-1 truncate">{w.name}</span>
              {w.paused && <span className="badge badge-warn text-2xs">paused</span>}
            </div>
            <p className="text-2xs text-fg-subtle font-mono break-all">
              {conditionLabel(w)} · bbox {w.bbox}
            </p>
            <p className="text-2xs text-fg-subtle">
              Last check:{' '}
              {w.last_evaluated_at ? w.last_evaluated_at.slice(0, 16).replace('T', ' ') : 'never'}
              {w.last_counts ? ` · M${w.last_counts.MODIS} V${w.last_counts.VIIRS}` : ''}
            </p>
            {w.last_error && <p role="alert" className="text-2xs text-danger">{w.last_error}</p>}
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void run(`check-${w.id}`, () => watchlistApi.check(w.id))}
                className="text-2xs text-accent hover:underline disabled:opacity-60"
              >
                Check now
              </button>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void run(`pause-${w.id}`, () => watchlistApi.setPaused(w.id, !w.paused))}
                className="text-2xs text-fg-muted hover:text-fg inline-flex items-center gap-1 disabled:opacity-60"
              >
                {w.paused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
                {w.paused ? 'Resume' : 'Pause'}
              </button>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void run(`del-${w.id}`, () => watchlistApi.remove(w.id))}
                className="text-2xs text-danger hover:underline inline-flex items-center gap-1 disabled:opacity-60"
              >
                <Trash2 className="h-3 w-3" /> Delete
              </button>
            </div>
          </div>
        ))}
      </section>

      <section className="space-y-2">
        <h3 className="text-2xs font-mono uppercase tracking-wider text-fg-subtle inline-flex items-center gap-1">
          <Bell className="h-3.5 w-3.5" aria-hidden="true" /> Alerts ({alerts.length})
        </h3>
        {alerts.length === 0 && (
          <p className="text-2xs text-fg-subtle">No alerts. An alert means a saved threshold was reached.</p>
        )}
        {alerts.map((alert) => (
          <div key={alert.id} className="rounded-control border border-line bg-canvas p-2.5 space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-fg flex-1 truncate">{alert.watchlist_name}</span>
              <span className="text-2xs text-fg-subtle font-mono">{alert.date}</span>
              {alert.acknowledged && <span className="badge text-2xs">acknowledged</span>}
            </div>
            <p className="text-2xs text-fg-muted">{alert.reason}</p>
            {alert.new_detections != null && <p className="text-2xs text-fg-muted">New source observations: {alert.new_detections} · acquisition UTC {alert.first_acquisition_utc} → {alert.last_acquisition_utc}</p>}
            <p className="text-2xs text-fg-subtle font-mono">
              MODIS {alert.counts.MODIS} · VIIRS {alert.counts.VIIRS} · threshold ≥
              {alert.condition.min_detections}
            </p>
            <div className="flex flex-wrap gap-2">
              {!alert.acknowledged && (
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void run(`ack-${alert.id}`, () => watchlistApi.acknowledgeAlert(alert.id))}
                  className="text-2xs text-fg-muted hover:text-fg inline-flex items-center gap-1 disabled:opacity-60"
                >
                  <CheckCheck className="h-3 w-3" /> Acknowledge
                </button>
              )}
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void explain(alert)}
                className="text-2xs text-accent hover:underline disabled:opacity-60"
              >
                {busy === `explain-${alert.id}` ? 'Explaining…' : 'Explain with AI'}
              </button>
            </div>
            {explanations[alert.id] && (
              <p className="text-2xs text-fg-muted leading-relaxed border-t border-line pt-1.5">
                {explanations[alert.id].text ?? explanations[alert.id].reason}
              </p>
            )}
          </div>
        ))}
        <p className="text-2xs text-fg-subtle inline-flex items-center gap-1">
          <BellOff className="h-3 w-3" aria-hidden="true" />
          Alerts appear here only. No email or push notifications are sent.
        </p>
      </section>
    </div>
  );
};

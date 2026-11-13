/**
 * Global AI investigation panel: "Ask FireSync" + detection evidence.
 *
 * All numbers come from the server's data tools. This component only renders what the API
 * returned and forwards validated map actions to the app. When AI is disabled or unkeyed the
 * panel says so and keeps its inputs disabled instead of pretending a provider exists.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Sparkles, Send, X, Loader2, AlertTriangle, ShieldCheck, ListChecks } from 'lucide-react';
import type { CanonicalObservation } from '../../types/fire';
import type {
  AiApplyFiltersAction,
  AiChatResponse,
  AiFocusRegionAction,
  AiMapAction,
  AiRequestContext,
  AiStatusResponse,
  AiToolCallRecord,
} from '../../types/ai';
import { aiApi } from '../../api/ai';
import type { AiTab } from '../../utils/aiFeatureCatalog';
import { DetectionEvidenceCard } from './DetectionEvidenceCard';
import { AuditDashboard, ClusterInvestigator } from './IntelligencePanels';
import { SensorConflictPanel } from './SensorConflictPanel';
import { WatchlistPanel } from './WatchlistPanel';
import { ScenarioPanel } from './ScenarioPanel';

interface Props {
  open: boolean;
  onClose: () => void;
  context: AiRequestContext;
  detections: CanonicalObservation[];
  onApplyFilters: (action: AiApplyFiltersAction) => void;
  onFocusRegion: (action: AiFocusRegionAction) => void;
  onFocusCluster?: (target: { latitude: number; longitude: number }) => void;
  /** Deep link from the AI Intelligence hub; changing the nonce re-applies the same tab. */
  requestedTab?: AiTab;
  requestNonce?: number;
  /** A detection clicked on the map: pinned into the Evidence tab until another is picked. */
  requestedObservation?: CanonicalObservation | null;
  observationNonce?: number;
  /** Open the AI Intelligence hub from inside the panel. */
  onOpenHub?: () => void;
}

type ChatEntry =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; toolCalls: AiToolCallRecord[]; actions: AiMapAction[]; notes: string[] }
  | { role: 'error'; text: string };

const SUGGESTIONS = [
  'How many VIIRS and MODIS detections are in the current view?',
  'Show only high-confidence VIIRS hotspots from the last 2 days.',
  'Compare MODIS and VIIRS detections in this area.',
  'Zoom the map to the Amazon region.',
];

function daysInContext(context: AiRequestContext): number {
  if (context.start_date && context.end_date) {
    const span =
      Math.round((Date.parse(`${context.end_date}T00:00:00Z`) - Date.parse(`${context.start_date}T00:00:00Z`)) / 86_400_000) + 1;
    if (Number.isFinite(span)) return Math.min(Math.max(span, 1), 5);
  }
  return 1;
}

function describeAction(action: AiMapAction): string {
  if (action.type === 'focus_region') return `Focused map: ${action.name}`;
  const parts: string[] = [];
  if (action.sensors) parts.push(`sensor ${action.sensors}`);
  if (action.days) parts.push(`last ${action.days} day${action.days === 1 ? '' : 's'}`);
  if (action.min_frp !== undefined) parts.push(`FRP ≥ ${action.min_frp} MW`);
  if (action.min_confidence !== undefined) parts.push(`confidence ≥ ${action.min_confidence}`);
  return `Applied: ${parts.join(', ')}`;
}

export const AiInvestigatorPanel: React.FC<Props> = ({
  open,
  onClose,
  context,
  detections,
  onApplyFilters,
  onFocusRegion,
  onFocusCluster,
  requestedTab,
  requestNonce,
  requestedObservation = null,
  observationNonce = 0,
  onOpenHub,
}) => {
  const [tab, setTab] = useState<AiTab>('chat');
  const [status, setStatus] = useState<AiStatusResponse | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [selectedId, setSelectedId] = useState<string>('');
  /** Detection sent from the map; takes precedence over the dropdown selection. */
  const [pinned, setPinned] = useState<CanonicalObservation | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const appliedObservationRef = useRef<{ observation: CanonicalObservation; nonce: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open || status) return;
    aiApi
      .getStatus()
      .then(setStatus)
      .catch((err: unknown) =>
        setStatusError(err instanceof Error ? err.message : 'AI status could not be read.')
      );
  }, [open, status]);

  useEffect(() => {
    if (open && requestedTab) setTab(requestedTab);
  }, [open, requestedTab, requestNonce]);

  // A hotspot sent from the map pins the Evidence tab to that record. The nonce makes a repeated
  // click on the same detection a new request; picking another detection in the dropdown unpins.
  useEffect(() => {
    if (!open || !requestedObservation) return;
    const applied = appliedObservationRef.current;
    if (applied?.observation === requestedObservation && applied.nonce === observationNonce) return;
    appliedObservationRef.current = { observation: requestedObservation, nonce: observationNonce };
    setPinned(requestedObservation);
    setSelectedId(
      detections.some((o) => o.id === requestedObservation.id) ? requestedObservation.id : ''
    );
  }, [open, requestedObservation, observationNonce, detections]);

  const ready = status?.status === 'enabled';

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || sending || !ready) return;
      setEntries((prev) => [...prev, { role: 'user', text: trimmed }]);
      setMessage('');
      setSending(true);
      try {
        const response: AiChatResponse = await aiApi.chat({ message: trimmed, context });
        setEntries((prev) => [
          ...prev,
          {
            role: 'assistant',
            text: response.reply,
            toolCalls: response.tool_calls,
            actions: response.actions,
            notes: response.data_notes,
          },
        ]);
        for (const action of response.actions) {
          if (action.type === 'apply_filters') onApplyFilters(action);
          else onFocusRegion(action);
        }
      } catch (err) {
        setEntries((prev) => [
          ...prev,
          { role: 'error', text: err instanceof Error ? err.message : 'The assistant could not answer.' },
        ]);
      } finally {
        setSending(false);
      }
    },
    [context, onApplyFilters, onFocusRegion, ready, sending]
  );

  const selected = detections.find((o) => o.id === selectedId) ?? null;
  const evidenceObservation = pinned ?? selected;

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="presentation">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden="true" />
      <section
        role="dialog"
        aria-modal="true"
        aria-label="FireSync AI investigator"
        className="relative h-full w-full max-w-md bg-surface border-l border-line shadow-elev-2 flex flex-col"
      >
        <header className="flex items-center gap-2 border-b border-line px-4 py-3">
          <Sparkles className="h-4 w-4 text-accent" aria-hidden="true" />
          <h2 className="text-sm font-bold text-fg flex-1">AI Investigator</h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close AI investigator"
            className="p-1.5 rounded-control hover:bg-raised text-fg-muted"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </header>

        <div className="flex gap-1 border-b border-line px-3 py-2" role="tablist" aria-label="AI tools">
          {([
            { id: 'chat', label: 'Ask' },
            { id: 'evidence', label: 'Evidence' },
            { id: 'cluster', label: 'Clusters' },
            { id: 'sensors', label: 'Sensors' },
            { id: 'audit', label: 'Audit' },
            { id: 'watch', label: 'Watch' },
            { id: 'scenario', label: 'Lab' },
          ] as const).map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={tab === entry.id}
              onClick={() => setTab(entry.id)}
              className={`px-2.5 py-1.5 rounded-control text-xs font-semibold ${
                tab === entry.id ? 'bg-accent text-accent-fg' : 'text-fg-muted hover:bg-raised'
              }`}
            >
              {entry.label}
            </button>
          ))}
        </div>

        <div className="px-4 py-2 border-b border-line">
          {statusError && (
            <p role="alert" className="text-2xs text-danger">
              {statusError}
            </p>
          )}
          {!status && !statusError && (
            <p className="text-2xs text-fg-subtle inline-flex items-center gap-1">
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> Checking AI availability…
            </p>
          )}
          {status && (
            <p className="text-2xs text-fg-subtle flex items-start gap-1.5">
              {ready ? (
                <ShieldCheck className="h-3.5 w-3.5 text-accent shrink-0 mt-0.5" aria-hidden="true" />
              ) : (
                <AlertTriangle className="h-3.5 w-3.5 text-warning shrink-0 mt-0.5" aria-hidden="true" />
              )}
              <span>
                {status.note} {status.model ? `Model: ${status.model}.` : ''}
              </span>
            </p>
          )}
        </div>

        {tab === 'chat' ? (
          <>
            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
              {entries.length === 0 && (
                <div className="space-y-2">
                  <p className="text-xs text-fg-muted">
                    Ask about the detections currently on the map. The assistant can count them, compare sensors and
                    change the map filters. All numbers come from FireSync data tools.
                  </p>
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      disabled={!ready}
                      onClick={() => send(s)}
                      className="w-full text-left text-xs rounded-control border border-line bg-canvas px-3 py-2 text-fg-muted hover:border-accent disabled:opacity-60 disabled:cursor-not-allowed"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              )}

              {entries.map((entry, index) => {
                if (entry.role === 'user') {
                  return (
                    <div key={index} className="ml-8 rounded-card bg-accent/10 border border-accent/30 px-3 py-2">
                      <p className="text-xs text-fg">{entry.text}</p>
                    </div>
                  );
                }
                if (entry.role === 'error') {
                  return (
                    <div key={index} role="alert" className="rounded-card border border-danger/60 bg-canvas px-3 py-2">
                      <p className="text-xs text-danger">{entry.text}</p>
                    </div>
                  );
                }
                return (
                  <div key={index} className="mr-4 rounded-card border border-line bg-canvas px-3 py-2.5 space-y-2">
                    <p className="text-xs text-fg leading-relaxed whitespace-pre-line">{entry.text}</p>
                    {entry.toolCalls.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {entry.toolCalls.map((call, i) => (
                          <span
                            key={`${call.name}-${i}`}
                            className={`badge text-2xs font-mono ${call.ok ? 'badge-info' : 'badge-warn'}`}
                            title={call.summary}
                          >
                            {call.name}
                          </span>
                        ))}
                      </div>
                    )}
                    {entry.actions.length > 0 && (
                      <ul className="space-y-1">
                        {entry.actions.map((action, i) => (
                          <li key={i} className="text-2xs text-accent inline-flex items-center gap-1">
                            <ListChecks className="h-3 w-3" aria-hidden="true" />
                            {describeAction(action)}
                          </li>
                        ))}
                      </ul>
                    )}
                    {entry.notes.length > 0 && (
                      <p className="text-2xs text-fg-subtle">{entry.notes.join(' ')}</p>
                    )}
                  </div>
                );
              })}

              {sending && (
                <p className="text-2xs text-fg-subtle inline-flex items-center gap-1.5">
                  <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> Querying FireSync data tools…
                </p>
              )}
            </div>

            <form
              className="border-t border-line p-3 flex items-end gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void send(message);
              }}
            >
              <label className="sr-only" htmlFor="ai-message">
                Ask the FireSync assistant
              </label>
              <textarea
                id="ai-message"
                rows={2}
                value={message}
                onChange={(event) => setMessage(event.target.value.slice(0, 1500))}
                placeholder={ready ? 'Ask about the detections on the map…' : 'AI is not configured on this server.'}
                disabled={!ready || sending}
                className="flex-1 resize-none rounded-control border border-line bg-canvas px-3 py-2 text-xs text-fg placeholder:text-fg-subtle disabled:opacity-60"
              />
              <button
                type="submit"
                disabled={!ready || sending || !message.trim()}
                className="btn btn-primary px-3 py-2 disabled:opacity-60 disabled:cursor-not-allowed"
                aria-label="Send question"
              >
                <Send className="h-4 w-4" aria-hidden="true" />
              </button>
            </form>
          </>
        ) : tab === 'watch' ? (
          <div className="flex-1 overflow-y-auto p-4">
            <WatchlistPanel context={context} />
          </div>
        ) : tab === 'scenario' ? (
          <div className="flex-1 overflow-y-auto p-4">
            <ScenarioPanel />
          </div>
        ) : tab === 'cluster' || tab === 'sensors' || tab === 'audit' ? (
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {tab === 'cluster' ? (
              <ClusterInvestigator
                key={`${context.bbox ?? 'world'}|${daysInContext(context)}`}
                bbox={context.bbox ?? '-180,-90,180,90'}
                days={daysInContext(context)}
                onFocusCluster={onFocusCluster}
              />
            ) : tab === 'sensors' ? (
              <SensorConflictPanel bbox={context.bbox ?? '-180,-90,180,90'} days={daysInContext(context)} />
            ) : (
              <AuditDashboard bbox={context.bbox ?? '-180,-90,180,90'} days={daysInContext(context)} />
            )}
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            <label className="block text-2xs font-mono uppercase tracking-wider text-fg-subtle" htmlFor="ai-evidence-select">
              Detection on the map
            </label>
            <select
              id="ai-evidence-select"
              value={selectedId}
              onChange={(event) => {
                setPinned(null);
                setSelectedId(event.target.value);
              }}
              disabled={detections.length === 0}
              className="w-full rounded-control border border-line bg-canvas px-2 py-1.5 text-xs text-fg disabled:opacity-60"
            >
              <option value="">
                {detections.length === 0 ? 'No detections loaded yet' : `Select one of ${detections.length} loaded detections`}
              </option>
              {detections.slice(0, 100).map((o) => (
                <option key={o.id} value={o.id}>
                  {o.sensor} · {o.datetime_utc} · {o.frp_mw} MW · {o.satellite}
                </option>
              ))}
            </select>
            {pinned && !detections.some((o) => o.id === pinned.id) && (
              <p className="text-2xs text-fg-subtle">
                Showing the detection selected on the map; it is not in the loaded list above.
              </p>
            )}
            <DetectionEvidenceCard observation={evidenceObservation} />
          </div>
        )}

        <footer className="border-t border-line px-4 py-2">
          <div className="flex items-start gap-2">
            <p className="flex-1 text-2xs text-fg-subtle leading-relaxed">
              Satellite thermal anomalies, not confirmed wildfires or burned area. AI text is explanatory only; every
              number comes from FireSync data tools.
            </p>
            {onOpenHub && (
              <button
                type="button"
                onClick={onOpenHub}
                className="text-2xs text-accent hover:underline shrink-0"
              >
                All AI features
              </button>
            )}
          </div>
        </footer>
      </section>
    </div>
  );
};

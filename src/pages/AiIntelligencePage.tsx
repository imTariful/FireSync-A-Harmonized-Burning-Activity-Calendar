/**
 * AI Intelligence hub.
 *
 * All 16 Groq-powered capabilities are listed here with the status of THIS deployment.
 * The page is a catalog and a set of deep links, not a claim that every roadmap feature works:
 * unavailable entries state the missing dataset, provider or infrastructure component.
 */

import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Database,
  Loader2,
  MinusCircle,
  Server,
  Sparkles,
  XCircle,
} from 'lucide-react';
import { aiApi } from '../api/ai';
import { intelligenceApi, type DatasetStatusResponse } from '../api/intelligence';
import type { AiRequestContext, AiStatusResponse } from '../types/ai';
import { FIRE_LEGEND } from '../types/ai';
import {
  AI_FEATURE_STATUS_LABELS,
  aiFeatureStatusCounts,
  groupAiFeatures,
  type AiFeatureAction,
  type AiFeatureEntry,
  type AiFeaturePage,
  type AiFeatureStatus,
  type AiTab,
  type GeographicLayerId,
} from '../utils/aiFeatureCatalog';

interface Props {
  context: AiRequestContext;
  onOpenAiTool: (tab: AiTab) => void;
  onOpenGeographicLayer: (layer: GeographicLayerId) => void;
  onOpenGeographicReport: () => void;
  onNavigate: (page: AiFeaturePage) => void;
}

export interface AiIntelligenceContentProps extends Props {
  status: AiStatusResponse | null;
  statusError: string | null;
  datasets: DatasetStatusResponse | null;
  datasetsError: string | null;
}

const STATUS_BADGE: Record<AiFeatureStatus, string> = {
  available: 'badge badge-success',
  partial: 'badge badge-amber',
  unavailable: 'badge border border-line bg-raised text-fg-muted',
};

const STATUS_ICON: Record<AiFeatureStatus, React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>> = {
  available: CheckCircle2,
  partial: MinusCircle,
  unavailable: XCircle,
};

const StatusIcon: React.FC<{ status: AiFeatureStatus }> = ({ status }) => {
  const Icon = STATUS_ICON[status];
  return <Icon className="h-3.5 w-3.5 shrink-0 mt-0.5" aria-hidden={true} />;
};

const ProviderStatus: React.FC<{
  status: AiStatusResponse | null;
  error: string | null;
}> = ({ status, error }) => {
  if (error) {
    return (
      <div data-testid="ai-provider-status" className="rounded-control border border-danger/40 bg-canvas p-3">
        <p className="text-2xs font-mono uppercase tracking-wider text-fg-subtle">AI provider</p>
        <p role="alert" className="mt-1 text-xs text-danger">
          AI status could not be read: {error}
        </p>
      </div>
    );
  }

  if (!status) {
    return (
      <div data-testid="ai-provider-status" className="rounded-control border border-line bg-canvas p-3">
        <p className="text-2xs font-mono uppercase tracking-wider text-fg-subtle">AI provider</p>
        <p className="mt-1 text-xs text-fg-subtle inline-flex items-center gap-1.5">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> Checking AI availability…
        </p>
      </div>
    );
  }

  const capabilities: Array<[string, boolean]> = [
    ['Chat', status.capabilities.chat],
    ['Function calling', status.capabilities.function_calling],
    ['Detection explanation', status.capabilities.detection_explanation],
    ['Image analysis', status.capabilities.image_analysis],
  ];

  return (
    <div data-testid="ai-provider-status" className="rounded-control border border-line bg-canvas p-3 space-y-2">
      <div className="flex items-center gap-2">
        <Server className="h-4 w-4 text-accent" aria-hidden="true" />
        <p className="text-2xs font-mono uppercase tracking-wider text-fg-subtle flex-1">AI provider</p>
        <span
          className={`badge text-2xs ${
            status.status === 'enabled' ? 'badge-success' : status.status === 'disabled' ? 'badge-amber' : 'badge-danger'
          }`}
        >
          {status.status === 'not_configured' ? 'not configured' : status.status}
        </span>
      </div>
      <p className="text-xs text-fg-muted">{status.note}</p>
      <p className="text-2xs text-fg-subtle font-mono">
        Model: {status.model ?? 'not selected'} · Provider: {status.provider}
      </p>
      <ul className="flex flex-wrap gap-1">
        {capabilities.map(([label, available]) => (
          <li
            key={label}
            className={`badge text-2xs ${available ? 'badge-info' : 'border border-line bg-raised text-fg-muted'}`}
          >
            {label}: {available ? 'yes' : 'no'}
          </li>
        ))}
      </ul>
      <details className="text-2xs text-fg-subtle">
        <summary className="cursor-pointer text-fg-muted">Guardrails ({status.guardrails.length})</summary>
        <ul className="mt-1 space-y-0.5">
          {status.guardrails.map((guardrail) => (
            <li key={guardrail}>{guardrail}</li>
          ))}
        </ul>
      </details>
    </div>
  );
};

const DatasetStatus: React.FC<{
  datasets: DatasetStatusResponse | null;
  error: string | null;
  onOpenGeographic: () => void;
}> = ({ datasets, error, onOpenGeographic }) => {
  if (error) {
    return (
      <div data-testid="ai-dataset-status" className="rounded-control border border-danger/40 bg-canvas p-3">
        <p className="text-2xs font-mono uppercase tracking-wider text-fg-subtle">Geographic datasets</p>
        <p role="alert" className="mt-1 text-xs text-danger">
          Dataset status could not be read: {error}
        </p>
      </div>
    );
  }

  if (!datasets) {
    return (
      <div data-testid="ai-dataset-status" className="rounded-control border border-line bg-canvas p-3">
        <p className="text-2xs font-mono uppercase tracking-wider text-fg-subtle">Geographic datasets</p>
        <p className="mt-1 text-xs text-fg-subtle inline-flex items-center gap-1.5">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> Checking dataset availability…
        </p>
      </div>
    );
  }

  return (
    <div data-testid="ai-dataset-status" className="rounded-control border border-line bg-canvas p-3 space-y-2">
      <div className="flex items-center gap-2">
        <Database className="h-4 w-4 text-accent" aria-hidden="true" />
        <p className="text-2xs font-mono uppercase tracking-wider text-fg-subtle flex-1">Geographic datasets</p>
        <span className="badge badge-info text-2xs">{datasets.available_count} configured</span>
        <span className="badge border border-line bg-raised text-fg-muted text-2xs">
          {datasets.unavailable_count} unavailable
        </span>
      </div>
      <p className="text-xs text-fg-muted">{datasets.note}</p>
      <button
        type="button"
        onClick={onOpenGeographic}
        className="text-2xs text-accent hover:underline inline-flex items-center gap-1"
      >
        Open dataset availability <ArrowRight className="h-3 w-3" aria-hidden="true" />
      </button>
    </div>
  );
};

const FeatureCard: React.FC<{
  feature: AiFeatureEntry;
  onAction: (action: AiFeatureAction) => void;
}> = ({ feature, onAction }) => {
  const action = feature.action;

  return (
    <article
      data-testid={`ai-feature-${feature.id}`}
      className="flex flex-col gap-2 rounded-card border border-line bg-surface p-4"
    >
      <div className="flex items-start gap-2">
        <span className="rounded-control bg-raised px-1.5 py-0.5 text-2xs font-mono font-semibold text-fg-subtle">
          #{String(feature.id).padStart(2, '0')}
        </span>
        <h4 className="flex-1 text-sm font-bold text-fg">{feature.title}</h4>
        <span className={`${STATUS_BADGE[feature.status]} text-2xs shrink-0`}>
          {AI_FEATURE_STATUS_LABELS[feature.status]}
        </span>
      </div>

      <p className="text-xs text-fg-muted leading-relaxed">{feature.summary}</p>

      <p className="text-2xs text-fg-subtle flex items-start gap-1.5">
        <StatusIcon status={feature.status} />
        <span>{feature.availabilityNote}</span>
      </p>

      <ul className="space-y-0.5">
        {feature.limitations.map((limitation) => (
          <li key={limitation} className="text-2xs text-fg-subtle flex items-start gap-1.5">
            <span className="mt-1 h-1 w-1 rounded-full bg-fg-subtle shrink-0" aria-hidden="true" />
            <span>{limitation}</span>
          </li>
        ))}
      </ul>

      {feature.subCapabilities && feature.subCapabilities.length > 0 && (
        <div className="rounded-control border border-line bg-canvas p-2">
          <p className="text-2xs font-mono uppercase tracking-wider text-fg-subtle">
            Geographic capabilities
          </p>
          <ul className="mt-1 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {feature.subCapabilities.map((sub) => (
              <li key={sub.label} className="text-2xs">
                <span className={`${STATUS_BADGE[sub.status]} text-[10px]`}>
                  {AI_FEATURE_STATUS_LABELS[sub.status]}
                </span>{' '}
                <span className="font-semibold text-fg-muted">{sub.label}</span>
                <span className="block text-fg-subtle">{sub.note}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {action && (
        <div className="mt-auto pt-1">
          <button
            type="button"
            onClick={() => onAction(action)}
            className="btn btn-secondary text-xs gap-1.5"
          >
            {action.label} <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      )}
    </article>
  );
};

export const AiIntelligenceContent: React.FC<AiIntelligenceContentProps> = ({
  context,
  status,
  statusError,
  datasets,
  datasetsError,
  onOpenAiTool,
  onOpenGeographicLayer,
  onOpenGeographicReport,
  onNavigate,
}) => {
  const counts = aiFeatureStatusCounts();
  const groups = groupAiFeatures();

  const handleAction = (action: AiFeatureAction) => {
    switch (action.kind) {
      case 'ai_tab':
        onOpenAiTool(action.tab);
        break;
      case 'geo_layer':
        onOpenGeographicLayer(action.layer);
        break;
      case 'geo_report':
        onOpenGeographicReport();
        break;
      case 'page':
        onNavigate(action.page);
        break;
    }
  };

  const windowLabel =
    context.start_date && context.end_date
      ? `${context.start_date} to ${context.end_date}`
      : 'live window not specified';

  return (
    <div className="space-y-5 page-enter">
      <section className="bg-surface border border-line rounded-card p-5 sm:p-6 space-y-3">
        <div className="flex items-start gap-3">
          <div className="h-9 w-9 rounded-control bg-gradient-to-br from-violet-500 to-fuchsia-500 flex items-center justify-center shrink-0">
            <Sparkles className="h-4.5 w-4.5 text-white" aria-hidden="true" />
          </div>
          <div className="flex-1">
            <h2 className="text-base font-bold text-fg tracking-tight">AI Intelligence</h2>
            <p className="text-xs text-fg-muted mt-0.5">
              All 16 Groq-powered capabilities, with the implementation status of this deployment.
            </p>
          </div>
        </div>
        <p className="text-2xs text-fg-subtle">
          {context.area_name ?? 'Current area'} · {windowLabel} · sensor {context.sensors ?? 'ALL'}
        </p>
        <p className="text-2xs text-fg-subtle leading-relaxed">
          Available means the UI and server route exist. Partial means some sub-capabilities are missing.
          Unavailable means a required dataset, provider or infrastructure component is absent. AI text is
          explanatory only; deterministic calculations stay on the server.
        </p>
      </section>

      <section className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="ai-feature-counts">
        {[
          { label: 'Features listed', value: counts.total },
          { label: 'Available', value: counts.available },
          { label: 'Partial', value: counts.partial },
          { label: 'Unavailable', value: counts.unavailable },
        ].map((stat) => (
          <div key={stat.label} className="rounded-card border border-line bg-surface p-3">
            <div className="text-2xs font-mono uppercase tracking-wider text-fg-subtle">{stat.label}</div>
            <div className="mt-0.5 text-xl font-bold font-mono text-fg">{stat.value}</div>
          </div>
        ))}
      </section>

      <section className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <ProviderStatus status={status} error={statusError} />
        <DatasetStatus
          datasets={datasets}
          error={datasetsError}
          onOpenGeographic={() => onNavigate('geographic')}
        />
      </section>

      {groups.map((group) => (
        <section key={group.phase} className="space-y-2">
          <div className="flex items-baseline gap-2">
            <h3 className="text-sm font-bold text-fg">{group.phase}</h3>
            <span className="text-2xs text-fg-subtle font-mono">
              {group.features.length} feature{group.features.length === 1 ? '' : 's'}
            </span>
          </div>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {group.features.map((feature) => (
              <FeatureCard key={feature.id} feature={feature} onAction={handleAction} />
            ))}
          </div>
        </section>
      ))}

      <section className="rounded-card border border-line bg-surface p-4 space-y-2">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-warning" aria-hidden="true" />
          <h3 className="text-sm font-bold text-fg">Verification status</h3>
        </div>
        <p className="text-2xs text-fg-subtle leading-relaxed">
          Phase 7 verification is ongoing. These statuses describe the current deployment and do not claim
          that every roadmap feature is complete. Unavailable capabilities are reported explicitly instead
          of returning zeros, empty successes or simulated results.
        </p>
        <p className="text-2xs text-fg-subtle">{FIRE_LEGEND}</p>
      </section>
    </div>
  );
};

export const AiIntelligencePage: React.FC<Props> = (props) => {
  const [status, setStatus] = useState<AiStatusResponse | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [datasets, setDatasets] = useState<DatasetStatusResponse | null>(null);
  const [datasetsError, setDatasetsError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    aiApi
      .getStatus()
      .then((result) => {
        if (!cancelled) setStatus(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) setStatusError(err instanceof Error ? err.message : 'AI status could not be read.');
      });

    intelligenceApi
      .datasets()
      .then((result) => {
        if (!cancelled) setDatasets(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) setDatasetsError(err instanceof Error ? err.message : 'Dataset status could not be read.');
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <AiIntelligenceContent
      {...props}
      status={status}
      statusError={statusError}
      datasets={datasets}
      datasetsError={datasetsError}
    />
  );
};

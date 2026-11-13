import React, { useId } from 'react';
import { CalendarClock, GitCompare, HelpCircle, Layers, MapPinned, Share2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export type ToolbarAction = 'area' | 'mapview' | 'harmonize' | 'timeline' | 'share' | 'help';

interface ExplorerToolbarProps {
  onAction: (action: ToolbarAction) => void;
  helpButtonRef?: React.Ref<HTMLButtonElement>;
  /** The Harmonize button, so the page can hand focus back to it when the drawer closes. */
  harmonizeButtonRef?: React.Ref<HTMLButtonElement>;
  /** Whether the Harmonize drawer is open (drives aria-expanded). */
  harmonizeOpen?: boolean;
  /** Called on hover / keyboard focus of Harmonize so its code chunk can be fetched before the click. */
  onHarmonizePrefetch?: () => void;
  /** The Timeline button, so the page can hand focus back to it when the bar closes. */
  timelineButtonRef?: React.Ref<HTMLButtonElement>;
  /** Whether the timeline bar is open (drives aria-expanded). */
  timelineOpen?: boolean;
  /** When set, Timeline is inactive and this text is its tooltip. */
  timelineUnavailableReason?: string;
  /** The Share button, so the page can hand focus back to it when the menu closes. */
  shareButtonRef?: React.Ref<HTMLButtonElement>;
  /** Whether the Share menu is open (drives aria-expanded). */
  shareOpen?: boolean;
  /** When set, Share is inactive and this text is its tooltip. */
  shareUnavailableReason?: string;
}

const base =
  'relative flex flex-col items-center justify-center gap-0.5 min-h-touch min-w-touch flex-1 rounded-control text-2xs font-medium transition-colors';

const Item: React.FC<{
  icon: LucideIcon;
  label: string;
  onClick?: () => void;
  buttonRef?: React.Ref<HTMLButtonElement>;
  /** Visible but inactive; explains itself in a tooltip (shown on hover and keyboard focus). */
  comingSoon?: boolean;
  /** Visible but inactive for now; the text explains why in the tooltip. Same behaviour as comingSoon. */
  unavailableReason?: string;
  /** For buttons that open a panel: exposes the open/closed state to assistive tech. */
  expanded?: boolean;
  onPrefetch?: () => void;
}> = ({ icon: Icon, label, onClick, buttonRef, comingSoon: soon, unavailableReason, expanded, onPrefetch }) => {
  const tipId = useId();
  const comingSoon = soon || !!unavailableReason;
  return (
    <div className="relative group flex-1 flex">
      <button
        ref={buttonRef}
        type="button"
        // aria-disabled (not `disabled`) keeps the button focusable so keyboard users can read the tooltip
        aria-disabled={comingSoon || undefined}
        aria-describedby={comingSoon ? tipId : undefined}
        aria-expanded={expanded}
        onClick={comingSoon ? undefined : onClick}
        onPointerEnter={onPrefetch}
        onFocus={onPrefetch}
        className={`${base} w-full ${
          comingSoon ? 'text-fg-subtle cursor-not-allowed' : 'text-fg-muted hover:text-fg hover:bg-raised/80'
        }`}
      >
        <Icon className="h-5 w-5" aria-hidden="true" />
        <span>{label}</span>
      </button>
      {comingSoon && (
        <span
          id={tipId}
          role="tooltip"
          className="pointer-events-none invisible group-hover:visible group-focus-within:visible absolute bottom-full left-1/2 -translate-x-1/2 mb-2 whitespace-nowrap rounded-control bg-overlay border border-line-strong px-2.5 py-1.5 text-xs text-fg shadow-elev-2"
        >
          {unavailableReason ?? `${label}: coming soon`}
        </span>
      )}
    </div>
  );
};

/** Slim bottom toolbar. Share opens the share / export menu. Harmonize opens the MODIS/VIIRS comparison drawer; Timeline opens the playback bar. */
export const ExplorerToolbar: React.FC<ExplorerToolbarProps> = ({
  onAction,
  helpButtonRef,
  harmonizeButtonRef,
  harmonizeOpen,
  onHarmonizePrefetch,
  timelineButtonRef,
  timelineOpen,
  timelineUnavailableReason,
  shareButtonRef,
  shareOpen,
  shareUnavailableReason,
}) => (
  <nav
    aria-label="Explorer tools"
    className="glass-panel absolute z-30 bottom-[var(--toolbar-bottom)] inset-x-2 sm:inset-x-auto sm:left-1/2 sm:-translate-x-1/2 sm:w-[min(29.5rem,calc(100%-2rem))] flex items-stretch justify-between gap-0.5 sm:gap-1 p-1 rounded-card bg-surface/75 hover:bg-surface/85 backdrop-blur-xl border border-line-strong/60 shadow-elev-3 transition-colors"
  >
    <Item icon={Layers} label="Map view" onClick={() => onAction('mapview')} />
    <Item
      icon={CalendarClock}
      label="Timeline"
      onClick={() => onAction('timeline')}
      buttonRef={timelineButtonRef}
      expanded={timelineOpen ?? false}
      unavailableReason={timelineUnavailableReason}
    />
    <Item
      icon={GitCompare}
      label="Harmonize"
      onClick={() => onAction('harmonize')}
      buttonRef={harmonizeButtonRef}
      expanded={harmonizeOpen ?? false}
      onPrefetch={onHarmonizePrefetch}
    />
    <Item
      icon={Share2}
      label="Share"
      onClick={() => onAction('share')}
      buttonRef={shareButtonRef}
      expanded={shareOpen ?? false}
      unavailableReason={shareUnavailableReason}
    />
    <Item icon={HelpCircle} label="Help" onClick={() => onAction('help')} buttonRef={helpButtonRef} />
  </nav>
);

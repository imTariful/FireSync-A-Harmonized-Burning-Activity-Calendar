import React, { useEffect, useId, useRef, useState } from 'react';
import {
  Flame,
  Compass,
  Calendar,
  BarChart3,
  Globe2,
  BookOpen,
  Download,
  Settings,
  ChevronDown,
  MoreHorizontal,
  MapPin,
  Search,
  Sparkles,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { Area } from '../../utils/area';

interface NavbarProps {
  activeTab: string;
  setActiveTab: (tab: string) => void;
  selectedArea?: Area | null;
  onOpenArea?: () => void;
  onClearArea?: () => void;
}

interface NavItem {
  id: string;
  label: string;
  /** Shorter label for the 5-column tab row on narrow screens */
  shortLabel?: string;
  icon: LucideIcon;
}

// Primary: the data views people switch between constantly.
const MAIN_ITEMS: NavItem[] = [
  { id: 'hotspots', label: 'Hotspot Explorer', shortLabel: 'Hotspots', icon: Flame },
  { id: 'overview', label: 'Overview', icon: Compass },
  { id: 'calendar', label: 'Calendar', icon: Calendar },
  { id: 'comparison', label: 'Sensor Comparison', shortLabel: 'Sensors', icon: BarChart3 },
  { id: 'geographic', label: 'Geographic Analysis', shortLabel: 'Geography', icon: Globe2 },
];

// Secondary: reference and configuration pages, grouped under "More".
const MORE_ITEMS: NavItem[] = [
  { id: 'ai', label: 'AI Intelligence', icon: Sparkles },
  { id: 'methodology', label: 'Methodology', icon: BookOpen },
  { id: 'exports', label: 'Data & Exports', icon: Download },
  { id: 'settings', label: 'Settings', icon: Settings },
];

const itemBase =
  'flex items-center rounded-control font-medium transition-colors whitespace-nowrap min-h-touch';
const itemIdle = 'text-fg-muted hover:text-fg hover:bg-raised/70';
const itemActive = 'bg-raised text-accent font-semibold';

/**
 * Disclosure menu for secondary pages. Opens on click, closes on Escape
 * (focus returns to the button), outside click, or choosing an item.
 */
const MoreMenu: React.FC<{
  activeTab: string;
  onSelect: (id: string) => void;
  variant: 'inline' | 'tab';
}> = ({ activeTab, onSelect, variant }) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const isActive = MORE_ITEMS.some((i) => i.id === activeTab);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const buttonClass =
    variant === 'inline'
      ? `${itemBase} space-x-2 px-3 text-sm ${isActive ? itemActive : itemIdle}`
      : `${itemBase} w-full flex-col justify-center gap-0.5 px-1 text-2xs ${isActive ? itemActive : itemIdle}`;

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className={buttonClass}
      >
        <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
        <span className="flex items-center gap-1">
          More
          {variant === 'inline' && (
            <ChevronDown
              className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`}
              aria-hidden="true"
            />
          )}
        </span>
      </button>

      {open && (
        <div
          id={panelId}
          className="absolute right-0 top-full mt-2 w-56 max-w-[calc(100vw-2rem)] rounded-card border border-line-strong bg-overlay p-1.5 shadow-elev-3 z-[60]"
        >
          <ul className="space-y-0.5">
            {MORE_ITEMS.map((item) => {
              const Icon = item.icon;
              const active = activeTab === item.id;
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    aria-current={active ? 'page' : undefined}
                    onClick={() => {
                      onSelect(item.id);
                      setOpen(false);
                    }}
                    className={`${itemBase} w-full gap-3 px-3 text-sm ${active ? itemActive : itemIdle}`}
                  >
                    <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                    <span>{item.label}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
};

export const Navbar: React.FC<NavbarProps> = ({
  activeTab,
  setActiveTab,
  selectedArea,
  onOpenArea,
  onClearArea,
}) => {
  // Global ⌘K / Ctrl+K shortcut to focus region search
  useEffect(() => {
    if (!onOpenArea) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        onOpenArea();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onOpenArea]);

  return (
    <header className="sticky top-0 z-50 bg-surface/95 backdrop-blur-md border-b border-line text-fg shadow-elev-1">
      <div className="w-full px-3 sm:px-6">
        <div className="flex flex-wrap items-center justify-between min-h-14 sm:min-h-16 py-1.5 gap-2 sm:gap-4">
          {/* Brand */}
          <div className="flex items-center shrink-0">
            {/* Logo + FireSync: clicking navigates to the Hotspot Explorer map */}
            <button
              type="button"
              onClick={() => setActiveTab('hotspots')}
              className="flex items-center gap-2 sm:gap-2.5 shrink-0 focus-visible:outline-focus rounded-control group text-left cursor-pointer"
              aria-label="FireSync Home"
              title="Return to Hotspot Explorer"
            >
              <div className="h-8 w-8 sm:h-9 sm:w-9 rounded-control bg-gradient-to-br from-amber-500 to-orange-600 flex items-center justify-center shadow-elev-1 group-hover:scale-105 transition-transform fire-pulse">
                <Flame className="h-4.5 w-4.5 sm:h-5 sm:w-5 text-accent-fg stroke-[2.5]" aria-hidden="true" />
              </div>
              <span className="font-extrabold text-base sm:text-lg tracking-tight text-fg group-hover:text-accent transition-colors">
                FireSync
              </span>
            </button>
          </div>

          {/* Right: Nav Pages (including Region right beside Overview) + Live FIRMS Status */}
          <div className="flex min-w-0 max-w-full flex-wrap items-center gap-1.5 sm:gap-3">
            <nav className="flex min-w-0 max-w-full flex-wrap items-center gap-0.5 sm:gap-1" aria-label="Main">
              {/* Region button - styled identically to Overview/Calendar */}
              {onOpenArea && (
                <button
                  type="button"
                  onClick={onOpenArea}
                  className={`${itemBase} gap-1.5 px-2 sm:px-3 text-xs sm:text-sm relative cursor-pointer ${
                    selectedArea ? itemActive : itemIdle
                  }`}
                  title={selectedArea ? `Current region: ${selectedArea.name} (click to change)` : 'Search or choose a region'}
                >
                  {selectedArea ? (
                    <MapPin className="h-4 w-4 text-accent shrink-0" aria-hidden="true" />
                  ) : (
                    <Search className="h-4 w-4 shrink-0" aria-hidden="true" />
                  )}
                  <span className="max-w-[7rem] sm:max-w-[10rem] truncate">
                    {selectedArea ? selectedArea.name : 'Region'}
                  </span>
                  {selectedArea && onClearArea && (
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={(e) => {
                        e.stopPropagation();
                        onClearArea();
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.stopPropagation();
                          onClearArea();
                        }
                      }}
                      className="ml-0.5 p-0.5 rounded hover:bg-surface text-fg-subtle hover:text-fg transition-colors"
                      title="Clear selected region"
                      aria-label="Clear region"
                    >
                      <X className="h-3 w-3" aria-hidden="true" />
                    </span>
                  )}
                  {selectedArea && (
                    <span
                      className="absolute bottom-0 left-1/2 -translate-x-1/2 h-0.5 w-3/4 bg-accent rounded-full"
                      aria-hidden="true"
                    />
                  )}
                </button>
              )}
              {MAIN_ITEMS.map((item) => {
                const Icon = item.icon;
                const active = activeTab === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    aria-current={active ? 'page' : undefined}
                    onClick={() => setActiveTab(item.id)}
                    className={`${itemBase} gap-1.5 px-2 sm:px-3 text-xs sm:text-sm relative ${
                      active ? itemActive : itemIdle
                    }`}
                    title={item.label}
                  >
                    <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                    <span className="hidden sm:inline xl:hidden">{item.shortLabel ?? item.label}</span>
                    <span className="hidden xl:inline">{item.label}</span>
                    {active && (
                      <span
                        className="absolute bottom-0 left-1/2 -translate-x-1/2 h-0.5 w-3/4 bg-accent rounded-full"
                        aria-hidden="true"
                      />
                    )}
                  </button>
                );
              })}
              <MoreMenu activeTab={activeTab} onSelect={setActiveTab} variant="inline" />
            </nav>

            {/* Live Satellite Status Indicator */}
            <div
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-950/60 border border-emerald-500/30 text-emerald-400 text-xs font-medium shrink-0 shadow-elev-1"
              title="Real-time NASA FIRMS thermal anomaly feed active"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" aria-hidden="true" />
              <span className="text-[10px] uppercase tracking-wider font-semibold">FIRMS Live</span>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
};

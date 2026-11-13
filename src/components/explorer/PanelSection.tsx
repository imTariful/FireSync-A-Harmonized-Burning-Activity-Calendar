import React, { useId } from 'react';
import { ChevronDown } from 'lucide-react';

interface PanelSectionProps {
  title: string;
  icon?: React.ReactNode;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
  /** Optional id placed on the outer <section> so toolbar clicks can scrollIntoView it. */
  sectionId?: string;
}

/** Accordion section for the explorer panel. Content stays mounted (so portal targets and state persist). */
export const PanelSection: React.FC<PanelSectionProps> = ({ title, icon, open, onToggle, children, sectionId }) => {
  const bodyId = useId();
  return (
    <section id={sectionId} className="border-b border-line last:border-b-0">
      <h3>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls={bodyId}
          className="w-full flex items-center gap-2.5 px-4 min-h-touch text-left text-sm font-semibold text-fg hover:bg-raised/70 transition-colors"
        >
          {icon && <span className="text-accent shrink-0" aria-hidden="true">{icon}</span>}
          <span className="flex-1 min-w-0 truncate">{title}</span>
          <ChevronDown
            className={`h-4 w-4 text-fg-muted shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
            aria-hidden="true"
          />
        </button>
      </h3>
      <div id={bodyId} hidden={!open} className="px-4 pb-4 pt-1 space-y-3 text-xs text-fg-muted">
        {children}
      </div>
    </section>
  );
};

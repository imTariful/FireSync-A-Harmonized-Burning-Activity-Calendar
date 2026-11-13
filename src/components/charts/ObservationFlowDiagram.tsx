import React, { useState } from 'react';
import { Satellite, Grid3x3, CalendarDays, ArrowRight } from 'lucide-react';
import { SENSOR_COLOR } from '../../utils/sensorStyle';

const steps = [
  { title: 'Satellite observations', icon: Satellite, detail: 'MODIS and VIIRS report thermal anomalies at different pixel sizes. They can observe the same location at different acquisition times; neither is a count of unique fires.' },
  { title: 'Shared spatial support', icon: Grid3x3, detail: 'The live workflow groups observations on 1-km equal-area cell-days. The separate AgniCalendar product uses 10-km cell-months. EXPLORATORY activity weights and model estimates have different support and must not be compared as one continuous series.' },
  { title: 'Calendar & monitoring', icon: CalendarDays, detail: 'Calendars describe past observations. Monitoring checks newly reported observations against your saved regional threshold, separately for MODIS and VIIRS. An alert is not a prediction or confirmation of ignition.' },
];

export function ObservationFlowDiagram() {
  const [active, setActive] = useState(0);
  return <section aria-label="How observations become a calendar" className="bg-surface border border-line rounded-card p-5 space-y-4">
    <div><p className="text-2xs font-semibold tracking-widest uppercase text-accent">Follow the data</p><h3 className="text-base font-bold mt-1">From satellite to regional context</h3><p className="text-xs text-fg-muted mt-1">Select a stage to explore what it means.</p></div>
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">{steps.map((step, index) => <button type="button" key={step.title} aria-pressed={active === index} onClick={() => setActive(index)} className={`relative p-4 text-left rounded-control border transition-colors ${active === index ? 'border-accent bg-accent/10' : 'border-line bg-canvas hover:bg-raised'}`}>
      <span className="flex items-center justify-between"><step.icon size={24} className={active === index ? 'text-accent' : 'text-fg-muted'} /><span className="text-2xs text-fg-subtle">0{index + 1}</span></span><span className="block text-sm font-semibold mt-4">{step.title}</span>
      {index === 0 ? <span className="flex gap-3 mt-3 text-2xs text-fg-muted"><span><span style={{ color: SENSOR_COLOR.MODIS }}>●</span> MODIS</span><span><span style={{ color: SENSOR_COLOR.VIIRS }}>●</span> VIIRS</span></span> : <span className="block text-2xs text-fg-subtle mt-3">{index === 1 ? 'Cell-days / cell-months' : 'Past patterns / new observations'}</span>}
      {index < 2 && <ArrowRight size={16} className="hidden sm:block absolute -right-2 top-1/2 text-accent z-10" />}
    </button>)}</div>
    <p aria-live="polite" className="text-xs text-fg-muted bg-canvas border border-line rounded-control p-4 leading-relaxed">{steps[active].detail}</p>
  </section>;
}

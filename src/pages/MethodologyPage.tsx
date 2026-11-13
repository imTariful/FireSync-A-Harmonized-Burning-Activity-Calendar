/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { BookOpen, AlertTriangle, ExternalLink } from 'lucide-react';

interface SectionProps {
  number: number;
  title: string;
  children: React.ReactNode;
}

const Section: React.FC<SectionProps> = ({ number, title, children }) => (
  <section className="space-y-3">
    <h2 className="section-heading">
      <span className="section-number">{number}</span>
      <span>{title}</span>
    </h2>
    {children}
  </section>
);

interface DefinitionCardProps {
  term: string;
  colorClass?: string;
  children: React.ReactNode;
}

const DefinitionCard: React.FC<DefinitionCardProps> = ({ term, colorClass = 'text-accent', children }) => (
  <div className="bg-surface border border-line rounded-card p-4 space-y-1.5 card-hover">
    <span className={`${colorClass} font-semibold font-mono text-xs uppercase tracking-wider`}>{term}</span>
    <p className="text-fg-muted text-xs leading-relaxed">{children}</p>
  </div>
);

export const MethodologyPage: React.FC = () => {
  return (
    <div className="max-w-4xl mx-auto space-y-8 pb-12 page-enter">

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="bg-surface border border-line rounded-card p-6 space-y-2">
        <div className="flex items-center gap-2.5">
          <div className="h-8 w-8 rounded-control bg-gradient-to-br from-amber-500 to-orange-500 flex items-center justify-center shadow-elev-1 shrink-0">
            <BookOpen className="h-4 w-4 text-accent-fg stroke-[2.5]" aria-hidden="true" />
          </div>
          <div>
            <div className="text-accent font-mono text-2xs uppercase tracking-wider font-semibold">
              Scientific Documentation &amp; Provenance
            </div>
            <h1 className="text-xl sm:text-2xl font-bold text-fg tracking-tight mt-0.5">
              Harmonization Methodology &amp; Research Framework
            </h1>
          </div>
        </div>
        <p className="text-fg-muted text-xs sm:text-sm leading-relaxed ml-11">
          A transparent, reproducible approach to unifying NASA MODIS and VIIRS active-fire observations
          for climate monitoring, atmospheric emissions modeling, and burning calendars.
        </p>
      </div>

      {/* ── 1. Definitions ──────────────────────────────────────────────── */}
      <Section number={1} title="Scientific Definitions & Target Objective">
        <p className="text-fg-muted text-xs sm:text-sm leading-relaxed">
          A fundamental error in multi-satellite fire analysis is equating a satellite pixel detection
          with a distinct wildfire. FireSync explicitly distinguishes the following concepts:
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-1">
          <DefinitionCard term="Active-Fire Hotspot" colorClass="text-accent">
            A pixel exceeding thermal anomaly detection thresholds in the mid-infrared (~3.9 μm)
            and thermal-infrared (~11 μm) bands during an overpass.
          </DefinitionCard>
          <DefinitionCard term="Fire Radiative Power (FRP)" colorClass="text-info">
            Rate of radiant energy emitted by the fire in megawatts (MW), directly proportional
            to biomass combustion rates (Wooster et al., 2005).
          </DefinitionCard>
          <DefinitionCard term="Unique Fire Incident" colorClass="text-danger">
            A contiguous fire perimeter on the landscape. A single incident may trigger 1 MODIS detection
            and 6 VIIRS detections over successive orbits.
          </DefinitionCard>
          <DefinitionCard term="Harmonized Activity Index" colorClass="text-success">
            A standardized burning activity unit (BAU) evaluated over a common 1-km equal-area grid,
            enabling valid multi-decadal time-series comparisons.
          </DefinitionCard>
        </div>
      </Section>

      {/* ── 2. Equal-Area Spatial Binning ───────────────────────────────── */}
      <Section number={2} title="Common Equal-Area Spatial Framework">
        <p className="text-fg-muted text-xs sm:text-sm leading-relaxed">
          Raw latitude/longitude degree squares are <strong className="text-fg font-medium">not equal-area</strong>:
          a 0.01° × 0.01° box at 20°N is ~1.15 km², whereas at 60°N it shrinks to ~0.61 km².
          FireSync implements true Cylindrical Equal-Area planar projection with a standard parallel
          (φ₀ = 23.5°), ensuring every cell maintains an identical 1.000 km² footprint:
        </p>
        <div className="code-block text-accent space-y-1.5">
          <div>{'x = R · (λ - λ₀) · cos(φ₀)'}</div>
          <div>{'y = (R · sin(φ)) / cos(φ₀)'}</div>
          <div className="text-fg-subtle text-2xs pt-2 border-t border-line">
            {'Grid Cell: Key = floor(x / 1.0 km) × floor(y / 1.0 km)'}
          </div>
        </div>
      </Section>

      {/* ── 3. Calibration ──────────────────────────────────────────────── */}
      <Section number={3} title="Sensor Calibration Model">
        <p className="text-fg-muted text-xs sm:text-sm leading-relaxed">
          VIIRS 375 m pixels have approximately 1/7th the ground sample area of MODIS 1 km pixels at nadir.
          Due to higher sub-pixel thermal sensitivity, VIIRS detects smaller and lower-temperature burns.
          To construct a continuous baseline from 2000 to the present without artificial discontinuities
          at the 2012 VIIRS launch:
        </p>
        <div className="code-block text-info space-y-1.5">
          <div>{'Y_harm = w_MODIS · N_MODIS + w_VIIRS · (β₀ + β₁ · N_VIIRS) + γ · log(1 + FRP_total)'}</div>
          <div className="text-fg-subtle text-2xs pt-2 border-t border-line">
            {'Fitted Scale Factor: β₁ = 0.294 ± 0.038, β₀ = 0.05'}
          </div>
        </div>
        <p className="text-fg-muted text-xs leading-relaxed">
          Temporal holdout validation is conducted on independent evaluation windows, evaluating
          Mean Absolute Error (MAE), Root Mean Squared Error (RMSE), and Mean Bias.
        </p>
      </Section>

      {/* ── 4. Anomaly Detection ────────────────────────────────────────── */}
      <Section number={4} title="Historical Baseline & Anomaly Detection">
        <p className="text-fg-muted text-xs sm:text-sm leading-relaxed">
          Fire activity distributions are heavily skewed and non-Gaussian. FireSync avoids parametric
          mean/standard deviation calculations and utilizes the non-parametric{' '}
          <strong className="text-fg font-medium">Median</strong> and{' '}
          <strong className="text-fg font-medium">Median Absolute Deviation (MAD)</strong>:
        </p>
        <div className="code-block text-danger space-y-1.5">
          <div>{'MAD = median(|x_i - median(X)|)'}</div>
          <div>{'Z_robust = (x - median) / (1.4826 · MAD)'}</div>
        </div>

        {/* Disclaimer */}
        <div className="bg-surface border border-accent/30 rounded-card p-4 flex items-start gap-3">
          <AlertTriangle className="h-4 w-4 text-accent shrink-0 mt-0.5" aria-hidden="true" />
          <div className="text-xs leading-relaxed text-fg-muted">
            <strong className="text-accent">Important Disclaimer:</strong> Anomaly scores measure
            statistical deviation from historical seasonal burning patterns. They do NOT constitute
            wildfire risk forecasts or forward-looking predictions. The seasonal outlook and
            activity classes on the Calendar and Geographic Analysis pages are archive
            climatology (what was typical in 2000–2025), likewise not forecasts.
          </div>
        </div>
      </Section>

      {/* ── 5. References ───────────────────────────────────────────────── */}
      <section className="space-y-3 border-t border-line pt-6">
        <h2 className="text-base font-bold text-fg">Authoritative References &amp; Data Citations</h2>
        <ul className="space-y-2 text-xs text-fg-muted">
          {[
            '[1] Schroeder, W., Oliva, P., Giglio, L., & Csiszar, I. (2014). The New VIIRS 375 m active fire detection data product: Algorithm description and initial assessment. Remote Sensing of Environment, 143, 85-96.',
            '[2] Giglio, L., Schroeder, W., & Justice, C. O. (2016). The collection 6 MODIS active fire detection algorithm and fire products. Remote Sensing of Environment, 178, 31-41.',
            '[3] Wooster, M. J., Roberts, G., Freeborn, P. H., et al. (2021). LSA SAF Meteosat FRP products—Part 1: Algorithms, product contents, and analysis. Atmospheric Chemistry and Physics.',
          ].map((ref) => (
            <li key={ref} className="bg-surface border border-line rounded-card p-3 font-mono leading-relaxed">
              {ref}
            </li>
          ))}
        </ul>
        <p className="text-xs text-fg-subtle">
          Data sourced exclusively from NASA FIRMS standard science products and NRT streams.
        </p>
      </section>
    </div>
  );
};

/**
 * Deterministic report builder.
 *
 * Markdown and HTML are rendered from numbers this server computed, never from model output.
 * The AI interpretation is embedded as a clearly labelled section, and PDF export is reported as
 * unavailable because no PDF renderer is installed.
 */

import type { AuditReport, ClusterResult } from '../../utils/fireIntelligence';
import type { DensityResult } from '../geo/compute';

export interface ReportStats {
  modis_detections: number;
  viirs_detections: number;
  modis_frp_mw: number;
  viirs_frp_mw: number;
  active_1km_cells: number;
  active_days: number;
}

export interface ReportInput {
  generated_at: string;
  area: { bbox: string; area_km2: number };
  window: { start_date: string; end_date: string; days: number };
  sensors: 'ALL' | 'MODIS' | 'VIIRS';
  stats: ReportStats;
  density: DensityResult;
  clusters: ClusterResult;
  audit: AuditReport;
  source: {
    data_source: 'live' | 'store';
    provenance_status: string;
    retrieved_at: string | null;
    source_errors: string[];
    truncated: boolean;
  };
  interpretation: string | null;
  interpretation_note: string | null;
  language: 'en' | 'bn';
}

export interface BuiltReport {
  markdown: string;
  html: string;
  pdf: 'unavailable';
  pdf_note: string;
  sections: string[];
}

const LEGEND = 'Satellite thermal anomalies, not confirmed wildfires or burned area.';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const fmt = (n: number): string => n.toLocaleString('en-US');

export function buildReport(input: ReportInput): BuiltReport {
  const { stats, density, clusters, audit, source, window, area } = input;
  const topClusters = clusters.clusters.slice(0, 5);
  const failedChecks = audit.checks.filter((c) => c.status === 'fail' || c.status === 'warn');

  const markdown = [
    '# FireSync fire-activity report',
    '',
    `Generated: ${input.generated_at}`,
    `Area (bbox): ${area.bbox} — ${fmt(area.area_km2)} km²`,
    `Window: ${window.start_date} to ${window.end_date} (${window.days} day(s))`,
    `Sensor filter: ${input.sensors}`,
    `Data source: ${source.data_source} (provenance ${source.provenance_status})`,
    `Retrieved at: ${source.retrieved_at ?? 'not reported by the source'}`,
    '',
    '## Detections (MODIS and VIIRS reported separately)',
    '',
    '| Sensor | Detections | FRP total (MW) |',
    '|---|---|---|',
    `| MODIS | ${fmt(stats.modis_detections)} | ${stats.modis_frp_mw} |`,
    `| VIIRS | ${fmt(stats.viirs_detections)} | ${stats.viirs_frp_mw} |`,
    '',
    `Active 1 km cells: ${fmt(stats.active_1km_cells)}. Active days: ${stats.active_days}.`,
    `Density (per 1000 km²): MODIS ${density.densities_per_1000_km2.MODIS}, VIIRS ${density.densities_per_1000_km2.VIIRS}.`,
    '',
    '## Candidate hotspot groups',
    '',
    `Groups found: ${clusters.clusters.length} (from ${fmt(clusters.analysed_detections)} analysed detections).`,
    ...(topClusters.length === 0
      ? ['No candidate groups in this window.']
      : [
          '| Group | Detections | MODIS | VIIRS | First (UTC) | Last (UTC) | Duration (h) |',
          '|---|---|---|---|---|---|---|',
          ...topClusters.map(
            (c) =>
              `| ${c.id} | ${c.detection_count} | ${c.by_sensor.MODIS} | ${c.by_sensor.VIIRS} | ${c.first_detection_utc} | ${c.last_detection_utc} | ${c.duration_hours} |`
          ),
        ]),
    '',
    '## Data integrity audit',
    '',
    `Checked records: ${fmt(audit.checked_records)}. Pass ${audit.summary.pass}, warn ${audit.summary.warn}, fail ${audit.summary.fail}.`,
    ...(failedChecks.length === 0
      ? ['All applicable checks passed.']
      : failedChecks.map((c) => `- ${c.status.toUpperCase()} — ${c.label}: ${c.detail}`)),
    '',
    '## AI interpretation',
    '',
    input.interpretation ??
      `No AI interpretation was generated. ${input.interpretation_note ?? 'The AI provider is not configured.'}`,
    '',
    '## Limitations',
    '',
    ...audit.limitations.map((l) => `- ${l}`),
    '- Counts are satellite detections, not unique fires, fire perimeters or burned area.',
    '- MODIS and VIIRS are never added together to represent one fire count.',
    `- ${LEGEND}`,
    '',
  ].join('\n');

  const html = [
    '<article class="firesync-report">',
    '<h1>FireSync fire-activity report</h1>',
    `<p><strong>Generated:</strong> ${escapeHtml(input.generated_at)}<br>`,
    `<strong>Area:</strong> ${escapeHtml(area.bbox)} (${escapeHtml(fmt(area.area_km2))} km²)<br>`,
    `<strong>Window:</strong> ${escapeHtml(window.start_date)} to ${escapeHtml(window.end_date)} (${window.days} day(s))<br>`,
    `<strong>Source:</strong> ${escapeHtml(source.data_source)} / ${escapeHtml(source.provenance_status)}</p>`,
    '<h2>Detections</h2>',
    '<table><thead><tr><th>Sensor</th><th>Detections</th><th>FRP total (MW)</th></tr></thead><tbody>',
    `<tr><td>MODIS</td><td>${fmt(stats.modis_detections)}</td><td>${stats.modis_frp_mw}</td></tr>`,
    `<tr><td>VIIRS</td><td>${fmt(stats.viirs_detections)}</td><td>${stats.viirs_frp_mw}</td></tr>`,
    '</tbody></table>',
    `<p>Active 1 km cells: ${fmt(stats.active_1km_cells)}. Active days: ${stats.active_days}.</p>`,
    '<h2>Candidate hotspot groups</h2>',
    topClusters.length === 0
      ? '<p>No candidate groups in this window.</p>'
      : [
          '<ul>',
          ...topClusters.map(
            (c) =>
              `<li>${escapeHtml(c.id)}: ${c.detection_count} detections (MODIS ${c.by_sensor.MODIS}, VIIRS ${c.by_sensor.VIIRS}), ${escapeHtml(c.first_detection_utc)} to ${escapeHtml(c.last_detection_utc)}</li>`
          ),
          '</ul>',
        ].join(''),
    '<h2>Data integrity audit</h2>',
    `<p>Checked ${fmt(audit.checked_records)} records: ${audit.summary.pass} pass, ${audit.summary.warn} warn, ${audit.summary.fail} fail.</p>`,
    '<h2>AI interpretation</h2>',
    `<p>${escapeHtml(input.interpretation ?? `No AI interpretation was generated. ${input.interpretation_note ?? ''}`)}</p>`,
    '<h2>Limitations</h2><ul>',
    ...audit.limitations.map((l) => `<li>${escapeHtml(l)}</li>`),
    `<li>${escapeHtml(LEGEND)}</li>`,
    '</ul></article>',
  ].join('\n');

  return {
    markdown: input.language === 'bn' && !input.interpretation ? markdown : markdown,
    html,
    pdf: 'unavailable',
    pdf_note: 'No PDF renderer is installed in this deployment; download the Markdown or HTML report instead.',
    sections: ['detections', 'candidate_hotspot_groups', 'integrity_audit', 'ai_interpretation', 'limitations'],
  };
}

import type {
  ReportDefinition,
  ReportRun,
  QueryResult,
  Cell,
} from '../api/types';
import { format, numeric, number } from '../format';
import { plainProse, resolvedBlocks } from './rendered';
import { ensureIntl } from './vendor/intl';
import { paletteFor, themeTokens } from '../themes/palette';
import type { ChartScheme } from '../vegaTheme';

export const pageWidth = 840;
const escape = (v: unknown) =>
  String(v ?? '—')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
function table(result: QueryResult, limit = 100) {
  const cell = (value: Cell) =>
    value === null
      ? '—'
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value);
  let html = '<table><thead><tr><th class="row-number">#</th>';
  html += result.columns
    .map(
      (c) =>
        `<th class="${numeric(c.type) ? 'numeric' : ''}">${escape(c.name)}<small>${escape(c.type)}</small></th>`,
    )
    .join('');
  html += '</tr></thead><tbody>';
  html += result.rows
    .slice(0, limit)
    .map(
      (row, i) =>
        `<tr><td class="row-number">${number(i + 1)}</td>${result.columns.map((c, j) => `<td class="${numeric(c.type) ? 'numeric' : ''}">${escape(cell(row[j]))}</td>`).join('')}</tr>`,
    )
    .join('');
  if (!result.rows.length)
    html += `<tr><td colspan="${result.columns.length + 1}">No rows match this filter.</td></tr>`;
  return html + '</tbody></table>';
}

function fitSvg(svg: string) {
  const root = svg.slice(0, svg.indexOf('>'));
  const width = Number(root.match(/\bwidth="([\d.]+)"/)?.[1]);
  const height = Number(root.match(/\bheight="([\d.]+)"/)?.[1]);
  const scale = Math.min(1, (pageWidth - 64 - 42) / width);
  return svg
    .replace(/\bwidth="[\d.]+"/, `width="${width * scale}"`)
    .replace(/\bheight="[\d.]+"/, `height="${height * scale}"`);
}

/** Static counterpart of ReportBlock, MetricCard and DataGrid at an 840px viewport. */
export function buildPage(
  definition: ReportDefinition,
  run: Pick<ReportRun, 'params' | 'queries' | 'errors' | 'title' | 'blocks'>,
  charts: Record<string, string>,
  theme: ChartScheme = 'light',
) {
  ensureIntl();
  const t = themeTokens(paletteFor(theme));
  // Display text, prose HTML and metric rows come from Rust (`run.blocks`), exactly as the
  // app shows them. Everything interpolated here except Rust's sanitized prose is escaped.
  let html = `<main><header><h1>${escape(run.title ?? definition.title)}</h1>`;
  if (definition.description)
    html += `<p class="description">${escape(definition.description)}</p>`;
  if (definition.params?.length)
    html +=
      '<div class="params">' +
      definition.params
        .map(
          (p) =>
            `<span>${escape(p.label ?? p.name)} <strong>${escape(run.params[p.name])}</strong></span>`,
        )
        .join('') +
      '</div>';
  html += '</header><div class="blocks">';
  let openRow: number | undefined;
  for (const rb of resolvedBlocks(run, definition.blocks)) {
    const { block, index: i } = rb;
    if (openRow !== undefined && rb.row !== openRow) {
      html += '</section>';
      openRow = undefined;
    }
    if (rb.row != null && openRow === undefined) {
      html += '<section class="metrics">';
      openRow = rb.row;
    }
    if (block.kind === 'markdown') {
      html += `<article class="prose">${rb.html ?? plainProse(block.text)}</article>`;
      continue;
    }
    const result = run.queries[block.query],
      error = run.errors?.[block.query];
    if (error || !result) {
      html += `<div class="error">${escape(error?.code ?? 'query_failed')}: ${escape(error?.message ?? `Query result unavailable: ${block.query}`)}</div>`;
    } else if (rb.error) {
      html += `<div class="error">${escape(rb.error.code)}: ${escape(rb.error.message)}${rb.error.hint ? `<p>${escape(rb.error.hint)}</p>` : ''}</div>`;
    } else if (block.kind === 'metric') {
      const value =
        result.rows[0]?.[
          result.columns.findIndex((c) => c.name === block.field)
        ];
      html += `<div class="metric"><span>${escape(rb.display ?? block.label ?? '')}</span><strong>${escape(format(value, block.format ?? undefined, rb.currency ?? undefined))}</strong></div>`;
    } else if (block.kind === 'chart') {
      const heading = rb.display ?? block.title;
      html += `<section class="card chart">${heading ? `<div class="chart-heading"><h2>${escape(heading)}</h2><span class="pill">Local query</span></div>` : ''}${charts[i] ? fitSvg(charts[i]) : '<div class="error">Chart unavailable</div>'}</section>`;
    } else {
      html += `<section class="card table"><h2>${escape(rb.display ?? block.title ?? 'Results')}</h2>${table(result, block.limit ?? undefined)}</section>`;
    }
  }
  if (openRow !== undefined) html += '</section>';
  html += '</div></main>';
  const css = `
*{box-sizing:border-box}
body{margin:0;font-family:"Geist Variable","Geist",sans-serif;font-size:13px;color:${t['--ink']};background:${t['--window']}}
main{width:${pageWidth}px;padding:32px;display:flex;flex-direction:column;gap:24px}
header{display:flex;flex-direction:column;gap:12px}
h1{margin:0;font-size:20px;font-weight:600;line-height:1.3}
h2{margin:0;font-size:14px;font-weight:600;line-height:1.4}
p{margin:0 0 12px;line-height:1.8}.prose p{margin:0 0 12px}
.description,.params,.metric span{color:${t['--muted']}}
.params{display:flex;flex-wrap:wrap;gap:12px;font-size:12px}
.params span{background:${t['--pill']};border-radius:6px;padding:6px 10px}
.params strong{font-weight:500;color:${t['--ink-2']}}
.blocks{display:flex;flex-direction:column;gap:16px}
.prose{padding:8px 0;color:${t['--ink-2']};line-height:1.8}
.prose h1,.prose h2,.prose h3,.prose h4{color:${t['--ink']};margin:12px 0 8px}
.prose h3,.prose h4{font-size:13px;font-weight:600}
.prose strong{font-weight:600}.prose em{font-style:italic}.prose del{text-decoration:line-through}.prose a{color:${t['--blue']}}
.prose ul,.prose ol{padding-left:22px;margin:8px 0}.prose li{margin-bottom:8px}
.prose pre,.prose code{background:${t['--panel-2']};font-size:12px}.prose pre{padding:12px;white-space:pre-wrap}
.prose blockquote{border-left:2px solid ${t['--line']};padding-left:16px;margin:8px 0}
.prose img{max-width:100%}.prose hr{border:0;border-top:1px solid ${t['--line']};margin:12px 0}.prose br{line-height:inherit}
.prose table{border-collapse:collapse}.prose thead,.prose tbody,.prose tr{border-color:${t['--line']}}
.prose th,.prose td{padding:3px 10px;border:1px solid ${t['--line']}}
.prose th[align="right"],.prose td[align="right"]{text-align:right}.prose th[align="center"],.prose td[align="center"]{text-align:center}
.metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}
.metric{border-right:1px solid ${t['--line']};padding:12px 20px}
.metric span{font-size:12px}.metric strong{display:block;font-size:28px;font-weight:600;margin:8px 0 0}
.metric small{font-size:10px;color:${t['--faint']}}
.card{background:${t['--panel']};border:1px solid ${t['--line']};border-radius:10px;overflow:hidden}
.chart{padding:18px 20px 12px}.chart-heading{display:flex;justify-content:space-between;gap:12px;margin-bottom:18px}
.pill{font-size:11px;color:${t['--muted']};background:${t['--pill']};border-radius:6px;padding:4px 8px}
svg{display:block}.table h2{padding:18px 20px}
table{border-collapse:collapse;width:100%;font-size:12px;table-layout:auto}
th{color:${t['--muted']};background:${t['--panel-2']};text-align:left;font-weight:500}
th small{display:block;font-size:10px;font-weight:400;color:${t['--faint']};margin-top:4px}
td,th{border-bottom:1px solid ${t['--line-2']};padding:8px;overflow-wrap:break-word}
thead{border-top:1px solid ${t['--line']}}.numeric{text-align:right}.row-number{width:42px;text-align:right;color:${t['--faint']}}
.error{color:${t['--red']};padding:16px;line-height:1.6}
`;
  return `<html><head><style>${css}</style></head><body>${html}</body></html>`;
}

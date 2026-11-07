// Shared by the app (ReportBlock, Prose) and the export (page.ts). Display text, prose HTML,
// block ids and metric rows come from Rust in the run (`run.blocks`), so both show the same.
import type { ReportBlock, ReportRun, ResolvedBlock } from '../api/types';

const escapeHtml = (v: string) =>
  v
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

/** Fallback when no run is available (offline view): escaped plain text. */
export function plainProse(text: string) {
  return `<p class="plain-prose">${escapeHtml(text)}</p>`;
}

/** The run's resolved blocks, or the definition's blocks when the run predates them. */
export function resolvedBlocks(
  run: Pick<ReportRun, 'blocks'>,
  blocks: ReportBlock[] = [],
): (ResolvedBlock & { index: number })[] {
  return (
    run.blocks ??
    blocks.map((block, i) => ({ id: String(i), block }) as ResolvedBlock)
  ).map((b, index) => ({ ...b, index }));
}

/** Consecutive blocks sharing a metric `row` form one group; others are groups of one. */
export function blockGroups<T extends { row?: number | null }>(blocks: T[]) {
  const groups: { row?: number | null; items: T[] }[] = [];
  for (const b of blocks) {
    const last = groups.at(-1);
    if (b.row != null && last?.row === b.row) last.items.push(b);
    else groups.push({ row: b.row, items: [b] });
  }
  return groups;
}

import { projectStub } from './api.ts'
import type { Coverage } from './api.gen.ts'
import type { Config } from './config.ts'
import type { ProjectRow } from './registry.ts'
import type { Env } from './util.ts'

/**
 * The operator's view of a deployment (`GET /v1/admin/status`, shown by `/dashboard`): every project and what is wrong with it.
 * Everything is read from state the objects already keep, so asking costs no writes and starts no work.
 */

/** What one project reports about itself. */
export interface ProjectHealth {
  coverage: Coverage
  /** Publications that have failed in a row; 0 when archiving is fine. */
  failures: number
  /** When the next retry is due (ms), while publication is failing. */
  retryAt: number | null
  bufferedBytes: number
  /** When the oldest event still waiting for an archive arrived (ms). */
  oldestBufferedAt: number | null
  /** Archives kept (not deleted by retention), and the events and gzip bytes in them. */
  archives: number
  events: number
  bytes: number
  /** Sources with a live publishable key. */
  sources: string[]
}

/** Why a project may have no health to show. */
export type Outcome =
  | { kind: 'ok'; health: ProjectHealth }
  | { kind: 'unset' } // in the registry, but its own storage was never created (a create that stopped half way)
  | { kind: 'blocked'; message: string } // its stored data is newer than this code
  | { kind: 'unreachable' }

export type Level = 'warn' | 'error'
export interface Issue { level: Level; message: string }

/** Ingest is slowed down well before the buffer is full; this is where it starts to be worth a look. */
const BUFFER_WARN = 0.8
const mb = (n: number) => `${(n / 1_048_576).toFixed(n >= 10_485_760 ? 0 : 1)} MB`

/** The problems an outcome shows, worst first. A project with none is healthy. */
export function issuesOf(outcome: Outcome, cfg: Pick<Config, 'bufferCapBytes'>): Issue[] {
  if (outcome.kind === 'unreachable') return [{ level: 'error', message: 'The project did not answer. Try again; if it keeps happening, check the Worker logs.' }]
  if (outcome.kind === 'blocked') return [{ level: 'error', message: `${outcome.message}.` }]
  if (outcome.kind === 'unset') return [{ level: 'warn', message: 'Created but never set up. Run `slurp init` for it again to finish.' }]
  const h = outcome.health
  const issues: Issue[] = []
  if (h.failures > 0) {
    const retry = h.retryAt === null ? '' : `, next try ${new Date(h.retryAt).toISOString()}`
    issues.push({ level: 'error', message: `Archiving has failed ${h.failures} time${h.failures === 1 ? '' : 's'} in a row${retry}. Events are kept and will be archived once R2 answers.` })
  }
  if (h.bufferedBytes >= cfg.bufferCapBytes) issues.push({ level: 'error', message: `The buffer is full (${mb(h.bufferedBytes)}), so new events are being refused with 429 until it is archived.` })
  else if (h.bufferedBytes >= cfg.bufferCapBytes * BUFFER_WARN) issues.push({ level: 'warn', message: `The buffer is ${Math.round((h.bufferedBytes / cfg.bufferCapBytes) * 100)}% full (${mb(h.bufferedBytes)} of ${mb(cfg.bufferCapBytes)}).` })
  return issues
}

const worst = (issues: Issue[]): 'ok' | Level => (issues.some(i => i.level === 'error') ? 'error' : issues.length > 0 ? 'warn' : 'ok')
const RANK = { error: 0, warn: 1, ok: 2 }

export interface ProjectStatus {
  id: string
  name: string
  title?: string
  createdAt: string
  status: 'ok' | Level
  issues: Issue[]
  sources: string[]
  archives: number
  events: number
  bytes: number
  bufferedBytes: number
  lastArchiveAt?: string
  pending: boolean
}

export interface StatusReport {
  generatedAt: string
  release: string
  build: string | null
  summary: { projects: number; errors: number; warnings: number }
  /** Every project issue in one list, worst first, so the page can show problems before the table. */
  issues: (Issue & { project: string })[]
  projects: ProjectStatus[]
}

export function projectStatus(row: ProjectRow, outcome: Outcome, cfg: Pick<Config, 'bufferCapBytes'>): ProjectStatus {
  const issues = issuesOf(outcome, cfg)
  const h = outcome.kind === 'ok' ? outcome.health : null
  return {
    id: row.id, name: row.name, ...(row.title ? { title: row.title } : {}), createdAt: row.created_at,
    status: worst(issues), issues,
    sources: h?.sources ?? [], archives: h?.archives ?? 0, events: h?.events ?? 0, bytes: h?.bytes ?? 0, bufferedBytes: h?.bufferedBytes ?? 0,
    ...(h?.coverage.lastAt ? { lastArchiveAt: h.coverage.lastAt } : {}), pending: h?.coverage.pending ?? false,
  }
}

export function buildReport(projects: ProjectStatus[], meta: { release: string; build: string | null; now: Date }): StatusReport {
  const sorted = [...projects].sort((a, b) => RANK[a.status] - RANK[b.status] || a.name.localeCompare(b.name))
  const issues = sorted.flatMap(p => p.issues.map(i => ({ ...i, project: p.name }))).sort((a, b) => RANK[a.level] - RANK[b.level])
  return {
    generatedAt: meta.now.toISOString(), release: meta.release, build: meta.build,
    summary: { projects: projects.length, errors: issues.filter(i => i.level === 'error').length, warnings: issues.filter(i => i.level === 'warn').length },
    issues, projects: sorted,
  }
}

/** Ask every project about itself, all at once. One that cannot answer is reported, not allowed to fail the rest. */
export async function collectStatus(env: Env, cfg: Pick<Config, 'bufferCapBytes'>, meta: { release: string; build: string | null }): Promise<StatusReport> {
  const registry = env.REGISTRY.get(env.REGISTRY.idFromName('registry'))
  const rows = await registry.list()
  const projects = await Promise.all(rows.map(async (row): Promise<ProjectStatus> => {
    let outcome: Outcome
    try {
      const r = await projectStub(env, row.id).health()
      outcome = !r.ok ? { kind: 'blocked', message: r.message } : r.value === null ? { kind: 'unset' } : { kind: 'ok', health: r.value }
    } catch (e) {
      console.error(`status: project ${row.id} did not answer`, e)
      outcome = { kind: 'unreachable' }
    }
    return projectStatus(row, outcome, cfg)
  }))
  return buildReport(projects, { ...meta, now: new Date() })
}

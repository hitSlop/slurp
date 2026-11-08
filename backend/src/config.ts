/**
 * The Worker's settings, parsed once from `env` (docs/contracts.md, "Worker settings"). An empty, non-numeric, non-finite or
 * below-minimum value falls back to its default, with one warning per variable per isolate.
 */
export interface Config {
  sealIntervalMs: number
  archiveMaxBytes: number
  groupCommitMs: number
  bufferCapBytes: number
  maxBodyBytes: number
  /** 0 keeps archives forever; fractions are allowed. */
  retentionDays: number
  archiveRetryMs: number
  geo: boolean
}

export type ConfigEnv = Partial<Record<string, unknown>>

// [env variable, Config field, default, minimum]
const NUMBERS = [
  ['SEAL_INTERVAL_MS', 'sealIntervalMs', 600_000, 1],
  ['ARCHIVE_MAX_BYTES', 'archiveMaxBytes', 8 * 1024 * 1024, 1],
  ['GROUP_COMMIT_MS', 'groupCommitMs', 500, 0],
  ['BUFFER_CAP_BYTES', 'bufferCapBytes', 64 * 1024 * 1024, 1],
  ['MAX_BODY_BYTES', 'maxBodyBytes', 10 * 1024 * 1024, 1],
  ['RETENTION_DAYS', 'retentionDays', 0, 0],
  ['ARCHIVE_RETRY_MS', 'archiveRetryMs', 5000, 1],
] as const

const warned = new Set<string>()
const defaultWarn = (name: string, value: unknown, why: string) => {
  if (warned.has(name)) return
  warned.add(name)
  console.warn(`${name}=${JSON.stringify(value)} ${why}; using the default`)
}

export function parseConfig(env: ConfigEnv, warn: (name: string, value: unknown, why: string) => void = defaultWarn): Config {
  const config: Record<string, number | boolean> = {}
  for (const [name, field, fallback, minimum] of NUMBERS) {
    const raw = env[name]
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN
    if (raw !== undefined && !(Number.isFinite(n) && n >= minimum)) warn(name, raw, `is not a number of at least ${minimum}`)
    config[field] = Number.isFinite(n) && n >= minimum ? n : fallback
  }
  const geo = env.GEO
  if (geo !== undefined && geo !== 'on' && geo !== 'off') warn('GEO', geo, 'is not "on" or "off"')
  config.geo = geo !== 'off'
  return config as unknown as Config
}

const cache = new WeakMap<object, Config>()
/** The parsed settings for this `env` (parsed once, so a bad variable warns once). */
export const configOf = (env: object): Config => {
  let config = cache.get(env)
  if (!config) { config = parseConfig(env as ConfigEnv); cache.set(env, config) }
  return config
}

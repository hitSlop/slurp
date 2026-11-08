import { resolveEndpoint } from './event.ts'

export interface StorageAdapter {
  getItem(key: string): string | null | Promise<string | null>
  setItem(key: string, value: string): void | Promise<void>
  removeItem(key: string): void | Promise<void>
}

export function memoryStorage(): StorageAdapter {
  const values = new Map<string, string>()
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) },
    removeItem: key => { values.delete(key) },
  }
}

export function defaultStorage(report: (error: unknown) => void): StorageAdapter {
  const memory = memoryStorage()
  if (typeof window === 'undefined') return memory
  let failed = false
  return {
    getItem(key) {
      if (!failed) {
        try { return window.localStorage.getItem(key) }
        catch (error) { failed = true; report(error) }
      }
      return memory.getItem(key)
    },
    setItem(key, value) {
      memory.setItem(key, value)
      if (!failed) {
        try { window.localStorage.setItem(key, value) }
        catch (error) { failed = true; report(error) }
      }
    },
    removeItem(key) {
      memory.removeItem(key)
      if (!failed) {
        try { window.localStorage.removeItem(key) }
        catch (error) { failed = true; report(error) }
      }
    },
  }
}

const PUBLISHABLE_KEY = /^slurp_pk_([0-9a-f]{16})_([a-z][a-z0-9_]{0,31})_([0-9a-f]{48})$/

/**
 * Where one sender's saved state lives: endpoint, project and source, so rotating a key (the same source gets another key) keeps its queue,
 * and two senders sharing one storage never send each other's events. A key that does not parse is used whole.
 */
export function storageKey(endpoint: string, key: string): string {
  const base = resolveEndpoint(endpoint).replace(/[?#].*$/, '').replace(/\/$/, '')
  const parsed = PUBLISHABLE_KEY.exec(key)
  return `@hitslop/slurp-sdk:v1:${base}:${parsed ? `${parsed[1]}:${parsed[2]}` : key}`
}

/** What is saved: the identity, the lines not yet acknowledged, and the retry deadline. Nothing else (no batches, no stop flag). */
export interface Saved {
  version: 1
  anonymousId: string
  sessionId: string
  lastActivity: number
  userId?: string
  queue: string[]
  retryAt: number
  attempts: number
}

/** One complete JSON object. The Worker rejects a whole request for one bad line, so a damaged saved line must never be sent. */
function isRecord(line: string): boolean {
  try { const value = JSON.parse(line); return value !== null && typeof value === 'object' && !Array.isArray(value) } catch { return false }
}

/** Read saved state, keeping only complete records; `damaged` counts the lines that were thrown away. Throws when the state is not usable at all. */
export function restore(raw: string): { saved: Saved; damaged: number } {
  const saved: Saved = JSON.parse(raw)
  if (saved.version !== 1 || typeof saved.anonymousId !== 'string' || typeof saved.sessionId !== 'string' ||
      !Number.isFinite(saved.lastActivity) || (saved.userId !== undefined && typeof saved.userId !== 'string') ||
      !Array.isArray(saved.queue) || !saved.queue.every(line => typeof line === 'string') ||
      !Number.isFinite(saved.retryAt) || !Number.isSafeInteger(saved.attempts)) {
    throw new Error('invalid stored SDK state')
  }
  const queue = saved.queue.filter(line => line !== '' && !line.includes('\n') && isRecord(line))
  const damaged = saved.queue.filter(line => line !== '').length - queue.length
  return { saved: { ...saved, queue }, damaged }
}

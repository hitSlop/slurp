import { context, encoder, jsonData, pageHref, resolveEndpoint, uuidv7 } from './event.ts'
import { defaultStorage } from './storage.ts'
import type { StorageAdapter } from './storage.ts'

export type { StorageAdapter } from './storage.ts'
export { memoryStorage } from './storage.ts'
export { version } from './event.ts'

/** A terminal ingestion refusal; billing changes require the project owner. */
export class SlurpQuotaError extends Error {
  readonly status = 402
  constructor() {
    super('Slurp ingestion stopped: trial, spending limit, or payment needs attention. Ask the owner to run slurp billing status.')
    this.name = 'SlurpQuotaError'
  }
}

export interface SlurpOptions {
  key: string
  endpoint: string
  sourceId?: string
  context?: Record<string, unknown> | (() => Record<string, unknown>)
  flushAt?: number
  flushIntervalMs?: number
  maxBatchEvents?: number
  maxBatchBytes?: number
  maxQueue?: number
  sessionTimeoutMs?: number
  storage?: StorageAdapter
  fetch?: typeof globalThis.fetch
  onError?: (error: Error, dropped: number) => void
  flushOnHide?: boolean
}

export interface CaptureOptions {
  userId?: string
  anonymousId?: string
  sessionId?: string
  context?: Record<string, unknown>
}

/** Cumulative accepted/rejected counts for this client instance, plus current delivery state. */
export interface FlushResult {
  accepted: number
  rejected: number
  pending: number
  retryAt: number | null
  stopped: boolean
}

export interface SlurpClient {
  track(event: string, data?: Record<string, unknown>, options?: CaptureOptions): string
  identify(userId: string, data?: Record<string, unknown>): string
  reset(): void
  flush(): Promise<FlushResult>
  close(): Promise<void>
  readonly pending: number
}

interface State {
  version: 2
  anonymousId: string
  sessionId: string
  lastActivity: number
  userId?: string
  queue: string[]
  batches: string[]
  retryAt: number
  attempts: number
  stopped: boolean
}

const count = (body: string) => body.split('\n').length - 1
const bytes = (body: string) => encoder.encode(body).byteLength
const KEEPALIVE_BYTES = 60 * 1024
/** Largest single record the gateway accepts; records are stored whole, never truncated. */
const MAX_EVENT_BYTES = 1024 * 1024

function positive(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('limits and intervals must be positive safe integers')
  return value
}

function restore(raw: string): State {
  const state: State = JSON.parse(raw)
  if (state.version !== 2 || typeof state.anonymousId !== 'string' || typeof state.sessionId !== 'string' ||
      !Number.isFinite(state.lastActivity) || (state.userId !== undefined && typeof state.userId !== 'string') ||
      !Array.isArray(state.queue) || !state.queue.every(line => typeof line === 'string' && !line.includes('\n')) ||
      !Array.isArray(state.batches) || !state.batches.every(body => typeof body === 'string' && body.endsWith('\n')) ||
      !Number.isFinite(state.retryAt) || !Number.isSafeInteger(state.attempts) || typeof state.stopped !== 'boolean') {
    throw new Error('invalid stored SDK state')
  }
  return state
}

export function createClient(options: SlurpOptions): SlurpClient {
  if (!options.key || !options.endpoint) throw new Error('key and endpoint are required')
  const flushAt = positive(options.flushAt, 100)
  const interval = positive(options.flushIntervalMs, 5000)
  const maxBatchEvents = positive(options.maxBatchEvents, 1000)
  const maxBatchBytes = positive(options.maxBatchBytes, 900 * 1024)
  const maxQueue = positive(options.maxQueue, 10_000)
  const sessionTimeout = positive(options.sessionTimeoutMs, 30 * 60 * 1000)
  let accepted = 0
  let rejected = 0
  const report = (error: unknown, dropped = 0) => {
    rejected += dropped
    try { options.onError?.(error instanceof Error ? error : new Error(String(error)), dropped) } catch { /* callbacks cannot break delivery */ }
  }
  const storage = options.storage ?? defaultStorage(report)
  const storageKey = options.sourceId
    ? `@hitslop/slurp-sdk:v2:${resolveEndpoint(options.endpoint).replace(/[?#].*$/, "").replace(/\/$/, "")}:${options.sourceId}`
    : `@hitslop/slurp-sdk:v2:${options.key}`
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis)
  let state: State = {
    version: 2, anonymousId: uuidv7(), sessionId: uuidv7(), lastActivity: 0,
    queue: [], batches: [], retryAt: 0, attempts: 0, stopped: false,
  }
  let ready = false
  let quotaRefused = false
  let closed = false
  let closing: Promise<void> | undefined
  let stagedCount = 0
  const staged: (() => void)[] = []
  let sending: Promise<boolean | void> | undefined
  let controller: AbortController | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let timerAt = Infinity
  let saving = false
  let saveWaiters: ((saved: boolean) => void)[] = []
  let stop!: () => void
  const stopped = new Promise<void>(resolve => { stop = resolve })

  const clearTimer = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    timerAt = Infinity
  }
  const pending = () => stagedCount + state.queue.length + state.batches.reduce((total, body) => total + count(body), 0)
  const schedule = (delay: number) => {
    if (closed || state.stopped) return
    const at = Date.now() + delay
    if (timerAt <= at) return
    clearTimer()
    timerAt = at
    timer = setTimeout(() => { clearTimer(); void flush() }, Math.min(delay, 2_147_483_647))
    ;(timer as unknown as { unref?: () => void }).unref?.()
  }
  const trim = () => {
    const dropped = state.queue.length - maxQueue
    if (dropped > 0) {
      state.queue.splice(0, dropped)
      report(new Error('queue full; dropped oldest queued events'), dropped)
    }
  }
  const hydrate = (raw: string | null) => {
    if (raw !== null) state = restore(raw)
  }
  let read: string | null | Promise<string | null> = null
  try { read = storage.getItem(storageKey) } catch (error) { report(error) }
  const finishLoad = () => {
    ready = true
    for (const apply of staged.splice(0)) apply()
    trim()
    if (pending()) schedule(Math.max(0, state.retryAt - Date.now()) || interval)
  }
  let loaded: Promise<void>
  if (typeof read === 'string' || read === null) {
    try { hydrate(read) } catch (error) { report(error) }
    finishLoad()
    loaded = Promise.resolve()
  } else {
    loaded = Promise.resolve(read).then(hydrate).catch(report).then(finishLoad)
  }

  const persist = (): Promise<boolean> => new Promise(resolve => {
    saveWaiters.push(resolve)
    if (saving) return
    saving = true
    void (async () => {
      await loaded
      while (saveWaiters.length) {
        const waiters = saveWaiters
        saveWaiters = []
        let saved = true
        // A 402 stops this client, but a fresh client after an owner upgrade
        // must recover without clearing identities on every user's device.
        try { await storage.setItem(storageKey, JSON.stringify(quotaRefused ? { ...state, stopped: false } : state)) }
        catch (error) { saved = false; report(error) }
        for (const done of waiters) done(saved)
      }
      saving = false
    })()
  })
  const apply = (operation: () => void) => {
    if (ready) operation()
    else staged.push(operation)
    void persist()
  }
  const cutBatch = (limit: number) => {
    let size = 0
    let length = 0
    for (const line of state.queue) {
      const next = bytes(line) + 1
      if (length >= maxBatchEvents || (length > 0 && size + next > limit)) break
      size += next
      length++
    }
    if (length) state.batches.push(state.queue.splice(0, length).join('\n') + '\n')
  }
  const retry = async (response?: Response) => {
    let delay = NaN
    const header = response?.headers.get('Retry-After')
    if ((response?.status === 429 || response?.status === 503) && header) {
      delay = /^\d+(?:\.\d+)?$/.test(header.trim()) ? Number(header) * 1000 : Date.parse(header) - Date.now()
    }
    state.attempts++
    if (!Number.isFinite(delay)) {
      const backoff = Math.min(500 * 2 ** Math.min(state.attempts - 1, 7), 60_000)
      delay = backoff * (0.5 + Math.random() * 0.5)
    }
    state.retryAt = Date.now() + Math.max(0, delay)
    await persist()
    schedule(Math.max(0, state.retryAt - Date.now()))
  }
  const send = async (keepalive: boolean) => {
    await loaded
    while (!closed && !state.stopped) {
      if (state.retryAt > Date.now()) { schedule(state.retryAt - Date.now()); return }
      // A page-hide batch must fit a keepalive request; bigger pending batches wait for the next load.
      if (!state.batches.length) cutBatch(keepalive ? Math.min(maxBatchBytes, KEEPALIVE_BYTES) : maxBatchBytes)
      const body = state.batches[0]
      if (!body) return
      if (!(await persist())) { schedule(interval); return }
      if (closed || state.stopped) return
      if (keepalive && bytes(body) > KEEPALIVE_BYTES) return true
      let response: Response | undefined
      controller = new AbortController()
      try {
        const endpoint = keepalive ? new URL(options.endpoint, pageHref()) : undefined
        endpoint?.searchParams.set('key', options.key)
        response = await Promise.race([
          doFetch(endpoint?.toString() ?? options.endpoint, {
            method: 'POST', headers: keepalive ? { 'Content-Type': 'text/plain' } :
              { 'Content-Type': 'application/x-ndjson', Authorization: `Bearer ${options.key}` },
            body, keepalive, signal: controller.signal,
          }),
          stopped.then(() => undefined),
        ])
      } catch (error) {
        if (closed) return
        report(error)
        await retry()
        return
      } finally { controller = undefined }
      if (closed || !response) return
      void response.body?.cancel().catch(() => {})
      const status = response.status
      if (status === 401 || status === 402 || status === 403) {
        const dropped = pending()
        quotaRefused = status === 402
        state.stopped = true
        state.batches = []
        state.queue = []
        clearTimer()
        report(status === 402 ? new SlurpQuotaError() : new Error(`ingest ${status}; client stopped`), dropped)
        await persist()
        return
      }
      if (status === 429 || status >= 500) {
        report(new Error(`ingest ${status}; retry scheduled`))
        await retry(response)
        return
      }
      state.batches.shift()
      state.retryAt = 0
      state.attempts = 0
      if (status === 413) {
        const lines = body.slice(0, -1).split('\n')
        if (lines.length === 1) report(new Error('ingest 413; single event rejected'), 1)
        else {
          const middle = Math.ceil(lines.length / 2)
          state.batches.unshift(lines.slice(0, middle).join('\n') + '\n', lines.slice(middle).join('\n') + '\n')
        }
      } else if (status === 200) accepted += count(body)
      else if (status !== 200) report(new Error(`ingest ${status}; batch dropped`), count(body))
      if (!(await persist())) { schedule(interval); return }
      if (keepalive) return true
    }
  }
  const start = (keepalive: boolean) => {
    sending ??= send(keepalive).finally(() => {
      sending = undefined
      if (pending()) schedule(Math.max(0, state.retryAt - Date.now()) || interval)
    })
    return sending
  }
  async function flush(): Promise<FlushResult> {
    clearTimer()
    while (await start(false)) {
      if (closed || state.stopped || !pending()) break
      clearTimer()
    }
    return { accepted, rejected, pending: pending(), retryAt: state.retryAt > Date.now() ? state.retryAt : null, stopped: closed || state.stopped }
  }
  const onPageHide = () => {
    if (!sending && !closed && !state.stopped) { clearTimer(); void start(true) }
  }
  const onVisibility = () => { if (document.visibilityState === 'hidden') onPageHide() }
  const watchHide = (options.flushOnHide ?? true) && typeof window !== 'undefined' && typeof document !== 'undefined'
  const hideWindow = watchHide ? window : undefined
  const hideDocument = watchHide ? document : undefined
  if (watchHide) {
    hideWindow!.addEventListener('pagehide', onPageHide)
    hideDocument!.addEventListener('visibilitychange', onVisibility)
  }

  const capture = (type: 'track' | 'identify', event: string | undefined, data: Record<string, unknown>, overrides: CaptureOptions = {}, identified?: string): string => {
    const now = Date.now()
    const id = uuidv7(now)
    if (closed || state.stopped) { report(new Error('client stopped; event dropped'), 1); return id }
    let payload: Record<string, unknown>
    let eventContext: Record<string, unknown>
    let identity: CaptureOptions
    try {
      if (type === 'track' && (typeof event !== 'string' || !event.length || [...event].length > 200)) throw new Error('event must be a non-empty string of at most 200 characters')
      if (type === 'identify' && (typeof identified !== 'string' || !identified.length)) throw new Error('userId must be a non-empty string')
      for (const value of [overrides.userId, overrides.anonymousId, overrides.sessionId]) {
        if (value !== undefined && (typeof value !== 'string' || !value.length)) throw new Error('identity overrides must be non-empty strings')
      }
      payload = jsonData(data)
      const configured = typeof options.context === 'function' ? options.context() : options.context ?? {}
      eventContext = jsonData({ ...context(), ...jsonData(configured), ...jsonData(overrides.context ?? {}) })
      if ('geo' in eventContext) throw new Error('context.geo is reserved for server enrichment')
      identity = { userId: overrides.userId, anonymousId: overrides.anonymousId, sessionId: overrides.sessionId }
    } catch (error) { report(error, 1); return id }
    stagedCount++
    apply(() => {
      stagedCount--
      if (state.stopped) { report(new Error('client stopped; event dropped'), 1); return }
      const switching = identified !== undefined && state.userId !== undefined && state.userId !== identified
      const anonymousId = switching ? uuidv7(now) : state.anonymousId
      const sessionId = switching || now - state.lastActivity >= sessionTimeout ? uuidv7(now) : state.sessionId
      const userId = identified ?? identity.userId ?? state.userId
      const line = JSON.stringify({
        id, type, ...(event === undefined ? {} : { event }), timestamp: new Date(now).toISOString(),
        ...(userId !== undefined ? { user_id: userId } : {}),
        anonymous_id: identity.anonymousId ?? anonymousId,
        session_id: identity.sessionId ?? sessionId, data: payload, context: eventContext,
      })
      if (bytes(line) > MAX_EVENT_BYTES) { report(new Error('event exceeds 1 MiB'), 1); return }
      state.anonymousId = anonymousId
      state.sessionId = sessionId
      if (identified !== undefined) state.userId = identified
      state.lastActivity = now
      state.queue.push(line)
      trim()
      if (state.queue.length >= flushAt && state.retryAt <= Date.now()) void flush()
      else schedule(Math.max(0, state.retryAt - Date.now()) || interval)
    })
    return id
  }
  return {
    track: (event, data = {}, overrides) => capture('track', event, data, overrides),
    identify: (userId, data = {}) => capture('identify', undefined, data, {}, userId),
    reset() {
      if (closed || state.stopped) return
      apply(() => {
        delete state.userId
        state.anonymousId = uuidv7()
        state.sessionId = uuidv7()
        state.lastActivity = Date.now()
      })
    },
    flush,
    close() {
      if (closing) return closing
      closed = true
      stop()
      controller?.abort()
      clearTimer()
      hideWindow?.removeEventListener('pagehide', onPageHide)
      hideDocument?.removeEventListener('visibilitychange', onVisibility)
      return closing = persist().then(() => {})
    },
    get pending() { return pending() },
  }
}

let defaultClient: SlurpClient | undefined
export function init(options: SlurpOptions): SlurpClient {
  if (defaultClient) void defaultClient.close()
  return defaultClient = createClient(options)
}
function client(): SlurpClient {
  if (!defaultClient) throw new Error('call init before using the default client')
  return defaultClient
}
export const track = (event: string, data?: Record<string, unknown>, options?: CaptureOptions): string => client().track(event, data, options)
export const identify = (userId: string, data?: Record<string, unknown>): string => client().identify(userId, data)
export const reset = (): void => client().reset()
export const flush = (): Promise<FlushResult> => client().flush()

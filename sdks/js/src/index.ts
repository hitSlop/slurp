import { context, encoder, jsonData, pageHref, resolveEndpoint, uuidv7 } from './event.ts'
import { defaultStorage } from './storage.ts'
import type { StorageAdapter } from './storage.ts'

export type { StorageAdapter } from './storage.ts'
export { memoryStorage } from './storage.ts'
export { version } from './event.ts'


export interface SlurpOptions {
  key: string
  endpoint: string
  context?: Record<string, unknown> | (() => Record<string, unknown>)
  flushAt?: number
  flushIntervalMs?: number
  maxBatchEvents?: number
  maxBatchBytes?: number
  maxQueue?: number
  /** Most bytes kept while offline, counting events not yet batched and batches not yet acknowledged; the oldest are dropped (and reported) beyond it. Records can be up to 1 MiB each, so a count limit alone is not a size limit. Default 4 MiB, which also stays under the browser's roughly 5 MB localStorage. */
  maxQueueBytes?: number
  /** A request with no answer after this many milliseconds is aborted and retried with the same bytes. Default 30000. */
  requestTimeoutMs?: number
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
  version: 1
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

/** Saves still in flight for a closed client, by saved-state key. A replacement client waits for its own key here before it reads. */
const pendingCloses = new Map<string, Promise<void>>()
const bytes = (body: string) => encoder.encode(body).byteLength
const KEEPALIVE_BYTES = 60 * 1024
/** Largest single record the gateway accepts; records are stored whole, never truncated. */
const MAX_EVENT_BYTES = 1024 * 1024

function positive(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('limits and intervals must be positive safe integers')
  return value
}

/** True for one complete JSON object. The gateway validates a request as a whole, so one damaged line costs every event batched with it. */
function isRecord(line: string): boolean {
  try { const value = JSON.parse(line); return value !== null && typeof value === 'object' && !Array.isArray(value) } catch { return false }
}

/** Read saved state, keeping only complete records; `damaged` counts the lines that were thrown away. */
function restore(raw: string): { state: State; damaged: number } {
  const state: State = JSON.parse(raw)
  if (state.version !== 1 || typeof state.anonymousId !== 'string' || typeof state.sessionId !== 'string' ||
      !Number.isFinite(state.lastActivity) || (state.userId !== undefined && typeof state.userId !== 'string') ||
      !Array.isArray(state.queue) || !state.queue.every(line => typeof line === 'string') ||
      !Array.isArray(state.batches) || !state.batches.every(body => typeof body === 'string') ||
      !Number.isFinite(state.retryAt) || !Number.isSafeInteger(state.attempts) || typeof state.stopped !== 'boolean') {
    throw new Error('invalid stored SDK state')
  }
  let damaged = 0
  const keep = (lines: string[]) => lines.filter(line => { const ok = line !== '' && !line.includes('\n') && isRecord(line); if (!ok && line !== '') damaged++; return ok })
  state.queue = keep(state.queue)
  state.batches = state.batches.map(body => keep(body.split('\n').slice(0, -1)).join('\n')).filter(joined => joined !== '').map(joined => joined + '\n')
  return { state, damaged }
}

export function createClient(options: SlurpOptions): SlurpClient {
  if (!options.key || !options.endpoint) throw new Error('key and endpoint are required')
  const flushAt = positive(options.flushAt, 100)
  const interval = positive(options.flushIntervalMs, 5000)
  const maxBatchEvents = positive(options.maxBatchEvents, 1000)
  const maxBatchBytes = positive(options.maxBatchBytes, 900 * 1024)
  const maxQueue = positive(options.maxQueue, 10_000)
  const maxQueueBytes = positive(options.maxQueueBytes, 4 * 1024 * 1024)
  const requestTimeoutMs = positive(options.requestTimeoutMs, 30_000)
  const sessionTimeout = positive(options.sessionTimeoutMs, 30 * 60 * 1000)
  let accepted = 0
  let rejected = 0
  const report = (error: unknown, dropped = 0) => {
    rejected += dropped
    try { options.onError?.(error instanceof Error ? error : new Error(String(error)), dropped) } catch { /* callbacks cannot break delivery */ }
  }
  const storage = options.storage ?? defaultStorage(report)
  // Saved state belongs to one key: two senders sharing a storage (two sites on one origin) never send each other's queued events,
  // and a replaced key starts clean. Replacing a key therefore starts a new visitor identity.
  const storageKey = `@hitslop/slurp-sdk:v1:${resolveEndpoint(options.endpoint).replace(/[?#].*$/, "").replace(/\/$/, "")}:${options.key}`
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis)
  let state: State = {
    version: 1, anonymousId: uuidv7(), sessionId: uuidv7(), lastActivity: 0,
    queue: [], batches: [], retryAt: 0, attempts: 0, stopped: false,
  }
  let ready = false
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
  // Bytes held, kept incrementally (re-measured whenever whole batches change) so a capture never has to re-encode the queue.
  let queueBytes = 0
  let batchBytes = 0
  const measure = () => {
    queueBytes = state.queue.reduce((total, line) => total + bytes(line) + 1, 0)
    batchBytes = state.batches.reduce((total, body) => total + bytes(body), 0)
  }
  const trim = () => {
    let dropped = 0
    const excess = state.queue.length - maxQueue
    if (excess > 0) {
      for (const line of state.queue.splice(0, excess)) queueBytes -= bytes(line) + 1
      dropped += excess
    }
    while (queueBytes + batchBytes > maxQueueBytes && state.queue.length) {
      queueBytes -= bytes(state.queue.shift()!) + 1
      dropped++
    }
    // Still too much: the oldest unsent batches go too, but never the one that is on the wire right now.
    const protectedBatches = sending ? 1 : 0
    while (queueBytes + batchBytes > maxQueueBytes && state.batches.length > protectedBatches) {
      dropped += count(state.batches.splice(protectedBatches, 1)[0])
      measure()
    }
    if (dropped > 0) report(new Error('queue full; dropped the oldest queued events'), dropped)
  }
  const hydrate = (raw: string | null) => {
    if (raw !== null) {
      const restored = restore(raw)
      state = restored.state
      if (restored.damaged) report(new Error(`dropped ${restored.damaged} damaged saved event(s)`), restored.damaged)
    }
    measure()
  }
  // A client that replaces another one (`init` twice) must read what the first one saved, so it waits for that save to finish.
  const earlier = pendingCloses.get(storageKey)
  let read: string | null | Promise<string | null> = null
  try { read = earlier ? earlier.then(() => storage.getItem(storageKey)) : storage.getItem(storageKey) } catch (error) { report(error) }
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
        try { await storage.setItem(storageKey, JSON.stringify(state)) }
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
    if (length) {
      state.batches.push(state.queue.splice(0, length).join('\n') + '\n')
      queueBytes -= size
      batchBytes += size
    }
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
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined
      try {
        const endpoint = keepalive ? new URL(options.endpoint, pageHref()) : undefined
        endpoint?.searchParams.set('key', options.key)
        // A request that is never answered must not stall delivery for good: abort it and retry the same bytes.
        const deadline = new Promise<never>((_, reject) => {
          deadlineTimer = setTimeout(() => { controller?.abort(); reject(new Error(`request timed out after ${requestTimeoutMs} ms`)) }, requestTimeoutMs)
          ;(deadlineTimer as unknown as { unref?: () => void }).unref?.()
        })
        response = await Promise.race([
          doFetch(endpoint?.toString() ?? options.endpoint, {
            method: 'POST', headers: keepalive ? { 'Content-Type': 'text/plain' } :
              { 'Content-Type': 'application/x-ndjson', Authorization: `Bearer ${options.key}` },
            body, keepalive, signal: controller.signal,
          }),
          stopped.then(() => undefined),
          deadline,
        ])
      } catch (error) {
        if (closed) return
        report(error)
        await retry()
        return
      } finally { clearTimeout(deadlineTimer); controller = undefined }
      if (closed || !response) return
      void response.body?.cancel().catch(() => {})
      const status = response.status
      if (status === 401 || status === 403) {
        const dropped = pending()
        state.stopped = true
        state.batches = []
        state.queue = []
        queueBytes = 0
        batchBytes = 0
        clearTimer()
        report(new Error(`ingest ${status}; client stopped`), dropped)
        await persist()
        return
      }
      if (status === 408 || status === 429 || status >= 500) {
        report(new Error(`ingest ${status}; retry scheduled`))
        await retry(response)
        return
      }
      state.batches.shift()
      batchBytes -= bytes(body)
      state.retryAt = 0
      state.attempts = 0
      if (status === 413) {
        const lines = body.slice(0, -1).split('\n')
        if (lines.length === 1) report(new Error('ingest 413; single event rejected'), 1)
        else {
          const middle = Math.ceil(lines.length / 2)
          state.batches.unshift(lines.slice(0, middle).join('\n') + '\n', lines.slice(middle).join('\n') + '\n')
          measure()
        }
      } else if (status >= 200 && status < 300) accepted += count(body)
      else report(new Error(`ingest ${status}; batch dropped`), count(body))
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
      const size = bytes(line)
      if (size > MAX_EVENT_BYTES) { report(new Error('event exceeds 1 MiB'), 1); return }
      state.anonymousId = anonymousId
      state.sessionId = sessionId
      if (identified !== undefined) state.userId = identified
      state.lastActivity = now
      state.queue.push(line)
      queueBytes += size + 1
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
      const done = persist().then(() => {})
      pendingCloses.set(storageKey, done)
      void done.finally(() => { if (pendingCloses.get(storageKey) === done) pendingCloses.delete(storageKey) })
      return closing = done
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

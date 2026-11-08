import { bytes, context, jsonData, pageHref, uuidv7, validEventName } from './event.ts'
import { advance, newIdentity, reset as resetIdentity } from './identity.ts'
import type { Identity } from './identity.ts'
import { Queue } from './queue.ts'
import { classify } from './response.ts'
import { defaultStorage, restore, storageKey } from './storage.ts'
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
  /** Most bytes kept while offline; the oldest lines that are not in a request are dropped (and reported) beyond it. Records can be up to 1 MiB each, so a count limit alone is not a size limit. Default 4 MiB, which also stays under the browser's roughly 5 MB localStorage. */
  maxQueueBytes?: number
  /** A request with no answer after this many milliseconds is aborted and retried. Default 30000. */
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
  /** True once the client is closed, or the Worker refused its key (401/403) so this instance stopped. */
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

/** Saves still in flight for a closed client, by saved-state key. A replacement client waits for its own key here before it reads. */
const pendingCloses = new Map<string, Promise<void>>()
const KEEPALIVE_BYTES = 60 * 1024
/** Largest single record the gateway accepts; records are stored whole, never truncated. */
const MAX_EVENT_BYTES = 1024 * 1024

function positive(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('limits and intervals must be positive safe integers')
  return value
}

/**
 * The driver: loads and saves state, schedules sends, runs the send loop. What is decided lives in identity.ts (who is sending),
 * queue.ts (which lines go in a request) and response.ts (what an answer means); docs/contracts.md "SDK delivery" is the spec.
 */
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
  const savedAt = storageKey(options.endpoint, options.key)
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis)

  let identity: Identity = newIdentity(uuidv7)
  const queue = new Queue()
  let retryAt = 0
  let attempts = 0
  let ready = false
  let closed = false
  let stopped = false // this instance only: a refused key stops sending, but nothing about it is saved
  let closing: Promise<void> | undefined
  let stagedCount = 0
  const staged: (() => void)[] = []
  let sending: Promise<'partial' | void> | undefined
  let controller: AbortController | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let timerAt = Infinity
  let saving = false
  let saveWaiters: ((saved: boolean) => void)[] = []
  let saveFailing = false
  let shutDown!: () => void
  const shutdown = new Promise<void>(resolve => { shutDown = resolve })

  const pending = () => stagedCount + queue.length
  const until = () => Math.max(0, retryAt - Date.now()) || interval
  const clearTimer = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    timerAt = Infinity
  }
  /** Arm the flush timer. It keeps the earliest deadline, so a stream of captures never postpones a flush. */
  const schedule = (delay: number) => {
    if (closed || stopped) return
    const at = Date.now() + delay
    if (timerAt <= at) return
    clearTimer()
    timerAt = at
    timer = setTimeout(() => { clearTimer(); void flush() }, Math.min(delay, 2_147_483_647))
    ;(timer as unknown as { unref?: () => void }).unref?.()
  }
  const trim = () => {
    const dropped = queue.trim(maxQueue, maxQueueBytes)
    if (dropped > 0) report(new Error('queue full; dropped the oldest queued events'), dropped)
  }

  const hydrate = (raw: string | null) => {
    if (raw === null) return
    const { saved, damaged } = restore(raw)
    identity = { anonymousId: saved.anonymousId, sessionId: saved.sessionId, lastActivity: saved.lastActivity, ...(saved.userId === undefined ? {} : { userId: saved.userId }) }
    queue.load(saved.queue)
    retryAt = saved.retryAt
    attempts = saved.attempts
    if (damaged) report(new Error(`dropped ${damaged} damaged saved event(s)`), damaged)
  }
  // A client that replaces another one (`init` twice) must read what the first one saved, so it waits for that save to finish.
  const earlier = pendingCloses.get(savedAt)
  let read: string | null | Promise<string | null> = null
  try { read = earlier ? earlier.then(() => storage.getItem(savedAt)) : storage.getItem(savedAt) } catch (error) { report(error) }
  const finishLoad = () => {
    ready = true
    for (const apply of staged.splice(0)) apply()
    trim()
    if (pending()) schedule(until())
  }
  let loaded: Promise<void>
  if (typeof read === 'string' || read === null) {
    try { hydrate(read) } catch (error) { report(error) }
    finishLoad()
    loaded = Promise.resolve()
  } else {
    loaded = Promise.resolve(read).then(hydrate).catch(report).then(finishLoad)
  }

  const snapshot = () => JSON.stringify({
    version: 1, anonymousId: identity.anonymousId, sessionId: identity.sessionId, lastActivity: identity.lastActivity,
    ...(identity.userId === undefined ? {} : { userId: identity.userId }), queue: queue.lines, retryAt, attempts,
  })
  /** Save the state now, coalescing saves that arrive meanwhile. A failed save is reported once and delivery carries on: the events are still in memory and a later save may work. */
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
        try { await storage.setItem(savedAt, snapshot()); saveFailing = false }
        catch (error) { saved = false; if (!saveFailing) report(error); saveFailing = true }
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

  const retry = async (delayMs?: number) => {
    attempts++
    const delay = delayMs ?? Math.min(500 * 2 ** Math.min(attempts - 1, 7), 60_000) * (0.5 + Math.random() * 0.5)
    retryAt = Date.now() + delay
    await persist()
    schedule(Math.max(0, retryAt - Date.now()))
  }
  /** One request, bounded by the request timeout. Resolves with nothing when the client is closed meanwhile. */
  const exchange = async (body: string, keepalive: boolean) => {
    controller = new AbortController()
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined
    try {
      const endpoint = keepalive ? new URL(options.endpoint, pageHref()) : undefined
      endpoint?.searchParams.set('key', options.key)
      // A request that is never answered must not stall delivery for good: abort it and retry.
      const deadline = new Promise<never>((_, reject) => {
        deadlineTimer = setTimeout(() => { controller?.abort(); reject(new Error(`request timed out after ${requestTimeoutMs} ms`)) }, requestTimeoutMs)
        ;(deadlineTimer as unknown as { unref?: () => void }).unref?.()
      })
      const answer = async () => {
        const response = await doFetch(endpoint?.toString() ?? options.endpoint, {
          method: 'POST', headers: keepalive ? { 'Content-Type': 'text/plain' } :
            { 'Content-Type': 'application/x-ndjson', Authorization: `Bearer ${options.key}` },
          body, keepalive, signal: controller!.signal,
        })
        // Only a 400 body matters (it can list the rejected lines); read it inside the timeout and let go of every other body.
        const text = response.status === 400 ? await response.text().catch(() => '') : ''
        if (response.status !== 400) void response.body?.cancel().catch(() => {})
        return { status: response.status, retryAfter: response.headers?.get?.('Retry-After') ?? null, text }
      }
      return await Promise.race([answer(), shutdown.then(() => undefined), deadline])
    } finally { clearTimeout(deadlineTimer); controller = undefined }
  }
  const send = async (keepalive: boolean): Promise<'partial' | void> => {
    await loaded
    while (!closed && !stopped) {
      if (retryAt > Date.now()) { schedule(retryAt - Date.now()); return }
      // A page-hide request must fit a keepalive request; a bigger first line waits for the next load.
      const lines = queue.take(maxBatchEvents, keepalive ? Math.min(maxBatchBytes, KEEPALIVE_BYTES) : maxBatchBytes)
      if (!lines.length) return
      const k = lines.length
      const body = lines.join('\n') + '\n'
      if (keepalive && bytes(body) > KEEPALIVE_BYTES) { queue.release(); return }
      let reply: Awaited<ReturnType<typeof exchange>>
      try { reply = await exchange(body, keepalive) }
      catch (error) {
        queue.release()
        if (closed) return
        report(error)
        await retry()
        return
      }
      if (closed || !reply) { queue.release(); return }
      const outcome = classify(reply.status, reply.retryAfter, reply.text, k, Date.now())
      if (outcome.kind === 'retry') {
        queue.release()
        report(new Error(`ingest ${reply.status}; retry scheduled`))
        await retry(outcome.delayMs)
        return
      }
      if (outcome.kind === 'stop') {
        const dropped = queue.clear()
        stopped = true
        clearTimer()
        report(new Error(`ingest ${reply.status}; client stopped`), dropped)
        await persist()
        return
      }
      retryAt = 0
      attempts = 0
      if (outcome.kind === 'ok') { queue.ack(k); queue.split = Infinity; accepted += k }
      else if (outcome.kind === 'split') {
        if (queue.halve(k)) report(new Error('ingest 413; single event rejected'), 1)
      } else if (outcome.kind === 'rejected') {
        const dropped = queue.dropLines(outcome.lines.map(line => line - 1))
        report(new Error(`ingest 400; ${dropped} rejected event(s) dropped (${outcome.reasons})`), dropped)
      } else {
        queue.ack(k)
        report(new Error(`ingest ${reply.status}; batch dropped`), k)
      }
      await persist()
      if (keepalive) return queue.length ? 'partial' : undefined
    }
  }
  const start = (keepalive: boolean) => {
    sending ??= send(keepalive).finally(() => {
      sending = undefined
      if (queue.length) schedule(until())
    })
    return sending
  }
  async function flush(): Promise<FlushResult> {
    clearTimer()
    if (await start(false) === 'partial') await start(false) // a page-hide send stops after one request
    return { accepted, rejected, pending: pending(), retryAt: retryAt > Date.now() ? retryAt : null, stopped: closed || stopped }
  }
  const onPageHide = () => {
    if (!sending && !closed && !stopped) { clearTimer(); void start(true) }
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
    if (closed || stopped) { report(new Error('client stopped; event dropped'), 1); return id }
    let payload: Record<string, unknown>
    let eventContext: Record<string, unknown>
    try {
      if (type === 'track' && !validEventName(event)) throw new Error('event must be a non-empty string of at most 200 characters')
      if (type === 'identify' && (typeof identified !== 'string' || !identified.length)) throw new Error('userId must be a non-empty string')
      for (const value of [overrides.userId, overrides.anonymousId, overrides.sessionId]) {
        if (value !== undefined && (typeof value !== 'string' || !value.length)) throw new Error('identity overrides must be non-empty strings')
      }
      payload = jsonData(data)
      const configured = typeof options.context === 'function' ? options.context() : options.context ?? {}
      eventContext = jsonData({ ...context(), ...jsonData(configured), ...jsonData(overrides.context ?? {}) })
      if ('geo' in eventContext) throw new Error('context.geo is reserved for server enrichment')
    } catch (error) { report(error, 1); return id }
    stagedCount++
    apply(() => {
      stagedCount--
      if (stopped) { report(new Error('client stopped; event dropped'), 1); return }
      const next = advance(identity, now, sessionTimeout, identified, () => uuidv7(now))
      const userId = identified ?? overrides.userId ?? next.userId
      const line = JSON.stringify({
        id, type, ...(event === undefined ? {} : { event }), timestamp: new Date(now).toISOString(),
        ...(userId !== undefined ? { user_id: userId } : {}),
        anonymous_id: overrides.anonymousId ?? next.anonymousId,
        session_id: overrides.sessionId ?? next.sessionId, data: payload, context: eventContext,
      })
      if (bytes(line) > MAX_EVENT_BYTES) { report(new Error('event exceeds 1 MiB'), 1); return }
      identity = next
      queue.push(line)
      trim()
      if (queue.length >= flushAt && retryAt <= Date.now()) void flush()
      else schedule(until())
    })
    return id
  }
  return {
    track: (event, data = {}, overrides) => capture('track', event, data, overrides),
    identify: (userId, data = {}) => capture('identify', undefined, data, {}, userId),
    reset() {
      if (closed || stopped) return
      apply(() => { identity = resetIdentity(Date.now(), uuidv7) })
    },
    flush,
    close() {
      if (closing) return closing
      closed = true
      shutDown()
      controller?.abort()
      clearTimer()
      hideWindow?.removeEventListener('pagehide', onPageHide)
      hideDocument?.removeEventListener('visibilitychange', onVisibility)
      const done = persist().then(() => {})
      pendingCloses.set(savedAt, done)
      void done.finally(() => { if (pendingCloses.get(savedAt) === done) pendingCloses.delete(savedAt) })
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

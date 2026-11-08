import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { JSDOM } from 'jsdom'
import { createClient, flush, init, memoryStorage, track, type StorageAdapter } from '../src/index.ts'

// Replacing a client (init twice, or a restart) must not lose what the first one had queued, and two senders sharing one
// storage must never send each other's events.
const endpoint = 'https://worker.example/v1/events'
const keyFor = (project: string, random: string, source = 'web') => `slurp_pk_${project.repeat(16)}_${source}_${random.repeat(48)}`
const names = (body: string) => body.trim().split('\n').map(line => JSON.parse(line).event as string)

function server(status = 200) {
  const sent: { key: string; events: string[] }[] = []
  const fetch = (async (_url: string, init: { body: string; headers: Record<string, string> }) => {
    sent.push({ key: init.headers.Authorization.replace('Bearer ', ''), events: names(init.body) })
    return new Response(null, { status })
  }) as any
  return { sent, fetch, all: () => sent.flatMap(request => request.events) }
}
/** Every operation takes a little while, like AsyncStorage or IndexedDB. */
function slowStorage(): StorageAdapter {
  const inner = memoryStorage()
  const later = <T>(value: () => T) => new Promise<T>(resolve => setTimeout(() => resolve(value()), 15))
  return {
    getItem: key => later(() => inner.getItem(key) as string | null),
    setItem: (key, value) => later(() => { inner.setItem(key, value) }),
    removeItem: key => later(() => { inner.removeItem(key) }),
  }
}

afterEach(() => { delete (globalThis as any).window })

test('replacing the default client keeps what the first one had queued (browser storage)', async () => {
  ;(globalThis as any).window = new JSDOM('', { url: 'https://app.example.test/' }).window
  const s = server()
  const options = { key: keyFor('a', '1'), endpoint, fetch: s.fetch, flushIntervalMs: 3_600_000 }
  init(options); track('before')
  init(options); track('after')
  await flush()
  assert.deepEqual(s.all().sort(), ['after', 'before'])
})

test('three rapid replacements lose nothing and duplicate nothing', async () => {
  ;(globalThis as any).window = new JSDOM('', { url: 'https://app.example.test/' }).window
  const s = server()
  const options = { key: keyFor('a', '1'), endpoint, fetch: s.fetch, flushIntervalMs: 3_600_000 }
  for (const name of ['one', 'two', 'three', 'four']) { init(options); track(name) }
  await flush()
  assert.deepEqual(s.all().sort(), ['four', 'one', 'three', 'two'])
})

test('a client replaced while its storage is slow hands its queue to the next one', async () => {
  const storage = slowStorage()
  const s = server()
  const options = { key: keyFor('a', '1'), endpoint, fetch: s.fetch, storage, flushIntervalMs: 3_600_000 }
  const first = createClient(options)
  first.track('before')
  void first.close()
  const second = createClient(options)
  second.track('after')
  await second.flush()
  assert.deepEqual(s.all().sort(), ['after', 'before'])
  await second.close()
  // and a restart after that still has nothing left over
  const third = createClient({ ...options, fetch: server().fetch })
  assert.equal((await third.flush()).pending, 0)
  await third.close()
})

test('two senders of one project sharing a storage never send each other\'s events', async () => {
  const storage = memoryStorage()
  const web = keyFor('a', '1'), widget = keyFor('a', '2', 'widget')
  const offline = createClient({ key: widget, endpoint, storage, flushIntervalMs: 3_600_000, fetch: (async () => { throw new TypeError('offline') }) as any })
  offline.track('from-widget')
  await offline.close()
  const s = server()
  const sender = createClient({ key: web, endpoint, storage, fetch: s.fetch, flushIntervalMs: 3_600_000 })
  sender.track('from-web')
  await sender.flush()
  assert.deepEqual(s.sent, [{ key: web, events: ['from-web'] }], 'the widget\'s queued event is not sent as the web sender')
  await sender.close()
  const later = server()
  const widgetAgain = createClient({ key: widget, endpoint, storage, fetch: later.fetch, flushIntervalMs: 3_600_000 })
  await widgetAgain.flush()
  assert.deepEqual(later.sent, [{ key: widget, events: ['from-widget'] }], 'it is still there for the sender that queued it')
  await widgetAgain.close()
})

const offline = (key: string, storage: StorageAdapter) =>
  createClient({ key, endpoint, storage, fetch: (async () => { throw new TypeError('offline') }) as any, flushIntervalMs: 3_600_000 })

test('rotating a key keeps its queue and identity: the same source under another key is the same sender', async () => {
  const storage = memoryStorage()
  const before = offline(keyFor('a', '1'), storage)
  before.track('queued_under_old_key')
  await before.close()
  const s = server()
  const rotated = createClient({ key: keyFor('a', '2'), endpoint, storage, fetch: s.fetch, flushIntervalMs: 3_600_000 })
  rotated.track('under_new_key')
  await rotated.flush()
  assert.deepEqual(s.sent, [{ key: keyFor('a', '2'), events: ['queued_under_old_key', 'under_new_key'] }])
  await rotated.close()
})

test('another project with the same source does not share a queue', async () => {
  const storage = memoryStorage()
  const first = offline(keyFor('a', '1'), storage)
  first.track('project_a')
  await first.close()
  const s = server()
  const other = createClient({ key: keyFor('b', '1'), endpoint, storage, fetch: s.fetch, flushIntervalMs: 3_600_000 })
  other.track('project_b')
  await other.flush()
  assert.deepEqual(s.all(), ['project_b'])
  await other.close()
})

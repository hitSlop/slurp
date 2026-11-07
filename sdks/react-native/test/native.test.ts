import assert from 'node:assert/strict'
import { test } from 'node:test'
import { memoryStorage, type StorageAdapter } from '@hitslop/slurp-sdk'
import { chunkedStorage } from '../src/chunked.ts'
import { createNativeClient, type NativeEnvironment } from '../src/native.ts'

const endpoint = 'https://worker.example/v1/events'
const response = (status: number) => ({ status, ok: status < 400, headers: { get: () => null }, text: async () => '{}', json: async () => ({}) })

function fakes(overrides: Partial<NativeEnvironment> = {}) {
  const listeners = new Set<(state: string) => void>()
  const env: NativeEnvironment = {
    appState: { addEventListener: (_type, listener) => { listeners.add(listener); return { remove: () => listeners.delete(listener) } } },
    platform: { OS: 'ios', Version: '18.1', constants: { model: 'iPhone15,2' } },
    storage: memoryStorage(),
    ...overrides,
  }
  const sent: any[] = []
  const fetchOk = (async (_url: string, init: { body: string }) => { sent.push(...init.body.trim().split('\n').map(l => JSON.parse(l))); return response(200) }) as any
  const fetchDown = (async () => response(503)) as any
  return { env, listeners, sent, fetchOk, fetchDown, change: (state: string) => listeners.forEach(l => l(state)) }
}
const base = { key: 'slurp_pk_test', endpoint, flushIntervalMs: 60_000 }

test('events carry device and app context; screen() names the screen for later events', async () => {
  const f = fakes()
  const client = createNativeClient({ ...base, fetch: f.fetchOk, appVersion: '2.4.0', appBuild: '88', context: { experiment: 'b' } }, f.env)
  client.screen('Home', { tab: 'feed' })
  client.track('purchase', { total: 9 })
  await client.flush()
  const [screen, purchase] = f.sent
  assert.equal(screen.event, 'screen'); assert.deepEqual(screen.data, { name: 'Home', tab: 'feed' })
  assert.deepEqual(purchase.context.os, { name: 'ios', version: '18.1' })
  assert.deepEqual(purchase.context.app, { version: '2.4.0', build: '88' })
  assert.equal(purchase.context.device.model, 'iPhone15,2'); assert.equal(purchase.context.screen, 'Home'); assert.equal(purchase.context.experiment, 'b')
  assert.equal(purchase.context.library.name, '@hitslop/slurp-react-native')
  assert.equal(screen.session_id, purchase.session_id); assert.ok(purchase.anonymous_id)
  await client.close()
})

test('expo-application supplies the version and build when the app does not pass them', async () => {
  const f = fakes()
  const client = createNativeClient({ ...base, fetch: f.fetchOk, application: { nativeApplicationVersion: '1.0.3', nativeBuildVersion: '41', applicationId: 'com.example.app' } }, f.env)
  client.track('opened'); await client.flush()
  assert.deepEqual(f.sent[0].context.app, { version: '1.0.3', build: '41', id: 'com.example.app' })
  await client.close()
})

test('the app leaving the foreground sends what is queued', async () => {
  const f = fakes()
  const client = createNativeClient({ ...base, fetch: f.fetchOk }, f.env)
  client.track('before_background')
  assert.equal(f.sent.length, 0, 'queued, not yet sent')
  f.change('background')
  await new Promise(r => setTimeout(r, 50))
  assert.deepEqual(f.sent.map(e => e.event), ['before_background'])
  client.track('while_inactive'); f.change('inactive'); await new Promise(r => setTimeout(r, 50))
  assert.equal(f.sent.length, 2)
  await client.close()
})

test('a queued event survives the app being killed and is delivered, once, after relaunch', async () => {
  const storage = memoryStorage()
  const first = fakes({ storage })
  const a = createNativeClient({ ...base, fetch: first.fetchDown }, first.env)
  const id = a.track('checkout_started', { cart: 3 })
  a.identify('user-5')
  const down = await a.flush() // the network is down: the events stay queued and are written to storage
  assert.equal(down.pending, 2); assert.ok(down.retryAt)
  await a.close() // the process dies here
  const second = fakes({ storage })
  const b = createNativeClient({ ...base, fetch: second.fetchOk }, second.env)
  await new Promise(r => setTimeout(r, Math.max(0, down.retryAt! - Date.now()) + 50)) // the SDK honors the backoff across restarts
  await b.flush()
  assert.equal(second.sent.filter(e => e.id === id).length, 1)
  assert.deepEqual(second.sent.map(e => e.type), ['track', 'identify'])
  b.track('after_relaunch')
  await b.flush()
  assert.equal(second.sent.at(-1).user_id, 'user-5', 'the identified user and the visitor identity persist too')
  assert.equal(second.sent.at(-1).anonymous_id, second.sent[0].anonymous_id)
  await b.close()
})

test('netinfo: a reconnect flushes; close removes both listeners', async () => {
  const f = fakes()
  let netListener: ((s: { isConnected: boolean | null; isInternetReachable?: boolean | null }) => void) | undefined
  let netRemoved = false
  const netInfo = { addEventListener: (l: typeof netListener) => { netListener = l; return () => { netRemoved = true } } }
  const client = createNativeClient({ ...base, fetch: f.fetchOk, netInfo: netInfo as any }, f.env)
  client.track('offline_event')
  netListener!({ isConnected: false, isInternetReachable: false })
  await new Promise(r => setTimeout(r, 30))
  assert.equal(f.sent.length, 0, 'no flush while offline')
  netListener!({ isConnected: true, isInternetReachable: true })
  await new Promise(r => setTimeout(r, 50))
  assert.equal(f.sent.length, 1)
  await client.close()
  assert.ok(netRemoved); assert.equal(f.listeners.size, 0)
})

/** Replacing the client (what `init` does) must hand the first client's queue to the next one even though each client wraps AsyncStorage
 *  in a new `chunkedStorage` and every storage call takes a moment. */
test('a replaced client hands its queue on through the default storage wrapper, even over several rapid replacements', async () => {
  const inner = memoryStorage()
  const slow: StorageAdapter = {
    getItem: key => new Promise(resolve => setTimeout(() => resolve(inner.getItem(key) as string | null), 10)),
    setItem: (key, value) => new Promise(resolve => setTimeout(() => { inner.setItem(key, value); resolve() }, 10)),
    removeItem: key => new Promise(resolve => setTimeout(() => { inner.removeItem(key); resolve() }, 10)),
  }
  const f = fakes()
  const make = () => createNativeClient({ ...base, fetch: f.fetchOk }, { ...f.env, storage: chunkedStorage(slow) })
  let client = make()
  for (const name of ['one', 'two', 'three']) {
    client.track(name)
    void client.close()
    client = make()
  }
  client.track('four')
  await client.flush()
  assert.deepEqual(f.sent.map(event => event.event).sort(), ['four', 'one', 'three', 'two'])
  await client.close()
})

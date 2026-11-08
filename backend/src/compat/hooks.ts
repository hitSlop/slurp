import { MAX_RECORD_BYTES, validateRecord } from '../canonical.ts'
import { hmacBytesHex, isoOrUndefined, sha256Hex, timingSafeEqual } from '../util.ts'
import { type CompatHost, BodyTooLarge, ingestFailure, json, readBody } from './common.ts'

/**
 * Webhooks: a provider (GitHub, Stripe, or anything) posts to `/hooks/<provider>?key=<publishable key>`. The key says which project
 * and names the sender (the key is called `github`, so every event from GitHub carries `sender = 'github'`). The provider proves it is
 * the provider with its own signature. For GitHub, RevenueCat and generic the secret is derived from the admin token (so nothing is
 * stored); Stripe chooses its own secret per endpoint, so that one is given to Slurp and kept (see `webhookSecret` in index.ts).
 * RevenueCat has no signature unless you turn on its optional HMAC mode (not supported yet): it sends the value you typed as the
 * `Authorization` header, so the derived secret is that value.
 *
 * The payload is stored exactly as it arrived, as the `data` of one `track` record: its text is spliced into the record, never parsed
 * and re-serialized, so numbers and key order are untouched. Only the event name, the id and the timestamp are read from it.
 */

export const PROVIDERS = ['github', 'stripe', 'revenuecat', 'generic'] as const
export type Provider = (typeof PROVIDERS)[number]
export const isProvider = (value: string): value is Provider => (PROVIDERS as readonly string[]).includes(value)

const STRIPE_TOLERANCE_S = 300
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

export const hookRoute = (path: string): { provider: string } | null => {
  const m = /^\/hooks\/([^/]+)\/?$/.exec(path)
  return m ? { provider: m[1] } : null
}

const sameHex = (a: string, b: string) => timingSafeEqual(a.toLowerCase(), b.toLowerCase())

/** GitHub: `X-Hub-Signature-256: sha256=<HMAC-SHA256 of the raw body>`. */
export async function githubSignatureOk(body: Uint8Array, header: string | null, secret: string): Promise<boolean> {
  if (!header?.startsWith('sha256=')) return false
  return sameHex(header.slice('sha256='.length), await hmacBytesHex(secret, body))
}

/** RevenueCat: the `Authorization` header holds the secret exactly as it was pasted into RevenueCat (a `Bearer ` prefix is tolerated). */
export function authorizationOk(header: string | null, secret: string): boolean {
  if (!header) return false
  const value = header.trim()
  return timingSafeEqual(value.startsWith('Bearer ') ? value.slice('Bearer '.length).trim() : value, secret)
}

/** Stripe: `Stripe-Signature: t=<unix seconds>,v1=<hex>[,v1=<hex>...]`, the HMAC covering `<t>.<raw body>`, within five minutes of now. */
export async function stripeSignatureOk(body: Uint8Array, header: string | null, secret: string, nowMs = Date.now()): Promise<boolean> {
  if (!header) return false
  const parts = header.split(',').map(p => p.trim().split('=') as [string, string])
  const t = parts.find(([k]) => k === 't')?.[1]
  if (!t || !/^\d+$/.test(t) || Math.abs(nowMs / 1000 - Number(t)) > STRIPE_TOLERANCE_S) return false
  const prefix = encoder.encode(`${t}.`)
  const signed = new Uint8Array(prefix.length + body.length)
  signed.set(prefix); signed.set(body, prefix.length)
  const expected = await hmacBytesHex(secret, signed)
  return parts.some(([k, v]) => k === 'v1' && v !== undefined && sameHex(v, expected))
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)
const at = (root: unknown, ...path: string[]): unknown => path.reduce<unknown>((node, key) => (isObject(node) ? node[key] : undefined), root)
const fail = (status: number, error: string) => json(status, { error })

/** Where in each kind of GitHub event the time of the thing that happened is. */
const GITHUB_TIME: Record<string, string[][]> = {
  release: [['release', 'published_at'], ['release', 'created_at']],
  workflow_run: [['workflow_run', 'updated_at']],
  workflow_job: [['workflow_job', 'completed_at'], ['workflow_job', 'started_at']],
  deployment: [['deployment', 'created_at']],
  deployment_status: [['deployment_status', 'updated_at'], ['deployment_status', 'created_at']],
  push: [['head_commit', 'timestamp']],
  pull_request: [['pull_request', 'updated_at']],
  issues: [['issue', 'updated_at']],
}

/** `at` is when the thing happened according to the payload; without one, the time the delivery first arrived is used (see `firstSeen`). */
interface Described { event: string; id: string; delivery: string; at?: string }

export async function hookIngest(req: Request, route: { provider: string }, host: CompatHost): Promise<Response> {
  const provider = route.provider
  if (!isProvider(provider)) return fail(404, 'unknown webhook provider (github, stripe, revenuecat or generic)')
  if (req.method !== 'POST') return json(405, { error: 'method not allowed' }, { Allow: 'POST' })
  const keys = new URL(req.url).searchParams.getAll('key')
  const principal = keys.length === 1 ? await host.publishable(keys[0]) : null
  if (!principal) return fail(401, 'invalid key (the webhook URL carries one publishable key: slurp project webhook shows it)')
  let bytes: Uint8Array
  try { bytes = await readBody(req, host.maxBody) } catch (e) {
    return e instanceof BodyTooLarge ? fail(413, 'body too large') : fail(400, 'unreadable body')
  }

  const secret = await host.webhookSecret(provider, principal.project)
  if (secret === null) return fail(401, 'no signing secret is set for this provider yet; run slurp project webhook PROJECT stripe --secret whsec_...')
  const header = (name: string) => req.headers.get(name)
  if (provider === 'github' && !(await githubSignatureOk(bytes, header('x-hub-signature-256'), secret))) return fail(401, 'bad or missing X-Hub-Signature-256')
  if (provider === 'stripe' && !(await stripeSignatureOk(bytes, header('stripe-signature'), secret))) return fail(401, 'bad, missing or stale Stripe-Signature')
  if (provider === 'revenuecat' && !authorizationOk(header('authorization'), secret)) return fail(401, 'bad or missing Authorization header (paste the secret from slurp project webhook PROJECT revenuecat into RevenueCat)')
  const claimed = header('x-slurp-signature')
  if (provider === 'generic' && claimed !== null && !(await githubSignatureOk(bytes, claimed, secret))) return fail(401, 'bad X-Slurp-Signature')

  let text: string
  try { text = decoder.decode(bytes).trim() } catch { return fail(400, 'the body is not UTF-8 text') }
  let payload: unknown
  let isJson = true
  try { payload = JSON.parse(text) } catch { isJson = false }
  if (provider !== 'generic' && !(isJson && isObject(payload))) {
    return fail(400, provider === 'github' && (header('content-type') ?? '').includes('urlencoded')
      ? 'set the webhook content type to application/json in GitHub'
      : 'the body must be a JSON object')
  }

  const now = Date.now()
  let described: Described
  if (provider === 'github') {
    const kind = header('x-github-event') ?? ''
    if (kind === 'ping') return json(200, { ok: true, ignored: 'ping' })
    if (kind === '') return fail(400, 'missing X-GitHub-Event')
    const action = str(at(payload, 'action'))
    const delivery = header('x-github-delivery') ?? `sha256-${await sha256Hex(bytes)}`
    const when = (GITHUB_TIME[kind] ?? []).map(path => isoOrUndefined(at(payload, ...path))).find(Boolean)
    described = { event: `github.${kind}${action ? `.${action}` : ''}`, id: `github:${delivery}`, delivery, at: when }
  } else if (provider === 'stripe') {
    const id = str(at(payload, 'id')), type = str(at(payload, 'type'))
    if (!id || !type) return fail(400, 'not a Stripe event (no id or type)')
    const created = at(payload, 'created')
    described = { event: `stripe.${type}`, id, delivery: id, at: typeof created === 'number' ? isoOrUndefined(created * 1000) : undefined }
  } else if (provider === 'revenuecat') {
    const id = str(at(payload, 'event', 'id')), type = str(at(payload, 'event', 'type'))
    if (!id || !type) return fail(400, 'not a RevenueCat event (no event.id or event.type)')
    const ms = at(payload, 'event', 'event_timestamp_ms')
    // Retries reuse event.id, so a redelivery is the same event and is stored once.
    described = { event: `revenuecat.${type.toLowerCase()}`, id: `revenuecat:${id}`, delivery: id, at: isoOrUndefined(ms) }
  } else {
    const query = new URL(req.url).searchParams.get('event')
    const named = query || str(at(payload, 'type')) || str(at(payload, 'event')) || 'webhook'
    const supplied = header('idempotency-key') ?? header('x-request-id') ?? header('x-delivery-id')
    const given = supplied && encoder.encode(supplied).length <= 200 ? supplied : null
    const bodyTime = isoOrUndefined(at(payload, 'timestamp'))
    // The id says which deliveries are the same event. A caller's own id does. Without one, a body that carries its own time is the
    // same event when it is identical. A body with neither cannot be told from a repeat of itself (a heartbeat), so each POST is its own
    // event: a retry then costs a duplicate, never a record that conflicts with its first copy.
    const delivery = given ?? (bodyTime ? `sha256-${await sha256Hex(bytes)}` : `post-${crypto.randomUUID()}`)
    described = { event: named, id: `generic:${delivery}`, delivery, at: bodyTime ?? (given ? undefined : new Date(now).toISOString()) }
  }
  // A redelivery must produce the same record, so a delivery without a time of its own keeps the time it first arrived.
  const happened = described.at ?? new Date(await host.firstSeen(principal.project, described.id, now)).toISOString()

  // The payload text goes in as it is. An array is wrapped, and anything that is not JSON (generic only) is kept as text.
  const data = !isJson ? JSON.stringify({ raw: text }) : isObject(payload) ? text : `{"items":${text}}`
  const event = [...described.event].slice(0, 200).join('')
  const line = `{"id":${JSON.stringify(described.id)},"type":"track","event":${JSON.stringify(event)},"timestamp":"${happened}","data":${data},"context":{"webhook":{"provider":"${provider}","delivery":${JSON.stringify(described.delivery)}}}}`
  const record = encoder.encode(line)
  if (record.length > MAX_RECORD_BYTES) return fail(413, 'the payload is larger than 1 MiB; Slurp stores payloads whole, so it is refused')
  const invalid = validateRecord(line)
  if ('reason' in invalid) return fail(400, `the payload cannot be stored: ${invalid.reason}`)

  // Geo is left out on purpose: the caller is the provider's server, not a person.
  const result = await host.ingest(principal, encoder.encode(line + '\n'), null)
  if (!result.ok) return ingestFailure(result)
  return json(200, { ok: true })
}

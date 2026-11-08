import { hmacBytesHex, isoOrUndefined, sha256Hex, timingSafeEqual } from '../util.ts'

/**
 * The webhook providers. Everything that differs between them is here: how a delivery is proven genuine, how the secret is chosen,
 * what the event is called, which id and time it carries, and the setup steps shown to the user. `hooks.ts` is the same for all.
 * A new provider is one entry (its name is also the source its events carry, so it must be a valid source name).
 */
export interface Delivery {
  bytes: Uint8Array
  header(name: string): string | null
  /** The JSON payload when the body is JSON (undefined otherwise). */
  payload: unknown
  query: URLSearchParams
}
export type Described = { event: string; id?: string; delivery?: string; at?: string } | { ignored: string } | { error: string }

export interface Provider {
  /** `generated`: the Worker makes the secret. `issued`: the provider makes it and the user gives it to Slurp. */
  secret: 'generated' | { issued: RegExp; hint: string }
  /** `json-object`: the body must be a JSON object (anything else is kept as text, or wrapped). */
  body: 'json-object' | 'any'
  /** A hint for a body that is not JSON, from its content type. */
  notJson?: (contentType: string) => string | undefined
  /** Why the delivery is not genuine, or null when it is. */
  verify(delivery: Delivery, secret: string, now: number): Promise<string | null>
  describe(delivery: Delivery): Promise<Described>
  /** Setup instructions for the user, shown by `ConnectWebhook`. */
  steps: string[]
}

const encoder = new TextEncoder()
export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)
const at = (root: unknown, ...path: string[]): unknown => path.reduce<unknown>((node, key) => (isObject(node) ? node[key] : undefined), root)
const sameHex = (a: string, b: string) => timingSafeEqual(a.toLowerCase(), b.toLowerCase())
const STRIPE_TOLERANCE_S = 300

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

export const PROVIDERS: Record<string, Provider> = {
  github: {
    secret: 'generated',
    body: 'json-object',
    notJson: contentType => (contentType.includes('urlencoded') ? 'set the webhook content type to application/json in GitHub' : undefined),
    async verify(d, secret) { return (await githubSignatureOk(d.bytes, d.header('x-hub-signature-256'), secret)) ? null : 'bad or missing X-Hub-Signature-256' },
    async describe(d) {
      const kind = d.header('x-github-event') ?? ''
      if (kind === 'ping') return { ignored: 'ping' }
      if (kind === '') return { error: 'missing X-GitHub-Event' }
      const action = str(at(d.payload, 'action'))
      const delivery = d.header('x-github-delivery') ?? `sha256-${await sha256Hex(d.bytes)}`
      const when = (GITHUB_TIME[kind] ?? []).map(path => isoOrUndefined(at(d.payload, ...path))).find(Boolean)
      return { event: `github.${kind}${action ? `.${action}` : ''}`, id: `github:${delivery}`, delivery, at: when }
    },
    steps: [
      'In the repository: Settings > Webhooks > Add webhook.',
      'Payload URL: the url above. Content type: application/json.',
      'Secret: the secret above.',
      'Choose the events to send (Releases, Workflow runs, Deployment statuses are the useful ones), then Add webhook.',
      'To rotate: slurp project key revoke PROJECT KEY_ID, run this command again, and paste the new URL and secret.',
    ],
  },
  stripe: {
    secret: { issued: /^whsec_\S{16,200}$/, hint: 'Stripe chooses the signing secret: reveal it on the endpoint (whsec_...) and run slurp project webhook PROJECT stripe --secret whsec_...' },
    body: 'json-object',
    async verify(d, secret, now) { return (await stripeSignatureOk(d.bytes, d.header('stripe-signature'), secret, now)) ? null : 'bad, missing or stale Stripe-Signature' },
    async describe(d) {
      const id = str(at(d.payload, 'id')), type = str(at(d.payload, 'type'))
      if (!id || !type) return { error: 'not a Stripe event (no id or type)' }
      const created = at(d.payload, 'created')
      return { event: `stripe.${type}`, id, delivery: id, at: typeof created === 'number' ? isoOrUndefined(created * 1000) : undefined }
    },
    steps: [
      'In the Stripe Dashboard: Developers > Webhooks > Add endpoint.',
      'Endpoint URL: the url above.',
      'Select the events to send (invoice.paid, customer.subscription.*, checkout.session.completed).',
      'Stripe chooses the signing secret. Reveal it on the endpoint (whsec_...) and give it to Slurp: slurp project webhook PROJECT stripe --secret whsec_...',
      'Until then the endpoint refuses deliveries.',
      'To rotate: slurp project key revoke PROJECT KEY_ID, run this command again, and paste the new URL and secret.',
    ],
  },
  revenuecat: {
    secret: 'generated',
    body: 'json-object',
    // RevenueCat has no signature unless its optional HMAC mode is on (not supported): it sends the value you typed as `Authorization`.
    async verify(d, secret) { return authorizationOk(d.header('authorization'), secret) ? null : 'bad or missing Authorization header (paste the secret from slurp project webhook PROJECT revenuecat into RevenueCat)' },
    async describe(d) {
      const id = str(at(d.payload, 'event', 'id')), type = str(at(d.payload, 'event', 'type'))
      if (!id || !type) return { error: 'not a RevenueCat event (no event.id or event.type)' }
      // Retries reuse event.id, so a redelivery is the same event.
      return { event: `revenuecat.${type.toLowerCase()}`, id: `revenuecat:${id}`, delivery: id, at: isoOrUndefined(at(d.payload, 'event', 'event_timestamp_ms')) }
    },
    steps: [
      'In RevenueCat: Project settings > Integrations > Webhooks > New.',
      'Webhook URL: the url above.',
      'Authorization header value: the secret above, pasted exactly. RevenueCat sends it on every delivery.',
      'Choose the environment (send both Sandbox and Production if you want test purchases too) and the apps, then use Send test event.',
      "Query the revenue view: SELECT * FROM revenue WHERE environment = 'PRODUCTION'.",
      'To rotate: slurp project key revoke PROJECT KEY_ID, run this command again, and paste the new URL and secret.',
    ],
  },
  generic: {
    secret: 'generated',
    body: 'any',
    // Unsigned by default; when the caller signs, the signature has to be right.
    async verify(d, secret) {
      const claimed = d.header('x-slurp-signature')
      return claimed === null || (await githubSignatureOk(d.bytes, claimed, secret)) ? null : 'bad X-Slurp-Signature'
    },
    async describe(d) {
      const event = d.query.get('event') || str(at(d.payload, 'type')) || str(at(d.payload, 'event')) || 'webhook'
      const supplied = d.header('idempotency-key') ?? d.header('x-request-id') ?? d.header('x-delivery-id')
      const given = supplied && encoder.encode(supplied).length <= 200 ? supplied : undefined
      const at_ = isoOrUndefined(at(d.payload, 'timestamp'))
      // The id says which deliveries are the same event. A caller's own id does. Without one, a body that carries its own time is the
      // same event when it is identical. A body with neither cannot be told from a repeat of itself (a heartbeat), so it has no id and
      // each POST is its own event.
      const delivery = given ?? (at_ ? `sha256-${await sha256Hex(d.bytes)}` : undefined)
      return { event, ...(delivery ? { id: `generic:${delivery}`, delivery } : {}), at: at_ }
    },
    steps: [
      'POST any body to the url above. Name the event with ?event=NAME (or a `type` or `event` field in a JSON body).',
      'Send an Idempotency-Key (or X-Request-Id, X-Delivery-Id) header so a retry of the same POST is one event; without one, each POST is its own event unless the body has a `timestamp`.',
      'Optional: sign the body with HMAC-SHA256 using the secret and send X-Slurp-Signature: sha256=<hex>; a wrong signature is refused.',
      'To rotate: slurp project key revoke PROJECT KEY_ID, run this command again, and paste the new URL and secret.',
    ],
  },
}

export const providerNames = (): string[] => Object.keys(PROVIDERS)
/** "github, stripe, revenuecat or generic", for error messages. */
export const providerList = (): string => { const n = providerNames(); return `${n.slice(0, -1).join(', ')} or ${n[n.length - 1]}` }
export const providerOf = (name: string): Provider | undefined => (Object.hasOwn(PROVIDERS, name) ? PROVIDERS[name] : undefined)

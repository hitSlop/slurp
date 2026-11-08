import { MAX_RECORD_BYTES } from '../record.ts'
import { type Adapter, BodyTooLarge, json, publishable, readBody, submit } from './common.ts'
import { isObject, providerList, providerOf } from './providers.ts'

/**
 * Webhooks: a provider (GitHub, Stripe, or anything) posts to `/hooks/<provider>?key=<publishable key>`. The key's source is the provider
 * name, so every event from GitHub carries `sender = 'github'`. The provider proves it is the provider with its own signature, against the
 * secret stored when the webhook was connected. `providers.ts` holds what differs between providers; this is the same for all of them.
 *
 * The payload is stored exactly as it arrived, as the `data` of one `track` record: its text is spliced into the record, never parsed
 * and re-serialized, so numbers and key order are untouched. Only the event name, id and time are read from it, and a time or id the
 * delivery does not carry is left out, so a redelivery produces the same record. Geo is never added: the caller is the provider's server.
 */

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const fail = (status: number, error: string) => json(status, { error })

export const hooks: Adapter<{ provider: string }> = {
  name: 'webhook',
  match(_method, url) {
    const m = /^\/hooks\/([^/]+)\/?$/.exec(url.pathname)
    return m ? { provider: m[1] } : null
  },

  async handle(req, { provider: name }, host) {
    const provider = providerOf(name)
    if (!provider) return fail(404, `unknown webhook provider (${providerList()})`)
    if (req.method !== 'POST') return json(405, { error: 'method not allowed' }, { Allow: 'POST' })
    const url = new URL(req.url)
    const keys = url.searchParams.getAll('key')
    const principal = keys.length === 1 ? await publishable(host, keys[0]) : null
    if (!principal || principal.source !== name) return fail(401, 'invalid key (the webhook URL carries one publishable key: slurp project webhook shows it)')
    let bytes: Uint8Array
    try { bytes = await readBody(req, host.cfg.maxBodyBytes) } catch (e) {
      return e instanceof BodyTooLarge ? fail(413, 'body too large') : fail(400, 'unreadable body')
    }

    const secret = await host.webhookSecret(principal.project, name)
    if (secret === null) return fail(401, `${name} is not connected to this project; run slurp project webhook PROJECT ${name}`)
    if (secret === '') return fail(401, `no signing secret is set for ${name} yet${typeof provider.secret === 'object' ? `: ${provider.secret.hint}` : ''}`)
    const bad = await provider.verify({ bytes, header: h => req.headers.get(h), payload: undefined, query: url.searchParams }, secret, Date.now())
    if (bad) return fail(401, bad)

    let text: string
    try { text = decoder.decode(bytes).trim() } catch { return fail(400, 'the body is not UTF-8 text') }
    let payload: unknown
    let isJson = true
    try { payload = JSON.parse(text) } catch { isJson = false }
    if (provider.body === 'json-object' && !(isJson && isObject(payload)))
      return fail(400, provider.notJson?.(req.headers.get('content-type') ?? '') ?? 'the body must be a JSON object')

    const d = await provider.describe({ bytes, header: h => req.headers.get(h), payload, query: url.searchParams })
    if ('error' in d) return fail(400, d.error)
    if ('ignored' in d) return json(200, { ok: true, ignored: d.ignored })

    // The payload text goes in as it is. An array is wrapped, and anything that is not JSON (generic only) is kept as text.
    const data = !isJson ? JSON.stringify({ raw: text }) : isObject(payload) ? text : `{"items":${text}}`
    const event = [...d.event].slice(0, 200).join('')
    const webhook = `{"provider":${JSON.stringify(name)}${d.delivery ? `,"delivery":${JSON.stringify(d.delivery)}` : ''}}`
    const line = `{${d.id ? `"id":${JSON.stringify(d.id)},` : ''}"type":"track","event":${JSON.stringify(event)}${d.at ? `,"timestamp":"${d.at}"` : ''},"data":${data},"context":{"webhook":${webhook}}}`
    if (encoder.encode(line).length > MAX_RECORD_BYTES) return fail(413, 'the payload is larger than 1 MiB; Slurp stores payloads whole, so it is refused')

    const result = await submit(host, principal, [{ n: 1, text: line }], { invalid: 'fail', geo: null })
    return result instanceof Response ? result : json(200, { ok: true })
  },
}

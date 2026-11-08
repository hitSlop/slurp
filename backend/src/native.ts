import { presentedToken, projectOfKey } from './auth.ts'
import { type Adapter, BodyTooLarge, json, preflight, readBounded, requestGeo, submit } from './compat/common.ts'
import { splitLines } from './record.ts'

/** `POST /v1/events`: NDJSON records for one project, sent with one of its publishable keys (docs/contracts.md, "Sending events"). */
export const native: Adapter<true> = {
  name: 'ingest',
  match: (_method, url) => (url.pathname === '/v1/events' ? true : null),
  async handle(req, _route, host) {
    if (req.method === 'OPTIONS') return preflight('POST, OPTIONS', 'Authorization, Content-Type')
    if (req.method !== 'POST') return json(405, { error: 'method not allowed' }, { Allow: 'POST, OPTIONS' })
    const token = presentedToken(req, true)
    if (!token) return json(401, { error: 'invalid key' })
    // The key is checked once, by the project's object when it enqueues the events, which is after the body is read: a key revoked
    // while its body was uploading stores nothing. Here only the shape of the key is read, to find the project.
    const project = projectOfKey(token)
    if (!project) { // not a key: the admin token is known but may not send events
      return (await host.authenticate(token)) ? json(403, { error: 'publishable key required' }) : json(401, { error: 'invalid key' })
    }
    // The bytes as sent (no gzip decoding), never read past the limit.
    let body: Uint8Array
    try { body = await readBounded(req, host.cfg.maxBodyBytes, { gunzip: false }) } catch (e) {
      return e instanceof BodyTooLarge ? json(413, { error: 'body too large' }) : json(400, { error: 'unreadable body' })
    }
    const result = await submit(host, { project, token }, splitLines(body), { invalid: 'fail', geo: requestGeo(req) })
    return result instanceof Response ? result : json(200, { ok: true, accepted: result.accepted })
  },
}

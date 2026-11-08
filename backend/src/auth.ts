import type { Principal } from './project.ts'
import { type Env, timingSafeEqual } from './util.ts'

/** Who a request is: the admin, or a stored key of one project. */
export type Auth = { kind: 'admin' } | ({ kind: 'key'; project: string } & Principal)

export const MIN_ADMIN_TOKEN = 20
// A key names its project (hex only, so nothing needs escaping), so a request goes straight to that project's own object.
export const PUBLISHABLE_KEY = /^slurp_pk_([0-9a-f]{16})_([a-z][a-z0-9_]{0,31})_([0-9a-f]{48})$/
export const SECRET_KEY = /^slurp_sk_([0-9a-f]{16})_([0-9a-f]{48})$/

/** A project's object refused to answer (its stored data is newer than this Worker): not "wrong key", but "try again after the deploy". */
export class Unavailable extends Error {}

export const adminConfigured = (env: Env) => !!env.ADMIN_TOKEN && env.ADMIN_TOKEN.length >= MIN_ADMIN_TOKEN
const isAdmin = (token: string, env: Env) => adminConfigured(env) && timingSafeEqual(token, env.ADMIN_TOKEN)

export const bearer = (req: Request) => /^Bearer (.+)$/i.exec(req.headers.get('authorization') ?? '')?.[1] ?? null

/**
 * The credential on a request. Ingest also accepts exactly one publishable key in the query string, which wins over the header
 * (browsers cannot always set headers). `undefined` means the query string carried something that is not allowed.
 */
export function presentedToken(req: Request, allowQueryKey = false): string | null | undefined {
  let token = bearer(req)
  if (allowQueryKey) {
    const q = new URL(req.url).searchParams.getAll('key')
    if (q.length) { if (q.length !== 1 || !PUBLISHABLE_KEY.test(q[0])) return undefined; token = q[0] }
  }
  return token
}

/** The project a key names (from its text only: whether the key is live is the project's to say), or null for anything that is not a key. */
export const projectOfKey = (token: string): string | null => {
  const hex = PUBLISHABLE_KEY.exec(token)?.[1] ?? SECRET_KEY.exec(token)?.[1]
  return hex ? 'prj_' + hex : null
}

/** The principal for a token, or null. The source and label come from the stored key, never from the text of the token. */
export async function authenticate(env: Env, token: string | null | undefined): Promise<Auth | null> {
  if (!token) return null
  if (isAdmin(token, env)) return { kind: 'admin' }
  const project = projectOfKey(token)
  if (!project) return null
  const authorized = await env.PROJECT.get(env.PROJECT.idFromName(project)).authorize(token)
  if (!authorized.ok) throw new Unavailable(authorized.message)
  return authorized.value ? { kind: 'key', project, ...authorized.value } : null
}

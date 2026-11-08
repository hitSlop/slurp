import { projectStub } from './api.ts'
import type { Auth } from './auth.ts'
import type { Env } from './util.ts'

/**
 * Test-only routes, served only when `DEBUG=1` and only to the admin: `/__debug/<op>/<project id>`. They drive one project's Durable Object
 * directly (flush, publish, alarm, sweep), read its internal counters, and inject failures.
 */
export async function debugRoute(req: Request, env: Env, auth: Auth | null): Promise<Response | null> {
  const url = new URL(req.url)
  if (env.DEBUG !== '1' || auth?.kind !== 'admin' || !url.pathname.startsWith('/__debug/')) return null
  const [, , op, id] = url.pathname.split('/')
  const stub = projectStub(env, id)
  const ok = () => Response.json({ ok: true })
  const stats = async () => Response.json(await stub.stats())
  const fault = async (which: 'flush' | 'archive' | 'after-put') => { await stub.fault(which, url.searchParams.get('off') === null); return ok() }
  switch (op) {
    case 'flush': await stub.flush(); return stats()
    case 'publish': await stub.publish(); return stats()
    // `?force=1` publishes even when nothing is due yet; without it this is the alarm exactly as the platform runs it.
    case 'alarm': await stub.runAlarm(url.searchParams.get('force') !== null); return stats()
    case 'sweep': await stub.sweep(); return stats()
    case 'stats': return stats()
    case 'fail-flush': return fault('flush')
    case 'fail-archive': return fault('archive')
    case 'fail-after-put': return fault('after-put')
    case 'heal-archive': await stub.fault('archive', false); return ok()
    default: return null
  }
}

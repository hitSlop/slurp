/// <reference types="@cloudflare/vitest-plugin/types" />
import type { Env as WorkerEnv } from '../../src/util.ts'

// `env` and `exports` from `cloudflare:workers` are typed by these global interfaces (what `wrangler types` would generate).
declare global {
  namespace Cloudflare {
    interface GlobalProps { mainModule: typeof import('../../src/index.ts') }
    interface Env extends WorkerEnv {}
  }
}

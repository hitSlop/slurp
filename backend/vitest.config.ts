import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: { bindings: { ADMIN_TOKEN: 'test-admin-token-0123456789abcdef', GROUP_COMMIT_MS: '20', SEAL_INTERVAL_MS: '3600000', ARCHIVE_RETRY_MS: '60000' } },
    }),
  ],
  test: { include: ['test/worker/**/*.test.ts'] },
})

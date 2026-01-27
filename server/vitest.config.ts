import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: {
            CF_ACCOUNT_ID: 'test-account-id',
            CF_ZONE_ID: 'test-zone-id',
            CF_DOMAIN: 'nport.link',
            CF_API_TOKEN: 'test-api-token',
          },
        },
      },
    },
  },
});

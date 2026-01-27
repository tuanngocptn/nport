import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src/index.js';

// Define the environment type for tests
interface TestEnv {
  CF_ACCOUNT_ID: string;
  CF_ZONE_ID: string;
  CF_DOMAIN: string;
  CF_API_TOKEN?: string;
}

describe('NPort Worker', () => {
  describe('GET requests', () => {
    it('redirects to nport.link (unit style)', async () => {
      const request = new Request('http://example.com');
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, env as TestEnv, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(301);
      expect(response.headers.get('Location')).toBe('https://nport.link/');
    });

    it('redirects to nport.link (integration style)', async () => {
      const response = await SELF.fetch('http://example.com', { redirect: 'manual' });
      expect(response.status).toBe(301);
      expect(response.headers.get('Location')).toBe('https://nport.link/');
    });
  });

  describe('Unsupported methods', () => {
    it('returns 405 for PUT requests', async () => {
      const request = new Request('http://example.com', { method: 'PUT' });
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, env as TestEnv, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(405);
      expect(await response.text()).toBe('Method Not Allowed');
    });

    it('returns 405 for PATCH requests', async () => {
      const request = new Request('http://example.com', { method: 'PATCH' });
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, env as TestEnv, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(405);
    });
  });

  describe('Environment validation', () => {
    it('returns 400 when environment variables are missing', async () => {
      const request = new Request('http://example.com', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subdomain: 'test' }),
      });
      const ctx = createExecutionContext();

      // Use empty env to trigger validation error
      const emptyEnv = {} as TestEnv;
      const response = await worker.fetch(request, emptyEnv, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(400);
      const body = (await response.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toContain('Missing');
    });
  });

  describe('POST requests (tunnel creation)', () => {
    it('returns error for protected subdomain', async () => {
      const request = new Request('http://example.com', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subdomain: 'api' }),
      });
      const ctx = createExecutionContext();

      // Mock env with required variables
      const mockEnv: TestEnv = {
        CF_ACCOUNT_ID: 'test-account',
        CF_ZONE_ID: 'test-zone',
        CF_DOMAIN: 'nport.link',
        CF_API_TOKEN: 'test-token',
      };

      const response = await worker.fetch(request, mockEnv, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(500);
      const body = (await response.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toContain('SUBDOMAIN_PROTECTED');
    });
  });
});

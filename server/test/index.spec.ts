import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import worker, {
  getTunnelMaxAgeMs,
  isTunnelExpired,
  DEFAULT_TUNNEL_MAX_AGE_HOURS,
  type Tunnel,
  type Env,
} from '../src/index.js';

// Define the environment type for tests
interface TestEnv {
  CF_ACCOUNT_ID: string;
  CF_ZONE_ID: string;
  CF_DOMAIN: string;
  CF_API_TOKEN?: string;
  TUNNEL_MAX_AGE_HOURS?: string;
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

  describe('Tunnel max age configuration', () => {
    const baseEnv: Env = {
      CF_ACCOUNT_ID: 'test-account',
      CF_ZONE_ID: 'test-zone',
      CF_DOMAIN: 'nport.link',
      CF_API_TOKEN: 'test-token',
    };

    describe('getTunnelMaxAgeMs', () => {
      it('returns default value when TUNNEL_MAX_AGE_HOURS is not set', () => {
        const result = getTunnelMaxAgeMs(baseEnv);
        expect(result).toBe(DEFAULT_TUNNEL_MAX_AGE_HOURS * 60 * 60 * 1000);
      });

      it('returns custom value when TUNNEL_MAX_AGE_HOURS is set', () => {
        const envWithCustomAge: Env = { ...baseEnv, TUNNEL_MAX_AGE_HOURS: '10' };
        const result = getTunnelMaxAgeMs(envWithCustomAge);
        expect(result).toBe(10 * 60 * 60 * 1000); // 10 hours in ms
      });

      it('supports decimal values for TUNNEL_MAX_AGE_HOURS', () => {
        const envWithDecimal: Env = { ...baseEnv, TUNNEL_MAX_AGE_HOURS: '0.5' };
        const result = getTunnelMaxAgeMs(envWithDecimal);
        expect(result).toBe(0.5 * 60 * 60 * 1000); // 30 minutes in ms
      });

      it('returns default when TUNNEL_MAX_AGE_HOURS is invalid string', () => {
        const envWithInvalid: Env = { ...baseEnv, TUNNEL_MAX_AGE_HOURS: 'invalid' };
        const result = getTunnelMaxAgeMs(envWithInvalid);
        expect(result).toBe(DEFAULT_TUNNEL_MAX_AGE_HOURS * 60 * 60 * 1000);
      });

      it('returns default when TUNNEL_MAX_AGE_HOURS is zero', () => {
        const envWithZero: Env = { ...baseEnv, TUNNEL_MAX_AGE_HOURS: '0' };
        const result = getTunnelMaxAgeMs(envWithZero);
        expect(result).toBe(DEFAULT_TUNNEL_MAX_AGE_HOURS * 60 * 60 * 1000);
      });

      it('returns default when TUNNEL_MAX_AGE_HOURS is negative', () => {
        const envWithNegative: Env = { ...baseEnv, TUNNEL_MAX_AGE_HOURS: '-5' };
        const result = getTunnelMaxAgeMs(envWithNegative);
        expect(result).toBe(DEFAULT_TUNNEL_MAX_AGE_HOURS * 60 * 60 * 1000);
      });
    });

    describe('isTunnelExpired', () => {
      const maxAgeMs = 5 * 60 * 60 * 1000; // 5 hours

      beforeEach(() => {
        vi.useFakeTimers();
      });

      afterEach(() => {
        vi.useRealTimers();
      });

      it('returns false when tunnel has no created_at', () => {
        const tunnel: Tunnel = {
          id: 'test-id',
          name: 'test-tunnel',
          status: 'healthy',
        };
        expect(isTunnelExpired(tunnel, maxAgeMs)).toBe(false);
      });

      it('returns false when tunnel is younger than max age', () => {
        const now = new Date('2025-01-30T12:00:00Z');
        vi.setSystemTime(now);

        const tunnel: Tunnel = {
          id: 'test-id',
          name: 'test-tunnel',
          status: 'healthy',
          created_at: '2025-01-30T10:00:00Z', // 2 hours ago
        };
        expect(isTunnelExpired(tunnel, maxAgeMs)).toBe(false);
      });

      it('returns true when tunnel is older than max age', () => {
        const now = new Date('2025-01-30T12:00:00Z');
        vi.setSystemTime(now);

        const tunnel: Tunnel = {
          id: 'test-id',
          name: 'test-tunnel',
          status: 'healthy',
          created_at: '2025-01-30T06:00:00Z', // 6 hours ago
        };
        expect(isTunnelExpired(tunnel, maxAgeMs)).toBe(true);
      });

      it('returns false when tunnel is exactly at max age', () => {
        const now = new Date('2025-01-30T12:00:00Z');
        vi.setSystemTime(now);

        const tunnel: Tunnel = {
          id: 'test-id',
          name: 'test-tunnel',
          status: 'healthy',
          created_at: '2025-01-30T07:00:00Z', // exactly 5 hours ago
        };
        // At exactly max age, it should NOT be expired (uses > not >=)
        expect(isTunnelExpired(tunnel, maxAgeMs)).toBe(false);
      });

      it('returns true when tunnel is 1ms over max age', () => {
        const now = new Date('2025-01-30T12:00:00.001Z');
        vi.setSystemTime(now);

        const tunnel: Tunnel = {
          id: 'test-id',
          name: 'test-tunnel',
          status: 'healthy',
          created_at: '2025-01-30T07:00:00Z', // 5 hours + 1ms ago
        };
        expect(isTunnelExpired(tunnel, maxAgeMs)).toBe(true);
      });
    });
  });
});

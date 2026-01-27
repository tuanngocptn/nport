import { describe, it, expect, beforeEach } from 'vitest';
import { state } from '../src/state.js';

describe('TunnelState', () => {
  beforeEach(() => {
    state.reset();
  });

  describe('setTunnel', () => {
    it('should set tunnel information', () => {
      state.setTunnel('tunnel-123', 'myapp', 3000, 'https://api.example.com');
      
      expect(state.tunnelId).toBe('tunnel-123');
      expect(state.subdomain).toBe('myapp');
      expect(state.port).toBe(3000);
      expect(state.backendUrl).toBe('https://api.example.com');
    });

    it('should set startTime on first call', () => {
      expect(state.startTime).toBeNull();
      
      state.setTunnel('tunnel-123', 'myapp', 3000);
      
      expect(state.startTime).toBeGreaterThan(0);
    });

    it('should not reset startTime on subsequent calls', () => {
      state.setTunnel('tunnel-123', 'myapp', 3000);
      const firstStartTime = state.startTime;
      
      state.setTunnel('tunnel-456', 'myapp2', 4000);
      
      expect(state.startTime).toBe(firstStartTime);
    });
  });

  describe('hasTunnel', () => {
    it('should return false when no tunnel is set', () => {
      expect(state.hasTunnel()).toBe(false);
    });

    it('should return true when tunnel is set', () => {
      state.setTunnel('tunnel-123', 'myapp', 3000);
      expect(state.hasTunnel()).toBe(true);
    });
  });

  describe('incrementConnection', () => {
    it('should increment and return connection count', () => {
      expect(state.incrementConnection()).toBe(1);
      expect(state.incrementConnection()).toBe(2);
      expect(state.incrementConnection()).toBe(3);
    });
  });

  describe('getDurationSeconds', () => {
    it('should return 0 when not started', () => {
      expect(state.getDurationSeconds()).toBe(0);
    });

    it('should return positive duration when started', () => {
      state.setTunnel('tunnel-123', 'myapp', 3000);
      
      // Wait a tiny bit
      const duration = state.getDurationSeconds();
      expect(duration).toBeGreaterThanOrEqual(0);
    });
  });

  describe('network issue tracking', () => {
    it('should increment network issues', () => {
      expect(state.incrementNetworkIssue()).toBe(1);
      expect(state.incrementNetworkIssue()).toBe(2);
    });

    it('should reset network issues', () => {
      state.incrementNetworkIssue();
      state.incrementNetworkIssue();
      state.resetNetworkIssues();
      
      expect(state.incrementNetworkIssue()).toBe(1);
    });

    it('should determine when to show warning', () => {
      // Below threshold
      for (let i = 0; i < 4; i++) {
        state.incrementNetworkIssue();
      }
      expect(state.shouldShowNetworkWarning(5, 30000)).toBe(false);
      
      // At threshold
      state.incrementNetworkIssue();
      expect(state.shouldShowNetworkWarning(5, 30000)).toBe(true);
      
      // Should not show again immediately (cooldown)
      state.incrementNetworkIssue();
      expect(state.shouldShowNetworkWarning(5, 30000)).toBe(false);
    });
  });

  describe('reset', () => {
    it('should reset all state', () => {
      state.setTunnel('tunnel-123', 'myapp', 3000, 'https://api.example.com');
      state.incrementConnection();
      state.incrementNetworkIssue();
      
      state.reset();
      
      expect(state.tunnelId).toBeNull();
      expect(state.subdomain).toBeNull();
      expect(state.port).toBeNull();
      expect(state.backendUrl).toBeNull();
      expect(state.startTime).toBeNull();
      expect(state.hasTunnel()).toBe(false);
    });
  });
});

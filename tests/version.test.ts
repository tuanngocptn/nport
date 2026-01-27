import { describe, it, expect } from 'vitest';
import { VersionManager } from '../src/version.js';

describe('VersionManager', () => {
  describe('compareVersions', () => {
    it('should return 1 when v1 > v2', () => {
      expect(VersionManager.compareVersions('2.0.7', '2.0.6')).toBe(1);
      expect(VersionManager.compareVersions('2.1.0', '2.0.9')).toBe(1);
      expect(VersionManager.compareVersions('3.0.0', '2.9.9')).toBe(1);
    });

    it('should return -1 when v1 < v2', () => {
      expect(VersionManager.compareVersions('2.0.6', '2.0.7')).toBe(-1);
      expect(VersionManager.compareVersions('2.0.9', '2.1.0')).toBe(-1);
      expect(VersionManager.compareVersions('2.9.9', '3.0.0')).toBe(-1);
    });

    it('should return 0 when v1 === v2', () => {
      expect(VersionManager.compareVersions('2.0.7', '2.0.7')).toBe(0);
      expect(VersionManager.compareVersions('1.0.0', '1.0.0')).toBe(0);
    });

    it('should handle different version lengths', () => {
      expect(VersionManager.compareVersions('1.0', '1.0.0')).toBe(0);
      expect(VersionManager.compareVersions('1.0.0', '1.0')).toBe(0);
      expect(VersionManager.compareVersions('1.0.1', '1.0')).toBe(1);
      expect(VersionManager.compareVersions('1.0', '1.0.1')).toBe(-1);
    });

    it('should handle major version differences', () => {
      expect(VersionManager.compareVersions('10.0.0', '9.9.9')).toBe(1);
      expect(VersionManager.compareVersions('2.0.0', '1.999.999')).toBe(1);
    });
  });
});

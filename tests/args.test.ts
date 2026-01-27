import { describe, it, expect } from 'vitest';
import { ArgumentParser } from '../src/args.js';

describe('ArgumentParser', () => {
  describe('parse', () => {
    it('should parse port as first argument', () => {
      const result = ArgumentParser.parse(['3000']);
      expect(result.port).toBe(3000);
    });

    it('should use default port when not provided', () => {
      const result = ArgumentParser.parse([]);
      expect(result.port).toBe(8080);
    });

    it('should use default port for invalid port', () => {
      const result = ArgumentParser.parse(['abc']);
      expect(result.port).toBe(8080);
    });
  });

  describe('parseSubdomain', () => {
    it('should parse --subdomain flag', () => {
      const result = ArgumentParser.parse(['3000', '--subdomain', 'myapp']);
      expect(result.subdomain).toBe('myapp');
    });

    it('should parse -s flag', () => {
      const result = ArgumentParser.parse(['3000', '-s', 'myapp']);
      expect(result.subdomain).toBe('myapp');
    });

    it('should parse --subdomain=value format', () => {
      const result = ArgumentParser.parse(['3000', '--subdomain=myapp']);
      expect(result.subdomain).toBe('myapp');
    });

    it('should parse -s=value format', () => {
      const result = ArgumentParser.parse(['3000', '-s=myapp']);
      expect(result.subdomain).toBe('myapp');
    });

    it('should generate random subdomain when not provided', () => {
      const result = ArgumentParser.parse(['3000']);
      expect(result.subdomain).toMatch(/^user-\d+$/);
    });
  });

  describe('parseLanguage', () => {
    it('should parse --language flag with value', () => {
      const result = ArgumentParser.parse(['3000', '--language', 'vi']);
      expect(result.language).toBe('vi');
    });

    it('should parse -l flag with value', () => {
      const result = ArgumentParser.parse(['3000', '-l', 'en']);
      expect(result.language).toBe('en');
    });

    it('should return prompt when --language flag has no value', () => {
      const result = ArgumentParser.parse(['--language']);
      expect(result.language).toBe('prompt');
    });

    it('should return prompt when -l flag has no value', () => {
      const result = ArgumentParser.parse(['-l']);
      expect(result.language).toBe('prompt');
    });

    it('should return null when not provided', () => {
      const result = ArgumentParser.parse(['3000']);
      expect(result.language).toBeNull();
    });
  });

  describe('parseBackendUrl', () => {
    it('should parse --backend flag', () => {
      const result = ArgumentParser.parse(['3000', '--backend', 'https://custom.api.com']);
      expect(result.backendUrl).toBe('https://custom.api.com');
    });

    it('should parse -b flag', () => {
      const result = ArgumentParser.parse(['3000', '-b', 'https://custom.api.com']);
      expect(result.backendUrl).toBe('https://custom.api.com');
    });

    it('should parse --backend=value format', () => {
      const result = ArgumentParser.parse(['3000', '--backend=https://custom.api.com']);
      expect(result.backendUrl).toBe('https://custom.api.com');
    });

    it('should return null when not provided', () => {
      const result = ArgumentParser.parse(['3000']);
      expect(result.backendUrl).toBeNull();
    });
  });

  describe('parseSetBackend', () => {
    it('should parse --set-backend flag with value', () => {
      const result = ArgumentParser.parse(['--set-backend', 'https://custom.api.com']);
      expect(result.setBackend).toBe('https://custom.api.com');
    });

    it('should return clear when --set-backend has no value', () => {
      const result = ArgumentParser.parse(['--set-backend']);
      expect(result.setBackend).toBe('clear');
    });

    it('should return null when not provided', () => {
      const result = ArgumentParser.parse(['3000']);
      expect(result.setBackend).toBeNull();
    });
  });

  describe('complex arguments', () => {
    it('should parse multiple flags together', () => {
      const result = ArgumentParser.parse([
        '4000',
        '-s', 'myapp',
        '-l', 'vi',
        '-b', 'https://custom.api.com'
      ]);
      
      expect(result.port).toBe(4000);
      expect(result.subdomain).toBe('myapp');
      expect(result.language).toBe('vi');
      expect(result.backendUrl).toBe('https://custom.api.com');
    });
  });
});

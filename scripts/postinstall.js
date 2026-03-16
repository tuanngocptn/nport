#!/usr/bin/env node

/**
 * Post-install script
 * 
 * Runs bin-manager to download cloudflared binary if dist/ exists.
 * Silently skips if dist/ doesn't exist (e.g., during development before build).
 */

import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const binManagerPath = join(__dirname, '..', 'dist', 'bin-manager.js');

if (existsSync(binManagerPath)) {
  import(binManagerPath)
    .then((mod) => {
      if (typeof mod.ensureCloudflared === 'function') {
        return mod.ensureCloudflared();
      }
    })
    .catch((err) => {
      console.warn(`⚠️  Failed to download cloudflared binary during install: ${err?.message || err}`);
      console.warn('   The binary will be downloaded automatically on first run.');
      console.warn('   If the issue persists, try: npm uninstall -g nport && npm install -g nport');
    });
} else {
  console.log('ℹ️  Skipping binary download (run "npm run build" first for development)');
}

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
  // Dynamic import to run the bin-manager
  import(binManagerPath).catch(() => {
    // Silently fail if import fails
  });
} else {
  // For development: dist/ doesn't exist yet, skip silently
  console.log('ℹ️  Skipping binary download (run "npm run build" first for development)');
}

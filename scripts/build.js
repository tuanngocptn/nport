#!/usr/bin/env node

/**
 * Build script for NPort CLI
 * 
 * Uses esbuild to bundle and minify the CLI into a single file.
 * This significantly reduces package size by:
 * - Bundling all source files into one
 * - Minifying the output
 * - Tree-shaking unused code
 * - Excluding source maps
 */

import * as esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');

const isWatch = process.argv.includes('--watch');

/** @type {esbuild.BuildOptions} */
const sharedOptions = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  minify: true,
  sourcemap: false,
  // Mark dependencies as external - they're installed via npm
  // This avoids CJS/ESM compatibility issues with axios internals
  external: ['axios', 'chalk', 'ora'],
  treeShaking: true,
  keepNames: true,
  metafile: true,
};

// Main CLI entry point
/** @type {esbuild.BuildOptions} */
const mainBuildOptions = {
  ...sharedOptions,
  entryPoints: [path.join(rootDir, 'src/index.ts')],
  outfile: path.join(rootDir, 'dist/index.js'),
  banner: {
    js: '#!/usr/bin/env node',
  },
};

// Bin-manager for postinstall (downloads cloudflared binary)
/** @type {esbuild.BuildOptions} */
const binManagerOptions = {
  ...sharedOptions,
  entryPoints: [path.join(rootDir, 'src/bin-manager.ts')],
  outfile: path.join(rootDir, 'dist/bin-manager.js'),
  external: [], // bin-manager doesn't use axios/chalk/ora
};

async function build() {
  try {
    // Clean and recreate dist directory
    const distDir = path.join(rootDir, 'dist');
    if (fs.existsSync(distDir)) {
      fs.rmSync(distDir, { recursive: true });
    }
    fs.mkdirSync(distDir, { recursive: true });

    if (isWatch) {
      console.log('👀 Watching for changes...\n');
      
      // Disable minification in watch mode for faster rebuilds
      const watchMainOptions = { ...mainBuildOptions, minify: false };
      const watchBinOptions = { ...binManagerOptions, minify: false };
      
      // Watch both entry points
      const [mainCtx, binCtx] = await Promise.all([
        esbuild.context(watchMainOptions),
        esbuild.context(watchBinOptions),
      ]);
      
      await Promise.all([
        mainCtx.watch(),
        binCtx.watch(),
      ]);
      
      console.log('   Watching: src/index.ts → dist/index.js');
      console.log('   Watching: src/bin-manager.ts → dist/bin-manager.js\n');
    } else {
      console.log('🔨 Building NPort CLI...\n');
      
      // Build main CLI and bin-manager in parallel
      const [mainResult, binManagerResult] = await Promise.all([
        esbuild.build(mainBuildOptions),
        esbuild.build(binManagerOptions),
      ]);
      
      // Output build stats
      const mainFile = path.join(rootDir, 'dist/index.js');
      const binFile = path.join(rootDir, 'dist/bin-manager.js');
      const mainSize = (fs.statSync(mainFile).size / 1024).toFixed(2);
      const binSize = (fs.statSync(binFile).size / 1024).toFixed(2);
      const totalSize = (parseFloat(mainSize) + parseFloat(binSize)).toFixed(2);
      
      console.log(`✅ Build complete!`);
      console.log(`📦 dist/index.js:       ${mainSize} KB`);
      console.log(`📦 dist/bin-manager.js: ${binSize} KB`);
      console.log(`📊 Total size:          ${totalSize} KB\n`);
      
      // Show what was bundled in main
      if (mainResult.metafile) {
        const inputs = Object.keys(mainResult.metafile.inputs);
        const sourceFiles = inputs.filter(f => f.startsWith('src/'));
        console.log(`   Source files: ${sourceFiles.length}`);
      }
    }
  } catch (error) {
    console.error('❌ Build failed:', error.message);
    process.exit(1);
  }
}

build();

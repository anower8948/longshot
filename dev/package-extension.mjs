#!/usr/bin/env node
/**
 * Validates the manifest and zips the extension for the Chrome Web Store.
 *
 *   node dev/package-extension.mjs   →  dev/dist/longshot-<version>.zip
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEV = dirname(fileURLToPath(import.meta.url));
const EXTENSION = join(DEV, '..', 'longshot');
const manifest = JSON.parse(readFileSync(join(EXTENSION, 'manifest.json'), 'utf8'));

// Every file the manifest references must exist.
const referenced = [
  manifest.background.service_worker,
  manifest.action.default_popup,
  manifest.options_page,
  ...Object.values(manifest.icons),
  ...Object.values(manifest.action.default_icon),
];
const missing = referenced.filter((file) => !existsSync(join(EXTENSION, file)));
if (missing.length) {
  console.error(`Missing files referenced by manifest.json: ${missing.join(', ')}`);
  process.exit(1);
}
if (manifest.manifest_version !== 3) {
  console.error('manifest_version must be 3');
  process.exit(1);
}

const dist = join(DEV, 'dist');
mkdirSync(dist, { recursive: true });
const output = join(dist, `longshot-${manifest.version}.zip`);
rmSync(output, { force: true });
execFileSync('zip', ['-r', '-X', output, '.', '-x', '*.DS_Store'], { cwd: EXTENSION, stdio: 'inherit' });
console.log(`\nPackaged ${output}`);

#!/usr/bin/env node

/**
 * Generates the checksum manifest used to verify native binary downloads.
 *
 * Usage:
 *   node scripts/generate-native-manifest.js <directory-with-release-assets>
 */

import { createHash } from 'crypto';
import { readFileSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { BINARY_MANIFEST_PATH, EXPECTED_BINARY_NAMES, GITHUB_REPO } from './native-binary.js';

const assetDir = process.argv[2] || 'bin';
const binaries = {};
const missing = [];

for (const name of EXPECTED_BINARY_NAMES) {
  const path = join(assetDir, name);
  try {
    const contents = readFileSync(path);
    binaries[name] = {
      sha256: createHash('sha256').update(contents).digest('hex'),
      size: statSync(path).size,
    };
  } catch {
    missing.push(name);
  }
}

if (missing.length > 0) {
  console.error('Missing release assets for checksum manifest:');
  for (const name of missing) {
    console.error(`  ${name}`);
  }
  process.exit(1);
}

const manifest = {
  version: 1,
  repo: GITHUB_REPO,
  binaries,
};

writeFileSync(BINARY_MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote native binary checksum manifest: ${BINARY_MANIFEST_PATH}`);

#!/usr/bin/env node

/**
 * Verifies that the npm package ships the JS launcher, install scripts, and
 * checksum manifest, but not the platform-specific native binaries. Those
 * binaries are release assets and are downloaded for the current platform.
 */

import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { BINARY_MANIFEST_PATH, EXPECTED_BINARY_NAMES } from './native-binary.js';

const npmCache = mkdtempSync(join(tmpdir(), 'agent-browser-npm-cache-'));
let output;
try {
  output = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      NPM_CONFIG_CACHE: npmCache,
      npm_config_cache: npmCache,
    },
  });
} finally {
  rmSync(npmCache, { recursive: true, force: true });
}
const packs = JSON.parse(output);
const pack = packs[0];

if (!pack || !Array.isArray(pack.files)) {
  console.error('Could not inspect npm package contents');
  process.exit(1);
}

const files = pack.files.map(file => file.path);
const fileSet = new Set(files);
const requiredFiles = [
  'bin/agent-browser.js',
  'scripts/postinstall.js',
  'scripts/native-binary.js',
  'scripts/native-binaries.json',
  'package.json',
  'README.md',
];
const missing = requiredFiles.filter(file => !fileSet.has(file));
const forbidden = files.filter(file =>
  /^bin\/agent-browser-(?:darwin|linux|linux-musl|win32)/.test(file)
);
const maxUnpackedSize = 1_000_000;

if (missing.length > 0) {
  console.error('npm package is missing required files:');
  for (const file of missing) {
    console.error(`  ${file}`);
  }
  process.exit(1);
}

if (forbidden.length > 0) {
  console.error('npm package includes native binaries that should stay on GitHub Releases:');
  for (const file of forbidden) {
    console.error(`  ${file}`);
  }
  process.exit(1);
}

if (pack.unpackedSize > maxUnpackedSize) {
  console.error(
    `npm package is too large: ${pack.unpackedSize} bytes, expected <= ${maxUnpackedSize}`
  );
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(BINARY_MANIFEST_PATH, 'utf8'));
const invalidManifestEntries = EXPECTED_BINARY_NAMES.filter((name) => {
  const entry = manifest.binaries?.[name];
  return (
    !entry ||
    typeof entry.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(entry.sha256) ||
    !Number.isInteger(entry.size) ||
    entry.size <= 100000
  );
});

if (invalidManifestEntries.length > 0) {
  console.error('native binary checksum manifest is missing valid entries:');
  for (const file of invalidManifestEntries) {
    console.error(`  ${file}`);
  }
  process.exit(1);
}

console.log(
  `npm package contents OK: ${files.length} files, ${pack.unpackedSize} bytes unpacked`
);

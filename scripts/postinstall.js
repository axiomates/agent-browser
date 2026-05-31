#!/usr/bin/env node

/**
 * Postinstall script for agent-browser.
 *
 * Downloads and verifies the platform-specific native binary from the matching
 * GitHub release. The npm package intentionally ships only the JS launcher,
 * checksum manifest, and install scripts so installs do not download binaries
 * for other platforms.
 *
 * On global installs, and on local installs when the package manager has already
 * created a .bin link, patches the command entry to use the native binary
 * directly for zero-overhead startup.
 */

import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { platform } from 'os';
import {
  ensureNativeBinary,
  hasUsableBinary,
  isSourceCheckout,
  optimizeCommandLinks,
  writeInstallMethod,
} from './native-binary.js';

async function main() {
  let result;
  try {
    result = await ensureNativeBinary();
  } catch (err) {
    console.log(`Could not prepare native binary: ${err.message}`);
    console.log('');
    console.log('The npm package downloads the native binary from GitHub Releases during install.');
    console.log('Reinstall the package to retry the download.');

    if (isSourceCheckout()) {
      console.log('');
      console.log('For a source checkout, you can also build the native binary locally:');
      console.log('  1. Install Rust: https://rustup.rs');
      console.log('  2. Run: pnpm run build:native');
      console.log('');
      console.log('Continuing because this looks like a source checkout.');
    } else {
      process.exitCode = 1;
      return;
    }
  }

  writeInstallMethod();

  if (result && hasUsableBinary(result.binaryPath)) {
    optimizeCommandLinks({ binaryPath: result.binaryPath });
  }

  showInstallReminder();
}

function findSystemChrome() {
  const os = platform();
  if (os === 'darwin') {
    const candidates = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
    return candidates.find(p => existsSync(p)) || null;
  }
  if (os === 'linux') {
    const names = ['google-chrome', 'google-chrome-stable', 'chromium-browser', 'chromium'];
    for (const name of names) {
      try {
        const foundPath = execSync(`which ${name} 2>/dev/null`, { encoding: 'utf8' }).trim();
        if (foundPath) return foundPath;
      } catch {}
    }
    return null;
  }
  if (os === 'win32') {
    const candidates = [
      `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ];
    return candidates.find(p => p && existsSync(p)) || null;
  }
  return null;
}

function showInstallReminder() {
  const systemChrome = findSystemChrome();
  if (systemChrome) {
    console.log('');
    console.log(`  ✓ System Chrome found: ${systemChrome}`);
    console.log('    agent-browser will use it automatically.');
    console.log('');
    return;
  }

  console.log('');
  console.log('  ⚠ No Chrome installation detected.');
  console.log('  If you plan to use a local browser, run:');
  console.log('');
  console.log('    agent-browser install');
  if (platform() === 'linux') {
    console.log('');
    console.log('  On Linux, include system dependencies with:');
    console.log('');
    console.log('    agent-browser install --with-deps');
  }
  console.log('');
  console.log('  You can skip this if you use --cdp, --provider, --engine, or --executable-path.');
  console.log('');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

#!/usr/bin/env node

/**
 * Cross-platform CLI bootstrap for agent-browser.
 *
 * Normal installs patch the agent-browser command to point directly at the
 * native binary during postinstall. If lifecycle scripts were disabled, this
 * launcher downloads and verifies the native binary on first run, patches the
 * command link or shim, then delegates to the native binary for the current
 * command.
 */

import { spawn } from 'child_process';
import { arch, platform } from 'os';
import {
  ensureNativeBinary,
  getBinaryName,
  getBinaryPath,
  getDownloadUrl,
  isSourceCheckout,
  optimizeCommandLinks,
  packageVersion,
  projectRoot,
} from '../scripts/native-binary.js';

async function main() {
  const binaryName = getBinaryName();

  if (!binaryName) {
    console.error(`Error: Unsupported platform: ${platform()}-${arch()}`);
    process.exit(1);
  }

  let binaryPath = getBinaryPath(projectRoot, binaryName);
  try {
    const result = await ensureNativeBinary({
      binaryName,
      log: message => console.error(message),
      quietExisting: true,
    });
    binaryPath = result.binaryPath;
    optimizeCommandLinks({
      binaryPath,
      invokedPath: process.argv[1],
      log: message => console.error(message),
    });
  } catch (err) {
    console.error(`Error: No native binary available for ${platform()}-${arch()}`);
    console.error(`Expected: ${binaryPath}`);
    console.error('');
    console.error(`Reason: ${err.message}`);
    console.error('');
    console.error('The native binary is downloaded during npm postinstall or first run.');
    console.error('Reinstall this package to retry the install-time download.');
    try {
      console.error('');
      console.error('Manual download:');
      console.error(`  ${getDownloadUrl(binaryName, packageVersion(projectRoot))}`);
    } catch {
      // Best effort only.
    }
    if (isSourceCheckout()) {
      console.error('');
      console.error('For a source checkout, run "pnpm run build:native".');
    }
    process.exit(1);
  }

  const child = spawn(binaryPath, process.argv.slice(2), {
    stdio: 'inherit',
    windowsHide: false,
  });

  child.on('error', (err) => {
    console.error(`Error executing binary: ${err.message}`);
    process.exit(1);
  });

  child.on('close', (code) => {
    process.exit(code ?? 0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

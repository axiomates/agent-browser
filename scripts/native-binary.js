#!/usr/bin/env node

/**
 * Shared native binary bootstrap utilities.
 *
 * The npm package ships a small JavaScript launcher and downloads exactly one
 * platform binary from GitHub Releases. Both postinstall and first-run fallback
 * use this module so lifecycle-disabled installs can recover without keeping all
 * platform binaries in the npm tarball.
 */

import { execSync } from 'child_process';
import {
  accessSync,
  chmodSync,
  constants,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { createHash } from 'crypto';
import { get } from 'https';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { arch, platform } from 'os';
import { basename, dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const projectRoot = join(__dirname, '..');
export const binDir = join(projectRoot, 'bin');
export const GITHUB_REPO = 'vercel-labs/agent-browser';
export const BINARY_MANIFEST_PATH = join(projectRoot, 'scripts', 'native-binaries.json');
export const EXPECTED_BINARY_NAMES = [
  'agent-browser-linux-x64',
  'agent-browser-linux-arm64',
  'agent-browser-linux-musl-x64',
  'agent-browser-linux-musl-arm64',
  'agent-browser-win32-x64.exe',
  'agent-browser-darwin-x64',
  'agent-browser-darwin-arm64',
];

export function hasUsableBinary(path) {
  try {
    return statSync(path).size > 0;
  } catch {
    return false;
  }
}

export function isSourceCheckout(root = projectRoot) {
  return existsSync(join(root, 'cli', 'Cargo.toml'));
}

export function packageVersion(root = projectRoot) {
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  return packageJson.version;
}

export function isMusl() {
  if (platform() !== 'linux') return false;
  try {
    const result = execSync('ldd --version 2>&1 || true', { encoding: 'utf8' });
    return result.toLowerCase().includes('musl');
  } catch {
    return existsSync('/lib/ld-musl-x86_64.so.1') || existsSync('/lib/ld-musl-aarch64.so.1');
  }
}

export function getBinaryName() {
  const os = platform();
  const cpuArch = arch();

  let osKey;
  switch (os) {
    case 'darwin':
      osKey = 'darwin';
      break;
    case 'linux':
      osKey = isMusl() ? 'linux-musl' : 'linux';
      break;
    case 'win32':
      osKey = 'win32';
      break;
    default:
      return null;
  }

  let archKey;
  switch (cpuArch) {
    case 'x64':
    case 'x86_64':
      archKey = 'x64';
      break;
    case 'arm64':
    case 'aarch64':
      archKey = 'arm64';
      break;
    default:
      return null;
  }

  const ext = os === 'win32' ? '.exe' : '';
  return `agent-browser-${osKey}-${archKey}${ext}`;
}

export function getBinaryPath(root = projectRoot, binaryName = getBinaryName()) {
  return binaryName ? join(root, 'bin', binaryName) : null;
}

export function getDownloadUrl(binaryName, version = packageVersion()) {
  return `https://github.com/${GITHUB_REPO}/releases/download/v${version}/${binaryName}`;
}

export function loadBinaryManifest(root = projectRoot) {
  const manifestPath = join(root, 'scripts', 'native-binaries.json');
  return JSON.parse(readFileSync(manifestPath, 'utf8'));
}

export function getManifestEntry(binaryName, root = projectRoot) {
  const manifest = loadBinaryManifest(root);
  return manifest.binaries?.[binaryName] ?? null;
}

function cleanupFile(path) {
  try {
    unlinkSync(path);
  } catch {
    // Best effort cleanup only.
  }
}

async function getResponse(url, redirects = 0) {
  return new Promise((resolveResponse, rejectResponse) => {
    get(url, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.resume();
        if (redirects >= 5 || !response.headers.location) {
          rejectResponse(new Error('Too many redirects while downloading native binary'));
          return;
        }
        const nextUrl = new URL(response.headers.location, url).toString();
        resolveResponse(getResponse(nextUrl, redirects + 1));
        return;
      }

      if (response.statusCode !== 200) {
        response.resume();
        rejectResponse(new Error(`Failed to download: HTTP ${response.statusCode}`));
        return;
      }

      resolveResponse(response);
    }).on('error', rejectResponse);
  });
}

async function downloadFile(url, dest, expected) {
  const tmpDest = `${dest}.download-${process.pid}-${Date.now()}`;

  try {
    const response = await getResponse(url);
    const hash = createHash('sha256');
    const hashStream = new Transform({
      transform(chunk, _encoding, callback) {
        hash.update(chunk);
        callback(null, chunk);
      },
    });

    await pipeline(response, hashStream, createWriteStream(tmpDest, { flags: 'wx' }));

    const actualSha256 = hash.digest('hex');
    const actualSize = statSync(tmpDest).size;
    if (expected.size != null && actualSize !== expected.size) {
      throw new Error(
        `Downloaded binary size mismatch: got ${actualSize} bytes, expected ${expected.size}`
      );
    }
    if (actualSha256 !== expected.sha256) {
      throw new Error(
        `Downloaded binary checksum mismatch: got ${actualSha256}, expected ${expected.sha256}`
      );
    }

    renameSync(tmpDest, dest);
  } catch (err) {
    cleanupFile(tmpDest);
    cleanupFile(dest);
    throw err;
  }
}

export function ensureExecutable(binaryPath) {
  if (platform() === 'win32') return;
  try {
    accessSync(binaryPath, constants.X_OK);
  } catch {
    chmodSync(binaryPath, 0o755);
  }
}

export async function ensureNativeBinary(options = {}) {
  const {
    root = projectRoot,
    log = console.log,
    quietExisting = false,
    binaryName = getBinaryName(),
  } = options;

  if (!binaryName) {
    throw new Error(`Unsupported platform: ${platform()}-${arch()}`);
  }

  const binaryPath = getBinaryPath(root, binaryName);
  if (hasUsableBinary(binaryPath)) {
    ensureExecutable(binaryPath);
    if (!quietExisting) {
      log(`✓ Native binary ready: ${binaryName}`);
    }
    return { binaryName, binaryPath, downloaded: false };
  }

  const version = packageVersion(root);
  const downloadUrl = getDownloadUrl(binaryName, version);
  let manifestEntry;
  try {
    manifestEntry = getManifestEntry(binaryName, root);
  } catch (err) {
    throw new Error(`Could not read native binary checksum manifest: ${err.message}`);
  }
  if (!manifestEntry?.sha256) {
    throw new Error(`No checksum manifest entry for ${binaryName}`);
  }

  mkdirSync(dirname(binaryPath), { recursive: true });
  log(`Downloading native binary for ${platform()}-${arch()}...`);
  log(`URL: ${downloadUrl}`);

  await downloadFile(downloadUrl, binaryPath, manifestEntry);
  ensureExecutable(binaryPath);
  log(`✓ Downloaded and verified native binary: ${binaryName}`);

  return { binaryName, binaryPath, downloaded: true };
}

export function writeInstallMethod(root = projectRoot) {
  const ua = process.env.npm_config_user_agent || '';
  let method = '';
  if (ua.startsWith('pnpm/')) method = 'pnpm';
  else if (ua.startsWith('yarn/')) method = 'yarn';
  else if (ua.startsWith('bun/')) method = 'bun';
  else if (ua.startsWith('npm/')) method = 'npm';

  if (method) {
    try {
      writeFileSync(join(root, 'bin', '.install-method'), method);
    } catch {
      // Non-critical. The Rust upgrade command falls back to heuristics.
    }
  }
}

function addCandidate(set, candidate) {
  if (candidate) set.add(resolve(candidate));
}

function unixBinLinkCandidates(root, invokedPath) {
  const candidates = new Set();
  if (invokedPath && basename(invokedPath) === 'agent-browser') {
    addCandidate(candidates, invokedPath);
  }

  try {
    const prefix = execSync('npm prefix -g', { encoding: 'utf8' }).trim();
    addCandidate(candidates, join(prefix, 'bin', 'agent-browser'));
  } catch {
    // npm may not be available.
  }

  addCandidate(candidates, join(root, '..', '.bin', 'agent-browser'));
  if (process.env.INIT_CWD) {
    addCandidate(candidates, join(process.env.INIT_CWD, 'node_modules', '.bin', 'agent-browser'));
  }

  return [...candidates];
}

function replaceUnixSymlink(linkPath, binaryPath) {
  let stat;
  try {
    stat = lstatSync(linkPath);
  } catch {
    return false;
  }
  if (!stat.isSymbolicLink()) {
    return false;
  }

  const currentTarget = readlinkSync(linkPath);
  const resolvedTarget = resolve(dirname(linkPath), currentTarget);
  if (basename(resolvedTarget) !== 'agent-browser.js') {
    return false;
  }

  unlinkSync(linkPath);
  symlinkSync(binaryPath, linkPath);
  return true;
}

function windowsBinDirs(root) {
  const dirs = new Set();
  try {
    addCandidate(dirs, execSync('npm prefix -g', { encoding: 'utf8' }).trim());
  } catch {
    // npm may not be available.
  }

  addCandidate(dirs, join(root, '..', '.bin'));
  if (process.env.INIT_CWD) {
    addCandidate(dirs, join(process.env.INIT_CWD, 'node_modules', '.bin'));
  }
  return [...dirs];
}

function replaceWindowsShims(binDirPath, binaryPath) {
  const cmdShim = join(binDirPath, 'agent-browser.cmd');
  const ps1Shim = join(binDirPath, 'agent-browser.ps1');

  if (!existsSync(cmdShim)) {
    return false;
  }

  const cmdContent = `@ECHO off\r\n"${binaryPath}" %*\r\n`;
  const ps1Content = `#!/usr/bin/env pwsh\r\n& "${binaryPath}" $args\r\nexit $LASTEXITCODE\r\n`;
  writeFileSync(cmdShim, cmdContent);
  if (existsSync(ps1Shim)) {
    writeFileSync(ps1Shim, ps1Content);
  }
  return true;
}

export function optimizeCommandLinks(options = {}) {
  const {
    root = projectRoot,
    binaryPath = getBinaryPath(root),
    invokedPath = process.argv[1],
    log = console.log,
  } = options;

  if (!hasUsableBinary(binaryPath)) {
    return false;
  }

  const optimized = [];
  try {
    if (platform() === 'win32') {
      for (const binDirPath of windowsBinDirs(root)) {
        if (replaceWindowsShims(binDirPath, binaryPath)) {
          optimized.push(binDirPath);
        }
      }
    } else {
      for (const linkPath of unixBinLinkCandidates(root, invokedPath)) {
        if (replaceUnixSymlink(linkPath, binaryPath)) {
          optimized.push(linkPath);
        }
      }
    }
  } catch (err) {
    log(`⚠ Could not optimize command shim: ${err.message}`);
    log('  CLI will work via Node.js wrapper until the shim is repaired.');
    return false;
  }

  if (optimized.length > 0) {
    log('✓ Optimized: agent-browser command points to native binary');
    return true;
  }

  return false;
}

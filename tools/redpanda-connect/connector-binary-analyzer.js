const { Octokit } = require('@octokit/rest');
const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

/**
 * Binary analyzer for Redpanda Connect
 * Analyzes OSS, Cloud, and cgo binaries to determine:
 * - Which connectors are available in Cloud (cloud support)
 * - Which connectors require cgo builds (cgo-only)
 * - Which connectors are self-hosted only
 */

// Initialize Octokit with optional authentication
const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN,
  userAgent: 'redpanda-docs-tools',
  retry: {
    enabled: true,
    retries: 3
  }
});

const REPO_OWNER = 'redpanda-data';
const REPO_NAME = 'connect';

/**
 * Get platform-specific binary name
 * @returns {Object} Platform and arch info
 */
function getPlatformInfo() {
  const os = require('os');
  const platform = os.platform();
  const arch = os.arch();

  // Map Node.js platform names to binary names
  const platformMap = {
    'darwin': 'darwin',
    'linux': 'linux',
    'win32': 'windows'
  };

  const archMap = {
    'x64': 'amd64',
    'arm64': 'arm64',
    'arm': 'arm64'
  };

  return {
    platform: platformMap[platform] || 'linux',
    arch: archMap[arch] || 'amd64'
  };
}

/**
 * Get the latest release version from GitHub
 * @param {string} binaryType - Type of binary ('cloud' or 'cgo')
 * @returns {Promise<string>} Version string (e.g., "4.76.0")
 */
async function getLatestVersion(binaryType = 'cloud') {
  try {
    const { data: releases } = await octokit.repos.listReleases({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      per_page: 20
    });

    const prefix = binaryType === 'cloud' ? 'redpanda-connect-cloud' : 'redpanda-connect-cgo';

    // Find the latest release with the specified binary type
    for (const release of releases) {
      const asset = release.assets.find(a =>
        a.name.startsWith(prefix) &&
        a.name.includes('linux') &&
        a.name.includes('amd64')
      );

      if (asset) {
        const version = release.tag_name.replace(/^v/, '');
        return version;
      }
    }

    throw new Error(`No ${binaryType} binary found in recent releases`);
  } catch (error) {
    if (error.status === 403 && error.message.includes('rate limit')) {
      throw new Error(
        'GitHub API rate limit exceeded. Set GITHUB_TOKEN environment variable to increase limit from 60 to 5000 requests/hour.'
      );
    }
    throw new Error(`Failed to fetch latest version: ${error.message}`);
  }
}

/**
 * Download a file from a URL
 * @param {string} url - URL to download
 * @param {string} destPath - Destination file path
 * @returns {Promise<void>}
 */
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'redpanda-docs-tools' } }, (res) => {
      // Follow redirects
      if (res.statusCode === 302 || res.statusCode === 301) {
        downloadFile(res.headers.location, destPath).then(resolve).catch(reject);
        return;
      }

      if (res.statusCode !== 200) {
        reject(new Error(`Failed to download: HTTP ${res.statusCode}`));
        return;
      }

      const fileStream = fs.createWriteStream(destPath);
      res.pipe(fileStream);

      fileStream.on('finish', () => {
        fileStream.close();
        resolve();
      });

      fileStream.on('error', (err) => {
        if (fs.existsSync(destPath)) {
          fs.unlinkSync(destPath);
        }
        reject(err);
      });
    }).on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Download a binary from GitHub releases
 * @param {string} binaryType - 'cloud' or 'cgo'
 * @param {string} version - Version to download (e.g., "4.76.0")
 * @param {string} destDir - Destination directory
 * @returns {Promise<string>} Path to downloaded binary
 */
async function downloadBinary(binaryType, version, destDir) {
  // cgo binaries are only available for linux/amd64, so force that platform
  const platformInfo = binaryType === 'cgo'
    ? { platform: 'linux', arch: 'amd64' }
    : getPlatformInfo();
  const prefix = binaryType === 'cloud' ? 'redpanda-connect-cloud' : 'redpanda-connect-cgo';
  const binaryName = `${prefix}-${version}-${platformInfo.platform}-${platformInfo.arch}`;
  const destPath = path.join(destDir, binaryName);

  // Skip download if already exists
  if (fs.existsSync(destPath)) {
    console.log(`✓ ${binaryType.toUpperCase()} binary already downloaded: ${binaryName}`);
    return destPath;
  }

  console.log(`Downloading ${binaryType.toUpperCase()} binary v${version} for ${platformInfo.platform}/${platformInfo.arch}...`);

  try {
    // Get release information
    const { data: release } = await octokit.repos.getReleaseByTag({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      tag: `v${version}`
    });

    // Find the asset
    const assetName = `${prefix}_${version}_${platformInfo.platform}_${platformInfo.arch}.tar.gz`;
    const asset = release.assets.find(a => a.name === assetName);

    if (!asset) {
      throw new Error(`${binaryType.toUpperCase()} binary not found for version ${version} (${assetName})`);
    }

    // Download the tarball
    const tarballPath = `${destPath}.tar.gz`;
    await downloadFile(asset.browser_download_url, tarballPath);

    // Extract the binary
    console.log(`Extracting ${binaryType.toUpperCase()} binary...`);
    execSync(`tar -xzf "${tarballPath}" -C "${destDir}"`, { stdio: 'ignore' });

    // Find the extracted binary
    const extractedFiles = fs.readdirSync(destDir);
    let binaryPath = null;

    for (const file of extractedFiles) {
      const fullPath = path.join(destDir, file);
      if (fs.statSync(fullPath).isFile() && file.includes('redpanda-connect') && !file.endsWith('.tar.gz')) {
        binaryPath = fullPath;
        break;
      }
    }

    if (!binaryPath) {
      throw new Error('Binary not found after extraction');
    }

    // Rename to standard name if needed
    if (binaryPath !== destPath) {
      fs.renameSync(binaryPath, destPath);
    }

    // Make executable
    fs.chmodSync(destPath, 0o755);

    // Clean up tarball
    fs.unlinkSync(tarballPath);

    console.log(`Done: Downloaded ${binaryType.toUpperCase()} binary: ${binaryName}`);
    return destPath;
  } catch (error) {
    if (error.status === 404) {
      throw new Error(`Release v${version} not found or ${binaryType} binary not available for this version`);
    } else if (error.status === 403) {
      throw new Error('GitHub API rate limit exceeded. Set GITHUB_TOKEN environment variable.');
    }
    throw new Error(`Failed to download ${binaryType} binary: ${error.message}`);
  }
}

/**
 * Download cloud binary from GitHub releases
 * @param {string} version - Version to download
 * @param {string} destDir - Destination directory
 * @returns {Promise<string>} Path to downloaded binary
 */
async function downloadCloudBinary(version, destDir) {
  return downloadBinary('cloud', version, destDir);
}

/**
 * Download cgo binary from GitHub releases
 * @param {string} version - Version to download
 * @param {string} destDir - Destination directory
 * @returns {Promise<string>} Path to downloaded binary
 */
async function downloadCgoBinary(version, destDir) {
  return downloadBinary('cgo', version, destDir);
}

/**
 * Get list of connectors from a binary
 * @param {string} binaryPath - Path to binary
 * @returns {object} Connector index (same format as rpk connect list --format json-full)
 */
function getConnectorList(binaryPath) {
  try {
    const binaryName = path.basename(binaryPath);
    console.log(`Inspecting ${binaryName} for connectors...`);

    // Check if this is a Linux binary on non-Linux platform (need Docker)
    const isLinuxBinary = binaryName.includes('linux');
    const needsDocker = isLinuxBinary && os.platform() !== 'linux';

    let result;
    if (needsDocker) {
      // Use Docker to run Linux binaries on macOS/Windows
      const binaryDir = path.dirname(binaryPath);
      const binaryFile = path.basename(binaryPath);

      // Install dependencies for cgo binaries (libzmq) and run
      const isCgoBinary = binaryFile.includes('cgo');
      const command = isCgoBinary
        ? `apt-get update -qq && apt-get install -qq -y libzmq5 > /dev/null 2>&1 && chmod +x ./${binaryFile} && ./${binaryFile} list --format json-full`
        : `chmod +x ./${binaryFile} && ./${binaryFile} list --format json-full`;

      result = spawnSync('docker', [
        'run', '--rm', '--platform', 'linux/amd64',
        '-v', `${binaryDir}:/work`,
        '-w', '/work',
        'ubuntu:22.04',
        'bash', '-c', command
      ], {
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 10 * 1024 * 1024 // 10MB buffer
      });
    } else {
      // Run natively
      result = spawnSync(binaryPath, ['list', '--format', 'json-full'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 10 * 1024 * 1024 // 10MB buffer
      });
    }

    if (result.error) {
      throw new Error(`Failed to execute binary: ${result.error.message}`);
    }

    if (result.status !== 0) {
      throw new Error(`Binary exited with code ${result.status}`);
    }

    const output = result.stdout.toString();
    const connectors = JSON.parse(output);

    const typeCount = Object.keys(connectors).filter(k => Array.isArray(connectors[k])).length;
    console.log(`Done: Found ${typeCount} connector types in ${binaryName}`);

    return connectors;
  } catch (err) {
    throw new Error(`Failed to get connector list: ${err.message}`);
  }
}

/**
 * Deprecated alias for backward compatibility
 * @deprecated Use getConnectorList instead
 */
function getCloudConnectors(binaryPath) {
  return getConnectorList(binaryPath);
}

/**
 * Build a set of connector keys for comparison
 * @param {object} index - Connector index
 * @returns {Set<string>} Set of "type:name" keys
 */
function buildConnectorSet(index) {
  const connectorSet = new Set();

  // Iterate through all connector types
  const types = Object.keys(index).filter(key => Array.isArray(index[key]));

  types.forEach(type => {
    index[type].forEach(connector => {
      if (connector.name) {
        connectorSet.add(`${type}:${connector.name}`);
      }
    });
  });

  return connectorSet;
}

/**
 * Compare OSS connectors with cloud connectors
 * @param {object} ossIndex - OSS connector index
 * @param {object} cloudIndex - Cloud connector index
 * @returns {object} Comparison results
 */
function compareOssWithCloud(ossIndex, cloudIndex) {
  const ossSet = buildConnectorSet(ossIndex);
  const cloudSet = buildConnectorSet(cloudIndex);

  const inCloud = [];
  const notInCloud = [];
  const cloudOnly = [];

  // Find OSS connectors and check if they're in cloud
  ossSet.forEach(key => {
    const [type, name] = key.split(':');
    const ossConnector = ossIndex[type]?.find(c => c.name === name);

    if (cloudSet.has(key)) {
      inCloud.push({
        type,
        name,
        status: ossConnector?.status || ossConnector?.type || 'stable'
      });
    } else {
      notInCloud.push({
        type,
        name,
        status: ossConnector?.status || ossConnector?.type || 'stable',
        reason: 'self-hosted-only'
      });
    }
  });

  // Find cloud-only connectors (in cloud but NOT in OSS)
  cloudSet.forEach(key => {
    if (!ossSet.has(key)) {
      const [type, name] = key.split(':');
      const cloudConnector = cloudIndex[type]?.find(c => c.name === name);

      if (cloudConnector) {
        cloudOnly.push({
          ...cloudConnector, // Include full connector schema
          type,
          name,
          status: cloudConnector.status || 'stable',
          reason: 'cloud-only'
        });
      }
    }
  });

  return {
    inCloud,
    notInCloud,
    cloudOnly,
    totalOss: ossSet.size,
    totalCloud: cloudSet.size
  };
}

/**
 * Find connectors that are only available in cgo builds
 * @param {object} ossIndex - OSS connector index (from rpk connect)
 * @param {object} cgoIndex - cgo connector index
 * @returns {Array<object>} List of cgo-only connectors
 */
function findCgoOnlyConnectors(ossIndex, cgoIndex) {
  const ossSet = buildConnectorSet(ossIndex);
  const cgoSet = buildConnectorSet(cgoIndex);

  const cgoOnly = [];

  cgoSet.forEach(key => {
    if (!ossSet.has(key)) {
      const [type, name] = key.split(':');
      const connector = cgoIndex[type]?.find(c => c.name === name);
      if (connector) {
        // Return the full connector object with all fields and examples
        cgoOnly.push({
          ...connector,
          type,  // Add type field for convenience
          requiresCgo: true  // Mark as cgo-required
        });
      }
    }
  });

  return cgoOnly;
}

/**
 * Analyze all binary types for connector support
 * @param {string} ossVersion - OSS version to check
 * @param {string} [cloudVersion] - Cloud version (auto-detected if not provided)
 * @param {string} [dataDir] - Directory for docs-data (analysis results only)
 * @param {object} [options] - Analysis options
 * @param {boolean} [options.skipCloud] - Skip cloud binary analysis
 * @param {boolean} [options.skipCgo] - Skip cgo binary analysis
 * @param {string} [options.cgoVersion] - cgo version (defaults to cloudVersion)
 * @returns {Promise<object>} Analysis results
 */
async function analyzeAllBinaries(ossVersion, cloudVersion = null, dataDir = null, options = {}) {
  const { skipCloud = false, skipCgo = false, cgoVersion = null } = options;

  const docsDataDir = dataDir || path.resolve(process.cwd(), 'docs-data');

  // Use temp directory for binaries (not docs-data)
  const os = require('os');
  const binaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpcn-binaries-'));

  console.log(`📁 Using temp directory for binaries: ${binaryDir}`);

  // Load OSS connector data (from rpk connect list)
  const ossDataPath = path.join(docsDataDir, `connect-${ossVersion}.json`);
  if (!fs.existsSync(ossDataPath)) {
    throw new Error(`OSS data file not found: ${ossDataPath}. Run 'rpk connect list --format json-full > ${ossDataPath}' first.`);
  }

  const ossIndex = JSON.parse(fs.readFileSync(ossDataPath, 'utf8'));

  // Cloud binary analysis
  let cloudIndex = null;
  let comparison = null;

  if (!skipCloud) {
    // Auto-detect cloud version if not provided
    if (!cloudVersion) {
      console.log('Detecting latest cloud version...');
      cloudVersion = await getLatestVersion('cloud');
      console.log(`✓ Latest cloud version: ${cloudVersion}`);
    }

    // Download and inspect cloud binary
    const cloudBinaryPath = await downloadCloudBinary(cloudVersion, binaryDir);
    cloudIndex = getConnectorList(cloudBinaryPath);

    // Compare OSS with Cloud
    comparison = compareOssWithCloud(ossIndex, cloudIndex);
  } else {
    console.log('⏩ Skipping cloud binary analysis');
  }

  // cgo binary analysis
  let cgoOnly = [];
  let cgoIndex = null;

  if (!skipCgo) {
    console.log('\nAnalyzing cgo binary...');
    try {
      // Use cgo-specific version or fall back to cloud version
      let effectiveCgoVersion = cgoVersion || cloudVersion;

      // If neither is provided, auto-detect
      if (!effectiveCgoVersion) {
        console.log('Detecting latest cgo version...');
        effectiveCgoVersion = await getLatestVersion('cgo');
        console.log(`✓ Latest cgo version: ${effectiveCgoVersion}`);
      }

      const cgoBinaryPath = await downloadCgoBinary(effectiveCgoVersion, binaryDir);
      cgoIndex = getConnectorList(cgoBinaryPath);

      // Find connectors only in cgo (not in regular OSS binary)
      // These are connectors that require cgo-enabled builds
      cgoOnly = findCgoOnlyConnectors(ossIndex, cgoIndex);

      console.log(`Done: Cgo analysis complete: ${cgoOnly.length} cgo-only connectors found`);
      if (cgoOnly.length > 0) {
        console.log('   cgo-only connectors:');
        cgoOnly.forEach(c => console.log(`   • ${c.type}/${c.name} (${c.status})`));
      }
    } catch (err) {
      console.error(`Warning: Cgo analysis failed: ${err.message}`);
      console.error('   Continuing without cgo data...');
    }
  } else {
    console.log('⏩ Skipping cgo binary analysis');
  }

  // Clean up temp binaries
  try {
    fs.rmSync(binaryDir, { recursive: true, force: true });
    console.log(`🧹 Cleaned up temp binaries`);
  } catch (err) {
    console.warn(`Warning: Could not clean up temp directory: ${err.message}`);
  }

  // IMPORTANT: cgoOnly contains connectors that exist ONLY in the cgo binary
  // and NOT in the regular OSS binary (rpk connect list). These are the
  // connectors that require cgo-enabled builds. Connectors available in the
  // standard OSS binary do NOT require cgo and will NOT be in this list.
  //
  // As of v4.76.0, cgo-only connectors are:
  // - inputs/tigerbeetle_cdc (beta)
  // - processors/ffi (experimental)
  return {
    ossVersion,
    cloudVersion,
    cgoVersion: cgoVersion || cloudVersion, // The version analyzed for cgo
    comparison,
    cloudIndex,
    cgoIndex,
    cgoOnly
  };
}

/**
 * Deprecated alias for backward compatibility
 * @deprecated Use analyzeAllBinaries instead
 */
async function getCloudSupport(ossVersion, cloudVersion = null, dataDir = null) {
  return analyzeAllBinaries(ossVersion, cloudVersion, dataDir);
}

/**
 * Check GitHub API rate limit
 * @returns {Promise<object>} Rate limit information
 */
async function checkRateLimit() {
  try {
    const { data } = await octokit.rateLimit.get();
    return {
      remaining: data.rate.remaining,
      limit: data.rate.limit,
      reset: new Date(data.rate.reset * 1000),
      used: data.rate.used
    };
  } catch (error) {
    throw new Error(`Failed to check rate limit: ${error.message}`);
  }
}

module.exports = {
  // Primary functions
  analyzeAllBinaries,
  findCgoOnlyConnectors,
  getLatestVersion,
  downloadCloudBinary,
  downloadCgoBinary,
  getConnectorList,
  buildConnectorSet,
  compareOssWithCloud,
  checkRateLimit,

  // Deprecated aliases (for backward compatibility)
  getCloudSupport,
  getLatestCloudVersion: () => getLatestVersion('cloud'),
  getCloudConnectors: getConnectorList
};

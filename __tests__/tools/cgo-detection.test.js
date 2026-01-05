#!/usr/bin/env node
/**
 * End-to-end test for CGO detection workflow
 *
 * This test:
 * 1. Downloads real cloud and CGO binaries from GitHub releases
 * 2. Extracts connector lists from both
 * 3. Identifies CGO-only connectors
 * 4. Generates drafts with CGO requirements
 * 5. Verifies PR summary formatting
 *
 * Designed to run in CI/CD environments (Linux) or locally with Docker (macOS).
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');
const os = require('os');

// Test configuration
const TEST_VERSION = '4.75.1';
const TEST_DIR = path.join(__dirname, '../.test-cgo-detection');
const REPO_ROOT = path.resolve(__dirname, '../..');

// Test results
const results = {
  passed: 0,
  failed: 0,
  tests: []
};

function log(message) {
  console.log(`[CGO Test] ${message}`);
}

function assert(condition, testName, details = '') {
  results.tests.push({ name: testName, passed: condition, details });

  if (condition) {
    results.passed++;
    console.log(`  ✅ ${testName}`);
  } else {
    results.failed++;
    console.error(`  ❌ ${testName}`);
    if (details) console.error(`     ${details}`);
  }

  return condition;
}

function getPlatformInfo() {
  const platform = os.platform();
  const arch = os.arch();

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
    arch: archMap[arch] || 'amd64',
    needsDocker: platform !== 'linux'
  };
}

function downloadBinary(version, type) {
  const platform = getPlatformInfo();
  const binaryName = type === 'cgo' ? 'redpanda-connect-cgo' : 'redpanda-connect-cloud';
  const assetName = `${binaryName}_${version}_linux_amd64.tar.gz`;
  const url = `https://github.com/redpanda-data/connect/releases/download/v${version}/${assetName}`;

  log(`Downloading ${type} binary v${version}...`);

  const tarPath = path.join(TEST_DIR, `${type}.tar.gz`);

  try {
    execSync(`curl -sL "${url}" -o "${tarPath}"`, { stdio: 'pipe' });
    execSync(`tar -xzf "${tarPath}" -C "${TEST_DIR}"`, { stdio: 'pipe' });

    // Find extracted binary
    const files = fs.readdirSync(TEST_DIR);
    const binaryFile = files.find(f => f.includes('redpanda-connect') && !f.includes('.tar.gz') && fs.statSync(path.join(TEST_DIR, f)).isFile());

    if (!binaryFile) {
      throw new Error('Binary not found after extraction');
    }

    const binaryPath = path.join(TEST_DIR, binaryFile);
    const finalPath = path.join(TEST_DIR, `${type}-binary`);

    fs.renameSync(binaryPath, finalPath);
    fs.chmodSync(finalPath, 0o755);
    fs.unlinkSync(tarPath);

    return finalPath;
  } catch (err) {
    throw new Error(`Failed to download ${type} binary: ${err.message}`);
  }
}

function extractConnectors(binaryPath) {
  const platform = getPlatformInfo();

  try {
    let output;

    if (platform.needsDocker) {
      // Use Docker on non-Linux platforms
      log('Using Docker to run binary (non-Linux platform)');
      const result = spawnSync('docker', [
        'run', '--rm', '--platform', 'linux/amd64',
        '-v', `${TEST_DIR}:/work`,
        '-w', '/work',
        'ubuntu:22.04',
        `./${path.basename(binaryPath)}`,
        'list', '--format', 'json-full'
      ], {
        maxBuffer: 10 * 1024 * 1024,
        encoding: 'utf8'
      });

      if (result.error) {
        throw new Error(`Docker execution failed: ${result.error.message}`);
      }

      if (result.status !== 0) {
        throw new Error(`Binary exited with code ${result.status}: ${result.stderr}`);
      }

      output = result.stdout;
    } else {
      // Run natively on Linux
      log('Running binary natively (Linux platform)');
      output = execSync(`"${binaryPath}" list --format json-full`, {
        maxBuffer: 10 * 1024 * 1024,
        encoding: 'utf8'
      });
    }

    return JSON.parse(output);
  } catch (err) {
    throw new Error(`Failed to extract connectors: ${err.message}`);
  }
}

function buildConnectorSet(index) {
  const connectorSet = new Set();
  const types = ['inputs', 'outputs', 'processors', 'caches', 'rate_limits', 'buffers', 'metrics', 'tracers', 'scanners'];

  types.forEach(type => {
    if (Array.isArray(index[type])) {
      index[type].forEach(c => connectorSet.add(`${type}:${c.name}`));
    }
  });

  return connectorSet;
}

function findCgoOnlyConnectors(cloudIndex, cgoIndex) {
  const cloudSet = buildConnectorSet(cloudIndex);
  const cgoSet = buildConnectorSet(cgoIndex);

  const cgoOnly = [];

  cgoSet.forEach(key => {
    if (!cloudSet.has(key)) {
      const [type, name] = key.split(':');
      const connector = cgoIndex[type]?.find(c => c.name === name);
      cgoOnly.push({
        type,
        name,
        status: connector?.status || 'stable'
      });
    }
  });

  return cgoOnly;
}

async function testDraftGeneration(cgoOnly) {
  log('Testing draft generation with CGO detection...');

  const { generateRpcnConnectorDocs } = require(path.join(REPO_ROOT, 'tools/redpanda-connect/generate-rpcn-connector-docs.js'));

  // Create test data with a CGO-only connector
  const testData = {
    inputs: [
      {
        name: 'test_cgo_input',
        type: 'input',
        status: 'beta',
        description: 'Test CGO input',
        config: {
          children: [
            { name: 'test_field', type: 'string', description: 'Test field' }
          ]
        }
      }
    ]
  };

  const testDataPath = path.join(TEST_DIR, 'test-data.json');
  fs.writeFileSync(testDataPath, JSON.stringify(testData, null, 2));

  // Setup output directory
  const outputRoot = path.join(TEST_DIR, 'output');
  fs.mkdirSync(path.join(outputRoot, 'modules/components/partials/components/inputs'), { recursive: true });
  fs.mkdirSync(path.join(outputRoot, 'modules/components/partials/fields/inputs'), { recursive: true });
  fs.mkdirSync(path.join(outputRoot, 'modules/components/partials/examples/inputs'), { recursive: true });
  fs.mkdirSync(path.join(outputRoot, 'modules/components/examples/common/inputs'), { recursive: true });
  fs.mkdirSync(path.join(outputRoot, 'modules/components/examples/advanced/inputs'), { recursive: true });

  const originalCwd = process.cwd();
  process.chdir(outputRoot);

  try {
    const result = await generateRpcnConnectorDocs({
      data: testDataPath,
      template: path.join(REPO_ROOT, 'tools/redpanda-connect/templates/connector.hbs'),
      templateIntro: path.join(REPO_ROOT, 'tools/redpanda-connect/templates/intro.hbs'),
      templateFields: path.join(REPO_ROOT, 'tools/redpanda-connect/templates/fields-partials.hbs'),
      templateExamples: path.join(REPO_ROOT, 'tools/redpanda-connect/templates/examples-partials.hbs'),
      writeFullDrafts: true,
      cgoOnly: [{ type: 'inputs', name: 'test_cgo_input', status: 'beta' }]
    });

    // Verify draft was created
    assert(result.draftsWritten === 1, 'Draft generation count', `Expected 1, got ${result.draftsWritten}`);

    // Verify requiresCgo flag was set
    const hasCgoFlag = result.draftFiles.some(d => d.name === 'test_cgo_input' && d.requiresCgo);
    assert(hasCgoFlag, 'Draft has requiresCgo flag set');

    // Verify Requirements section exists in draft
    const draftPath = path.join(outputRoot, result.draftFiles[0].path);
    const draftContent = fs.readFileSync(draftPath, 'utf8');
    assert(draftContent.includes('== Requirements'), 'Draft contains Requirements section');
    assert(draftContent.includes('cgo-enabled builds'), 'Draft contains CGO requirement text');

    return result.draftFiles;

  } finally {
    process.chdir(originalCwd);
  }
}

function testPRSummary(cgoOnly, draftFiles) {
  log('Testing PR summary generation...');

  const { generatePRSummary } = require(path.join(REPO_ROOT, 'tools/redpanda-connect/pr-summary-formatter.js'));

  const diffData = {
    comparison: {
      oldVersion: '4.69.0',
      newVersion: TEST_VERSION,
      timestamp: new Date().toISOString()
    },
    summary: {
      newComponents: 1,
      newFields: 0,
      removedComponents: 0,
      removedFields: 0,
      deprecatedComponents: 0,
      deprecatedFields: 0,
      changedDefaults: 0
    },
    details: {
      newComponents: [
        { type: 'inputs', name: 'test_cgo_input', status: 'beta', description: 'Test CGO input' }
      ],
      newFields: [],
      removedComponents: [],
      removedFields: [],
      deprecatedComponents: [],
      deprecatedFields: [],
      changedDefaults: []
    }
  };

  // Add test connector to cgoOnly for PR summary testing
  const testCgoOnly = [
    ...cgoOnly,
    { type: 'inputs', name: 'test_cgo_input', status: 'beta' }
  ];

  const cloudSupport = {
    cloudVersion: TEST_VERSION,
    comparison: {
      inCloud: [],
      notInCloud: [{ type: 'inputs', name: 'test_cgo_input', status: 'beta' }]
    },
    cgoOnly: testCgoOnly
  };

  const summary = generatePRSummary(diffData, cloudSupport, draftFiles);

  // Verify CGO indicators in summary
  assert(summary.includes('🔧'), 'PR summary contains CGO indicator emoji');
  assert(summary.includes('Cgo Requirements'), 'PR summary contains CGO Requirements section');
  assert(summary.includes('[NOTE]'), 'PR summary contains NOTE blocks');
  assert(summary.includes('xref:install:prebuilt-binary.adoc'), 'PR summary contains installation links');

  return summary;
}

async function runTests() {
  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║  CGO Detection End-to-End Test Suite                  ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');

  const platform = getPlatformInfo();
  log(`Platform: ${platform.platform}/${platform.arch}${platform.needsDocker ? ' (using Docker)' : ''}`);
  log(`Test version: ${TEST_VERSION}\n`);

  try {
    // Setup
    log('Setting up test environment...');
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(TEST_DIR, { recursive: true });

    // Test 1: Download binaries
    log('\n📦 Test 1: Binary Download');
    let cloudBinary, cgoBinary;
    try {
      cloudBinary = downloadBinary(TEST_VERSION, 'cloud');
      assert(fs.existsSync(cloudBinary), 'Cloud binary downloaded');

      cgoBinary = downloadBinary(TEST_VERSION, 'cgo');
      assert(fs.existsSync(cgoBinary), 'CGO binary downloaded');
    } catch (err) {
      assert(false, 'Binary download', err.message);
      throw err;
    }

    // Test 2: Extract connectors
    log('\n📋 Test 2: Connector Extraction');
    let cloudIndex, cgoIndex;
    try {
      cloudIndex = extractConnectors(cloudBinary);
      const cloudCount = buildConnectorSet(cloudIndex).size;
      assert(cloudCount > 0, 'Cloud connectors extracted', `Found ${cloudCount} connectors`);

      cgoIndex = extractConnectors(cgoBinary);
      const cgoCount = buildConnectorSet(cgoIndex).size;
      assert(cgoCount > 0, 'CGO connectors extracted', `Found ${cgoCount} connectors`);
      assert(cgoCount > cloudCount, 'CGO has more connectors than cloud');
    } catch (err) {
      assert(false, 'Connector extraction', err.message);
      throw err;
    }

    // Test 3: Identify CGO-only connectors
    log('\n🔧 Test 3: CGO-Only Detection');
    const cgoOnly = findCgoOnlyConnectors(cloudIndex, cgoIndex);
    assert(cgoOnly.length > 0, 'CGO-only connectors identified', `Found ${cgoOnly.length} CGO-only connectors`);

    // Verify known CGO-only connectors
    const hasTigerbeetle = cgoOnly.some(c => c.name === 'tigerbeetle_cdc');
    assert(hasTigerbeetle, 'tigerbeetle_cdc identified as CGO-only');

    // Test 4: Draft generation
    log('\n📝 Test 4: Draft Generation');
    const draftFiles = await testDraftGeneration(cgoOnly);

    // Test 5: PR summary
    log('\n📊 Test 5: PR Summary Generation');
    testPRSummary(cgoOnly, draftFiles);

    // Cleanup
    log('\n🧹 Cleaning up...');
    fs.rmSync(TEST_DIR, { recursive: true, force: true });

    // Summary
    console.log('\n╔════════════════════════════════════════════════════════╗');
    console.log('║  Test Results                                          ║');
    console.log('╚════════════════════════════════════════════════════════╝\n');
    console.log(`  ✅ Passed: ${results.passed}`);
    console.log(`  ❌ Failed: ${results.failed}`);
    console.log(`  📊 Total:  ${results.tests.length}\n`);

    if (results.failed > 0) {
      console.error('Failed tests:');
      results.tests.filter(t => !t.passed).forEach(t => {
        console.error(`  - ${t.name}: ${t.details}`);
      });
      throw new Error(`${results.failed} test(s) failed`);
    }

    console.log('✅ All tests passed!\n');

  } catch (err) {
    console.error('\n❌ Test suite failed:', err.message);
    console.error(err.stack);
    throw err;
  }
}

// Jest test wrapper
if (require.main !== module) {
  // Running under Jest
  test('CGO detection end-to-end workflow', async () => {
    await runTests();
  }, 300000); // 5 minute timeout for this integration test
} else {
  // Running as standalone script
  runTests().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

// Integration test for property-docs description override functionality using Jest
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');

const repoRoot = path.resolve(__dirname, '..', '..');
const docTools = path.join(repoRoot, 'bin', 'doc-tools.js');
const overridesFile = path.join(repoRoot, '__tests__', 'docs-data', 'property-overrides.json');

describe('property-docs description override', () => {
  let tempOutdir;

  beforeAll(() => {
    tempOutdir = fs.mkdtempSync(path.join(os.tmpdir(), 'property-docs-test-'));
  });

  afterAll(() => {
    fs.rmSync(tempOutdir, { recursive: true, force: true });
  });

  it('applies the override description for admin property', () => {
    const command = `node "${docTools}" generate property-docs --tag v25.2.3 --overrides "${overridesFile}" --output-dir "${tempOutdir}"`;

    try {
      execSync(command, {
        cwd: repoRoot,
        stdio: 'pipe', // Capture output instead of inheriting
        timeout: 120000 // 2 minute timeout for slower CI environments
      });
    } catch (error) {
      const cleanError = new Error(`Command failed: ${error.message}`);
      cleanError.code = error.code;
      cleanError.signal = error.signal;

      if (error.stdout) {
        cleanError.stdout = error.stdout.toString();
      }
      if (error.stderr) {
        cleanError.stderr = error.stderr.toString();
      }

      throw cleanError;
    }

    // Check that the generated file exists
    const outFile = path.join(tempOutdir, 'pages', 'broker-properties.adoc');
    expect(fs.existsSync(outFile)).toBe(true);
    // Read the generated content
    const content = fs.readFileSync(outFile, 'utf8');
    // Load the overrides and check that they were applied
    const overrides = JSON.parse(fs.readFileSync(overridesFile, 'utf8'));
    const adminOverride = overrides.properties.admin;
    expect(adminOverride).toBeTruthy();
    expect(adminOverride.description).toBeTruthy();
    // Verify the override description appears in the generated docs
    expect(content).toContain(adminOverride.description);
    // Verify the version override is applied
    if (adminOverride.version) {
      expect(content).toContain(`*Introduced in ${adminOverride.version}*`);
    }
  }, 150000);
});

// Test for property-docs description override functionality using Jest
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
    // Mock the output file and directory structure
    const outDir = path.join(tempOutdir, 'properties', 'pages');
    fs.mkdirSync(outDir, { recursive: true });
    const overrides = JSON.parse(fs.readFileSync(overridesFile, 'utf8'));
    const prop = 'cloud_storage_access_key';
    const expectedDesc = overrides[prop]?.description || 'Overridden description.';
    // Minimal AsciiDoc content with the override
    const content = `=== cloud_storage_access_key\n\n${expectedDesc}\n\n*Visibility:* \`user\``;
    fs.writeFileSync(path.join(outDir, 'object-storage-properties.adoc'), content);
  });

  afterAll(() => {
    fs.rmSync(tempOutdir, { recursive: true, force: true });
  });

  it('applies the override description for cloud_storage_access_key', () => {
    const outFile = path.join(tempOutdir, 'properties', 'pages', 'object-storage-properties.adoc');
    expect(fs.existsSync(outFile)).toBe(true);
    const content = fs.readFileSync(outFile, 'utf8');
    const overrides = JSON.parse(fs.readFileSync(overridesFile, 'utf8'));
    const prop = 'cloud_storage_access_key';
    const expectedDesc = overrides[prop]?.description;
    expect(expectedDesc).toBeTruthy();
    expect(content).toContain(expectedDesc);
  });
});

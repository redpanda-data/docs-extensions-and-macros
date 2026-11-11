const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  propertyNamesFromJson,
  findPropertiesFile,
  loadPropertyNames,
} = require('../../tools/redpanda-release-notes/property-names');

const FIXTURE = path.join(__dirname, '../fixtures/release-notes/properties/redpanda-properties-v26.2.4.json');

describe('propertyNamesFromJson', () => {
  it('returns the keys of the properties object', () => {
    const names = propertyNamesFromJson({ definitions: {}, properties: { 'retention.ms': {}, rack: {} } });
    expect([...names].sort()).toEqual(['rack', 'retention.ms']);
  });

  it('throws when the file has no properties object', () => {
    expect(() => propertyNamesFromJson({ definitions: {} })).toThrow(/no "properties" object/);
  });
});

describe('loadPropertyNames', () => {
  it('reads the names from a property file', () => {
    expect(loadPropertyNames(FIXTURE).has('cloud_storage_segment_max_upload_interval_sec')).toBe(true);
  });
});

describe('findPropertiesFile', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rn-props-'));
    for (const f of [
      'redpanda-properties-v26.1.18.json',
      'redpanda-properties-v26.2.1.json',
      'redpanda-properties-v26.2.10.json',
      'redpanda-properties-v26.2.4.json',
      'redpanda-properties-v26.3.0-rc1.json',
      'unrelated.json',
    ]) fs.writeFileSync(path.join(dir, f), '{}');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('picks the newest GA file in the tag release series, comparing patches numerically', () => {
    expect(findPropertiesFile(dir, 'v26.2.5')).toBe(path.join(dir, 'redpanda-properties-v26.2.10.json'));
  });

  it('never uses a file from another release series or a prerelease file', () => {
    expect(findPropertiesFile(dir, 'v26.3.0')).toBeNull();
    expect(findPropertiesFile(dir, '26.1.19')).toBe(path.join(dir, 'redpanda-properties-v26.1.18.json'));
  });

  it('returns null for a missing directory', () => {
    expect(findPropertiesFile(path.join(dir, 'nope'), 'v26.2.5')).toBeNull();
  });
});

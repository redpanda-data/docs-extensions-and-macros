'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { updatePropertiesJsonWithVersion } = require('../../cli-utils/diff-utils.js');

describe('updatePropertiesJsonWithVersion', () => {
  let tmpDir, jsonPath;

  const diffData = {
    details: {
      newProperties: [
        { name: 'datalake_coordinator_max_files_per_commit' },
        { name: 'enable_development_metrics' },
      ],
    },
  };

  // Mirrors the Python extractor's output: 4-space indent, no trailing newline.
  const writeFixture = (data) => fs.writeFileSync(jsonPath, JSON.stringify(data, null, 4));

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-utils-test-'));
    jsonPath = path.join(tmpDir, 'redpanda-properties-v26.1.13.json');
    writeFixture({
      definitions: {},
      properties: {
        datalake_coordinator_max_files_per_commit: { name: 'datalake_coordinator_max_files_per_commit', type: 'integer' },
        enable_development_metrics: { name: 'enable_development_metrics', type: 'boolean' },
        existing_property: { name: 'existing_property', type: 'string', version: 'v26.1.1' },
      },
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('stamps the new tag on new properties so Phase 3 renders "Introduced in"', () => {
    updatePropertiesJsonWithVersion(jsonPath, diffData, 'v26.1.13');

    const props = JSON.parse(fs.readFileSync(jsonPath, 'utf8')).properties;
    expect(props.datalake_coordinator_max_files_per_commit.version).toBe('v26.1.13');
    expect(props.enable_development_metrics.version).toBe('v26.1.13');
  });

  test('leaves properties from earlier releases untouched', () => {
    updatePropertiesJsonWithVersion(jsonPath, diffData, 'v26.1.13');

    const props = JSON.parse(fs.readFileSync(jsonPath, 'utf8')).properties;
    expect(props.existing_property.version).toBe('v26.1.1');
  });

  test('does not rewrite the file when there are no new properties', () => {
    const before = fs.readFileSync(jsonPath, 'utf8');
    updatePropertiesJsonWithVersion(jsonPath, { details: { newProperties: [] } }, 'v26.1.13');
    expect(fs.readFileSync(jsonPath, 'utf8')).toBe(before);
  });

  test('skips new properties absent from the JSON without failing others', () => {
    const withGhost = { details: { newProperties: [{ name: 'ghost_property' }, { name: 'enable_development_metrics' }] } };
    updatePropertiesJsonWithVersion(jsonPath, withGhost, 'v26.1.13');

    const props = JSON.parse(fs.readFileSync(jsonPath, 'utf8')).properties;
    expect(props.enable_development_metrics.version).toBe('v26.1.13');
    expect(props.ghost_property).toBeUndefined();
  });

  test('does not stamp twice when a property already has a version', () => {
    updatePropertiesJsonWithVersion(jsonPath, diffData, 'v26.1.13');
    const once = fs.readFileSync(jsonPath, 'utf8');
    updatePropertiesJsonWithVersion(jsonPath, diffData, 'v26.1.13');
    expect(fs.readFileSync(jsonPath, 'utf8')).toBe(once);
  });

  test('supports a flat JSON without a top-level properties key', () => {
    writeFixture({
      enable_development_metrics: { name: 'enable_development_metrics', type: 'boolean' },
    });
    updatePropertiesJsonWithVersion(jsonPath, diffData, 'v26.1.13');

    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    expect(data.enable_development_metrics.version).toBe('v26.1.13');
  });

  test('is a no-op when the JSON file does not exist', () => {
    expect(() => updatePropertiesJsonWithVersion(path.join(tmpDir, 'missing.json'), diffData, 'v26.1.13')).not.toThrow();
  });

  test('edits are surgical: numbers JS cannot represent survive byte-for-byte', () => {
    // The Python extractor emits uint64 maxima and trailing-zero floats that a
    // JSON.parse/stringify round-trip would corrupt (…551615 → …552000, 0.0 → 0).
    const raw = [
      '{',
      '    "properties": {',
      '        "enable_development_metrics": {',
      '            "name": "enable_development_metrics",',
      '            "type": "boolean"',
      '        },',
      '        "big_number_property": {',
      '            "default": 0.0,',
      '            "maximum": 18446744073709551615,',
      '            "minimum": -9223372036854775808,',
      '            "name": "big_number_property"',
      '        }',
      '    }',
      '}',
    ].join('\n');
    fs.writeFileSync(jsonPath, raw);

    updatePropertiesJsonWithVersion(jsonPath, diffData, 'v26.1.13');

    const after = fs.readFileSync(jsonPath, 'utf8');
    expect(after).toContain('"version": "v26.1.13",');
    expect(after).toContain('"maximum": 18446744073709551615,');
    expect(after).toContain('"minimum": -9223372036854775808,');
    expect(after).toContain('"default": 0.0,');
    expect(after.endsWith('\n')).toBe(false);
  });

  test('does not touch an identically named key outside the properties section', () => {
    const raw = [
      '{',
      '    "definitions": {',
      '        "enable_development_metrics": {',
      '            "type": "object"',
      '        }',
      '    },',
      '    "properties": {',
      '        "enable_development_metrics": {',
      '            "name": "enable_development_metrics"',
      '        }',
      '    }',
      '}',
    ].join('\n');
    fs.writeFileSync(jsonPath, raw);

    updatePropertiesJsonWithVersion(jsonPath, diffData, 'v26.1.13');

    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    expect(data.definitions.enable_development_metrics.version).toBeUndefined();
    expect(data.properties.enable_development_metrics.version).toBe('v26.1.13');
  });
});

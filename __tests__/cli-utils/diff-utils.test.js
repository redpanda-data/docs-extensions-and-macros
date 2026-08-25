'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { updatePropertiesJsonWithVersion, resolveDiffBaseline } = require('../../cli-utils/diff-utils.js');

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

describe('resolveDiffBaseline', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-baseline-'));
    fs.mkdirSync(path.join(tmpDir, 'attachments'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('uses the committed baseline when the old-tag attachment exists', () => {
    const baseline = path.join(tmpDir, 'attachments', 'redpanda-properties-v26.1.14.json');
    fs.writeFileSync(baseline, '{}');
    const result = resolveDiffBaseline(tmpDir, 'v26.1.14');
    expect(result.useCommitted).toBe(true);
    expect(result.baselinePath).toBe(baseline);
  });

  it('falls back to extraction when no baseline exists', () => {
    const result = resolveDiffBaseline(tmpDir, 'v26.1.14');
    expect(result.useCommitted).toBe(false);
  });

  it('honors the regenerate flag even when a baseline exists', () => {
    fs.writeFileSync(path.join(tmpDir, 'attachments', 'redpanda-properties-v26.1.14.json'), '{}');
    const result = resolveDiffBaseline(tmpDir, 'v26.1.14', true);
    expect(result.useCommitted).toBe(false);
  });

  it('rejects tags that traverse outside the attachments directory', () => {
    expect(() => resolveDiffBaseline(tmpDir, '../../etc/passwd')).toThrow(/attachments directory/);
    expect(() => resolveDiffBaseline(tmpDir, '../secrets')).toThrow(/attachments directory/);
  });

  it('rejects tags that resolve into a subdirectory of attachments', () => {
    expect(() => resolveDiffBaseline(tmpDir, 'nested/v26.1.14')).toThrow(/attachments directory/);
  });
});

describe('repairPropertyAnchorsInJson', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { repairPropertyAnchorsInJson } = require('../../cli-utils/diff-utils.js');

  // The real file's shape: 4-space indent from the Python extractor, uint64 and
  // int64 limits as maxima, and anchors written with the dots deleted rather
  // than hyphenated.
  const FIXTURE = [
    '{',
    '    "properties": {',
    '        "flush.bytes": {',
    '            "name": "flush.bytes",',
    '            "config_scope": "topic",',
    '            "maximum": 18446744073709551615,',
    '            "minimum": -9223372036854775808,',
    '            "description": "Bytes before a flush. See <<flushms, `flush.ms`>>."',
    '        },',
    '        "flush.ms": {',
    '            "name": "flush.ms",',
    '            "config_scope": "topic",',
    '            "maximum": 9223372036854775807,',
    '            "description": "See <<flushbytes, `flush.bytes`>> too. Set it to 18446744073709551615."',
    '        }',
    '    }',
    '}'
  ].join('\n');

  let dir, file;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-repair-'));
    file = path.join(dir, 'redpanda-properties-v26.2.1.json');
    fs.writeFileSync(file, FIXTURE);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('rewrites the squashed anchors to the ids the pages actually emit', () => {
    const n = repairPropertyAnchorsInJson(file);
    const out = fs.readFileSync(file, 'utf8');

    expect(n).toBe(2);
    expect(out).toContain('<<flush-ms,');
    expect(out).toContain('<<flush-bytes,');
    expect(out).not.toContain('<<flushms,');
    expect(out).not.toContain('<<flushbytes,');
  });

  it('leaves every 64-bit literal byte-exact, which a round-trip would not', () => {
    repairPropertyAnchorsInJson(file);
    const out = fs.readFileSync(file, 'utf8');

    // These are the values JSON.stringify rounds. A parse/re-serialize would
    // publish 18446744073709552000, which the server rejects.
    expect(out).toContain('18446744073709551615');
    expect(out).toContain('-9223372036854775808');
    expect(out).toContain('9223372036854775807');
    expect(out).not.toContain('18446744073709552000');
    expect(out).not.toContain('9223372036854776000');
  });

  it('leaves a long integer inside a description alone', () => {
    repairPropertyAnchorsInJson(file);
    const out = JSON.parse(fs.readFileSync(file, 'utf8'));

    expect(out.properties['flush.ms'].description).toContain('Set it to 18446744073709551615.');
  });

  it('changes nothing but anchors, and keeps the file parseable and formatted', () => {
    repairPropertyAnchorsInJson(file);
    const out = fs.readFileSync(file, 'utf8');

    const mask = (v) => v.replace(/<<[^<>]*>>/g, 'X');
    expect(mask(out)).toBe(mask(FIXTURE));
    expect(() => JSON.parse(out)).not.toThrow();
    // Indentation is the extractor's, not JSON.stringify's default.
    expect(out).toMatch(/\n {8}"flush\.bytes": \{/);
  });

  it('is a no-op when every anchor is already correct', () => {
    repairPropertyAnchorsInJson(file);
    const once = fs.readFileSync(file, 'utf8');

    expect(repairPropertyAnchorsInJson(file)).toBe(0);
    expect(fs.readFileSync(file, 'utf8')).toBe(once);
  });

  it('does not throw on a missing or unparseable file', () => {
    expect(repairPropertyAnchorsInJson(path.join(dir, 'nope.json'))).toBe(0);
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(bad, '{ not json');
    expect(repairPropertyAnchorsInJson(bad)).toBe(0);
    expect(fs.readFileSync(bad, 'utf8')).toBe('{ not json');
  });
});

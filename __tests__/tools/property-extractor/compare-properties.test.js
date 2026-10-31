'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { comparePropertyFiles, compareProperties } = require('../../../tools/property-extractor/compare-properties.js');

describe('comparePropertyFiles JSON report', () => {
  let tmpDir, oldPath, newPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compare-properties-test-'));
    oldPath = path.join(tmpDir, 'redpanda-properties-v1.0.0.json');
    newPath = path.join(tmpDir, 'redpanda-properties-v2.0.0.json');

    fs.writeFileSync(oldPath, JSON.stringify({
      properties: {
        stable_property: { name: 'stable_property', type: 'string', description: 'Unchanged' },
      },
    }));
    fs.writeFileSync(newPath, JSON.stringify({
      properties: {
        stable_property: { name: 'stable_property', type: 'string', description: 'Unchanged' },
        brand_new_property: { name: 'brand_new_property', type: 'integer', description: 'Added' },
      },
    }));

    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('report is deterministic: reruns produce byte-identical output', () => {
    const filename = 'property-changes.json';
    comparePropertyFiles(oldPath, newPath, 'v1.0.0', 'v2.0.0', tmpDir, filename);
    const first = fs.readFileSync(path.join(tmpDir, filename), 'utf8');

    comparePropertyFiles(oldPath, newPath, 'v1.0.0', 'v2.0.0', tmpDir, filename);
    const second = fs.readFileSync(path.join(tmpDir, filename), 'utf8');

    expect(second).toBe(first);
  });

  test('report carries no timestamp field', () => {
    const filename = 'property-changes.json';
    comparePropertyFiles(oldPath, newPath, 'v1.0.0', 'v2.0.0', tmpDir, filename);

    const report = JSON.parse(fs.readFileSync(path.join(tmpDir, filename), 'utf8'));
    expect(report.comparison).toEqual({ oldVersion: 'v1.0.0', newVersion: 'v2.0.0' });
    expect(report.summary.newProperties).toBe(1);
    expect(report.details.newProperties[0].name).toBe('brand_new_property');
  });
});


/**
 * changedDescriptions used `!==` between the two sides' descriptions. That is
 * reference comparison, and each side of a comparison is parsed from its own
 * JSON file, so two byte-identical array-form descriptions (audience-scoped
 * paragraphs) are never the same array object and always reported as
 * "changed" -- with identical old and new text. On the published attachment,
 * which the release comparison actually reads, this would have reported
 * every array-form property as changed on every single comparison, forever,
 * masking real wording changes in the section of the release PR a reviewer
 * exists to check.
 */
function withDescription (description) {
  return { properties: { p: { name: 'p', description } } };
}

describe('changedDescriptions compares by value, not by reference', () => {
  it('reports no change for byte-identical array descriptions parsed as separate objects', () => {
    const description = ['Base prose.', 'cloud-only: Cloud sentence.'];
    const oldProps = withDescription(JSON.parse(JSON.stringify(description)));
    const newProps = withDescription(JSON.parse(JSON.stringify(description)));

    const report = compareProperties(oldProps, newProps, 'v1', 'v2');

    expect(report.changedDescriptions).toEqual([]);
  });

  it('still reports a genuine change between two different array descriptions', () => {
    const oldProps = withDescription(['Base prose.', 'cloud-only: Old sentence.']);
    const newProps = withDescription(['Base prose.', 'cloud-only: New sentence.']);

    const report = compareProperties(oldProps, newProps, 'v1', 'v2');

    expect(report.changedDescriptions).toHaveLength(1);
    expect(report.changedDescriptions[0].name).toBe('p');
  });

  it('still reports a genuine change between two different string descriptions', () => {
    const oldProps = withDescription('Old text.');
    const newProps = withDescription('New text.');

    const report = compareProperties(oldProps, newProps, 'v1', 'v2');

    expect(report.changedDescriptions).toHaveLength(1);
  });

  it('reports no change for identical string descriptions', () => {
    const oldProps = withDescription('Same text.');
    const newProps = withDescription('Same text.');

    const report = compareProperties(oldProps, newProps, 'v1', 'v2');

    expect(report.changedDescriptions).toEqual([]);
  });
});

describe('properties missing from the new tag', () => {
  const oldData = {
    properties: {
      kept: { name: 'kept', type: 'string', description: 'Kept', config_scope: 'cluster' },
      tagged_then_deleted: { name: 'tagged_then_deleted', type: 'string', description: 'Old flag', is_deprecated: true, visibility: 'deprecated', config_scope: 'cluster' },
      // A v26.1.x backport that the new line does not have yet, as
      // log_eviction_exempt_topics was for v26.1.14 -> v26.2.1 (#231).
      backport_only: { name: 'backport_only', type: 'array', description: 'Backported', is_deprecated: false, visibility: 'user', config_scope: 'cluster' },
      development_thing: { name: 'development_thing', type: 'string', description: 'Dev' },
    },
  };
  const newData = {
    properties: {
      kept: { name: 'kept', type: 'string', description: 'Kept', config_scope: 'cluster' },
    },
  };
  const names = (list) => list.map((p) => p.name).sort();

  test('on 26.1+, only a property deprecated in the old tag is reported as removed-deprecated', () => {
    const report = compareProperties(oldData, newData, 'v26.1.14', 'v26.2.1');
    expect(names(report.removedDeprecatedProperties)).toEqual(['tagged_then_deleted']);
    expect(names(report.removedProperties)).toEqual(['backport_only']);
  });

  test('before 26.1, every missing property is reported as removed, as before', () => {
    const report = compareProperties(oldData, newData, 'v25.2.1', 'v25.3.1');
    expect(report.removedDeprecatedProperties).toEqual([]);
    expect(names(report.removedProperties)).toEqual(['backport_only', 'tagged_then_deleted']);
  });

  describe('the merged new-version attachment', () => {
    let tmpDir;
    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compare-properties-removed-'));
      jest.spyOn(console, 'log').mockImplementation(() => {});
    });
    afterEach(() => {
      jest.restoreAllMocks();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('restores the deprecated property with its scope and never injects the backport', () => {
      const oldPath = path.join(tmpDir, 'old.json');
      const newPath = path.join(tmpDir, 'new.json');
      fs.writeFileSync(oldPath, JSON.stringify(oldData));
      fs.writeFileSync(newPath, JSON.stringify(newData));
      comparePropertyFiles(oldPath, newPath, 'v26.1.14', 'v26.2.1', tmpDir, 'changes.json');
      const merged = JSON.parse(fs.readFileSync(newPath, 'utf8')).properties;
      expect(Object.keys(merged).sort()).toEqual(['kept', 'tagged_then_deleted']);
      expect(merged.tagged_then_deleted).toMatchObject({ removed_deprecated: true, is_deprecated: true, config_scope: 'cluster' });
      const changes = JSON.parse(fs.readFileSync(path.join(tmpDir, 'changes.json'), 'utf8'));
      expect(JSON.stringify(changes)).toContain('backport_only');
    });
  });
});

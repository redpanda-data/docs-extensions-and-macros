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

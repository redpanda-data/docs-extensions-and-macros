'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { comparePropertyFiles } = require('../../../tools/property-extractor/compare-properties.js');

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

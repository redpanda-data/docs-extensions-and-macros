'use strict';

/**
 * The published version lives in three places: package.json and the two
 * mirrored copies in package-lock.json. Bumping only some of them leaves the
 * lockfile disagreeing with the manifest, which npm then rewrites on the next
 * install and which makes a release look bumped when it is not.
 *
 * release-please writes all three in the release PR. This test is what
 * catches a hand edit that updates some of them and not the others.
 */

const fs = require('fs');
const path = require('path');
const semver = require('semver');

const repoRoot = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8'));

describe('package version', () => {
  test('is a valid semver version', () => {
    expect(semver.valid(pkg.version)).toBe(pkg.version);
  });

  test('matches the top-level version in package-lock.json', () => {
    expect(lock.version).toBe(pkg.version);
  });

  test('matches the root package entry in package-lock.json', () => {
    expect(lock.packages[''].version).toBe(pkg.version);
  });

  test('names the same package in both files', () => {
    expect(lock.name).toBe(pkg.name);
    expect(lock.packages[''].name).toBe(pkg.name);
  });
});

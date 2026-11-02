'use strict';

/**
 * Shared `major.minor` derivation.
 *
 * Two variants exist because the callers have genuinely different contracts, and
 * they live side by side here so a third copy never gets written:
 *
 * - `getMajorMinor` is strict. It is used by the OpenAPI bundler, where a bad
 *   version is a build error and a Git branch name (for example, `dev`) must
 *   pass through untouched.
 * - `toShortVersion` is lenient. It is used by the Antora version fetcher, where
 *   a non-semver release channel (for example, `nightly`) must simply not
 *   produce a `-version-short` attribute rather than throw or leak the raw
 *   value into the docs.
 */

// A complete semantic version, optionally with prerelease and build metadata.
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(-[\w.-]+)?(\+[\w.-]+)?$/;

// A leading `<major>.<minor>` pair that is followed by a separator or the end of
// the string. This also accepts two-part versions such as `26.2`, which Antora
// components use, and which `SEMVER_PATTERN` rejects.
const MAJOR_MINOR_PATTERN = /^(\d+)\.(\d+)(?:[.+-]|$)/;

/**
 * Return the major.minor portion of a semantic version string.
 *
 * Accepts a semantic version like `25.1.1` and yields `25.1`. A value that is
 * not a semantic version (for example, the branch name `dev`) is returned
 * unchanged.
 * @param {string} version - Semantic version (for example, `'25.1.1'`) or a branch name.
 * @returns {string} The `major.minor` string (for example, `'25.1'`) or the input unchanged.
 * @throws {Error} If `version` is not a non-empty string, lacks major/minor parts, or if major/minor are not numeric.
 */
function getMajorMinor(version) {
  if (!version || typeof version !== 'string') {
    throw new Error('Version must be a non-empty string');
  }

  // Only process if valid semver, else return as-is (branch name)
  if (!SEMVER_PATTERN.test(version)) {
    return version;
  }
  const parts = version.split('.');
  if (parts.length < 2) {
    throw new Error(`Invalid version format: ${version}. Expected X.Y.Z format`);
  }
  const major = parseInt(parts[0], 10);
  const minor = parseInt(parts[1], 10);
  if (isNaN(major) || isNaN(minor)) {
    throw new Error(`Major and minor versions must be numbers: ${version}`);
  }
  return `${major}.${minor}`;
}

/**
 * Return the major.minor portion of a version, or `null` when there is none.
 *
 * Unlike `getMajorMinor`, this never throws and never returns a value that is
 * not a `major.minor` pair, so a caller can treat `null` as "no short version
 * exists for this release channel". Leading zeros are normalized, so `26.02.1`
 * yields `26.2`. The `v` prefix is not accepted: sanitize it first.
 * @param {string} version - Version without a `v` prefix (for example, `'26.2.1'`).
 * @returns {string|null} The `major.minor` string, or `null` for anything else.
 */
function toShortVersion(version) {
  if (!version || typeof version !== 'string') return null;
  const match = MAJOR_MINOR_PATTERN.exec(version);
  return match ? `${Number(match[1])}.${Number(match[2])}` : null;
}

module.exports = { getMajorMinor, toShortVersion };

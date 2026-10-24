'use strict';

// Helpers for pinning an attribute to the release line a component version
// documents, rather than to the newest release overall. The lines come from
// the fetched release tags themselves, so a new release line is picked up as
// soon as it ships and nothing needs a manual version map.

const semver = require('semver');

/**
 * Returns the newest stable tag of each major.minor release line.
 *
 * Only plain `v<major>.<minor>.<patch>` tags count. Prereleases are skipped,
 * and so are the legacy operator tags such as `v2.3.15-24.3.18`, whose suffix
 * semver reads as a prerelease. Patches are compared as semver, so the result
 * does not depend on the order the registry lists tags in.
 *
 * @param {string[]} tags - Release tags, for example ['v26.1.12', 'v26.1.9'].
 * @returns {Map<string, string>} Release line (for example '26.1') to its newest tag.
 */
function latestStablePerLine (tags) {
  const lines = new Map();
  for (const tag of tags || []) {
    if (typeof tag !== 'string' || !tag.startsWith('v')) continue;
    const parsed = semver.parse(tag.slice(1));
    if (!parsed || parsed.prerelease.length || parsed.build.length) continue;
    const line = `${parsed.major}.${parsed.minor}`;
    const current = lines.get(line);
    if (!current || semver.gt(parsed, current.slice(1))) lines.set(line, tag);
  }
  return lines;
}

/**
 * Returns the release line an Antora component version names, or null when
 * the version is not a `major.minor` pair (for example, an unversioned
 * component or a version named after something other than a release).
 *
 * @param {string|null|undefined} version - The component version, for example '25.3'.
 * @returns {string|null}
 */
function releaseLineOf (version) {
  const match = /^(\d+)\.(\d+)$/.exec(String(version ?? ''));
  return match ? `${Number(match[1])}.${Number(match[2])}` : null;
}

/**
 * Returns true when a component version documents an older release line than
 * the component's latest version. Only those versions are pinned to their own
 * line. The latest version, prereleases ahead of it, and unversioned
 * components keep the newest release overall.
 *
 * @param {string} version - The component version.
 * @param {string} latestVersion - The component's latest version.
 * @returns {boolean}
 */
function isOlderReleaseLine (version, latestVersion) {
  const line = releaseLineOf(version);
  const latestLine = releaseLineOf(latestVersion);
  if (!line || !latestLine) return false;
  return semver.lt(`${line}.0`, `${latestLine}.0`);
}

module.exports = { latestStablePerLine, releaseLineOf, isOlderReleaseLine };

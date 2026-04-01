'use strict';

const octokit = require('../../cli-utils/octokit-client');
const { hasGitHubToken } = require('../../cli-utils/github-token');
const semver = require('semver');

/**
 * GitHub release discovery utilities for Redpanda Connect
 *
 * Provides functions to discover and filter GitHub releases between versions.
 */

// Cache for GitHub releases to avoid repeated API calls
let releaseCache = null;
let cacheTimestamp = null;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Fetch all releases from redpanda-data/connect repository
 * @param {boolean} useCache - Whether to use cached results
 * @returns {Promise<Array>} Array of release objects
 */
async function fetchAllReleases(useCache = true) {
  // Check cache
  if (useCache && releaseCache && cacheTimestamp) {
    const age = Date.now() - cacheTimestamp;
    if (age < CACHE_TTL_MS) {
      console.log(`✓ Using cached releases (${Math.round(age / 1000)}s old)`);
      return releaseCache;
    }
  }

  console.log('Fetching releases from GitHub...');

  // Warn if no token available (only once per execution)
  if (!hasGitHubToken() && !fetchAllReleases._warnedAboutToken) {
    console.warn('⚠️  No GitHub token found. API rate limits will be more restrictive.');
    console.warn('   Set GITHUB_TOKEN or GH_TOKEN environment variable for higher limits.');
    fetchAllReleases._warnedAboutToken = true;
  }

  try {
    // Fetch all releases (paginated)
    const releases = await octokit.paginate(
      octokit.rest.repos.listReleases,
      {
        owner: 'redpanda-data',
        repo: 'connect',
        per_page: 100
      }
    );

    console.log(`✓ Fetched ${releases.length} releases from GitHub`);

    // Update cache
    releaseCache = releases;
    cacheTimestamp = Date.now();

    return releases;
  } catch (error) {
    if (error.status === 403 && error.response?.headers?.['x-ratelimit-remaining'] === '0') {
      const resetTime = new Date(parseInt(error.response.headers['x-ratelimit-reset']) * 1000);
      throw new Error(
        `GitHub API rate limit exceeded. Resets at ${resetTime.toLocaleTimeString()}. ` +
        `Consider setting GITHUB_TOKEN environment variable for higher limits.`
      );
    }

    throw new Error(`Failed to fetch GitHub releases: ${error.message}`);
  }
}

/**
 * Parse version from GitHub release tag
 * Handles formats: "v4.50.0", "4.50.0", "v4.50.0-beta.1"
 * @param {string} tag - Release tag name
 * @returns {string|null} Normalized version string or null if invalid
 */
function parseVersionFromTag(tag) {
  if (!tag) return null;

  // Remove 'v' prefix if present
  const normalized = tag.startsWith('v') ? tag.slice(1) : tag;

  // Validate semver format
  const version = semver.valid(normalized);
  return version;
}

/**
 * Check if a version is a pre-release (beta, RC, alpha, etc.)
 * @param {string} version - Semver version string
 * @returns {boolean} True if pre-release
 */
function isPrerelease(version) {
  const parsed = semver.parse(version);
  if (!parsed) return false;

  return parsed.prerelease.length > 0;
}

/**
 * Filter releases to stable GA releases only
 * @param {Array} releases - Array of GitHub release objects
 * @returns {Array} Filtered releases with only stable versions
 */
function filterToStableReleases(releases) {
  return releases.filter(release => {
    // Skip drafts
    if (release.draft) {
      return false;
    }

    // Parse version
    const version = parseVersionFromTag(release.tag_name);
    if (!version) {
      return false;
    }

    // Skip pre-releases (beta, RC, etc.)
    if (isPrerelease(version)) {
      return false;
    }

    return true;
  });
}

/**
 * Discover all intermediate releases between two versions
 * @param {string} fromVersion - Starting version (e.g., "4.50.0")
 * @param {string} toVersion - Ending version (e.g., "4.54.0")
 * @param {Object} options - Optional configuration
 * @param {boolean} options.includePrerelease - Include beta/RC versions (default: false)
 * @param {boolean} options.useCache - Use cached GitHub data (default: true)
 * @returns {Promise<Array>} Array of version objects: [{version, tag, date, url}]
 */
async function discoverIntermediateReleases(fromVersion, toVersion, options = {}) {
  const {
    includePrerelease = false,
    useCache = true
  } = options;

  // Validate versions are strings
  if (typeof fromVersion !== 'string') {
    throw new Error(`Invalid starting version: ${fromVersion}`);
  }
  if (typeof toVersion !== 'string') {
    throw new Error(`Invalid ending version: ${toVersion}`);
  }

  // Normalize versions (remove 'v' prefix if present)
  const normalizedFrom = fromVersion.startsWith('v') ? fromVersion.slice(1) : fromVersion;
  const normalizedTo = toVersion.startsWith('v') ? toVersion.slice(1) : toVersion;

  // Validate versions
  if (!semver.valid(normalizedFrom)) {
    throw new Error(`Invalid starting version: ${fromVersion}`);
  }
  if (!semver.valid(normalizedTo)) {
    throw new Error(`Invalid ending version: ${toVersion}`);
  }

  console.log('');
  console.log(`Discovering releases between ${normalizedFrom} and ${normalizedTo}...`);

  // Fetch all releases
  const allReleases = await fetchAllReleases(useCache);

  // Filter to stable releases unless includePrerelease is true
  const filteredReleases = includePrerelease
    ? allReleases.filter(r => !r.draft && parseVersionFromTag(r.tag_name))
    : filterToStableReleases(allReleases);

  // Parse and filter versions in range
  const versionsInRange = [];

  for (const release of filteredReleases) {
    const version = parseVersionFromTag(release.tag_name);
    if (!version) continue;

    // Check if version is in range (inclusive)
    if (
      semver.gte(version, normalizedFrom) &&
      semver.lte(version, normalizedTo)
    ) {
      versionsInRange.push({
        version,
        tag: release.tag_name,
        date: release.published_at,
        url: release.html_url,
        isPrerelease: isPrerelease(version)
      });
    }
  }

  // Sort by semver (oldest to newest)
  versionsInRange.sort((a, b) => semver.compare(a.version, b.version));

  console.log(`✓ Found ${versionsInRange.length} release(s) in range`);

  if (versionsInRange.length === 0) {
    console.warn('⚠️  No releases found in the specified range');
    return [];
  }

  // Log the discovered versions
  console.log('');
  console.log('Releases to process:');
  versionsInRange.forEach((v, i) => {
    const prereleaseTag = v.isPrerelease ? ' (pre-release)' : '';
    const date = new Date(v.date).toLocaleDateString();
    console.log(`  ${i + 1}. ${v.version}${prereleaseTag} - ${date}`);
  });
  console.log('');

  return versionsInRange;
}

/**
 * Find the appropriate cloud version for a given OSS release date
 * Returns the latest stable cloud version published on or before the OSS release date
 * @param {string} ossReleaseDate - ISO date string of the OSS release
 * @param {Object} options - Optional configuration
 * @param {boolean} options.useCache - Use cached GitHub data (default: true)
 * @returns {Promise<string|null>} Cloud version string or null if not found
 */
async function findCloudVersionForDate(ossReleaseDate, options = {}) {
  const { useCache = true } = options;

  // Fetch all releases from the main connect repo (includes cloud builds)
  const allReleases = await fetchAllReleases(useCache);

  // Filter to stable releases
  const stableReleases = filterToStableReleases(allReleases);

  // Filter to releases on or before the OSS release date
  const ossDate = new Date(ossReleaseDate);
  const eligibleReleases = stableReleases.filter(release => {
    const releaseDate = new Date(release.published_at);
    return releaseDate <= ossDate;
  });

  if (eligibleReleases.length === 0) {
    return null;
  }

  // Sort by date (most recent first)
  eligibleReleases.sort((a, b) => {
    return new Date(b.published_at) - new Date(a.published_at);
  });

  // Return the most recent version
  const cloudVersion = parseVersionFromTag(eligibleReleases[0].tag_name);
  return cloudVersion;
}

/**
 * Clear the release cache
 * Useful for testing or when you need fresh data
 */
function clearCache() {
  releaseCache = null;
  cacheTimestamp = null;
}

module.exports = {
  discoverIntermediateReleases,
  fetchAllReleases,
  parseVersionFromTag,
  isPrerelease,
  filterToStableReleases,
  findCloudVersionForDate,
  clearCache
};

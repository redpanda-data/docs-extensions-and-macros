'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Create a master diff JSON that aggregates changes across multiple releases
 *
 * @param {Array} intermediateResults - Array of {fromVersion, toVersion, diffPath, success}
 * @param {string} finalDiffPath - Path to the final diff JSON
 * @param {string} outputPath - Where to write the master diff
 * @returns {Object} Master diff object
 */
function createMasterDiff(intermediateResults, finalDiffPath, outputPath) {
  const releases = [];

  // Add all intermediate releases
  for (const result of intermediateResults) {
    if (!result.success) continue;

    try {
      const diffData = JSON.parse(fs.readFileSync(result.diffPath, 'utf8'));
      releases.push({
        fromVersion: result.fromVersion,
        toVersion: result.toVersion,
        date: diffData.comparison?.timestamp || new Date().toISOString(),
        summary: diffData.summary || {},
        details: diffData.details || {},
        binaryAnalysis: diffData.binaryAnalysis || null
      });
    } catch (err) {
      console.warn(`Warning: Failed to load ${result.diffPath}: ${err.message}`);
    }
  }

  // Add the final release
  if (finalDiffPath && fs.existsSync(finalDiffPath)) {
    try {
      const diffData = JSON.parse(fs.readFileSync(finalDiffPath, 'utf8'));
      const finalFromVersion = diffData.comparison?.oldVersion;
      const finalToVersion = diffData.comparison?.newVersion;

      releases.push({
        fromVersion: finalFromVersion,
        toVersion: finalToVersion,
        date: diffData.comparison?.timestamp || new Date().toISOString(),
        summary: diffData.summary || {},
        details: diffData.details || {},
        binaryAnalysis: diffData.binaryAnalysis || null
      });
    } catch (err) {
      console.warn(`Warning: Failed to load ${finalDiffPath}: ${err.message}`);
    }
  }

  // Calculate total summary across all releases
  const totalSummary = {
    versions: releases.map(r => r.toVersion),
    releaseCount: releases.length,
    newComponents: releases.reduce((sum, r) => sum + (r.summary.newComponents || 0), 0),
    newFields: releases.reduce((sum, r) => sum + (r.summary.newFields || 0), 0),
    removedComponents: releases.reduce((sum, r) => sum + (r.summary.removedComponents || 0), 0),
    removedFields: releases.reduce((sum, r) => sum + (r.summary.removedFields || 0), 0),
    deprecatedComponents: releases.reduce((sum, r) => sum + (r.summary.deprecatedComponents || 0), 0),
    deprecatedFields: releases.reduce((sum, r) => sum + (r.summary.deprecatedFields || 0), 0),
    changedDefaults: releases.reduce((sum, r) => sum + (r.summary.changedDefaults || 0), 0)
  };

  const masterDiff = {
    metadata: {
      generatedAt: new Date().toISOString(),
      startVersion: releases[0]?.fromVersion,
      endVersion: releases[releases.length - 1]?.toVersion,
      processedReleases: releases.length
    },
    totalSummary,
    releases
  };

  // Write to file
  if (outputPath) {
    fs.writeFileSync(outputPath, JSON.stringify(masterDiff, null, 2), 'utf8');
    console.log(`✓ Created master diff: ${path.basename(outputPath)}`);
    console.log(`   Spans ${releases.length} release(s): ${releases[0]?.fromVersion} → ${releases[releases.length - 1]?.toVersion}`);
  }

  return masterDiff;
}

module.exports = {
  createMasterDiff
};

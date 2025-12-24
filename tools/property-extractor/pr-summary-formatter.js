/**
 * Format property diff data into a PR-friendly summary
 * Outputs a console-parseable format for GitHub PRs
 *
 * This module generates GitHub PR-ready summaries from property comparison data.
 * It's automatically invoked by doc-tools during property docs generation when
 * comparing versions (e.g., doc-tools generate property-docs --tag v25.3.3 --diff v25.3.1)
 *
 * The summary includes:
 * - High-level statistics (new/changed/removed properties)
 * - Breaking change warnings
 * - Missing description alerts
 * - Action items for technical writers
 * - Detailed tables with property information
 *
 * Usage:
 *   const { printPRSummary } = require('./pr-summary-formatter');
 *   const diffData = require('./path/to/diff.json');
 *   printPRSummary(diffData);
 *
 * Input format (diff data from compare-properties.js):
 *   {
 *     comparison: { oldVersion, newVersion, timestamp },
 *     summary: { newProperties, changedDefaults, ... },
 *     details: { newProperties: [...], changedDefaults: [...], ... }
 *   }
 */

/**
 * Generate a PR-friendly summary for property changes
 * @param {object} diffData - Diff data from compareProperties
 * @returns {string} Formatted summary
 */
function generatePRSummary(diffData) {
  const lines = [];

  // Header with delimiters for GitHub Action parsing
  lines.push('<!-- PR_SUMMARY_START -->');
  lines.push('');

  // Quick Summary Section
  lines.push('## 📋 Redpanda Property Documentation Update');
  lines.push('');
  lines.push(`**Version:** ${diffData.comparison.oldVersion} → ${diffData.comparison.newVersion}`);
  lines.push('');

  // High-level stats
  const stats = diffData.summary;
  const hasChanges = Object.values(stats).some(v => v > 0);

  if (!hasChanges) {
    lines.push('Done: **No changes detected** - Documentation is up to date');
    lines.push('');
    lines.push('<!-- PR_SUMMARY_END -->');
    return lines.join('\n');
  }

  lines.push('### Summary');
  lines.push('');

  if (stats.newProperties > 0) {
    lines.push(`- **${stats.newProperties}** new propert${stats.newProperties !== 1 ? 'ies' : 'y'}`);
  }

  if (stats.changedDefaults > 0) {
    lines.push(`- **${stats.changedDefaults}** default value change${stats.changedDefaults !== 1 ? 's' : ''} ⚠️`);
  }

  if (stats.changedTypes > 0) {
    lines.push(`- **${stats.changedTypes}** type change${stats.changedTypes !== 1 ? 's' : ''} ⚠️`);
  }

  if (stats.changedDescriptions > 0) {
    lines.push(`- **${stats.changedDescriptions}** description update${stats.changedDescriptions !== 1 ? 's' : ''}`);
  }

  if (stats.deprecatedProperties > 0) {
    lines.push(`- **${stats.deprecatedProperties}** deprecated propert${stats.deprecatedProperties !== 1 ? 'ies' : 'y'}`);
  }

  if (stats.removedProperties > 0) {
    lines.push(`- **${stats.removedProperties}** removed propert${stats.removedProperties !== 1 ? 'ies' : 'y'} ⚠️`);
  }

  if (stats.emptyDescriptions > 0) {
    lines.push(`- **${stats.emptyDescriptions}** propert${stats.emptyDescriptions !== 1 ? 'ies' : 'y'} with missing descriptions ⚠️`);
  }

  lines.push('');

  // Breaking Changes Section
  const breakingChanges = [];
  if (stats.removedProperties > 0) breakingChanges.push('removed properties');
  if (stats.changedDefaults > 0) breakingChanges.push('changed defaults');
  if (stats.changedTypes > 0) breakingChanges.push('changed types');

  if (breakingChanges.length > 0) {
    lines.push('### Warning: Breaking Changes Detected');
    lines.push('');
    lines.push(`This update includes **${breakingChanges.join(', ')}** that may affect existing configurations.`);
    lines.push('');
  }

  // Missing Descriptions Warning
  if (stats.emptyDescriptions > 0) {
    lines.push('### Warning: Missing Descriptions');
    lines.push('');
    lines.push(`**${stats.emptyDescriptions}** propert${stats.emptyDescriptions !== 1 ? 'ies are' : 'y is'} missing descriptions - these need writer attention:`);
    lines.push('');

    diffData.details.emptyDescriptions.forEach(prop => {
      lines.push(`- \`${prop.name}\` (${prop.type})`);
    });
    lines.push('');
  }

  // Action Items
  lines.push('### 📝 Action Items for Writers');
  lines.push('');

  const actionItems = [];

  // Add action items for missing descriptions
  if (stats.emptyDescriptions > 0) {
    actionItems.push({
      priority: 0,
      text: `Warning: Add descriptions for ${stats.emptyDescriptions} propert${stats.emptyDescriptions !== 1 ? 'ies' : 'y'} (see Missing Descriptions section)`
    });
  }

  // New properties that need review
  if (stats.newProperties > 0) {
    const shortDescCount = diffData.details.newProperties.filter(p =>
      !p.description || p.description.length < 50
    ).length;

    if (shortDescCount > 0) {
      actionItems.push({
        priority: 1,
        text: `Review and enhance descriptions for ${shortDescCount} new propert${shortDescCount !== 1 ? 'ies' : 'y'} with minimal context`
      });
    }
  }

  // Deprecated properties
  if (stats.deprecatedProperties > 0) {
    diffData.details.deprecatedProperties.forEach(prop => {
      actionItems.push({
        priority: 2,
        text: `Update docs for deprecated property \`${prop.name}\``
      });
    });
  }

  // Removed properties
  if (stats.removedProperties > 0) {
    actionItems.push({
      priority: 3,
      text: `Review removal of ${stats.removedProperties} propert${stats.removedProperties !== 1 ? 'ies' : 'y'} and update migration guides if needed`
    });
  }

  // Changed defaults that may break configs
  if (stats.changedDefaults > 0) {
    actionItems.push({
      priority: 4,
      text: `Review ${stats.changedDefaults} default value change${stats.changedDefaults !== 1 ? 's' : ''} for breaking changes`
    });
  }

  // Sort by priority and output
  actionItems.sort((a, b) => a.priority - b.priority);

  if (actionItems.length > 0) {
    actionItems.forEach(item => {
      lines.push(`- [ ] ${item.text}`);
    });
  } else {
    lines.push('- [ ] Review generated documentation');
  }

  lines.push('');

  // Detailed breakdown (expandable)
  lines.push('<details>');
  lines.push('<summary><strong>📋 Detailed Changes</strong> (click to expand)</summary>');
  lines.push('');

  // New Properties
  if (stats.newProperties > 0) {
    lines.push('#### New Properties');
    lines.push('');
    lines.push('| Property | Type | Default | Description |');
    lines.push('|----------|------|---------|-------------|');

    diffData.details.newProperties.forEach(prop => {
      const name = `\`${prop.name}\``;
      const type = prop.type || 'unknown';
      const defaultVal = formatDefaultValue(prop.default);
      const desc = truncateDescription(prop.description, 80);
      lines.push(`| ${name} | ${type} | ${defaultVal} | ${desc} |`);
    });
    lines.push('');
  }

  // Changed Defaults
  if (stats.changedDefaults > 0) {
    lines.push('#### Warning: Changed Default Values');
    lines.push('');
    lines.push('| Property | Old Default | New Default |');
    lines.push('|----------|-------------|-------------|');

    diffData.details.changedDefaults.forEach(change => {
      const name = `\`${change.name}\``;
      const oldVal = formatDefaultValue(change.oldDefault);
      const newVal = formatDefaultValue(change.newDefault);
      lines.push(`| ${name} | ${oldVal} | ${newVal} |`);
    });
    lines.push('');
  }

  // Changed Types
  if (stats.changedTypes > 0) {
    lines.push('#### Warning: Changed Property Types');
    lines.push('');
    lines.push('| Property | Old Type | New Type |');
    lines.push('|----------|----------|----------|');

    diffData.details.changedTypes.forEach(change => {
      const name = `\`${change.name}\``;
      lines.push(`| ${name} | ${change.oldType} | ${change.newType} |`);
    });
    lines.push('');
  }

  // Changed Descriptions
  if (stats.changedDescriptions > 0) {
    lines.push('#### Description Updates');
    lines.push('');
    lines.push(`**${stats.changedDescriptions}** propert${stats.changedDescriptions !== 1 ? 'ies have' : 'y has'} updated descriptions:`);
    lines.push('');

    diffData.details.changedDescriptions.forEach(change => {
      lines.push(`**\`${change.name}\`:**`);
      lines.push('');
      lines.push('Old:');
      lines.push('> ' + (change.oldDescription || 'No description'));
      lines.push('');
      lines.push('New:');
      lines.push('> ' + (change.newDescription || 'No description'));
      lines.push('');
    });
  }

  // Deprecated Properties
  if (stats.deprecatedProperties > 0) {
    lines.push('#### Deprecated Properties');
    lines.push('');
    diffData.details.deprecatedProperties.forEach(prop => {
      lines.push(`- **\`${prop.name}\`** — ${prop.reason}`);
    });
    lines.push('');
  }

  // Removed Properties
  if (stats.removedProperties > 0) {
    lines.push('#### Warning: Removed Properties');
    lines.push('');
    diffData.details.removedProperties.forEach(prop => {
      lines.push(`- **\`${prop.name}\`** (${prop.type})`);
      if (prop.description && prop.description !== 'No description') {
        lines.push(`  - ${truncateDescription(prop.description, 100)}`);
      }
    });
    lines.push('');
  }

  lines.push('</details>');
  lines.push('');

  // Footer
  lines.push('---');
  lines.push('');
  lines.push(`*Generated: ${diffData.comparison.timestamp}*`);
  lines.push('');
  lines.push('<!-- PR_SUMMARY_END -->');

  return lines.join('\n');
}

/**
 * Format a default value for display in tables
 * @param {*} value - The default value
 * @returns {string} Formatted value
 */
function formatDefaultValue(value) {
  if (value === null || value === undefined) {
    return '`null`';
  }
  if (typeof value === 'string') {
    return `\`"${value}"\``;
  }
  if (typeof value === 'boolean') {
    return `\`${value}\``;
  }
  if (typeof value === 'number') {
    // Format large numbers with human-readable units
    if (value >= 3600000) {
      const hours = value / 3600000;
      return `\`${value}\` (${hours}h)`;
    }
    if (value >= 60000) {
      const minutes = value / 60000;
      return `\`${value}\` (${minutes}m)`;
    }
    if (value >= 1000) {
      const seconds = value / 1000;
      return `\`${value}\` (${seconds}s)`;
    }
    return `\`${value}\``;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '`[]`';
    return `\`[${value.length} items]\``;
  }
  if (typeof value === 'object') {
    return `\`${JSON.stringify(value)}\``;
  }
  return `\`${String(value)}\``;
}

/**
 * Truncate description to specified length, respecting word boundaries
 * @param {string} text - Text to truncate
 * @param {number} maxLength - Maximum length
 * @returns {string} Truncated text
 */
function truncateDescription(text, maxLength = 100) {
  if (!text || text === 'No description') {
    return '*No description*';
  }

  // Remove newlines and excessive whitespace
  const clean = text.replace(/\s+/g, ' ').trim();

  if (clean.length <= maxLength) {
    return clean;
  }

  // Truncate at word boundary
  const truncated = clean.substring(0, maxLength);
  const lastSpace = truncated.lastIndexOf(' ');

  if (lastSpace > maxLength * 0.8) {
    return truncated.substring(0, lastSpace) + '...';
  }

  return truncated + '...';
}

/**
 * Print the PR summary to console
 * @param {object} diffData - Diff data
 */
function printPRSummary(diffData) {
  const summary = generatePRSummary(diffData);
  console.log('\n' + summary + '\n');
}

module.exports = {
  generatePRSummary,
  printPRSummary,
  formatDefaultValue,
  truncateDescription
};

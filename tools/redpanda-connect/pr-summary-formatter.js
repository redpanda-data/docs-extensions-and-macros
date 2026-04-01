/**
 * Format diff and cloud support data into a PR-friendly summary
 * Outputs a console-parseable format for GitHub Actions
 */

/**
 * Generate PR summary for multiple releases
 * @param {object} masterDiff - Master diff with releases array
 * @param {object} binaryAnalysis - Cloud support data (from latest release)
 * @param {array} draftedConnectors - Array of newly drafted connectors
 * @returns {string} Formatted summary
 */
function generateMultiVersionPRSummary(masterDiff, binaryAnalysis = null, draftedConnectors = null) {
  const lines = [];

  // Defensive: ensure metadata exists
  const metadata = masterDiff?.metadata || {};
  const startVersion = metadata.startVersion || 'unknown';
  const endVersion = metadata.endVersion || 'unknown';
  const processedReleases = metadata.processedReleases || 0;

  lines.push('<!-- PR_SUMMARY_START -->');
  lines.push('');
  lines.push('## 📊 Redpanda Connect Documentation Update');
  lines.push('');
  lines.push(`**📦 Multi-Release Update:** ${startVersion} → ${endVersion}`);
  lines.push(`**Releases Processed:** ${processedReleases}`);

  if (binaryAnalysis) {
    lines.push(`**Cloud Version:** ${binaryAnalysis.cloudVersion}`);
  }

  lines.push('');

  // Total summary across all releases
  lines.push('### Total Changes Across All Releases');
  lines.push('');
  const total = masterDiff?.totalSummary || {};

  if (total.newComponents > 0) {
    lines.push(`- **${total.newComponents}** new connectors`);
  }
  if (total.newFields > 0) {
    lines.push(`- **${total.newFields}** new fields across ${total.releaseCount || 0} release(s)`);
  }
  if (total.removedComponents > 0) {
    lines.push(`- **${total.removedComponents}** removed connectors ⚠️`);
  }
  if (total.removedFields > 0) {
    lines.push(`- **${total.removedFields}** removed fields ⚠️`);
  }
  if (total.deprecatedComponents > 0) {
    lines.push(`- **${total.deprecatedComponents}** deprecated connectors`);
  }
  if (total.deprecatedFields > 0) {
    lines.push(`- **${total.deprecatedFields}** deprecated fields`);
  }
  if (total.changedDefaults > 0) {
    lines.push(`- **${total.changedDefaults}** changed default values ⚠️`);
  }

  lines.push('');

  // Guard: ensure releases array exists
  const releases = masterDiff?.releases || [];
  if (releases.length === 0) {
    lines.push('_No releases to process_');
    lines.push('');
    lines.push('<!-- PR_SUMMARY_END -->');
    return lines.join('\n');
  }

  // Per-release detailed breakdown
  lines.push('### Changes Per Release');
  lines.push('');

  for (const release of releases) {
    const releaseNotesUrl = `https://github.com/redpanda-data/connect/releases/tag/v${release.toVersion}`;
    lines.push(`#### 🔖 Version ${release.toVersion}`);
    lines.push(`> [Release notes](${releaseNotesUrl})`);
    lines.push('');

    const summary = release.summary || {};
    const details = release.details || {};
    const hasChanges = Object.values(summary).some(v => v > 0);

    if (!hasChanges) {
      lines.push('_No documentation changes in this release_');
      lines.push('');
      continue;
    }

    // New connectors with descriptions
    const newComponents = details.newComponents || [];
    if (summary.newComponents > 0 && newComponents.length > 0) {
      lines.push(`**New Connectors (${summary.newComponents}):**`);
      lines.push('');
      const inCloud = release.binaryAnalysis?.comparison?.inCloud || [];
      const cloudOnly = release.binaryAnalysis?.comparison?.cloudOnly || [];
      const notInCloud = release.binaryAnalysis?.comparison?.notInCloud || [];
      const cgoOnly = release.binaryAnalysis?.cgoOnly || [];

      newComponents.forEach(comp => {
        const isInCloud = inCloud.some(c => c.type === comp.type && c.name === comp.name) ||
          cloudOnly.some(c => c.type === comp.type && c.name === comp.name);
        const isSelfHostedOnly = notInCloud.some(c => c.type === comp.type && c.name === comp.name);
        const isCgoOnly = cgoOnly.some(c => c.type === comp.type && c.name === comp.name);

        let platformIndicator = '';
        if (isInCloud) platformIndicator = ' ☁️';
        else if (isSelfHostedOnly) platformIndicator = ' 🖥️';
        if (isCgoOnly) platformIndicator += ' 🔧';

        lines.push(`##### \`${comp.name}\` (${comp.type}, ${comp.status})${platformIndicator}`);

        // Add description (truncated to 2 sentences)
        if (comp.description) {
          const shortDesc = truncateToSentence(comp.description, 2);
          lines.push(`> ${shortDesc}`);
        }
        lines.push('');
      });
    }

    // New fields with details
    const newFields = details.newFields || [];
    if (summary.newFields > 0 && newFields.length > 0) {
      lines.push(`**New Fields (${summary.newFields}):**`);
      lines.push('');
      lines.push('| Component | Field | Description |');
      lines.push('|-----------|-------|-------------|');

      newFields.forEach(field => {
        const desc = field.description ? truncateToSentence(field.description, 1).replace(/\|/g, '\\|') : '_No description_';
        lines.push(`| \`${field.component}\` | \`${field.field}\` | ${desc} |`);
      });
      lines.push('');
    }

    // Removed components
    const removedComponents = details.removedComponents || [];
    if (summary.removedComponents > 0 && removedComponents.length > 0) {
      lines.push(`**⚠️ Removed Connectors (${summary.removedComponents}):**`);
      lines.push('');
      removedComponents.forEach(comp => {
        lines.push(`- \`${comp.name}\` (${comp.type})`);
      });
      lines.push('');
    }

    // Removed fields
    const removedFields = details.removedFields || [];
    if (summary.removedFields > 0 && removedFields.length > 0) {
      lines.push(`**⚠️ Removed Fields (${summary.removedFields}):**`);
      lines.push('');
      lines.push('| Component | Field |');
      lines.push('|-----------|-------|');
      removedFields.forEach(field => {
        lines.push(`| \`${field.component}\` | \`${field.field}\` |`);
      });
      lines.push('');
    }

    // Deprecated fields with migration guidance
    const deprecatedFields = details.deprecatedFields || [];
    if (summary.deprecatedFields > 0 && deprecatedFields.length > 0) {
      lines.push(`**Deprecated Fields (${summary.deprecatedFields}):**`);
      lines.push('');
      deprecatedFields.forEach(field => {
        const guidance = field.description ? ` — ${truncateToSentence(field.description, 1)}` : '';
        lines.push(`- \`${field.component}.${field.field}\`${guidance}`);
      });
      lines.push('');
    }

    // Changed defaults
    const changedDefaults = details.changedDefaults || [];
    if (summary.changedDefaults > 0 && changedDefaults.length > 0) {
      lines.push(`**⚠️ Changed Defaults (${summary.changedDefaults}):**`);
      lines.push('');
      lines.push('| Component | Field | Old Default | New Default |');
      lines.push('|-----------|-------|-------------|-------------|');
      changedDefaults.forEach(change => {
        const oldVal = change.oldDefault !== undefined ? `\`${JSON.stringify(change.oldDefault)}\`` : '_none_';
        const newVal = change.newDefault !== undefined ? `\`${JSON.stringify(change.newDefault)}\`` : '_none_';
        lines.push(`| \`${change.component}\` | \`${change.field}\` | ${oldVal} | ${newVal} |`);
      });
      lines.push('');
    }
  }

  // Writer action items (aggregate)
  lines.push('---');
  lines.push('');
  lines.push('### ✍️ Writer Action Items');
  lines.push('');

  // Collect all new connectors across all releases with full details
  const allNewConnectors = [];
  const allRemovedConnectors = [];
  const allDeprecatedFields = [];
  const allChangedDefaults = [];

  releases.forEach(release => {
    const details = release.details || {};
    const releaseInCloud = release.binaryAnalysis?.comparison?.inCloud || [];
    const releaseCloudOnly = release.binaryAnalysis?.comparison?.cloudOnly || [];
    const releaseNotInCloud = release.binaryAnalysis?.comparison?.notInCloud || [];

    // New connectors
    (details.newComponents || []).forEach(comp => {
      const isCloud = releaseInCloud.some(c => c.type === comp.type && c.name === comp.name) ||
        releaseCloudOnly.some(c => c.type === comp.type && c.name === comp.name);
      const isSelfHostedOnly = releaseNotInCloud.some(c => c.type === comp.type && c.name === comp.name);

      allNewConnectors.push({
        name: comp.name,
        type: comp.type,
        status: comp.status,
        description: comp.description,
        version: release.toVersion,
        isCloud,
        isSelfHostedOnly
      });
    });

    // Removed connectors
    (details.removedComponents || []).forEach(comp => {
      allRemovedConnectors.push({
        name: comp.name,
        type: comp.type,
        version: release.toVersion
      });
    });

    // Deprecated fields
    (details.deprecatedFields || []).forEach(field => {
      allDeprecatedFields.push({
        component: field.component,
        field: field.field,
        description: field.description,
        version: release.toVersion
      });
    });

    // Changed defaults
    (details.changedDefaults || []).forEach(change => {
      allChangedDefaults.push({
        component: change.component,
        field: change.field,
        oldDefault: change.oldDefault,
        newDefault: change.newDefault,
        version: release.toVersion
      });
    });
  });

  // Priority 1: New connectors needing documentation
  if (allNewConnectors.length > 0) {
    lines.push('**📝 Document New Connectors:**');
    lines.push('');

    // Group by cloud vs self-hosted
    const cloudConnectors = allNewConnectors.filter(c => c.isCloud);
    const selfHostedConnectors = allNewConnectors.filter(c => c.isSelfHostedOnly);
    const otherConnectors = allNewConnectors.filter(c => !c.isCloud && !c.isSelfHostedOnly);

    if (cloudConnectors.length > 0) {
      lines.push('_Cloud-supported (higher priority):_');
      cloudConnectors.forEach(conn => {
        lines.push(`- [ ] \`${conn.name}\` ${conn.type} ☁️ — introduced in **${conn.version}**`);
      });
      lines.push('');
    }

    if (selfHostedConnectors.length > 0) {
      lines.push('_Self-hosted only:_');
      selfHostedConnectors.forEach(conn => {
        lines.push(`- [ ] \`${conn.name}\` ${conn.type} 🖥️ — introduced in **${conn.version}**`);
      });
      lines.push('');
    }

    if (otherConnectors.length > 0) {
      lines.push('_Other connectors:_');
      otherConnectors.forEach(conn => {
        lines.push(`- [ ] \`${conn.name}\` ${conn.type} — introduced in **${conn.version}**`);
      });
      lines.push('');
    }
  }

  // Priority 2: Removed connectors needing migration docs
  if (allRemovedConnectors.length > 0) {
    lines.push('**⚠️ Update Migration Guide for Removed Connectors:**');
    lines.push('');
    allRemovedConnectors.forEach(conn => {
      lines.push(`- [ ] \`${conn.name}\` ${conn.type} — removed in **${conn.version}**`);
    });
    lines.push('');
  }

  // Priority 3: Deprecated fields needing docs update
  if (allDeprecatedFields.length > 0) {
    lines.push('**📋 Update Docs for Deprecated Fields:**');
    lines.push('');
    allDeprecatedFields.forEach(field => {
      const guidance = field.description ? ` (${truncateToSentence(field.description, 1)})` : '';
      lines.push(`- [ ] \`${field.component}.${field.field}\`${guidance} — deprecated in **${field.version}**`);
    });
    lines.push('');
  }

  // Priority 4: Changed defaults that may affect users
  if (allChangedDefaults.length > 0) {
    lines.push('**⚠️ Review Changed Defaults for Breaking Changes:**');
    lines.push('');
    allChangedDefaults.forEach(change => {
      const oldVal = change.oldDefault !== undefined ? JSON.stringify(change.oldDefault) : 'none';
      const newVal = change.newDefault !== undefined ? JSON.stringify(change.newDefault) : 'none';
      lines.push(`- [ ] \`${change.component}.${change.field}\`: \`${oldVal}\` → \`${newVal}\` — changed in **${change.version}**`);
    });
    lines.push('');
  }

  // Add commercial name reminder if there are new connectors
  if (allNewConnectors.length > 0) {
    lines.push('---');
    lines.push('');
    lines.push('**💡 Reminder:** For each new connector, add the `:page-commercial-names:` attribute:');
    lines.push('');
    lines.push('```asciidoc');
    lines.push('= Connector Name');
    lines.push(':type: input');
    lines.push(':page-commercial-names: Commercial Name, Alternative Name');
    lines.push('```');
    lines.push('');
  }

  lines.push('<!-- PR_SUMMARY_END -->');
  return lines.join('\n');
}

/**
 * Generate a PR-friendly summary for connector changes
 * @param {object} diffData - Diff data from generateConnectorDiffJson OR master diff with multiple releases
 * @param {object} binaryAnalysis - Cloud support data from getCloudSupport
 * @param {array} draftedConnectors - Array of newly drafted connectors
 * @param {boolean} isMultiVersion - Whether diffData is a master diff with multiple releases
 * @returns {string} Formatted summary
 */
function generatePRSummary(diffData, binaryAnalysis = null, draftedConnectors = null, isMultiVersion = false) {
  const lines = [];

  // Header with delimiters for GitHub Action parsing
  lines.push('<!-- PR_SUMMARY_START -->');
  lines.push('');

  // Detect if this is a master diff
  if (!isMultiVersion && diffData.releases && diffData.totalSummary) {
    isMultiVersion = true;
  }

  if (isMultiVersion) {
    // Multi-version format
    return generateMultiVersionPRSummary(diffData, binaryAnalysis, draftedConnectors);
  }

  // Single version format (original logic)
  // Quick Summary Section
  lines.push('## 📊 Redpanda Connect Documentation Update');
  lines.push('');
  lines.push(`**OSS Version:** ${diffData.comparison.oldVersion} → ${diffData.comparison.newVersion}`);

  if (binaryAnalysis) {
    lines.push(`**Cloud Version:** ${binaryAnalysis.cloudVersion}`);
  }

  lines.push('');

  // High-level stats
  const stats = diffData.summary;
  const hasChanges = Object.values(stats).some(v => v > 0) || (draftedConnectors && draftedConnectors.length > 0);

  if (!hasChanges) {
    lines.push('✅ **No changes detected** - Documentation is up to date');
    lines.push('');
    lines.push('<!-- PR_SUMMARY_END -->');
    return lines.join('\n');
  }

  lines.push('### Summary');
  lines.push('');

  if (stats.newComponents > 0) {
    lines.push(`- **${stats.newComponents}** new connector${stats.newComponents !== 1 ? 's' : ''}`);

    if (binaryAnalysis && binaryAnalysis.comparison) {
      const newConnectorKeys = diffData.details.newComponents.map(c => `${c.type}:${c.name}`);
      const cloudSupported = newConnectorKeys.filter(key => {
        const inCloud = binaryAnalysis.comparison.inCloud.some(c => `${c.type}:${c.name}` === key);
        const cloudOnly = binaryAnalysis.comparison.cloudOnly &&
                         binaryAnalysis.comparison.cloudOnly.some(c => `${c.type}:${c.name}` === key);
        return inCloud || cloudOnly;
      }).length;

      const needsCloudDocs = cloudSupported;

      if (needsCloudDocs > 0) {
        lines.push(`  - ${needsCloudDocs} need${needsCloudDocs !== 1 ? '' : 's'} cloud docs ☁️`);
      }
    }
  }

  if (stats.newFields > 0) {
    const affectedComponents = new Set(diffData.details.newFields.map(f => f.component)).size;
    lines.push(`- **${stats.newFields}** new field${stats.newFields !== 1 ? 's' : ''} across ${affectedComponents} connector${affectedComponents !== 1 ? 's' : ''}`);
  }

  if (stats.removedComponents > 0) {
    lines.push(`- **${stats.removedComponents}** removed connector${stats.removedComponents !== 1 ? 's' : ''} ⚠️`);
  }

  if (stats.removedFields > 0) {
    lines.push(`- **${stats.removedFields}** removed field${stats.removedFields !== 1 ? 's' : ''} ⚠️`);
  }

  if (stats.deprecatedComponents > 0) {
    lines.push(`- **${stats.deprecatedComponents}** deprecated connector${stats.deprecatedComponents !== 1 ? 's' : ''}`);
  }

  if (stats.deprecatedFields > 0) {
    lines.push(`- **${stats.deprecatedFields}** deprecated field${stats.deprecatedFields !== 1 ? 's' : ''}`);
  }

  if (stats.changedDefaults > 0) {
    lines.push(`- **${stats.changedDefaults}** default value change${stats.changedDefaults !== 1 ? 's' : ''} ⚠️`);
  }

  lines.push('');

  // Writer Reminder for Commercial Names
  if (stats.newComponents > 0) {
    lines.push('### ✍️ Writer Action Required');
    lines.push('');
    lines.push('For each new connector, add the `:page-commercial-names:` attribute to the frontmatter:');
    lines.push('');
    lines.push('```asciidoc');
    lines.push('= Connector Name');
    lines.push(':type: input');
    lines.push(':page-commercial-names: Commercial Name, Alternative Name');
    lines.push('```');
    lines.push('');
    lines.push('_This helps improve discoverability and ensures proper categorization._');
    lines.push('');

    // Check if any new connectors are cloud-supported
    if (binaryAnalysis && binaryAnalysis.comparison) {
      const newConnectorKeys = diffData.details.newComponents.map(c => ({
        key: `${c.type}:${c.name}`,
        type: c.type,
        name: c.name
      }));

      const cloudSupported = newConnectorKeys.filter(item => {
        // Check both inCloud (OSS+Cloud) and cloudOnly (Cloud-only)
        const inCloud = binaryAnalysis.comparison.inCloud.some(c => `${c.type}:${c.name}` === item.key);
        const cloudOnly = binaryAnalysis.comparison.cloudOnly &&
          binaryAnalysis.comparison.cloudOnly.some(c => `${c.type}:${c.name}` === item.key);
        return inCloud || cloudOnly;
      });

      if (cloudSupported.length > 0) {
        lines.push('### ☁️ Cloud Docs Update Required');
        lines.push('');
        lines.push(`**${cloudSupported.length}** new connector${cloudSupported.length !== 1 ? 's are' : ' is'} available in Redpanda Cloud.`);
        lines.push('');
        lines.push('**Action:** Submit a separate PR to https://github.com/redpanda-data/cloud-docs to add the connector pages using include syntax:');
        lines.push('');

        // Check if any are cloud-only (need partial syntax)
        const cloudOnly = cloudSupported.filter(item =>
          binaryAnalysis.comparison.cloudOnly &&
          binaryAnalysis.comparison.cloudOnly.some(c => `${c.type}:${c.name}` === item.key)
        );
        const regularCloud = cloudSupported.filter(item =>
          !binaryAnalysis.comparison.cloudOnly ||
          !binaryAnalysis.comparison.cloudOnly.some(c => `${c.type}:${c.name}` === item.key)
        );

        if (regularCloud.length > 0) {
          lines.push('**For connectors in pages:**');
          lines.push('```asciidoc');
          lines.push('= Connector Name');
          lines.push('');
          lines.push('include::redpanda-connect:components:page$type/connector-name.adoc[tag=single-source]');
          lines.push('```');
          lines.push('');
        }

        if (cloudOnly.length > 0) {
          lines.push('**For cloud-only connectors (in partials):**');
          lines.push('```asciidoc');
          lines.push('= Connector Name');
          lines.push('');
          lines.push('include::redpanda-connect:components:partial$components/cloud-only/type/connector-name.adoc[tag=single-source]');
          lines.push('```');
          lines.push('');
        }

        // Add instruction to update cloud whats-new
        lines.push('**Also update the cloud whats-new file:**');
        lines.push('');
        lines.push('Add entries for the new cloud-supported connectors to the Redpanda Cloud whats-new file in the cloud-docs repository.');
        lines.push('');
      }
    }
  }

  // Breaking Changes Section
  const breakingChanges = [];
  if (stats.removedComponents > 0) breakingChanges.push('removed connectors');
  if (stats.removedFields > 0) breakingChanges.push('removed fields');
  if (stats.changedDefaults > 0) breakingChanges.push('changed defaults');

  if (breakingChanges.length > 0) {
    lines.push('### ⚠️ Breaking Changes Detected');
    lines.push('');
    lines.push(`This update includes **${breakingChanges.join(', ')}** that may affect existing configurations.`);
    lines.push('');
  }

  // Newly Drafted Connectors Section
  if (draftedConnectors && draftedConnectors.length > 0) {
    lines.push('### 📝 Newly Drafted - Needs Review');
    lines.push('');
    lines.push(`**${draftedConnectors.length}** connector${draftedConnectors.length !== 1 ? 's have' : ' has'} been auto-generated and placed in the proper location. These drafts need writer review:`);
    lines.push('');

    // Group by type
    const draftsByType = {};
    draftedConnectors.forEach(draft => {
      const type = draft.type || 'unknown';
      if (!draftsByType[type]) {
        draftsByType[type] = [];
      }
      draftsByType[type].push(draft);
    });

    // List drafts by type
    Object.entries(draftsByType).forEach(([type, drafts]) => {
      lines.push(`**${type}:**`);
      drafts.forEach(draft => {
        // Check both inCloud (OSS+Cloud) and cloudOnly (Cloud-only)
        const isInCloud = binaryAnalysis?.comparison.inCloud.some(c =>
          c.type === type && c.name === draft.name
        );
        const isCloudOnly = binaryAnalysis?.comparison.cloudOnly &&
          binaryAnalysis.comparison.cloudOnly.some(c =>
            c.type === type && c.name === draft.name
          );
        const cloudIndicator = (isInCloud || isCloudOnly) ? ' ☁️' : '';
        const cgoIndicator = draft.requiresCgo ? ' 🔧' : '';
        const statusBadge = draft.status && draft.status !== 'stable' ? ` (${draft.status})` : '';
        lines.push(`- \`${draft.name}\`${statusBadge}${cloudIndicator}${cgoIndicator} → \`${draft.path}\``);
      });
      lines.push('');
    });
  }

  // Missing Descriptions Warning
  const missingDescriptions = [];

  // Check for new components with missing descriptions
  if (stats.newComponents > 0) {
    diffData.details.newComponents.forEach(connector => {
      if (!connector.description || connector.description.trim() === '') {
        missingDescriptions.push({
          type: 'component',
          name: connector.name,
          componentType: connector.type
        });
      }
    });
  }

  // Check for new fields with missing descriptions
  if (stats.newFields > 0) {
    diffData.details.newFields.forEach(field => {
      if (!field.description || field.description.trim() === '') {
        missingDescriptions.push({
          type: 'field',
          name: field.field,
          component: field.component
        });
      }
    });
  }

  if (missingDescriptions.length > 0) {
    lines.push('### ⚠️ Missing Descriptions');
    lines.push('');
    lines.push(`**${missingDescriptions.length}** item${missingDescriptions.length !== 1 ? 's' : ''} missing descriptions - these need writer attention:`);
    lines.push('');

    const componentsMissing = missingDescriptions.filter(m => m.type === 'component');
    const fieldsMissing = missingDescriptions.filter(m => m.type === 'field');

    if (componentsMissing.length > 0) {
      lines.push('**Components:**');
      componentsMissing.forEach(m => {
        lines.push(`- \`${m.name}\` (${m.componentType})`);
      });
      lines.push('');
    }

    if (fieldsMissing.length > 0) {
      lines.push('**Fields:**');
      // Group by component
      const fieldsByComponent = {};
      fieldsMissing.forEach(m => {
        if (!fieldsByComponent[m.component]) {
          fieldsByComponent[m.component] = [];
        }
        fieldsByComponent[m.component].push(m.name);
      });

      Object.entries(fieldsByComponent).forEach(([component, fields]) => {
        const [type, name] = component.split(':');
        lines.push(`- **${type}/${name}:** ${fields.map(f => `\`${f}\``).join(', ')}`);
      });
      lines.push('');
    }
  }

  // Action Items
  lines.push('### 📝 Action Items for Writers');
  lines.push('');

  const actionItems = [];

  // Add action items for missing descriptions
  if (missingDescriptions.length > 0) {
    actionItems.push({
      priority: 0,
      text: `⚠️ Add descriptions for ${missingDescriptions.length} component${missingDescriptions.length !== 1 ? 's' : ''}/field${missingDescriptions.length !== 1 ? 's' : ''} (see Missing Descriptions section)`
    });
  }

  // New connectors that need cloud docs
  if (binaryAnalysis && stats.newComponents > 0) {
    diffData.details.newComponents.forEach(connector => {
      const key = `${connector.type}:${connector.name}`;
      const inCloud = binaryAnalysis.comparison.inCloud.some(c => `${c.type}:${c.name}` === key);

      if (inCloud) {
        actionItems.push({
          priority: 1,
          text: `Document new \`${connector.name}\` ${connector.type} (☁️ **CLOUD SUPPORTED**)`
        });
      }
    });
  }

  // New connectors without cloud support (self-hosted only)
  if (binaryAnalysis && stats.newComponents > 0) {
    diffData.details.newComponents.forEach(connector => {
      const key = `${connector.type}:${connector.name}`;

      // Check if it's explicitly in the self-hosted only list
      const isSelfHostedOnly = binaryAnalysis.comparison.notInCloud &&
        binaryAnalysis.comparison.notInCloud.some(c => `${c.type}:${c.name}` === key);

      if (isSelfHostedOnly) {
        actionItems.push({
          priority: 2,
          text: `Document new \`${connector.name}\` ${connector.type} (self-hosted only)`
        });
      }
    });
  }

  // Deprecated connectors
  if (stats.deprecatedComponents > 0) {
    diffData.details.deprecatedComponents.forEach(connector => {
      actionItems.push({
        priority: 3,
        text: `Update docs for deprecated \`${connector.name}\` ${connector.type}`
      });
    });
  }

  // Removed connectors
  if (stats.removedComponents > 0) {
    diffData.details.removedComponents.forEach(connector => {
      actionItems.push({
        priority: 3,
        text: `Update migration guide for removed \`${connector.name}\` ${connector.type}`
      });
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

  // New Connectors
  if (stats.newComponents > 0) {
    lines.push('#### New Connectors');
    lines.push('');

    if (binaryAnalysis) {
      const cloudSupportedNew = [];
      const selfHostedOnlyNew = [];

      diffData.details.newComponents.forEach(connector => {
        const key = `${connector.type}:${connector.name}`;

        // Check explicit categories
        const inCloud = binaryAnalysis.comparison.inCloud.some(c => `${c.type}:${c.name}` === key);
        const isSelfHostedOnly = binaryAnalysis.comparison.notInCloud &&
          binaryAnalysis.comparison.notInCloud.some(c => `${c.type}:${c.name}` === key);
        const isCloudOnly = binaryAnalysis.comparison.cloudOnly &&
          binaryAnalysis.comparison.cloudOnly.some(c => `${c.type}:${c.name}` === key);

        const entry = {
          name: connector.name,
          type: connector.type,
          status: connector.status,
          description: connector.description
        };

        // Use explicit positive checks instead of !inCloud
        if (inCloud || isCloudOnly) {
          cloudSupportedNew.push(entry);
        } else if (isSelfHostedOnly) {
          selfHostedOnlyNew.push(entry);
        }
      });

      if (cloudSupportedNew.length > 0) {
        lines.push('**☁️ Cloud Supported:**');
        lines.push('');
        cloudSupportedNew.forEach(c => {
          lines.push(`- **${c.name}** (${c.type}, ${c.status})`);
          const desc = c.summary || c.description;
          if (desc) {
            const shortDesc = truncateToSentence(desc, 2);
            lines.push(`  - ${shortDesc}`);
          }
        });
        lines.push('');
      }

      if (selfHostedOnlyNew.length > 0) {
        lines.push('**Self-Hosted Only:**');
        lines.push('');
        selfHostedOnlyNew.forEach(c => {
          lines.push(`- **${c.name}** (${c.type}, ${c.status})`);
          const desc = c.summary || c.description;
          if (desc) {
            const shortDesc = truncateToSentence(desc, 2);
            lines.push(`  - ${shortDesc}`);
          }
        });
        lines.push('');
      }
    } else {
      // No cloud support info, just list all
      diffData.details.newComponents.forEach(c => {
        lines.push(`- **${c.name}** (${c.type}, ${c.status})`);
        const desc = c.summary || c.description;
        if (desc) {
          const shortDesc = truncateToSentence(desc, 2);
          lines.push(`  - ${shortDesc}`);
        }
      });
      lines.push('');
    }
  }

  // cgo-only connectors (if any new connectors require cgo)
  if (binaryAnalysis && binaryAnalysis.cgoOnly && binaryAnalysis.cgoOnly.length > 0 && stats.newComponents > 0) {
    // Find new connectors that are cgo-only
    const newCgoConnectors = diffData.details.newComponents.filter(connector => {
      const key = `${connector.type}:${connector.name}`;
      return binaryAnalysis.cgoOnly.some(cgo => `${cgo.type}:${cgo.name}` === key);
    });

    if (newCgoConnectors.length > 0) {
      lines.push('#### 🔧 Cgo Requirements');
      lines.push('');
      lines.push('The following new connectors require cgo-enabled builds:');
      lines.push('');

      newCgoConnectors.forEach(connector => {
        // Convert type to singular form for better grammar (e.g., "inputs" -> "input")
        const typeSingular = connector.type.endsWith('s') ? connector.type.slice(0, -1) : connector.type;

        lines.push(`**${connector.name}** (${connector.type}):`);
        lines.push('');
        lines.push('[NOTE]');
        lines.push('====');
        lines.push(`The \`${connector.name}\` ${typeSingular} requires a cgo-enabled build of Redpanda Connect.`);
        lines.push('');
        lines.push('For instructions, see:');
        lines.push('');
        lines.push('* xref:install:prebuilt-binary.adoc[Download a cgo-enabled binary]');
        lines.push('* xref:install:build-from-source.adoc[Build Redpanda Connect from source]');
        lines.push('====');
        lines.push('');
      });
    }
  }

  // New Fields
  if (stats.newFields > 0) {
    lines.push('#### New Fields');
    lines.push('');

    // Group by component
    const fieldsByComponent = {};
    diffData.details.newFields.forEach(field => {
      if (!fieldsByComponent[field.component]) {
        fieldsByComponent[field.component] = [];
      }
      fieldsByComponent[field.component].push(field);
    });

    Object.entries(fieldsByComponent).forEach(([component, fields]) => {
      const [type, name] = component.split(':');
      lines.push(`**${type}/${name}:**`);
      fields.forEach(f => {
        lines.push(`- \`${f.field}\`${f.introducedIn ? ` (since ${f.introducedIn})` : ''}`);
      });
      lines.push('');
    });
  }

  // Removed Connectors
  if (stats.removedComponents > 0) {
    lines.push('#### ⚠️ Removed Connectors');
    lines.push('');
    diffData.details.removedComponents.forEach(c => {
      lines.push(`- **${c.name}** (${c.type})`);
    });
    lines.push('');
  }

  // Removed Fields
  if (stats.removedFields > 0) {
    lines.push('#### ⚠️ Removed Fields');
    lines.push('');

    const fieldsByComponent = {};
    diffData.details.removedFields.forEach(field => {
      if (!fieldsByComponent[field.component]) {
        fieldsByComponent[field.component] = [];
      }
      fieldsByComponent[field.component].push(field);
    });

    Object.entries(fieldsByComponent).forEach(([component, fields]) => {
      const [type, name] = component.split(':');
      lines.push(`**${type}/${name}:**`);
      fields.forEach(f => {
        lines.push(`- \`${f.field}\``);
      });
      lines.push('');
    });
  }

  // Deprecated Connectors
  if (stats.deprecatedComponents > 0) {
    lines.push('#### Deprecated Connectors');
    lines.push('');
    diffData.details.deprecatedComponents.forEach(c => {
      lines.push(`- **${c.name}** (${c.type})`);
    });
    lines.push('');
  }

  // Deprecated Fields
  if (stats.deprecatedFields > 0) {
    lines.push('#### Deprecated Fields');
    lines.push('');

    const fieldsByComponent = {};
    diffData.details.deprecatedFields.forEach(field => {
      if (!fieldsByComponent[field.component]) {
        fieldsByComponent[field.component] = [];
      }
      fieldsByComponent[field.component].push(field);
    });

    Object.entries(fieldsByComponent).forEach(([component, fields]) => {
      const [type, name] = component.split(':');
      lines.push(`**${type}/${name}:**`);
      fields.forEach(f => {
        lines.push(`- \`${f.field}\``);
      });
      lines.push('');
    });
  }

  // Changed Defaults
  if (stats.changedDefaults > 0) {
    lines.push('#### ⚠️ Changed Default Values');
    lines.push('');

    const changesByComponent = {};
    diffData.details.changedDefaults.forEach(change => {
      if (!changesByComponent[change.component]) {
        changesByComponent[change.component] = [];
      }
      changesByComponent[change.component].push(change);
    });

    Object.entries(changesByComponent).forEach(([component, changes]) => {
      const [type, name] = component.split(':');
      lines.push(`**${type}/${name}:**`);
      changes.forEach(c => {
        const oldStr = JSON.stringify(c.oldDefault);
        const newStr = JSON.stringify(c.newDefault);
        lines.push(`- \`${c.field}\`: ${oldStr} → ${newStr}`);
      });
      lines.push('');
    });
  }

  // Cloud Support Gap Analysis
  if (binaryAnalysis && binaryAnalysis.comparison.notInCloud.length > 0) {
    lines.push('#### 🔍 Cloud Support Gap Analysis');
    lines.push('');
    lines.push(`**${binaryAnalysis.comparison.notInCloud.length} connector${binaryAnalysis.comparison.notInCloud.length !== 1 ? 's' : ''} available in OSS but not in cloud:**`);
    lines.push('');

    // Group by type
    const gapsByType = {};
    binaryAnalysis.comparison.notInCloud.forEach(connector => {
      if (!gapsByType[connector.type]) {
        gapsByType[connector.type] = [];
      }
      gapsByType[connector.type].push(connector);
    });

    Object.entries(gapsByType).forEach(([type, connectors]) => {
      lines.push(`**${type}:**`);
      connectors.forEach(c => {
        lines.push(`- ${c.name} (${c.status})`);
      });
      lines.push('');
    });
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
 * Truncate description to specified number of sentences
 * @param {string} text - Text to truncate
 * @param {number} sentences - Number of sentences to keep
 * @returns {string} Truncated text
 */
function truncateToSentence(text, sentences = 2) {
  if (!text) return '';

  // Remove markdown formatting
  let clean = text
    .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1') // Remove links
    .replace(/[*_`]/g, '') // Remove emphasis
    .replace(/\n/g, ' '); // Replace newlines with spaces

  // Split by sentence boundaries
  const sentenceRegex = /[^.!?]+[.!?]+/g;
  const matches = clean.match(sentenceRegex);

  if (!matches || matches.length === 0) {
    return clean.substring(0, 150);
  }

  const truncated = matches.slice(0, sentences).join(' ').trim();

  return truncated.length > 200 ? truncated.substring(0, 200) + '...' : truncated;
}

/**
 * Print the PR summary to console
 * @param {object} diffData - Diff data
 * @param {object} binaryAnalysis - Cloud support data
 * @param {array} draftedConnectors - Array of newly drafted connectors
 */
function printPRSummary(diffData, binaryAnalysis = null, draftedConnectors = null) {
  const summary = generatePRSummary(diffData, binaryAnalysis, draftedConnectors);
  console.log('\n' + summary + '\n');
}

module.exports = {
  generatePRSummary,
  generateMultiVersionPRSummary,
  printPRSummary,
  truncateToSentence
};

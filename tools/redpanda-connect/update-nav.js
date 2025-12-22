/**
 * Updates modules/ROOT/nav.adoc with new connector entries
 */

const fs = require('fs');
const path = require('path');

/**
 * Parse nav.adoc and extract connector sections
 * @param {string} content - nav.adoc content
 * @returns {Object} Sections with their connectors
 */
function parseNav(content) {
  const lines = content.split('\n');
  const sections = {};
  let currentSection = null;
  let sectionStartLine = -1;
  let sectionEndLine = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect component type sections
    if (line.match(/^\*\* xref:components:(inputs|outputs|processors|scanners|caches|rate_limits|buffers|metrics|tracers)\/about\.adoc\[\]/)) {
      // Save previous section end
      if (currentSection && sectionStartLine !== -1) {
        sections[currentSection].endLine = i - 1;
      }

      // Extract type
      const match = line.match(/components:(\w+)\//);
      currentSection = match ? match[1] : null;

      if (currentSection) {
        sections[currentSection] = {
          startLine: i,
          endLine: -1,
          connectors: []
        };
        sectionStartLine = i;
      }
    }

    // Collect connector entries
    if (currentSection && line.match(/^\*\*\* xref:components:\w+\/[\w_]+\.adoc\[\]/)) {
      const match = line.match(/xref:components:\w+\/([\w_]+)\.adoc/);
      if (match) {
        sections[currentSection].connectors.push({
          name: match[1],
          line: i,
          text: line
        });
      }
    }

    // Detect section end (next major section starts)
    if (currentSection && line.match(/^\*\* xref:/) && !line.includes(`components:${currentSection}`)) {
      sections[currentSection].endLine = i - 1;
      currentSection = null;
    }
  }

  // Close last section if needed
  if (currentSection && sections[currentSection].endLine === -1) {
    sections[currentSection].endLine = lines.length - 1;
  }

  return { lines, sections };
}

/**
 * Insert connectors into nav.adoc in alphabetical order
 * @param {string} navPath - Path to nav.adoc
 * @param {Array} newConnectors - Array of {type, name} objects
 * @returns {Object} Update result
 */
function updateNav(navPath, newConnectors) {
  if (!fs.existsSync(navPath)) {
    throw new Error(`nav.adoc not found at ${navPath}`);
  }

  const content = fs.readFileSync(navPath, 'utf8');
  const { lines, sections } = parseNav(content);

  const updates = [];
  const skipped = [];

  // Group new connectors by type
  const byType = {};
  newConnectors.forEach(conn => {
    if (!byType[conn.type]) byType[conn.type] = [];
    byType[conn.type].push(conn);
  });

  // Process each type
  Object.entries(byType).forEach(([type, connectors]) => {
    if (!sections[type]) {
      console.warn(`Warning: Section not found for type: ${type}`);
      connectors.forEach(c => skipped.push({ ...c, reason: 'section not found' }));
      return;
    }

    const section = sections[type];
    const existingNames = new Set(section.connectors.map(c => c.name));

    connectors.forEach(conn => {
      // Skip if already exists
      if (existingNames.has(conn.name)) {
        skipped.push({ ...conn, reason: 'already exists' });
        return;
      }

      // Find insertion point (alphabetical order)
      const newEntry = `*** xref:components:${type}/${conn.name}.adoc[]`;
      let insertIndex = -1;

      for (let i = 0; i < section.connectors.length; i++) {
        if (conn.name.localeCompare(section.connectors[i].name) < 0) {
          insertIndex = section.connectors[i].line;
          break;
        }
      }

      // If no insertion point found, append at end of section
      if (insertIndex === -1) {
        // Find last connector line in section
        if (section.connectors.length > 0) {
          insertIndex = section.connectors[section.connectors.length - 1].line + 1;
        } else {
          // Empty section, insert after section header
          insertIndex = section.startLine + 1;
        }
      }

      updates.push({
        type,
        name: conn.name,
        insertIndex,
        entry: newEntry
      });
    });
  });

  // Apply updates (in reverse order to maintain line numbers)
  updates.sort((a, b) => b.insertIndex - a.insertIndex);

  updates.forEach(update => {
    lines.splice(update.insertIndex, 0, update.entry);
  });

  // Write updated nav.adoc
  fs.writeFileSync(navPath, lines.join('\n'));

  return {
    updated: updates.length,
    skippedCount: skipped.length,
    updates,
    skipped
  };
}

/**
 * Update nav.adoc from draft files
 * @param {Array} draftFiles - Array of draft file objects
 * @param {string} navPath - Path to nav.adoc (optional, auto-detects)
 * @returns {Object} Update result
 */
function updateNavFromDrafts(draftFiles, navPath = null) {
  // Auto-detect nav.adoc location if not provided
  if (!navPath) {
    const possiblePaths = [
      path.resolve(process.cwd(), 'modules/ROOT/nav.adoc'),
      path.resolve(process.cwd(), '../rp-connect-docs/modules/ROOT/nav.adoc'),
      // Optional: Set RP_CONNECT_DOCS_PATH env var to specify custom location
      process.env.RP_CONNECT_DOCS_PATH && path.resolve(process.env.RP_CONNECT_DOCS_PATH, 'modules/ROOT/nav.adoc')
    ].filter(Boolean);

    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        navPath = p;
        break;
      }
    }

    if (!navPath) {
      console.warn('Warning: Could not find nav.adoc, skipping navigation update');
      return { updated: 0, skippedCount: draftFiles.length, error: 'nav.adoc not found' };
    }
  }

  console.log(`📝 Updating navigation: ${navPath}`);

  const connectors = draftFiles.map(draft => ({
    type: draft.type,
    name: draft.name
  }));

  return updateNav(navPath, connectors);
}

module.exports = {
  parseNav,
  updateNav,
  updateNavFromDrafts
};

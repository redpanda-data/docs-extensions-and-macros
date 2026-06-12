/**
 * Scan rpk Go source code for hidden and deprecated commands
 *
 * Extracts commands marked with Hidden: true or Deprecated: "message"
 * to ensure they're included in documentation with proper deprecation notices.
 */

const fs = require('fs');
const path = require('path');

/**
 * Scan a Go file for cobra command definitions with deprecation/hidden status
 * @param {string} filePath - Path to Go file
 * @returns {Object|null} Command metadata if deprecated/hidden, null otherwise
 */
function scanGoFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');

  // Look for NewCommand function that returns *cobra.Command
  const newCommandMatch = content.match(/func NewCommand\([^)]*\)\s*\*cobra\.Command\s*\{/);
  if (!newCommandMatch) {
    return null;
  }

  // Extract the cobra.Command struct definition
  // Handle nested braces and multiline strings
  let cmdBlock = '';
  let braceCount = 0;
  let startIndex = content.indexOf('&cobra.Command{');

  if (startIndex === -1) {
    return null;
  }

  startIndex += '&cobra.Command{'.length;
  for (let i = startIndex; i < content.length; i++) {
    const char = content[i];
    if (char === '{') braceCount++;
    if (char === '}') {
      if (braceCount === 0) break;
      braceCount--;
    }
    cmdBlock += char;
  }

  // Extract fields - handle multiline strings with backticks or quotes
  const useMatch = cmdBlock.match(/Use:\s*"([^"]+)"/);
  const shortMatch = cmdBlock.match(/Short:\s*"([^"]+)"/);
  const longMatch = cmdBlock.match(/Long:\s*`([^`]+)`|Long:\s*"([^"]+)"/s);
  const hiddenMatch = cmdBlock.match(/Hidden:\s*true/);
  const deprecatedMatch = cmdBlock.match(/Deprecated:\s*"([^"]+(?:[^"\\]|\\.)*)"/s);

  // Only return if hidden or deprecated
  if (!hiddenMatch && !deprecatedMatch) {
    return null;
  }

  const result = {
    use: useMatch ? useMatch[1] : null,
    short: shortMatch ? shortMatch[1] : null,
    long: longMatch ? (longMatch[1] || longMatch[2]) : null,
    hidden: !!hiddenMatch,
    deprecated: !!deprecatedMatch,
    deprecatedMessage: deprecatedMatch ? deprecatedMatch[1].replace(/\n\s*/g, ' ').trim() : null
  };

  return result;
}

/**
 * Build command path from directory structure
 * @param {string} filePath - Path to Go file (relative to rpk root)
 * @param {string} rpkRoot - Path to rpk source root
 * @returns {string} Command path (e.g., "rpk redpanda admin")
 */
function buildCommandPath(filePath, rpkRoot) {
  const relativePath = path.relative(rpkRoot, filePath);
  const parts = relativePath.split(path.sep);

  // Remove filename, and filter out structural directories
  // Structure is either:
  //   pkg/cli/<group>/<command>/file.go
  //   cmd/rpk/<command>/file.go
  const commandParts = [];
  let inCommandPath = false;

  for (const part of parts) {
    if (part.endsWith('.go')) continue;

    // Start collecting after 'cli' or after 'rpk' in cmd
    if (part === 'cli' || (part === 'rpk' && parts.includes('cmd'))) {
      inCommandPath = true;
      continue;
    }

    if (inCommandPath) {
      commandParts.push(part);
    }
  }

  // Build path: rpk + directory hierarchy
  return 'rpk ' + commandParts.join(' ');
}

/**
 * Recursively scan directory for deprecated commands
 * @param {string} dir - Directory to scan
 * @param {string} rpkRoot - Path to rpk source root
 * @param {Array} results - Accumulator for results
 */
function scanDirectory(dir, rpkRoot, results = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      scanDirectory(fullPath, rpkRoot, results);
    } else if (entry.isFile() && entry.name.endsWith('.go')) {
      const metadata = scanGoFile(fullPath);
      if (metadata) {
        const commandPath = buildCommandPath(fullPath, rpkRoot);
        results.push({
          commandPath,
          filePath: path.relative(rpkRoot, fullPath),
          ...metadata
        });
      }
    }
  }

  return results;
}

/**
 * Extract deprecation info and convert to override format
 * @param {Object} cmdMetadata - Command metadata from source scan
 * @returns {Object} Override object for rpk-overrides.json
 */
function buildOverrideFromDeprecation(cmdMetadata) {
  const override = {
    deprecated: true,
    _note: `Hidden: ${cmdMetadata.hidden}, found by scanning Go source`
  };

  if (cmdMetadata.deprecatedMessage) {
    // Parse the deprecation message to extract replacement info
    const message = cmdMetadata.deprecatedMessage;

    // Common patterns:
    // "use `rpk cluster` subcommands; see ..."
    // "use `rpk cluster brokers` instead"

    if (message.includes('use `') && message.includes('`')) {
      // Extract the replacement command
      const cmdMatch = message.match(/use `([^`]+)`/);
      if (cmdMatch) {
        const replacementCmd = cmdMatch[1];

        // Try to build xref
        if (replacementCmd.startsWith('rpk ')) {
          const parts = replacementCmd.split(' ');
          const xrefPath = parts.slice(1).join('/');
          const filename = parts.slice(1).join('-');
          override.replacement = `Use xref:reference:rpk/rpk-${xrefPath}/rpk-${filename}.adoc[\`${replacementCmd}\`] instead.`;
        } else {
          override.replacement = `Use \`${replacementCmd}\` instead.`;
        }
      }

      // Add full deprecation message if it has additional context
      if (message.length > 50 || message.includes(';')) {
        override.deprecatedMessage = message;
      }
    } else {
      override.deprecatedMessage = message;
    }
  }

  return override;
}

/**
 * Scan rpk source for deprecated/hidden commands
 * @param {string} sourcePath - Path to rpk source (src/go/rpk)
 * @returns {Object} Map of command paths to override metadata
 */
function scanDeprecatedCommands(sourcePath) {
  console.log('Scanning Go source for deprecated/hidden commands...');

  // Scan both cmd/rpk (old structure) and pkg/cli (current structure)
  const dirsToScan = [
    path.join(sourcePath, 'cmd', 'rpk'),
    path.join(sourcePath, 'pkg', 'cli')
  ];

  const results = [];

  for (const dir of dirsToScan) {
    if (fs.existsSync(dir)) {
      console.log(`Scanning ${dir}...`);
      scanDirectory(dir, sourcePath, results);
    }
  }

  console.log(`Found ${results.length} deprecated/hidden command(s):`);

  const overrides = {};
  for (const cmd of results) {
    console.log(`  - ${cmd.commandPath}`);
    if (cmd.deprecatedMessage) {
      console.log(`    Deprecated: ${cmd.deprecatedMessage.substring(0, 80)}${cmd.deprecatedMessage.length > 80 ? '...' : ''}`);
    }
    if (cmd.hidden) {
      console.log(`    Hidden: true`);
    }

    overrides[cmd.commandPath] = buildOverrideFromDeprecation(cmd);
  }

  return overrides;
}

/**
 * Merge deprecated commands into existing tree
 * @param {Object} tree - Command tree from rpk --print-tree
 * @param {Object} deprecatedOverrides - Overrides from source scanning
 * @param {Object} existingOverrides - Existing overrides.json data
 * @returns {Object} Tree with deprecated commands added
 */
function mergeDeprecatedCommands(tree, deprecatedOverrides, existingOverrides) {
  // For now, just return the overrides to be merged into overrides.json
  // The actual command data will come from the old docs or manual creation

  console.log('\nMerging deprecated commands into overrides...');

  if (!existingOverrides.commands) {
    existingOverrides.commands = {};
  }

  let added = 0;
  let updated = 0;

  for (const [cmdPath, metadata] of Object.entries(deprecatedOverrides)) {
    if (!existingOverrides.commands[cmdPath]) {
      existingOverrides.commands[cmdPath] = metadata;
      added++;
    } else {
      // Merge, keeping existing content but adding deprecation metadata
      existingOverrides.commands[cmdPath] = {
        ...existingOverrides.commands[cmdPath],
        deprecated: metadata.deprecated,
        replacement: metadata.replacement || existingOverrides.commands[cmdPath].replacement,
        deprecatedMessage: metadata.deprecatedMessage || existingOverrides.commands[cmdPath].deprecatedMessage,
        _note: metadata._note
      };
      updated++;
    }
  }

  console.log(`Added ${added} new deprecated commands`);
  console.log(`Updated ${updated} existing commands with deprecation info`);

  return existingOverrides;
}

module.exports = {
  scanDeprecatedCommands,
  mergeDeprecatedCommands,
  scanGoFile,
  buildCommandPath
};

// CLI usage
if (require.main === module) {
  const sourcePath = process.argv[2];
  const overridesPath = process.argv[3];

  if (!sourcePath) {
    console.error('Usage: node scan-deprecated-commands.js <rpk-source-path> [overrides-json-path]');
    process.exit(1);
  }

  const deprecated = scanDeprecatedCommands(sourcePath);

  if (overridesPath) {
    const existingOverrides = JSON.parse(fs.readFileSync(overridesPath, 'utf8'));
    const updated = mergeDeprecatedCommands(null, deprecated, existingOverrides);
    fs.writeFileSync(overridesPath, JSON.stringify(updated, null, 2));
    console.log(`\nUpdated overrides file: ${overridesPath}`);
  } else {
    console.log('\nDeprecated commands (JSON):');
    console.log(JSON.stringify(deprecated, null, 2));
  }
}

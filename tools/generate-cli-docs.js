#!/usr/bin/env node

/**
 * Generate CLI Reference Documentation
 *
 * This script automatically generates AsciiDoc documentation for the doc-tools CLI
 * by executing commands with --help and parsing the output, then enhancing it with
 * JSDoc comments from the source code.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * Execute a CLI command and capture help output
 */
function getHelpOutput(command) {
  try {
    return execSync(`npx doc-tools ${command} --help`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
  } catch (error) {
    // Commander exits with code 0 for help, but some shells treat it as error
    return error.stdout || '';
  }
}

/**
 * Sanitize path values in option descriptions to remove user-specific absolute paths
 */
function sanitizePathInDescription(description) {
  // Get the repository root path for relativization
  const repoRoot = path.resolve(__dirname, '..');
  
  let sanitized = description;
  
  // First, handle repository root paths specifically
  const repoRootEscaped = repoRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const repoRootPattern = new RegExp(repoRootEscaped, 'g');
  
  sanitized = sanitized.replace(repoRootPattern, '<repository-root>');
  
  // Then handle any remaining long absolute paths that contain our repo structure
  // This regex matches paths that look like they're part of our repository
  const longPathPattern = /\/[^\/\s"')]*docs-extensions-and-macros[^\/\s"')]*(?:\/[^\/\s"')\]]+)*/g;
  
  sanitized = sanitized.replace(longPathPattern, (match) => {
    // If this path wasn't already replaced and looks like a subpath, make it relative
    if (!match.includes('<repository-root>')) {
      const relativePath = path.relative(repoRoot, match);
      if (relativePath && !relativePath.startsWith('..') && relativePath !== match) {
        return `./${relativePath}`;
      }
      return '<repository-root>';
    }
    return match;
  });
  
  // Finally, handle generic home directory patterns for any remaining absolute paths
  const homePattern = /\/(?:Users|home)\/[^\/\s"')]+/g;
  sanitized = sanitized.replace(homePattern, '~');
  
  return sanitized;
}

/**
 * Parse command help output into structured data
 */
function parseHelp(helpText) {
  const lines = helpText.split('\n');
  const result = {
    usage: '',
    description: '',
    options: [],
    commands: []
  };

  let currentSection = null;
  let currentItem = null;

  for (const line of lines) {
    // Usage line
    if (line.startsWith('Usage:')) {
      result.usage = line.replace('Usage:', '').trim();
      currentSection = null;
    }
    // Options section
    else if (line === 'Options:') {
      currentSection = 'options';
    }
    // Commands section
    else if (line === 'Commands:') {
      currentSection = 'commands';
    }
    // Option or command line (starts with spaces and has content)
    else if (line.match(/^  \S/) && currentSection) {
      // Match option/command name (everything up to 2+ spaces) and description
      const match = line.match(/^  (.+?)\s{2,}(.*)/);
      if (match) {
        currentItem = {
          name: match[1].trim(),
          description: match[2].trim()
        };
        result[currentSection].push(currentItem);
      }
    }
    // Continuation of description (more indentation than option lines)
    else if (line.match(/^\s{10,}/) && currentItem) {
      currentItem.description += ' ' + line.trim();
    }
    // Description (first non-empty line that's not a section)
    else if (line.trim() && !currentSection && !result.description && !line.startsWith('Usage:')) {
      result.description = line.trim();
    }
  }

  return result;
}

/**
 * Parse JSDoc comments from source file
 */
function parseJSDocComments(sourceFile) {
  const content = fs.readFileSync(sourceFile, 'utf8');
  const comments = {};

  // Regex to match JSDoc comments followed by command definitions.
  // Matches both top-level commands and automation.command().
  //
  // The comment body is `(?:(?!\*\/)[\s\S])*?`, a tempered match that cannot
  // cross a closing `*\/`, rather than a plain `[\s\S]*?`. With the plain
  // version two ADJACENT JSDoc blocks merged into one match: the lazy body ran
  // past the first block's terminator, because that terminator is followed by
  // `/**` rather than by `.command(`, and kept going to the second. The
  // extractor then took the FIRST @description it found, so the second command
  // was documented with the first command's prose. That is exactly what
  // happened to `generate migrate-rpcn-descriptions`, which shipped a
  // regenerated section describing migrate-rpcn-metadata.
  //
  // The group is captured too, because a command NAME is not unique: the same
  // name can be registered under both `automation` (generate) and `validation`
  // (validate). `kapa-source-groups` is, and keying on the bare name alone made
  // the later registration silently overwrite the earlier, so the
  // `generate kapa-source-groups` section shipped describing the validate
  // command, complete with validate examples under a generate usage line.
  // Same failure as the migrate-rpcn one above, one level up.
  const pattern = /\/\*\*\s*((?:(?!\*\/)[\s\S])*?)\s*\*\/\s*(programCli|automation|validation)\s*\.command\(['"]([^'"]+)['"]\)/g;

  let match;
  while ((match = pattern.exec(content)) !== null) {
    const [, commentText, group, commandName] = match;

    // Parse the comment into sections
    const parsed = {
      description: '',
      why: '',
      example: '',
      requirements: ''
    };

    // Extract sections
    const descMatch = commentText.match(/@description\s*([\s\S]*?)(?=@\w+|$)/);
    if (descMatch) {
      parsed.description = descMatch[1]
        .split('\n')
        .map(line => line.replace(/^\s*\*\s*/, '').trim())
        .filter(line => line)
        .join(' ');
    }

    const whyMatch = commentText.match(/@why\s*([\s\S]*?)(?=@\w+|$)/);
    if (whyMatch) {
      parsed.why = whyMatch[1]
        .split('\n')
        .map(line => line.replace(/^\s*\*\s*/, '').trim())
        .filter(line => line)
        .join(' ');
    }

    const exampleMatch = commentText.match(/@example\s*([\s\S]*?)(?=@\w+|$)/);
    if (exampleMatch) {
      parsed.example = exampleMatch[1]
        .split('\n')
        .map(line => line.replace(/^\s*\*\s?/, ''))
        .join('\n')
        .trim();
    }

    const reqMatch = commentText.match(/@requirements\s*([\s\S]*?)(?=@\w+|$)/);
    if (reqMatch) {
      parsed.requirements = reqMatch[1]
        .split('\n')
        .map(line => line.replace(/^\s*\*\s?/, ''))
        .join('\n')
        .trim();
    }

    // Keyed by the CLI path a reader would type, so `generate x` and
    // `validate x` cannot collide. The bare name is kept as well, for the
    // top-level commands registered straight onto programCli.
    const groupPrefix = { automation: 'generate ', validation: 'validate ', programCli: '' }[group]
    comments[`${groupPrefix}${commandName}`] = parsed;
    if (comments[commandName] === undefined) comments[commandName] = parsed;
  }

  return comments;
}

/**
 * Generate AsciiDoc for a command
 */
function generateCommandDoc(commandName, helpData, jsdoc, level = 2) {
  const heading = '='.repeat(level);
  let doc = `${heading} ${commandName || 'doc-tools'}\n\n`;

  // Add extended description from JSDoc if available
  if (jsdoc && jsdoc.description) {
    doc += `${jsdoc.description}\n\n`;
  } else if (helpData.description) {
    doc += `${helpData.description}\n\n`;
  }

  // Add "Why use it" section if available
  if (jsdoc && jsdoc.why) {
    doc += `*Why use it:*\n\n${jsdoc.why}\n\n`;
  }

  if (helpData.usage) {
    doc += `*Usage:*\n\n`;
    doc += `[,bash]\n----\n${helpData.usage}\n----\n\n`;
  }

  if (helpData.options.length > 0) {
    doc += `*Options:*\n\n`;
    helpData.options.forEach(opt => {
      const name = opt.name.replace(/\s+/g, ' ');
      const sanitizedDescription = sanitizePathInDescription(opt.description);
      doc += `\`${name}\`::\n${sanitizedDescription}\n\n`;
    });
  }

  if (helpData.commands.length > 0) {
    doc += `*Commands:*\n\n`;
    helpData.commands.forEach(cmd => {
      const cmdName = cmd.name.split(' ')[0];
      doc += `* \`${cmdName}\` - ${cmd.description}\n`;
    });
    doc += `\n`;
  }

  // Add examples from JSDoc if available
  if (jsdoc && jsdoc.example) {
    doc += `*Examples:*\n\n[,bash]\n----\n${jsdoc.example}\n----\n\n`;
  }

  // Add requirements from JSDoc if available
  if (jsdoc && jsdoc.requirements) {
    doc += `*Requirements:*\n\n${jsdoc.requirements}\n\n`;
  }

  return doc;
}

/**
 * Main generation function
 */
function generateDocs() {
  console.log('Generating CLI documentation...');

  // Parse JSDoc comments from source
  const sourceFile = path.join(__dirname, '..', 'bin', 'doc-tools.js');
  console.log('  Parsing JSDoc comments from source...');
  const jsdocs = parseJSDocComments(sourceFile);
  console.log(`  Found ${Object.keys(jsdocs).length} documented commands`);

  let doc = `= Doc Tools CLI Reference
:toc:
:toclevels: 3

Auto-generated reference documentation for the \`doc-tools\` command-line interface.

IMPORTANT: This documentation is auto-generated. Do not edit manually. Run \`npm run generate:cli-docs\` to regenerate.

`;

  // Get main help
  const mainHelp = getHelpOutput('');
  const mainData = parseHelp(mainHelp);
  doc += generateCommandDoc('', mainData, null, 2);

  // Walk the command tree the CLI itself reports, rather than three
  // hardcoded lists. Those lists had drifted both ways at once: lint-strings,
  // preview-string and overrides were undocumented while README.adoc points
  // users here as the complete reference, and `preview-prompt` was still
  // getting a section even though the command no longer exists (the generator
  // fell back to the top-level help for it, so the section was real-looking
  // and wrong). A command group is anything whose help lists Commands: of its
  // own, so a new command or subcommand is documented the moment it is
  // registered.
  const documentCommand = (commandPath, level) => {
    const label = commandPath.join(' ');
    console.log(`${'  '.repeat(level - 1)}Generating docs for: ${label}`);
    const data = parseHelp(getHelpOutput(label));
    // Prefer the full command path, falling back to the bare name so that
    // commands registered directly on programCli still resolve.
    const jsdoc = jsdocs[label] || jsdocs[commandPath[commandPath.length - 1]];
    doc += generateCommandDoc(label, data, jsdoc, level);
    for (const child of data.commands) {
      // Commander lists `help [command]` in every group; it is not a command
      // anyone documents.
      const childName = child.name.split(/[\s[<]/)[0];
      if (childName === 'help') continue;
      documentCommand([...commandPath, childName], level + 1);
    }
  };

  for (const child of mainData.commands) {
    const childName = child.name.split(/[\s[<]/)[0];
    if (childName === 'help') continue;
    documentCommand([childName], 2);
  }

  // Write to file
  const outputPath = path.join(__dirname, '..', 'CLI_REFERENCE.adoc');
  fs.writeFileSync(outputPath, doc);
  console.log(`✓ Generated: ${outputPath}`);
}

// Run if executed directly
if (require.main === module) {
  generateDocs();
}

module.exports = { generateDocs };

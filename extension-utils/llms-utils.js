'use strict';

/**
 * Shared utilities for llms.txt generation and markdown processing.
 * Used by both convert-to-markdown.js and convert-llms-to-txt.js.
 */

/**
 * The base directive text that appears in markdown files pointing to llms.txt.
 * This is the canonical source of truth used for both rendering and stripping.
 */
const LLMS_DIRECTIVE_BASE = 'For the complete documentation index, see [llms.txt](/llms.txt)';

/**
 * Format the llms directive blockquote for a page.
 * @param {string} componentName - Optional component name for component-specific link
 * @returns {string} Formatted markdown blockquote directive
 */
function formatLlmsDirective(componentName) {
  if (componentName) {
    return `> ${LLMS_DIRECTIVE_BASE}. Component-specific: [${componentName}-full.txt](/${componentName}-full.txt)`;
  }
  return `> ${LLMS_DIRECTIVE_BASE}`;
}

/**
 * Regex pattern to match and strip the llms directive from markdown content.
 * Matches the blockquote format with optional component-specific suffix.
 */
const LLMS_DIRECTIVE_REGEX = /^> For the complete documentation index, see \[llms\.txt\].*$/gm;

/**
 * Regex pattern to match and strip HTML source comments from markdown content.
 */
const SOURCE_COMMENT_REGEX = /^<!--[\s\S]*?-->\s*/gm;

/**
 * Strip metadata added by convert-to-markdown extension from page content.
 * This removes:
 * 1. HTML comments (source URLs)
 * 2. llms.txt directive blockquotes (redundant in aggregated exports)
 *
 * @param {string|Buffer} content - The markdown content to strip
 * @returns {string} Cleaned markdown content
 */
function stripMarkdownMetadata(content) {
  let text = typeof content === 'string' ? content : content.toString('utf8');

  // Strip HTML comments (source URLs)
  text = text.replace(SOURCE_COMMENT_REGEX, '');

  // Strip llms.txt directive blockquotes
  text = text.replace(LLMS_DIRECTIVE_REGEX, '');

  return text.trim();
}

module.exports = {
  LLMS_DIRECTIVE_BASE,
  LLMS_DIRECTIVE_REGEX,
  SOURCE_COMMENT_REGEX,
  formatLlmsDirective,
  stripMarkdownMetadata,
};

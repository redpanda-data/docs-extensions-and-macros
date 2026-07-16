'use strict';

/**
 * Utilities for extracting the "== Metadata" section out of a connector's
 * `description` prose so it can be emitted as a regenerated partial (like the
 * fields and examples partials) instead of being frozen into a hand-maintained
 * main page.
 *
 * Convention: the connector `.Description()` in the Connect source contains a
 * level-2 AsciiDoc heading `== Metadata` followed by a bullet list, terminated
 * by the next level-2 heading (for example `== Permissions`) or end of string.
 * As of Connect 4.99.0, 52 of the 65 metadata-documenting components already
 * follow this exact heading convention.
 */

const METADATA_HEADING = /^==\s+Metadata\s*$/;
const LEVEL2_HEADING = /^==\s+\S/;

/**
 * Locate the `== Metadata` section within a description.
 * @param {string} description
 * @returns {{start:number, end:number, block:string}|null} character offsets of
 *   the section (heading through the last content line, trailing blank lines
 *   excluded) and the extracted block text, or null when no section is present.
 */
function locateMetadata (description) {
  if (!description || typeof description !== 'string') return null;

  const lines = description.split('\n');
  let headingLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (METADATA_HEADING.test(lines[i])) { headingLine = i; break; }
  }
  if (headingLine === -1) return null;

  // Find the terminating heading (next level-2 heading after the metadata one).
  let endLine = lines.length;
  for (let i = headingLine + 1; i < lines.length; i++) {
    if (LEVEL2_HEADING.test(lines[i])) { endLine = i; break; }
  }

  // Trim trailing blank lines inside the section so the block ends cleanly.
  let lastContent = endLine - 1;
  while (lastContent > headingLine && lines[lastContent].trim() === '') lastContent--;

  const startOffset = lines.slice(0, headingLine).join('\n').length + (headingLine > 0 ? 1 : 0);
  const block = lines.slice(headingLine, lastContent + 1).join('\n');
  const endOffset = startOffset + block.length;

  return { start: startOffset, end: endOffset, block };
}

/**
 * Return the extracted `== Metadata` block, or '' when there is none.
 * @param {string} description
 * @returns {string}
 */
function extractMetadata (description) {
  const found = locateMetadata(description);
  return found ? found.block : '';
}

/**
 * Derive the plural type directory (for example `input` -> `inputs`).
 * @param {object} item connector data with `type` and/or `typeDir`
 * @returns {string}
 */
function typeDirFor (item) {
  if (item && item.typeDir) return item.typeDir;
  const type = item && item.type;
  if (!type) return '';
  return type.endsWith('s') ? type : `${type}s`;
}

/**
 * Build the Antora include directive for a connector's metadata partial.
 * @param {object} item connector data with `type`/`typeDir` and `name`
 * @returns {string}
 */
function metadataIncludeLine (item) {
  return `include::connect:components:partial$metadata/${typeDirFor(item)}/${item.name}.adoc[]`;
}

/**
 * Replace the inline `== Metadata` block in a description with an include
 * directive pointing at the regenerated metadata partial, preserving position
 * relative to surrounding sections (such as `== Permissions`). Returns the
 * description unchanged when no metadata section is present.
 * @param {object} item connector data (needs `description`, `type`/`typeDir`, `name`)
 * @returns {string}
 */
function descriptionWithMetadataInclude (item) {
  const description = (item && item.description) || '';
  const found = locateMetadata(description);
  if (!found) return description;
  return description.slice(0, found.start) + metadataIncludeLine(item) + description.slice(found.end);
}

module.exports = {
  locateMetadata,
  extractMetadata,
  typeDirFor,
  metadataIncludeLine,
  descriptionWithMetadataInclude,
};

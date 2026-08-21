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
// AsciiDoc listing/literal block delimiter (`----`, possibly longer). Lines
// inside such blocks must not be treated as headings.
const BLOCK_DELIMITER = /^-{4,}$/;
// The metadata block ends at the next structural element. Besides the next
// level-2 heading, this also covers page-level constructs that follow the
// section when locateMetadata runs against a full reference page (not just a
// connector description): Antora include directives (for example the fields or
// examples partials) and single-source tag comments. Without these, a metadata
// section that is the last heading on a page would run to end-of-string and
// swallow the trailing `include::...partial$fields[]` and `// end::single-source[]`.
const SECTION_END = /^(?:==\s+\S|include::|\/\/\s*(?:tag|end)::)/;

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
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    if (BLOCK_DELIMITER.test(lines[i])) { inBlock = !inBlock; continue; }
    if (!inBlock && METADATA_HEADING.test(lines[i])) { headingLine = i; break; }
  }
  if (headingLine === -1) return null;

  // Find the terminating element after the metadata heading: the next level-2
  // heading, an Antora include directive, or a single-source tag comment.
  let endLine = lines.length;
  inBlock = false;
  for (let i = headingLine + 1; i < lines.length; i++) {
    if (BLOCK_DELIMITER.test(lines[i])) { inBlock = !inBlock; continue; }
    if (!inBlock && SECTION_END.test(lines[i])) { endLine = i; break; }
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

// Rate limits are the one component family the upstream data and the docs
// repo spell differently: the dataset key is `rate-limits`, `item.type` is
// `rate_limit`, and the pages directory is `rate_limits`. Every spelling has
// to collapse to one partial directory or the write path and the include path
// disagree and the include does not resolve.
const TYPE_DIR_ALIASES = new Map([
  ['rate-limit', 'rate_limits'],
  ['rate-limits', 'rate_limits'],
  ['rate_limit', 'rate_limits'],
]);

/**
 * Canonical partial directory for a plural type directory. Applied to every
 * derivation of a type directory so `typeDirFor` is the single source of truth
 * for both the file the generator writes and the include line a page carries.
 * @param {string} typeDir
 * @returns {string}
 */
function normalizeTypeDir (typeDir) {
  return TYPE_DIR_ALIASES.get(typeDir) || typeDir;
}

/**
 * Derive the plural, canonical type directory (for example `input` ->
 * `inputs`, `rate-limits` -> `rate_limits`).
 * @param {object} item connector data with `type` and/or `typeDir`
 * @returns {string}
 */
function typeDirFor (item) {
  if (item && item.typeDir) return normalizeTypeDir(item.typeDir);
  const type = item && item.type;
  if (!type) return '';
  return normalizeTypeDir(type.endsWith('s') ? type : `${type}s`);
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

/**
 * Build the Antora include directive for a connector's description partial.
 * Mirrors {@link metadataIncludeLine} so a drafted page can pull its
 * auto-generated summary and description from a regenerated partial instead of
 * freezing them into the page body at first draft.
 * @param {object} item connector data with `type`/`typeDir` and `name`
 * @returns {string}
 */
function descriptionIncludeLine (item) {
  return `include::connect:components:partial$descriptions/${typeDirFor(item)}/${item.name}.adoc[]`;
}

// Markdown-style fence delimiter (``` or ~~~, possibly with a language tag).
// Metadata blocks can carry fenced examples alongside AsciiDoc ---- blocks.
const FENCE_DELIMITER = /^(`{3,}|~{3,})/;

/**
 * Collect the section heading titles in an AsciiDoc block, ignoring lines
 * inside `----` literal blocks and ```/~~~ fenced blocks. Titles are returned
 * without their `=` markers so callers can compare sections across heading
 * levels (the same section may be `==` in a connector description but `===`
 * in a partial migrated from a page).
 * @param {string} text
 * @returns {string[]}
 */
function sectionHeadings (text) {
  if (!text || typeof text !== 'string') return [];
  const headings = [];
  let inBlock = false;
  let fence = null;
  for (const line of text.split('\n')) {
    // Layered state: while inside one delimiter kind, the only thing that
    // matters is its own closer. A fence-like line inside a ---- literal
    // block (or a ---- line inside a fence) is content, not a delimiter —
    // treating it as one leaks the state and swallows every later heading.
    if (inBlock) {
      if (BLOCK_DELIMITER.test(line)) inBlock = false;
      continue;
    }
    if (fence) {
      const closer = line.match(FENCE_DELIMITER);
      if (closer && closer[1][0] === fence) fence = null;
      continue;
    }
    const fenceMatch = line.match(FENCE_DELIMITER);
    if (fenceMatch) { fence = fenceMatch[1][0]; continue; }
    if (BLOCK_DELIMITER.test(line)) { inBlock = true; continue; }
    const m = line.match(/^=+\s+(\S.*)$/);
    if (m) headings.push(m[1].trim());
  }
  return headings;
}

/**
 * Report the section headings present in a previously generated metadata
 * partial that are missing from its regenerated replacement. Regeneration is
 * authoritative, but published content silently disappearing is how docs lose
 * examples: a section that lives outside the upstream description's
 * `== Metadata` block (or was hand-migrated from a page) is dropped without a
 * trace on the next run. Callers use this to warn before overwriting.
 * @param {string} oldContent existing partial on disk
 * @param {string} newContent regenerated partial about to be written
 * @returns {string[]} heading titles present in oldContent but not newContent
 */
function lostMetadataSections (oldContent, newContent) {
  const newHeadings = new Set(sectionHeadings(newContent));
  return sectionHeadings(oldContent).filter((h) => !newHeadings.has(h));
}

/**
 * Flatten AsciiDoc prose into a value usable as a `:description:` attribute
 * and, downstream, as the page's `<meta name="description">`.
 *
 * Meta descriptions are read as plain text by search results, link previews
 * and assistants, so markup has to come out mechanically: xref and link
 * macros become their labels, bare URL macros become their labels, `<<>>`
 * shorthand becomes its text, the "open in new tab" caret goes, inline code
 * loses its backticks, and whitespace (including hard line breaks, which an
 * attribute value cannot carry) collapses to single spaces. No prose is
 * edited.
 *
 * This is the one implementation: `summaryAttribute` (the description
 * partial's attrs region) and `backfillPageDescriptions` (the page-header
 * self-heal) both call it, so the two paths cannot drift into publishing
 * different meta descriptions for the same summary.
 *
 * @param {string} text
 * @returns {string}
 */
function flattenToAttributeValue (text) {
  if (!text) return '';
  return String(text)
    .replace(/(?:xref|link):[^\[\]]+\[([^\]]*)\]/g, '$1')
    // Bare URL macros (no xref:/link: prefix) and internal xref shorthand
    // also appear in source summaries and render literally if left in place.
    .replace(/https?:\/\/[^\s\[\]]+\[([^\]]*)\]/g, '$1')
    // image:: and inline image: macros have no textual value in a meta
    // description; drop them rather than leaking the target path.
    .replace(/image:{1,2}[^\[\]\s]*\[[^\]]*\]/g, '')
    .replace(/<<[^,>]+,([^>]+)>>/g, '$1')
    .replace(/<<([^>]+)>>/g, '$1')
    // Strip the "open in new tab" caret that AsciiDoc URL macros carry
    // inside the link text, e.g. [Open Telemetry collector^].
    .replace(/\^/g, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = {
  locateMetadata,
  flattenToAttributeValue,
  normalizeTypeDir,
  extractMetadata,
  typeDirFor,
  metadataIncludeLine,
  descriptionWithMetadataInclude,
  descriptionIncludeLine,
  sectionHeadings,
  lostMetadataSections,
  FENCE_DELIMITER,
};

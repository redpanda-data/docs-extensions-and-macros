// Render a parsed release model into a candidate AsciiDoc release-notes section.
//
// Output is a `== vX.Y.Z (date)` section with `=== Features` / `=== Improvements`
// / `=== Bug fixes` subsections of plain `*` bullets. Entries are emitted as
// bullets carrying the de-noised source prose verbatim: this is a CANDIDATE for
// the curation step, which rewrites voice, converts bullets to `Area::`
// definition-list items, normalizes units, and phrases CVEs. This renderer adds
// no `Area::` labels and makes no editorial change.

const LOG_TAG = '[release-notes]';

const VERSION_RE = /^\d+\.\d+\.\d+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Normalizes a tag or version to a bare `X.Y.Z` (strips a leading `v`).
 *
 * @param {string} version - A version or tag, such as `v26.2.3` or `26.2.3`.
 * @return {string} The bare `X.Y.Z` version.
 */
function normalizeVersion(version) {
  return String(version || '').trim().replace(/^v/i, '');
}

/**
 * Renders one release section as AsciiDoc.
 *
 * @param {Object} options
 * @param {string} options.version - The release version (`v26.2.3` or `26.2.3`).
 * @param {string} options.date - The release date as `YYYY-MM-DD` (authored; the
 *   captain confirms it on the PR).
 * @param {Array<{title: string, entries: string[]}>} options.sections - Sections
 *   in page order, as produced by parseReleaseBody.
 * @return {string} The AsciiDoc section, ending with a single trailing newline.
 * @throws {Error} If the version or date is malformed, or there are no sections.
 */
function renderReleaseSection({ version, date, sections }) {
  const v = normalizeVersion(version);
  if (!VERSION_RE.test(v)) {
    throw new Error(`Invalid version: ${JSON.stringify(version)}. Expected X.Y.Z (optionally v-prefixed).`);
  }
  if (!DATE_RE.test(String(date || '').trim())) {
    throw new Error(`Invalid date: ${JSON.stringify(date)}. Expected YYYY-MM-DD.`);
  }
  if (!Array.isArray(sections) || sections.length === 0) {
    throw new Error('No release-note sections to render.');
  }

  const lines = [`== v${v} (${String(date).trim()})`, ''];
  for (const section of sections) {
    if (!section.entries || section.entries.length === 0) continue;
    lines.push(`=== ${section.title}`, '');
    for (const entry of section.entries) {
      lines.push(`* ${entry}`);
    }
    lines.push('');
  }

  // Trim the trailing blank line to exactly one terminating newline.
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n') + '\n';
}

module.exports = {
  renderReleaseSection,
  normalizeVersion,
  VERSION_RE,
  DATE_RE,
  LOG_TAG,
};

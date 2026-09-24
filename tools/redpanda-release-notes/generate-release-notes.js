// Orchestrate release-notes generation: parse the body, render a candidate
// section, and insert it into the target page under the mechanical guards
// (GA-only, floor, idempotency). Pure and IO-free: callers pass the page
// content in and get the updated content back; the doc-tools action does the
// file read/write, and the workflow fetches the release body.

const { parseReleaseBody } = require('./parse-release-body');
const { renderReleaseSection, normalizeVersion } = require('./render-release-notes');

const LOG_TAG = '[release-notes]';

/**
 * Compares two `X.Y.Z` versions numerically.
 *
 * @param {string} a - A version (optionally v-prefixed).
 * @param {string} b - A version (optionally v-prefixed).
 * @return {number} -1 if a < b, 0 if equal, 1 if a > b.
 */
function compareVersions(a, b) {
  const pa = normalizeVersion(a).split('.').map(Number);
  const pb = normalizeVersion(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

/**
 * Reports whether a tag is a GA release. Release notes are added for GA tags
 * only; a prerelease (for example `v26.2.3-rc1`) gets no section.
 *
 * @param {string} tag - The release tag.
 * @return {boolean} True if the tag is a bare `vX.Y.Z` with no prerelease suffix.
 */
function isGaTag(tag) {
  return /^v?\d+\.\d+\.\d+$/.test(String(tag || '').trim());
}

/**
 * Reads the `:earliest-tracked-version:` floor attribute from the page.
 *
 * @param {string} pageContent - The target page content.
 * @return {string|null} The bare floor version, or null if the attribute is absent.
 */
function readFloor(pageContent) {
  const m = String(pageContent).match(/^:earliest-tracked-version:\s*(.+?)\s*$/m);
  return m ? normalizeVersion(m[1]) : null;
}

/**
 * Reports whether the page already has a section for this version, so a re-run
 * for an already-published tag is a no-op rather than a duplicate.
 *
 * @param {string} pageContent - The target page content.
 * @param {string} version - The release version (optionally v-prefixed).
 * @return {boolean} True if a `== vX.Y.Z (` heading is already present.
 */
function hasVersionSection(pageContent, version) {
  const v = normalizeVersion(version).replace(/[.]/g, '\\.');
  return new RegExp(`^==\\s+v${v}\\s*\\(`, 'm').test(String(pageContent));
}

/**
 * Inserts a rendered section into the page in descending-version order: before
 * the first existing `== vX.Y.Z` heading OLDER than the section, so a later
 * backfill of an older release lands below the newer ones already present
 * rather than jumping to the top. If nothing older exists (the section is the
 * oldest, or there are no version sections yet), it goes before the
 * "Release notes for older versions" footer; failing that, before the first
 * version heading; failing that, at the end.
 *
 * @param {string} pageContent - The target page content.
 * @param {string} sectionText - The rendered section (ending in a newline).
 * @return {string} The page content with the section inserted.
 */
function insertReleaseSection(pageContent, sectionText) {
  const lines = String(pageContent).split('\n');
  const sectionLines = sectionText.replace(/\n+$/, '').split('\n');
  const versionHeading = /^==\s+v(\d+\.\d+\.\d+)\s*\(/;
  const newVer = (sectionText.match(versionHeading) || [])[1];

  let idx = -1;
  if (newVer) {
    // Keep newest-first: insert before the first section older than this one.
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(versionHeading);
      if (m && compareVersions(newVer, m[1]) > 0) { idx = i; break; }
    }
  }
  if (idx === -1) {
    // Older than everything present (or no version parsed): sit after the last
    // version section — before the older-versions footer — else before the
    // first version heading, else at the end.
    const footerIdx = lines.findIndex((l) => /^==\s+Release notes for older versions/i.test(l));
    idx = footerIdx !== -1 ? footerIdx : lines.findIndex((l) => versionHeading.test(l));
  }
  if (idx === -1) {
    // No anchor at all: append at end with a blank-line separator.
    const tail = lines[lines.length - 1] === '' ? [] : [''];
    return [...lines, ...tail, ...sectionLines, ''].join('\n');
  }

  // The anchor heading is already preceded by a blank line, so inserting the
  // section plus one blank separator keeps exactly one blank line on each side.
  lines.splice(idx, 0, ...sectionLines, '');
  return lines.join('\n');
}

/**
 * Builds a candidate release section from a raw release body.
 *
 * @param {Object} options
 * @param {string} options.body - The raw rpchangelog release body markdown.
 * @param {string} options.version - The release version (`v26.2.3` or `26.2.3`).
 * @param {string} options.date - The release date as `YYYY-MM-DD`.
 * @return {string} The rendered AsciiDoc section.
 */
function buildReleaseSection({ body, version, date }) {
  const { sections } = parseReleaseBody(body);
  return renderReleaseSection({ version, date, sections });
}

/**
 * Asserts that an externally-produced (curated) section carries exactly one
 * `== vX.Y.Z (date)` heading whose version matches the requested tag. Phase 2
 * inserts the section verbatim, and the idempotency guard keys off the tag, so
 * a heading that disagrees with the tag would defeat idempotency and let
 * reruns insert duplicates. This is malformed input, so it throws (fail loud)
 * rather than returning a skip.
 *
 * @param {string} section - The curated section text.
 * @param {string} version - The bare `X.Y.Z` version the tag resolved to.
 * @throws {Error} If the section has zero or several release headings, or one
 *   whose version does not match.
 */
function assertSectionMatchesTag(section, version) {
  const headings = String(section).match(/^==\s+v\d+\.\d+\.\d+\s*\(/gm) || [];
  if (headings.length !== 1) {
    throw new Error(`Curated section must contain exactly one "== vX.Y.Z (date)" heading; found ${headings.length}.`);
  }
  const found = String(section).match(/^==\s+v(\d+\.\d+\.\d+)\s*\(/m)[1];
  if (found !== version) {
    throw new Error(`Curated section heading (v${found}) does not match the requested tag (v${version}).`);
  }
}

/**
 * Generates the updated page content for a release, applying the GA, floor, and
 * idempotency guards. Never throws for a guard miss: returns a `skipped` status
 * so the workflow can no-op cleanly.
 *
 * Two phases, because the LLM curation step sits between them:
 * - Phase 1 (pass `body`): build the de-noised candidate section from the raw
 *   release body. This candidate is the curation step's input.
 * - Phase 2 (pass `section`): insert the curated section the skill produced.
 * Exactly one of `body` or `section` is supplied. The guards apply in both
 * phases, since they depend on the tag and the page, not on the entries.
 *
 * @param {Object} options
 * @param {string} [options.body] - Raw rpchangelog release body (phase 1).
 * @param {string} [options.section] - A pre-built/curated section to insert (phase 2).
 * @param {string} options.tag - The release tag (`v26.2.3`).
 * @param {string} [options.date] - The authored release date as `YYYY-MM-DD` (phase 1 only).
 * @param {string} options.pageContent - The current target page content.
 * @return {{status: 'ok'|'skipped', reason?: string, section?: string, content?: string}}
 */
function generateReleaseNotes({ body, section, tag, date, pageContent }) {
  if (body == null && section == null) {
    throw new Error('Provide either body (phase 1) or section (phase 2).');
  }
  if (body != null && section != null) {
    throw new Error('Provide only one of body or section, not both.');
  }

  if (!isGaTag(tag)) {
    return { status: 'skipped', reason: `not a GA tag: ${tag}` };
  }
  const version = normalizeVersion(tag);

  const floor = readFloor(pageContent);
  if (floor && compareVersions(version, floor) <= 0) {
    return { status: 'skipped', reason: `version ${version} is not newer than the floor ${floor}` };
  }

  if (hasVersionSection(pageContent, version)) {
    return { status: 'skipped', reason: `page already has a section for v${version}` };
  }

  let finalSection;
  if (section != null) {
    assertSectionMatchesTag(section, version);
    finalSection = section;
  } else {
    finalSection = buildReleaseSection({ body, version, date });
  }
  const content = insertReleaseSection(pageContent, finalSection);
  return { status: 'ok', section: finalSection, content };
}

module.exports = {
  generateReleaseNotes,
  buildReleaseSection,
  assertSectionMatchesTag,
  insertReleaseSection,
  compareVersions,
  isGaTag,
  readFloor,
  hasVersionSection,
  LOG_TAG,
};

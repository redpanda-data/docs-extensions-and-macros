// Orchestrate release notes for the Redpanda Operator and the Helm charts.
//
// Three operations, all pure except the Helm index lookup:
// - buildCandidate: release body -> candidate section (the curation step's input)
// - publishSection: curated section -> checked, assembled section -> updated page
// - lintPage: report anything on a page that points into private systems
//
// The docs-repo workflow fetches the release body, runs the curation step
// between the first two, and opens the pull request.

const { parseTag, INDEX_URL } = require('./projects');
const { parseChangieBody, renderCandidate } = require('./changie');
const { assembleSection, findLeaks, hashSource } = require('./section');
const {
  parseChanges,
  isFullyDeclared,
  declaredUpgradeNotes,
  declaredPublicCounts,
  declaredPublicFlags,
  declaredEntries,
  publishedEntries,
  changesToMarkdown,
  changesText,
} = require('./changes');
const { updatePage } = require('./page');

const LOG_TAG = '[k8s-release-notes]';

/**
 * Builds the candidate section from a raw release body.
 *
 * @param {Object} options
 * @param {string} options.tag - The release tag, such as `operator/v26.2.6`.
 * @param {string} options.date - The release date as `YYYY-MM-DD`.
 * @param {string} options.body - The raw changie release body.
 * @param {string} [options.changes] - The release's `changes.json` text. When
 *   given, the candidate is built from it: entries declared internal are left
 *   out, and the declared upgrade notes are listed under "Before you upgrade".
 * @return {{status: 'ok'|'skipped'|'empty', reason?: string, section?: string, unknownKinds?: string[], publicBody?: string}}
 *   `empty` when the structured entries are all declared internal: the
 *   release has nothing to publish. `publicBody` is the published entries as
 *   Markdown, which is what the curation step may read in place of the raw
 *   release body.
 */
function buildCandidate({ tag, date, body, changes }) {
  const parsed = parseTag(tag);
  if (!parsed) return { status: 'skipped', reason: `not a GA tag of a published project: ${tag}` };
  if (changes == null) {
    const { sections, unknownKinds } = parseChangieBody(body);
    return { status: 'ok', section: renderCandidate({ version: parsed.version, date, sections }), unknownKinds };
  }
  const doc = parseChanges(changes, tag);
  if (!publishedEntries(doc).length) {
    return { status: 'empty', reason: `every changelog entry of ${tag} is declared internal` };
  }
  const publicBody = changesToMarkdown(doc);
  const { sections, unknownKinds } = parseChangieBody(publicBody);
  const upgrade = { lines: declaredUpgradeNotes(doc), complete: isFullyDeclared(doc), declaredPublic: declaredPublicFlags(doc) };
  return { status: 'ok', section: renderCandidate({ version: parsed.version, date, sections, upgrade }), unknownKinds, publicBody };
}

/**
 * Looks up a chart version in the Helm index, retrying until it is listed or
 * the wait runs out. Charts reach the public index a few minutes after the
 * release, and a command for a version that is not there yet would fail.
 *
 * @param {Object} options
 * @param {string} options.chart - The chart name in the index.
 * @param {string} options.version - The bare chart version.
 * @param {function} options.fetchEntries - Returns the chart's index entries, or null.
 * @param {number} [options.waitSeconds] - How long to keep retrying.
 * @param {number} [options.intervalSeconds] - Seconds between retries.
 * @param {function} [options.sleep] - Waits the given milliseconds (injected in tests).
 * @return {Promise<{version: string, appVersion: string|null}|null>} The entry, or null if it never appeared.
 */
async function waitForChart({ chart, version, fetchEntries, waitSeconds = 0, intervalSeconds = 30, sleep }) {
  const pause = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + waitSeconds * 1000;
  for (;;) {
    const entries = await fetchEntries({ chart });
    const found = (entries || []).find((entry) => entry.version === version);
    if (found) return found;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return null;
    const waitMs = Math.min(intervalSeconds * 1000, remainingMs);
    console.log(`${LOG_TAG} ${chart} ${version} is not in the Helm index yet; retrying in ${Math.round(waitMs / 1000)}s.`);
    await pause(waitMs);
  }
}

/**
 * Checks a curated section, assembles the published section, and puts it into
 * the page.
 *
 * @param {Object} options
 * @param {string} options.tag - The release tag.
 * @param {string} options.curated - The curated section text.
 * @param {string} options.sourceBody - The raw release body the section came from.
 * @param {string} options.pageContent - The current page content.
 * @param {{version: string, appVersion: string|null}|null} options.chartEntry - The
 *   chart's entry in the Helm index. Null means the version cannot be installed
 *   yet, which is an error: the section carries a command that pins it.
 * @param {string} [options.changes] - The release's `changes.json` text. When
 *   given, the upgrade notes its entries declare are written as declared, and
 *   the curated section is checked against the published entries only.
 * @param {string} [options.date] - The release date. When given, the curated
 *   heading must carry it.
 * @return {{status: 'ok'|'skipped', action?: string, reason?: string, section?: string, content?: string}}
 * @throws {Error} If the curated section fails a check or the chart is not published.
 */
function publishSection({ tag, curated, sourceBody, pageContent, chartEntry, changes, date }) {
  const parsed = parseTag(tag);
  if (!parsed) return { status: 'skipped', reason: `not a GA tag of a published project: ${tag}` };
  if (!chartEntry) {
    throw new Error(`Chart ${parsed.project.chart} ${parsed.version} is not in the Helm index at ${INDEX_URL}, so readers could not install it.`);
  }
  let declared;
  if (changes != null) {
    const doc = parseChanges(changes, tag);
    declared = {
      lines: declaredUpgradeNotes(doc),
      complete: isFullyDeclared(doc),
      text: changesText(doc),
      publicCounts: declaredPublicCounts(doc),
      entries: declaredEntries(doc),
    };
  }
  const sourceHash = hashSource(sourceBody, changes);
  const section = assembleSection({
    curated,
    tag,
    version: parsed.version,
    project: parsed.project,
    sourceBody,
    appVersion: chartEntry.appVersion,
    date,
    declared,
    sourceHash,
  });
  const result = updatePage(pageContent, section, sourceHash);
  return result.status === 'ok' ? { ...result, section } : result;
}

/**
 * Reports text on a page that points into private systems.
 *
 * @param {string} pageContent - The page content.
 * @return {Array<{line: number, kind: string, match: string}>} One finding per hit.
 */
function lintPage(pageContent) {
  return findLeaks(pageContent);
}

module.exports = { buildCandidate, waitForChart, publishSection, lintPage, LOG_TAG };

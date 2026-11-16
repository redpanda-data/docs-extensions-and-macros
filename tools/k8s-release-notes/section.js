// Check a curated release section and assemble the section that is published.
//
// The curation step returns a small, strict format:
//
//   == vX.Y.Z (YYYY-MM-DD)
//
//   One-sentence summary.
//
//   === Before you upgrade        (optional)
//   * ...
//
//   === New features              (any of the category headings)
//   * ...
//
// Everything else in the published section is added here, by code, so it is
// the same on every release: the anchor, the source hash line, the "Before you
// upgrade" callout, and the pinned upgrade command.

const crypto = require('crypto');
const { CATEGORY_TITLES, PUBLIC_KEY_PREFIXES, outsideCode } = require('./changie');

const UPGRADE_TITLE = 'Before you upgrade';
const HEADING_RE = /^==\s+v(\d+\.\d+\.\d+)\s+\((\d{4}-\d{2}-\d{2})\)\s*$/;

/**
 * Hashes a release body, so the page can record which body a section came
 * from without holding the body itself.
 *
 * @param {string} body - The raw release body.
 * @return {string} The SHA-256 hex digest.
 */
function hashBody(body) {
  return crypto.createHash('sha256').update(String(body), 'utf8').digest('hex');
}

/**
 * Returns the anchor ID of a version's section.
 *
 * @param {string} version - The bare `X.Y.Z` version.
 * @return {string} An ID such as `v26-2-6`.
 */
function sectionId(version) {
  return `v${String(version).replace(/\./g, '-')}`;
}

/**
 * Parses a curated section into its parts.
 *
 * @param {string} curated - The curated section text.
 * @return {{version: string, date: string, summary: string, upgrade: string[], categories: Array<{title: string, lines: string[]}>}}
 * @throws {Error} If the section does not follow the curated format.
 */
function parseCurated(curated) {
  const lines = String(curated).replace(/\r\n?/g, '\n').split('\n');
  const headings = lines.filter((l) => /^==\s/.test(l));
  if (headings.length !== 1) {
    throw new Error(`A curated section needs exactly one "== vX.Y.Z (YYYY-MM-DD)" heading; found ${headings.length}.`);
  }
  const head = headings[0].match(HEADING_RE);
  if (!head) throw new Error(`Malformed release heading ${JSON.stringify(headings[0])}; expected "== vX.Y.Z (YYYY-MM-DD)".`);

  const blocks = [];
  let block = { title: null, lines: [] };
  for (const line of lines.slice(lines.indexOf(headings[0]) + 1)) {
    const sub = line.match(/^===\s+(.+?)\s*$/);
    if (/^={4,}\s/.test(line)) throw new Error(`Heading too deep for a release section: ${JSON.stringify(line)}.`);
    if (sub) { blocks.push(block); block = { title: sub[1], lines: [] }; } else block.lines.push(line);
  }
  blocks.push(block);

  const trim = (ls) => {
    const out = ls.slice();
    while (out.length && !out[0].trim()) out.shift();
    while (out.length && !out[out.length - 1].trim()) out.pop();
    return out;
  };

  const summaryLines = trim(blocks[0].lines);
  if (!summaryLines.length) throw new Error('A curated section needs a one-sentence summary under the release heading.');
  if (summaryLines.some((l) => !l.trim()) || /^[*.[|]/.test(summaryLines[0])) {
    throw new Error('The summary under the release heading must be one plain paragraph.');
  }

  const allowed = [UPGRADE_TITLE, ...CATEGORY_TITLES];
  const seen = new Set();
  let upgrade = [];
  const categories = [];
  for (const b of blocks.slice(1)) {
    if (!allowed.includes(b.title)) {
      throw new Error(`Unknown heading "=== ${b.title}". Allowed: ${allowed.join(', ')}.`);
    }
    if (seen.has(b.title)) throw new Error(`Heading "=== ${b.title}" appears twice.`);
    seen.add(b.title);
    const body = trim(b.lines);
    if (!body.some((l) => /^\* \S/.test(l))) throw new Error(`"=== ${b.title}" has no "* " entries.`);
    if (b.title === UPGRADE_TITLE) {
      if (body.some((l) => l.trim() && !/^\* \S/.test(l))) {
        throw new Error(`"=== ${UPGRADE_TITLE}" takes single-line "* " items only.`);
      }
      upgrade = body.filter((l) => l.trim());
    } else {
      categories.push({ title: b.title, lines: body });
    }
  }
  if (!categories.length) throw new Error('A curated section needs at least one category with entries.');
  // Page order, whatever order the curated text used.
  categories.sort((a, b) => CATEGORY_TITLES.indexOf(a.title) - CATEGORY_TITLES.indexOf(b.title));

  return { version: head[1], date: head[2], summary: summaryLines.join(' ').trim(), upgrade, categories };
}

/**
 * Finds text that points into private systems: links into the redpanda-data
 * GitHub organization, issue or pull request numbers, ticket keys, author
 * handles, and compare links. Code spans, comment lines, and listing blocks
 * are not prose and are skipped.
 *
 * @param {string} text - AsciiDoc text (a section or a whole page).
 * @return {Array<{line: number, kind: string, match: string}>} One finding per hit.
 */
function findLeaks(text) {
  const findings = [];
  let inListing = false;
  String(text).split('\n').forEach((line, i) => {
    if (/^(-{4,}|\.{4,})\s*$/.test(line)) { inListing = !inListing; return; }
    if (inListing || /^\/\//.test(line)) return;
    const add = (kind, match) => findings.push({ line: i + 1, kind, match });
    // URLs are checked on the whole line: a private link is a leak in code too.
    for (const m of line.match(/github\.com\/redpanda-data\/[\w./#-]*/g) || []) add('private link', m);
    outsideCode(line, (part) => {
      for (const m of part.match(/(?:^|[\s(\[/])(?:[\w.-]+)?#\d+\b/g) || []) add('issue or pull request number', m.trim());
      for (const m of part.matchAll(/\b([A-Z][A-Z0-9]{1,9})-\d+\b/g)) {
        if (!PUBLIC_KEY_PREFIXES.has(m[1])) add('ticket key', m[0]);
      }
      for (const m of part.match(/(?:^|[\s(])@[A-Za-z0-9][A-Za-z0-9-]*/g) || []) add('author handle', m.trim());
      if (/\b(?:Full|Partial) Changelog\b/.test(part)) add('compare link', 'Changelog');
      return part;
    });
  });
  return findings;
}

/**
 * Finds identifiers and version numbers in the curated text that the source
 * body never mentions. Curation may shorten and rephrase, but every code span
 * and every version it writes must come from the source.
 *
 * @param {string} curated - The curated section text.
 * @param {string} sourceBody - The raw release body.
 * @param {string} version - The release's own bare `X.Y.Z` version (always allowed).
 * @return {string[]} The invented tokens, without duplicates.
 */
function findUnsupported(curated, sourceBody, version) {
  const source = String(sourceBody);
  const flat = source.replace(/\s+/g, ' ');
  const invented = new Set();
  const text = String(curated).split('\n').filter((l) => !/^==\s/.test(l)).join('\n');
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    const span = m[1].replace(/\\\{/g, '{').trim();
    if (span && !source.includes(span) && !flat.includes(span.replace(/\s+/g, ' '))) invented.add(`\`${m[1]}\``);
  }
  for (const m of text.replace(/`[^`\n]*`/g, ' ').matchAll(/\bv?(\d+\.\d+\.\d+(?:-[\w.]+)?)\b/g)) {
    if (m[1] !== version && !source.includes(m[1])) invented.add(m[0]);
  }
  return [...invented];
}

/**
 * Assembles the published section from a curated section.
 *
 * @param {Object} options
 * @param {string} options.curated - The curated section text.
 * @param {string} options.tag - The release tag, recorded in the source line.
 * @param {string} options.version - The bare `X.Y.Z` version the tag resolved to.
 * @param {Object} options.project - The project entry from projects.js.
 * @param {string} options.sourceBody - The raw release body the section came from.
 * @param {string} [options.appVersion] - The application version the chart deploys by default.
 * @return {string} The section, ending in one newline.
 * @throws {Error} If the curated text is malformed, names a different version,
 *   points into private systems, or contains identifiers the source lacks.
 */
function assembleSection({ curated, tag, version, project, sourceBody, appVersion }) {
  const parsed = parseCurated(curated);
  if (parsed.version !== version) {
    throw new Error(`Curated section heading (v${parsed.version}) does not match the requested tag (${tag}).`);
  }
  const leaks = findLeaks(curated);
  if (leaks.length) {
    throw new Error(`Curated section points into private systems: ${leaks.map((f) => `${f.kind} "${f.match}" (line ${f.line})`).join('; ')}.`);
  }
  const invented = findUnsupported(curated, sourceBody, version);
  if (invented.length) {
    throw new Error(`Curated section contains identifiers or versions that are not in the release body: ${invented.join(', ')}.`);
  }

  const id = sectionId(version);
  const lines = [
    `[#${id}]`,
    `== v${version} (${parsed.date})`,
    `// release-notes-source: ${tag} sha256=${hashBody(sourceBody)}`,
    '',
    parsed.summary,
    '',
  ];
  if (parsed.upgrade.length) {
    lines.push(`.${UPGRADE_TITLE}`, '[IMPORTANT]', '====', ...parsed.upgrade, '====', '');
  }
  lines.push('.Install or upgrade to this version', '[,bash]', '----', ...project.command(version), '----', '');
  const after = [];
  if (project.appVersionLine && appVersion) after.push(project.appVersionLine(appVersion));
  after.push(project.after);
  lines.push(after.join(' '), '');
  for (const category of parsed.categories) {
    lines.push(`=== ${category.title}`, '', ...category.lines, '');
  }
  while (lines[lines.length - 1] === '') lines.pop();
  return `${lines.join('\n')}\n`;
}

module.exports = {
  UPGRADE_TITLE,
  hashBody,
  sectionId,
  parseCurated,
  findLeaks,
  findUnsupported,
  assembleSection,
};

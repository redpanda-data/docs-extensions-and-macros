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
const {
  CATEGORY_TITLES,
  PUBLIC_KEY_PREFIXES,
  PRIVATE_LINK_RE,
  ISSUE_REF_STRICT_RE,
  outsideCode,
} = require('./changie');

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
 * Hashes everything a section is built from: the release body and, when the
 * release has structured entries, that document too. A change to either one
 * rebuilds the section.
 *
 * @param {string} body - The raw release body.
 * @param {string} [changesText] - The raw `changes.json` text, if any.
 * @return {string} The SHA-256 hex digest. With no structured entries it is
 *   the hash of the body alone.
 */
function hashSource(body, changesText) {
  return changesText == null ? hashBody(body) : hashBody(`${body}\n${changesText}`);
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
  // The candidate's `// upgrade-notes:` and `// declared-public` lines are
  // instructions for the curation step, not content. Other `//` lines are
  // left alone: inside a listing they are part of the code.
  const lines = String(curated).replace(/\r\n?/g, '\n').split('\n')
    .filter((l) => !/^\/\/ (upgrade-notes:|declared-public\s*$)/.test(l));
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

const LISTING_RE = /^(-{4,}|\.{4,})\s*$/;

/**
 * Steps a listing-block state over one line. A block closes only on the same
 * delimiter that opened it, so a `....` line inside a `----` block is content.
 *
 * @param {string|null} fence - The delimiter of the open block, or null.
 * @param {string} line - The line.
 * @return {{delimiter: boolean, fence: (string|null)}} Whether the line opens
 *   or closes a block, and the delimiter of the block open after it.
 */
function stepListing(fence, line) {
  const m = LISTING_RE.exec(line);
  if (!m) return { delimiter: false, fence };
  const d = m[1];
  if (fence === null) return { delimiter: true, fence: d };
  if (d === fence) return { delimiter: true, fence: null };
  return { delimiter: false, fence };
}

/**
 * Finds text that points into private systems: private links, issue or pull
 * request references, ticket keys, author handles, and compare links. A
 * private link is a leak anywhere, including code spans and listing blocks.
 * The other kinds are checked in prose only. Comment lines are skipped.
 *
 * @param {string} text - AsciiDoc text (a section or a whole page).
 * @return {Array<{line: number, kind: string, match: string}>} One finding per hit.
 */
function findLeaks(text) {
  const findings = [];
  let fence = null;
  String(text).split('\n').forEach((line, i) => {
    const step = stepListing(fence, line);
    fence = step.fence;
    if (step.delimiter) return;
    const inListing = fence !== null;
    if (!inListing && /^\/\//.test(line)) return;
    const add = (kind, match) => findings.push({ line: i + 1, kind, match });
    for (const m of line.match(PRIVATE_LINK_RE) || []) add('private link', m);
    if (inListing) return;
    outsideCode(line.replace(PRIVATE_LINK_RE, ' '), (part) => {
      for (const m of part.match(ISSUE_REF_STRICT_RE) || []) add('issue or pull request number', m.trim());
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
 * Finds AsciiDoc in release-note text that would do more than format an
 * entry: includes, block and inline macros, passthroughs, attribute entries,
 * unescaped attribute references outside code spans, block attributes, and
 * block types the section format does not use. Release notes need only
 * paragraphs, lists, code spans, listings, and a collapsed details block. Also reports a block that is opened and never closed.
 * Listing blocks are not scanned: their content is literal.
 *
 * @param {string} text - Curated release-note text, or one upgrade note.
 * @return {Array<{line: number, kind: string, match: string}>} One finding per hit.
 */
function findMarkup(text) {
  const findings = [];
  const open = { '====': 0, '--': 0 };
  let fence = null;
  let listingStart = 0;
  String(text).split('\n').forEach((line, i) => {
    const add = (kind, match) => findings.push({ line: i + 1, kind, match });
    const step = stepListing(fence, line);
    fence = step.fence;
    if (step.delimiter) { listingStart = i + 1; return; }
    if (fence !== null) return;
    const trimmed = line.trim();
    if (trimmed === '====' || trimmed === '--') { open[trimmed] += 1; return; }
    if (/^(\*{4,}|_{4,}|\+{4,}|\/{4,}|={5,}|\|={3,}|`{3,})\s*$/.test(trimmed)) return add('block type', trimmed);
    if (/^[a-z][\w-]*::\S*\[/i.test(trimmed)) return add('block macro', trimmed.split('[')[0]);
    if (/^:[\w-]+!?:/.test(trimmed)) return add('attribute entry', trimmed);
    if (/^\[.*\]$/.test(trimmed) && !/^\[(%collapsible|,[\w+-]+)\]$/.test(trimmed)) return add('block attribute', trimmed);
    if (/^\.[A-Za-z]/.test(trimmed) && trimmed !== '.Details') return add('block title', trimmed);
    if (/\+{3}|\$\$/.test(line)) add('passthrough', '+++');
    outsideCode(line, (part) => {
      for (const m of part.match(/\b(?:image|video|audio|pass|link|xref|mailto|footnote|footnoteref|kbd|btn|menu|icon|stem|latexmath|asciimath|anchor|indexterm):[^\s[]*\[/g) || []) add('inline macro', m);
      for (const m of part.match(/<<[^>]*>>|\[\[[^\]]*\]\]/g) || []) add('cross reference or anchor', m);
      // `{name}`, `{set:name}`, `{counter:name}`: an attribute reference or
      // inline entry, unless escaped as `\{`.
      for (const m of part.match(/(?<!\\)\{[\w-]+(?::[^{}\n]*)?\}/g) || []) add('attribute reference', m);
      return part;
    });
  });
  if (fence !== null) findings.push({ line: listingStart, kind: 'unclosed block', match: fence });
  for (const [delimiter, count] of Object.entries(open)) {
    if (count % 2) findings.push({ line: 0, kind: 'unclosed block', match: delimiter });
  }
  return findings;
}

/**
 * Finds what the curated text has that the source never mentions: code
 * spans, version numbers, links, and the lines of listing blocks. Curation may
 * shorten and rephrase, but each of these must come from the source.
 *
 * @param {string} curated - The curated section text.
 * @param {string} sourceText - The text the section was curated from.
 * @param {string} version - The release's own bare `X.Y.Z` version (always allowed).
 * @return {string[]} The invented tokens, without duplicates.
 */
function findUnsupported(curated, sourceText, version) {
  const source = String(sourceText);
  const flat = source.replace(/\s+/g, ' ');
  const has = (text) => source.includes(text) || flat.includes(text.replace(/\s+/g, ' '));
  const invented = new Set();
  const prose = [];
  let fence = null;
  for (const line of String(curated).split('\n')) {
    const step = stepListing(fence, line);
    fence = step.fence;
    if (step.delimiter) continue;
    if (/^==\s/.test(line)) continue;
    if (fence === null) { prose.push(line); continue; }
    const code = line.trim();
    if (code && !has(code)) invented.add(`listing line "${code}"`);
  }
  const text = prose.join('\n');
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    const span = m[1].replace(/\\\{/g, '{').trim();
    if (span && !has(span)) invented.add(`\`${m[1]}\``);
  }
  const plain = text.replace(/`[^`\n]*`/g, ' ');
  for (const m of plain.matchAll(/\bv?((\d+\.\d+\.\d+)(-[\w.]+)?)\b/g)) {
    const ok = (v) => v === version || source.includes(v);
    if (ok(m[1])) continue;
    // A trailing word, as in "25.3.1-based", is not part of the version. A
    // suffix with a digit is a prerelease or build, and must be in the source.
    if (m[3] && !/\d/.test(m[3]) && ok(m[2])) continue;
    invented.add(m[0]);
  }
  for (const m of text.matchAll(/https?:\/\/[^\s[\]()<>`]+/g)) {
    const url = m[0].replace(/[.,;:]+$/, '');
    if (!source.includes(url)) invented.add(url);
  }
  return [...invented];
}

// Two upgrade items are the same if they differ only in case, spacing, or
// punctuation.
const sameItem = (line) => line.toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * Splits a category into its top-level entries: each `* ` line outside any
 * block, with the lines that follow it up to the next one.
 *
 * @param {string[]} lines - A category's lines.
 * @return {string[]} One text per entry.
 */
function splitEntries(lines) {
  let depth = 0;
  let fence = null;
  const entries = [];
  for (const line of lines) {
    const step = stepListing(fence, line);
    fence = step.fence;
    const prose = !step.delimiter && fence === null;
    if (prose && line.trim() === '====') depth = depth ? 0 : 1;
    else if (prose && !depth && /^\* \S/.test(line)) { entries.push(line); continue; }
    if (entries.length) entries[entries.length - 1] += `\n${line}`;
  }
  return entries;
}

/**
 * Counts the top-level entries of a category: `* ` lines outside any block.
 *
 * @param {string[]} lines - A category's lines.
 * @return {number} The number of entries.
 */
function countEntries(lines) {
  return splitEntries(lines).length;
}

const STOP_WORDS = new Set('a an and are as at be by for from in is it no not now of on or that the this to was when with'.split(' '));
const words = (text) => new Set((String(text).toLowerCase().match(/[a-z0-9][a-z0-9_.-]*[a-z0-9]|[a-z0-9]/g) || [])
  .filter((w) => !STOP_WORDS.has(w)));

/**
 * Finds the changelog entries that have no bullet in the curated category.
 * Each bullet belongs to the entry whose words it shares most of (Dice
 * coefficient over the words that are not stop words), so a rephrased entry
 * still finds its bullet, and a bullet kept for one entry cannot stand in for
 * another that was dropped or merged into it.
 *
 * @param {string[]} lines - The curated category's lines.
 * @param {Array<{text: string, isPublic: boolean}>} entries - The category's
 *   published changelog entries, in changelog order.
 * @return {string[]} The text of each declared-public entry with no bullet.
 */
function findDroppedPublic(lines, entries) {
  const entryWords = entries.map((e) => words(e.text));
  const kept = new Set();
  for (const bullet of splitEntries(lines)) {
    const b = words(bullet);
    let best = 0;
    const scores = entryWords.map((e) => {
      let shared = 0;
      for (const w of e) if (b.has(w)) shared += 1;
      const score = e.size + b.size ? (2 * shared) / (e.size + b.size) : 0;
      best = Math.max(best, score);
      return score;
    });
    if (best > 0) scores.forEach((score, i) => { if (score === best) kept.add(i); });
  }
  return entries.filter((e, i) => e.isPublic && !kept.has(i)).map((e) => e.text);
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
 * @param {string} [options.date] - The release date. When given, the curated
 *   heading must carry it.
 * @param {{lines: string[], complete: boolean, text: string, publicCounts: Object<string, number>, entries: Object<string, Array<{text: string, isPublic: boolean}>>}} [options.declared] - From
 *   the release's structured entries: the upgrade notes they declare, whether
 *   every entry declares its upgrade effects, the published entries' text, and
 *   how many entries per category are declared public, and each category's
 *   published entries. Declared notes are written as given. When they are
 *   complete, the curated section may not add an upgrade item of its own.
 *   Otherwise its items follow the declared ones.
 *   The published entries' text, not the release body, is then what the
 *   curated section is checked against, so nothing from an internal entry can
 *   come back. A category may not have fewer entries than are declared public,
 *   and each entry declared public must keep its own bullet.
 * @param {string} [options.sourceHash] - The hash recorded on the source line.
 *   Defaults to the hash of the release body.
 * @return {string} The section, ending in one newline.
 * @throws {Error} If the curated text is malformed, names a different version
 *   or date, points into private systems, uses markup beyond formatting,
 *   contains identifiers, versions, links, or code the source lacks, drops
 *   an entry declared public, or adds an upgrade item to a complete list.
 */
function assembleSection({ curated, tag, version, project, sourceBody, appVersion, date, declared, sourceHash }) {
  const parsed = parseCurated(curated);
  if (parsed.version !== version) {
    throw new Error(`Curated section heading (v${parsed.version}) does not match the requested tag (${tag}).`);
  }
  if (date && parsed.date !== date) {
    throw new Error(`Curated section heading has the date ${parsed.date}; the release date is ${date}.`);
  }

  // The curated upgrade items are not published when the entries declare all
  // of them, so they are not checked either.
  const curatedUpgrade = declared && declared.complete ? [] : parsed.upgrade;
  const checked = [
    parsed.summary,
    '',
    ...curatedUpgrade,
    '',
    ...parsed.categories.flatMap((category) => [...category.lines, '']),
  ].join('\n');
  const describe = (findings) => findings.map((f) => `${f.kind} "${f.match}"`).join('; ');
  const leaks = findLeaks(checked);
  if (leaks.length) throw new Error(`Curated section points into private systems: ${describe(leaks)}.`);
  const markup = findMarkup(checked);
  if (markup.length) throw new Error(`Curated section uses markup that release notes do not allow: ${describe(markup)}.`);
  const invented = findUnsupported(checked, declared ? declared.text : sourceBody, version);
  if (invented.length) {
    throw new Error(`Curated section contains identifiers, versions, links, or code that are not in the ${declared ? 'published changelog entries' : 'release body'}: ${invented.join(', ')}.`);
  }
  if (declared) {
    for (const [title, required] of Object.entries(declared.publicCounts || {})) {
      const category = parsed.categories.find((c) => c.title === title);
      const found = category ? countEntries(category.lines) : 0;
      if (found < required) {
        throw new Error(`"=== ${title}" has ${found} entries, but ${required} changelog entries of that kind are declared public. Curation may not drop or merge them.`);
      }
    }
    for (const [title, entries] of Object.entries(declared.entries || {})) {
      const category = parsed.categories.find((c) => c.title === title);
      const dropped = findDroppedPublic(category ? category.lines : [], entries);
      if (dropped.length) {
        throw new Error(`"=== ${title}" has no entry for ${dropped.map((t) => JSON.stringify(t.split('\n')[0])).join(', ')}, which ${dropped.length === 1 ? 'is' : 'are'} declared public. Curation may not drop or merge it.`);
      }
    }
    if (declared.complete) {
      const known = new Set(declared.lines.map(sameItem));
      const extra = parsed.upgrade.filter((line) => !known.has(sameItem(line)));
      if (extra.length) {
        throw new Error(`The changelog entries declare every upgrade note, so the curated section may not add any: ${extra.map((l) => JSON.stringify(l)).join(', ')}. Report a missing note instead.`);
      }
    }
  }

  let upgrade = parsed.upgrade;
  let mode = 'curated';
  if (declared) {
    mode = declared.complete ? 'declared' : 'partial';
    const known = new Set(declared.lines.map(sameItem));
    upgrade = [...declared.lines, ...curatedUpgrade.filter((line) => !known.has(sameItem(line)))];
  }

  const id = sectionId(version);
  const lines = [
    `[#${id}]`,
    `== v${version} (${parsed.date})`,
    `// release-notes-source: ${tag} sha256=${sourceHash || hashBody(sourceBody)} upgrade-notes=${mode}`,
    '',
    parsed.summary,
    '',
  ];
  if (upgrade.length) {
    lines.push(`.${UPGRADE_TITLE}`, '[IMPORTANT]', '====', ...upgrade, '====', '');
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
  hashSource,
  sectionId,
  parseCurated,
  findLeaks,
  findMarkup,
  findUnsupported,
  countEntries,
  splitEntries,
  findDroppedPublic,
  assembleSection,
};

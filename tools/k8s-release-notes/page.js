// Read and update a release-notes page: find its version sections, put a
// section in (or replace one whose source changed), and rebuild the summary
// table at the top from the sections, so the table is never edited by hand.

const { compareVersions } = require('../redpanda-release-notes/generate-release-notes');
const { UPGRADE_TITLE, sectionId } = require('./section');

const SUMMARY_START = '// release-summary:start';
const SUMMARY_END = '// release-summary:end';
const VERSION_HEADING_RE = /^==\s+v(\d+\.\d+\.\d+)\s+\((\d{4}-\d{2}-\d{2})\)\s*$/;
const SOURCE_RE = /^\/\/ release-notes-source: (\S+) sha256=([0-9a-f]{64})(?: upgrade-notes=\w+)?\s*$/;
const ANCHOR_RE = /^\[#[\w-]+\]\s*$/;

// Pages are read and written with LF line endings.

/**
 * Splits a page into the text before its version sections, the sections, and
 * the text after them. A section runs from its anchor line (or its heading,
 * when it has no anchor) to the next section or the next top-level heading.
 *
 * @param {string} pageContent - The page content.
 * @return {{head: string[], sections: Array<{version: string, date: string, lines: string[]}>, tail: string[]}}
 */
function splitPage(pageContent) {
  const lines = String(pageContent).replace(/\r\n?/g, '\n').split('\n');
  const starts = [];
  lines.forEach((line, i) => {
    const m = line.match(VERSION_HEADING_RE);
    if (!m) return;
    const anchored = i > 0 && ANCHOR_RE.test(lines[i - 1]);
    starts.push({ index: anchored ? i - 1 : i, heading: i, version: m[1], date: m[2] });
  });
  if (!starts.length) {
    // With no sections yet, new ones go before the first top-level heading
    // after the summary table, else at the end.
    const from = Math.max(lines.indexOf(SUMMARY_END), 0);
    let cut = lines.findIndex((l, i) => i > from && /^==\s/.test(l));
    if (cut === -1) cut = lines.length;
    // An anchor line belongs to the heading under it.
    else if (cut > 0 && ANCHOR_RE.test(lines[cut - 1])) cut -= 1;
    return { head: lines.slice(0, cut), sections: [], tail: lines.slice(cut) };
  }
  let end = lines.length;
  for (let i = starts[starts.length - 1].heading + 1; i < lines.length; i++) {
    if (/^==\s/.test(lines[i])) { end = ANCHOR_RE.test(lines[i - 1]) ? i - 1 : i; break; }
  }
  const sections = starts.map((s, n) => {
    const stop = n + 1 < starts.length ? starts[n + 1].index : end;
    const body = lines.slice(s.index, stop);
    while (body.length && !body[body.length - 1].trim()) body.pop();
    return { version: s.version, date: s.date, lines: body };
  });
  return { head: lines.slice(0, starts[0].index), sections, tail: lines.slice(end) };
}

/**
 * Reads the source hash a section recorded.
 *
 * @param {{lines: string[]}} section - A section from splitPage.
 * @return {string|null} The SHA-256 hex digest, or null if the section has no source line.
 */
function sectionSourceHash(section) {
  for (const line of section.lines) {
    const m = line.match(SOURCE_RE);
    if (m) return m[2];
  }
  return null;
}

/**
 * Builds the summary table from the sections.
 *
 * @param {Array<{version: string, date: string, lines: string[]}>} sections - Sections, newest first.
 * @return {string[]} The table lines, including the start and end markers.
 */
function renderSummary(sections) {
  const out = [SUMMARY_START];
  if (sections.length) {
    // Three columns, with the date under the version, so the table fits a phone.
    out.push('[cols="2,7,2"]', '|===', '|Version |Highlights |Upgrade notes', '');
    for (const s of sections) {
      const id = sectionId(s.version);
      // The summary is the first paragraph after the heading and source line.
      const body = s.lines.slice(s.lines.findIndex((l) => VERSION_HEADING_RE.test(l)) + 1);
      const first = body.findIndex((l) => l.trim() && !/^\/\//.test(l));
      const summary = [];
      // A section with no summary paragraph gets an empty cell, not its first
      // heading or block.
      const isParagraph = first !== -1 && !/^(=+\s|[*.[|]|-{4,}|={4,})/.test(body[first]);
      for (let i = first; isParagraph && i < body.length && body[i].trim(); i++) summary.push(body[i].trim());
      const hasUpgrade = s.lines.includes(`.${UPGRADE_TITLE}`);
      out.push(
        `|<<${id},v${s.version}>> +`,
        s.date,
        `|${summary.join(' ').replace(/\|/g, '\\|')}`,
        `|${hasUpgrade ? `<<${id},Yes>>` : 'No'}`,
        '',
      );
    }
    out.push('|===');
  }
  out.push(SUMMARY_END);
  return out;
}

/**
 * Puts a section into the page and rebuilds the summary table.
 *
 * @param {string} pageContent - The current page content. It must contain the
 *   summary markers; the page shell carries them.
 * @param {string} sectionText - The assembled section.
 * @param {string} sourceHash - The SHA-256 of the body the section came from.
 * @return {{status: 'ok'|'skipped', action?: 'inserted'|'replaced', reason?: string, content?: string}}
 *   `skipped` when the page already holds this version from the same body.
 * @throws {Error} If the page has no summary markers or the section has no version heading.
 */
function updatePage(pageContent, sectionText, sourceHash) {
  const sectionLines = String(sectionText).replace(/\n+$/, '').split('\n');
  const heading = sectionLines.map((l) => l.match(VERSION_HEADING_RE)).find(Boolean);
  if (!heading) throw new Error('The section has no "== vX.Y.Z (YYYY-MM-DD)" heading.');
  const incoming = { version: heading[1], date: heading[2], lines: sectionLines };

  const { head, sections, tail } = splitPage(pageContent);
  const startIdx = head.indexOf(SUMMARY_START);
  const endIdx = head.indexOf(SUMMARY_END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw new Error(`The page needs a "${SUMMARY_START}" line followed by a "${SUMMARY_END}" line.`);
  }

  let action = 'inserted';
  const existing = sections.findIndex((s) => s.version === incoming.version);
  if (existing !== -1) {
    if (sectionSourceHash(sections[existing]) === sourceHash) {
      return { status: 'skipped', reason: `the page already has v${incoming.version} from this release body` };
    }
    sections[existing] = incoming;
    action = 'replaced';
  } else {
    sections.push(incoming);
  }
  sections.sort((a, b) => compareVersions(b.version, a.version));

  const newHead = [...head.slice(0, startIdx), ...renderSummary(sections), ...head.slice(endIdx + 1)];
  while (newHead.length && !newHead[newHead.length - 1].trim()) newHead.pop();
  const newTail = tail.slice();
  while (newTail.length && !newTail[0].trim()) newTail.shift();
  while (newTail.length && !newTail[newTail.length - 1].trim()) newTail.pop();

  const parts = [newHead.join('\n'), ...sections.map((s) => s.lines.join('\n'))];
  if (newTail.length) parts.push(newTail.join('\n'));
  return { status: 'ok', action, content: `${parts.join('\n\n')}\n` };
}

module.exports = {
  SUMMARY_START,
  SUMMARY_END,
  splitPage,
  sectionSourceHash,
  renderSummary,
  updatePage,
};

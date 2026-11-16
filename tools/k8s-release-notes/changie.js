// Turn a changie release body (the operator repository's per-version changelog,
// which is also its GitHub Release body) into a candidate AsciiDoc section.
//
// This is the deterministic half. It parses the kinds and entries, converts
// Markdown to AsciiDoc, removes references that only resolve inside the private
// source repository, and unwraps hard-wrapped paragraphs. It makes no editorial
// change: shortening an entry and writing the summary are the curation step's
// job. The candidate it renders is that step's input.

// changie kind -> the heading readers see, in page order.
const CATEGORIES = [
  ['Added', 'New features'],
  ['Changed', 'Improvements'],
  ['Fixed', 'Bug fixes'],
  ['Deprecated', 'Deprecations'],
  ['Removed', 'Removed'],
];
const CATEGORY_TITLES = CATEGORIES.map(([, title]) => title);

// Prefixes that look like a ticket key (`ABC-123`) but name a public standard
// or advisory, so they stay.
const PUBLIC_KEY_PREFIXES = new Set([
  'CVE', 'GHSA', 'KIP', 'RFC', 'ISO', 'UTF', 'SHA', 'TLS', 'AES', 'RSA', 'MD', 'IEEE', 'PKCS', 'FIPS', 'HTTP',
]);
const TICKET_KEY_RE = /\b([A-Z][A-Z0-9]{1,9})-\d+\b/g;
const ISSUE_REF_RE = /(?:[\w.-]+\/)?[\w.-]*#\d+\b/g;
const PRIVATE_URL_RE = /https?:\/\/github\.com\/redpanda-data\/[^\s)\]>]*/g;

/**
 * Applies a transform to the parts of a line that are outside `code spans`.
 *
 * @param {string} text - One line or paragraph of text.
 * @param {function(string): string} fn - Transform for the non-code parts.
 * @return {string} The text with code spans untouched.
 */
function outsideCode(text, fn) {
  return String(text).split(/(`[^`]*`)/).map((part, i) => (i % 2 ? part : fn(part))).join('');
}

/**
 * Removes references that a reader cannot follow: links into the redpanda-data
 * GitHub organization, issue and pull request numbers, and ticket keys. A
 * removed reference that sat alone in parentheses takes the parentheses with
 * it. Text inside code spans is left alone.
 *
 * @param {string} text - Markdown or AsciiDoc prose.
 * @return {string} The prose with private references removed.
 */
function stripPrivateReferences(text) {
  return outsideCode(text, (part) => {
    let out = part
      // A Markdown link into the organization keeps its text, unless the text
      // is only another reference.
      .replace(/\[([^\]]*)\]\((https?:\/\/github\.com\/redpanda-data\/[^)]*)\)/g, '$1')
      .replace(PRIVATE_URL_RE, '')
      .replace(ISSUE_REF_RE, '')
      .replace(TICKET_KEY_RE, (match, prefix) => (PUBLIC_KEY_PREFIXES.has(prefix) ? match : ''));
    // Tidy what the removals leave behind.
    out = out
      .replace(/\(\s*[,;]?\s*\)/g, '')
      .replace(/\[\s*\]/g, '')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\s+([,.;:)])/g, '$1')
      .replace(/\(\s+/g, '(');
    return out;
  });
}

/**
 * Converts the inline Markdown that changelog entries use to AsciiDoc.
 *
 * @param {string} text - Markdown prose.
 * @return {string} AsciiDoc prose.
 */
function markdownInlineToAsciiDoc(text) {
  const converted = outsideCode(text, (part) => part
    .replace(/\*\*([^*]+)\*\*/g, '*$1*')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$2[$1]'));
  // `{name}` is an attribute reference in AsciiDoc, in monospace too.
  return converted.replace(/\{(?=[\w-]+\})/g, '\\{');
}

/**
 * Joins the hard-wrapped lines of one paragraph. A line that starts a list item
 * starts a new line; everything else continues the line before it.
 *
 * @param {string[]} lines - The lines of one paragraph (no blank lines).
 * @return {string[]} The paragraph as logical lines.
 */
function unwrap(lines) {
  const out = [];
  for (const raw of lines) {
    const line = raw.trim();
    const item = line.match(/^(?:[-*]|\d+\.)\s+(.*)$/);
    if (item) out.push(`** ${item[1]}`);
    else if (out.length) out[out.length - 1] += ` ${line}`;
    else out.push(line);
  }
  return out;
}

/**
 * Parses a changie release body.
 *
 * @param {string} body - The release body: `### Kind` headings, each followed by
 *   `* ` entries. An entry's first line is its lead; any paragraphs after it,
 *   up to the next entry, are its details.
 * @return {{sections: Array<{title: string, entries: Array<{lead: string, details: string[][]}>}>, unknownKinds: string[]}}
 *   Sections in page order, with empty kinds omitted. `details` is a list of
 *   paragraphs, each a list of logical lines.
 */
function parseChangieBody(body) {
  const byKind = new Map();
  const unknownKinds = [];
  let entries = null;
  let entry = null;
  let paragraph = null;
  let inFence = false;

  const closeParagraph = () => {
    if (entry && paragraph && paragraph.lines.length) {
      entry.details.push(paragraph.code ? paragraph.lines : unwrap(paragraph.lines));
    }
    paragraph = null;
  };

  for (const raw of String(body || '').replace(/\r\n?/g, '\n').split('\n')) {
    if (inFence) {
      if (/^\s*```/.test(raw)) { paragraph.lines.push('----'); inFence = false; closeParagraph(); } else paragraph.lines.push(raw.replace(/^ {0,4}/, ''));
      continue;
    }
    const heading = raw.match(/^#{2,3}\s+(.+?)\s*$/);
    if (heading) {
      closeParagraph();
      entry = null;
      // A `## [vX](...) - date` version header is not a kind.
      if (/^\[?v?\d/.test(heading[1])) { entries = null; continue; }
      const known = CATEGORIES.find(([kind]) => kind.toLowerCase() === heading[1].toLowerCase());
      if (!known) { unknownKinds.push(heading[1]); entries = null; continue; }
      if (!byKind.has(known[0])) byKind.set(known[0], []);
      entries = byKind.get(known[0]);
      continue;
    }
    if (!entries) continue;
    const bullet = raw.match(/^\*\s+(.*)$/);
    if (bullet) {
      closeParagraph();
      entry = { lead: bullet[1].trim(), details: [] };
      entries.push(entry);
      continue;
    }
    if (!entry) continue;
    const fence = raw.match(/^\s*```\s*(\w*)\s*$/);
    if (fence) {
      closeParagraph();
      paragraph = { code: true, lines: [fence[1] ? `[,${fence[1]}]` : '[,bash]', '----'] };
      inFence = true;
      continue;
    }
    if (/^\s*$/.test(raw)) { closeParagraph(); entry.sawBlank = true; continue; }
    if (!paragraph) {
      // A line directly under the lead, with no blank line, continues the lead.
      if (!entry.details.length && !entry.sawBlank) { entry.lead += ` ${raw.trim()}`; continue; }
      paragraph = { code: false, lines: [] };
    }
    paragraph.lines.push(raw);
  }
  closeParagraph();

  const clean = (text) => markdownInlineToAsciiDoc(stripPrivateReferences(text)).trim();
  const sections = [];
  for (const [kind, title] of CATEGORIES) {
    const list = byKind.get(kind);
    if (!list || !list.length) continue;
    sections.push({
      title,
      entries: list.map((e) => ({
        lead: clean(e.lead),
        details: e.details.map((para) => (para[1] === '----' ? para : para.map(clean).filter(Boolean))).filter((para) => para.length),
      })),
    });
  }
  return { sections, unknownKinds };
}

/**
 * Renders the candidate section the curation step edits: the release heading,
 * then each category with every entry and its full details.
 *
 * @param {Object} options
 * @param {string} options.version - The bare `X.Y.Z` version.
 * @param {string} options.date - The release date as `YYYY-MM-DD`.
 * @param {Array} options.sections - Sections from parseChangieBody.
 * @return {string} The candidate section, ending in one newline.
 */
function renderCandidate({ version, date, sections }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) {
    throw new Error(`Invalid date: ${JSON.stringify(date)}. Expected YYYY-MM-DD.`);
  }
  if (!sections.length) throw new Error('The release body has no changelog entries.');
  const lines = [`== v${version} (${date})`, ''];
  for (const section of sections) {
    lines.push(`=== ${section.title}`, '');
    for (const entry of section.entries) {
      lines.push(`* ${entry.lead}`);
      if (entry.details.length) {
        lines.push('+', '--');
        entry.details.forEach((para, i) => {
          if (i) lines.push('');
          lines.push(...para);
        });
        lines.push('--');
      }
    }
    lines.push('');
  }
  while (lines[lines.length - 1] === '') lines.pop();
  return `${lines.join('\n')}\n`;
}

module.exports = {
  CATEGORIES,
  CATEGORY_TITLES,
  PUBLIC_KEY_PREFIXES,
  TICKET_KEY_RE,
  outsideCode,
  stripPrivateReferences,
  markdownInlineToAsciiDoc,
  parseChangieBody,
  renderCandidate,
};

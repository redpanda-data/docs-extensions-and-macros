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

// Prefixes that look like a ticket key (`ABC-123`) but name a public standard,
// protocol, or advisory, so they stay.
const PUBLIC_KEY_PREFIXES = new Set([
  'CVE', 'GHSA', 'KIP', 'KEP', 'RFC', 'ISO', 'IEEE', 'FIPS', 'PKCS', 'UTF', 'SHA', 'MD', 'AES', 'RSA', 'ECDSA', 'ECDH',
  'HMAC', 'ED', 'TLS', 'SSL', 'DNS', 'HTTP', 'TCP', 'UDP', 'OAUTH', 'SCRAM', 'ARM', 'AMD', 'X',
]);
const TICKET_KEY_RE = /\b([A-Z][A-Z0-9]{1,9})-\d+\b/g;

// A link a reader outside the company cannot open: the redpanda-data GitHub
// organization in any of its URL forms, and the issue tracker, chat, CI, and
// shared-document hosts. The public `redpanda` and `console` repositories are
// the exception. The scheme is optional, because a bare host is still a link,
// and hosts match in any case.
const PUBLIC_REPO = String.raw`(?:redpanda|console)(?=[/#?)\]>\s` + '`' + String.raw`]|$)`;
const PRIVATE_LINK = String.raw`(?:https?:\/\/|git@)?(?:(?:[\w-]+\.)?github(?:usercontent)?\.com[/:](?:repos\/)?redpanda-data\/(?!` + PUBLIC_REPO + String.raw`)|[\w-]+\.atlassian\.net\b|[\w-]+\.slack\.com\b|buildkite\.com\b|(?:[\w-]+\.)?notion\.(?:so|site)\b|(?:docs|drive)\.google\.com\b|linear\.app\b)[^\s)\]>` + '`' + String.raw`]*`;
const PRIVATE_LINK_RE = new RegExp(PRIVATE_LINK, 'gi');

// An issue or pull request reference: a bare `#123`, a repository reference
// such as `repo#123` or `org/repo#123` (repository names are lower case, which
// keeps `PKCS#12` and `C#7`), or the words "PR 123" and "issue 123".
const ISSUE_REF_STRICT_RE = new RegExp(String.raw`(?<![\w#/.-])#\d+\b|(?<![\w/.-])(?:[a-z0-9][\w.-]*\/)?[a-z][a-z0-9._-]*#\d+\b|\b(?:PRs?|[Pp]ull requests?|[Ii]ssues?)\s+#?\d{2,}\b`, 'g');

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
 * Removes references that a reader cannot follow: private links, issue and
 * pull request references, and ticket keys. A removed reference that sat
 * alone in parentheses takes the parentheses with it. Only the text next to a
 * removal is tidied; the rest of the prose is returned as written. Text
 * inside code spans is left alone, except that a private link is removed
 * there too.
 *
 * @param {string} text - Markdown or AsciiDoc prose.
 * @return {string} The prose with private references removed.
 */
function stripPrivateReferences(text) {
  const GONE = '\u0000';
  const marked = String(text)
    // A Markdown link to a private target keeps its text.
    .replace(new RegExp(String.raw`\[([^\]]*)\]\(\s*` + PRIVATE_LINK + String.raw`\s*\)`, 'gi'), `$1${GONE}`)
    .replace(PRIVATE_LINK_RE, GONE);
  const stripped = outsideCode(marked, (part) => part
    .replace(ISSUE_REF_STRICT_RE, GONE)
    .replace(TICKET_KEY_RE, (match, prefix) => (PUBLIC_KEY_PREFIXES.has(prefix) ? match : GONE)));
  if (!stripped.includes(GONE)) return stripped;
  return stripped
    // The reference was the whole parenthesis or bracket, or a list inside one.
    .replace(/[ \t]*[([][\s,;]*\u0000(?:[\s,;]*(?:and\s+)?\u0000)*[\s,;]*[)\]]/g, '')
    // A dash or colon that only introduced the reference.
    .replace(/[ \t]+(?:-|–|—|:)[ \t]*\u0000(?=\s*(?:[.,;]|$))/gm, '')
    .replace(/[ \t]*\u0000/g, '')
    .replace(/[ \t]+$/gm, '');
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
  let fenceIndent = '';

  const closeParagraph = () => {
    if (entry && paragraph && paragraph.lines.length) {
      entry.details.push(paragraph.code ? paragraph.lines : unwrap(paragraph.lines));
    }
    paragraph = null;
  };

  for (const raw of String(body || '').replace(/\r\n?/g, '\n').split('\n')) {
    if (inFence) {
      if (/^\s*```\s*$/.test(raw)) { paragraph.lines.push('----'); inFence = false; closeParagraph(); } else paragraph.lines.push(raw.startsWith(fenceIndent) ? raw.slice(fenceIndent.length) : raw.trimStart());
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
    const fence = raw.match(/^(\s*)```\s*([\w+-]*).*$/);
    if (fence) {
      closeParagraph();
      fenceIndent = fence[1];
      paragraph = { code: true, lines: [fence[2] ? `[,${fence[2]}]` : '[,bash]', '----'] };
      inFence = true;
      continue;
    }
    if (/^\s*$/.test(raw)) { closeParagraph(); entry.sawBlank = true; continue; }
    if (!paragraph) {
      // A line directly under the lead, with no blank line, continues the
      // lead, unless it starts a list.
      const startsList = /^\s*(?:[-*]|\d+\.)\s+\S/.test(raw);
      if (!entry.details.length && !entry.sawBlank && !startsList) { entry.lead += ` ${raw.trim()}`; continue; }
      paragraph = { code: false, lines: [] };
    }
    paragraph.lines.push(raw);
  }
  closeParagraph();

  const clean = (text) => markdownInlineToAsciiDoc(stripPrivateReferences(text)).trim();
  // unwrap() prefixes list items with "** ". Clean only the item text so the marker is not read as bold.
  const cleanLine = (line) => {
    if (!line.startsWith('** ')) return clean(line);
    const text = clean(line.slice(3));
    return text ? `** ${text}` : '';
  };
  const sections = [];
  for (const [kind, title] of CATEGORIES) {
    const list = byKind.get(kind);
    if (!list || !list.length) continue;
    sections.push({
      title,
      entries: list.map((e) => ({
        lead: clean(e.lead),
        details: e.details.map((para) => (para[1] === '----' ? para : para.map(cleanLine).filter(Boolean))).filter((para) => para.length),
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
 * @param {{lines: string[], complete: boolean, declaredPublic: Object<string, boolean[]>}} [options.upgrade] - When
 *   the release has structured entries: the upgrade notes the entries
 *   declare, whether every entry declares its upgrade effects (`complete`),
 *   and, per category title, which entries their engineers declared public.
 *   Those entries get a `// declared-public` line above them, so the curation
 *   step knows it may not drop or merge them.
 * @return {string} The candidate section, ending in one newline.
 */
function renderCandidate({ version, date, sections, upgrade }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) {
    throw new Error(`Invalid date: ${JSON.stringify(date)}. Expected YYYY-MM-DD.`);
  }
  if (!sections.length) throw new Error('The release body has no changelog entries.');
  const lines = [`== v${version} (${date})`, ''];
  if (upgrade) {
    // Tells the curation step who owns the upgrade notes. `declared`: the
    // list below is complete, add nothing. `partial`: some entries predate
    // the declared fields, so their upgrade effects may still be added.
    lines.push(`// upgrade-notes: ${upgrade.complete ? 'declared' : 'partial'}`, '');
    if (upgrade.lines.length) lines.push('=== Before you upgrade', '', ...upgrade.lines, '');
  }
  for (const section of sections) {
    lines.push(`=== ${section.title}`, '');
    const marks = (upgrade && upgrade.declaredPublic && upgrade.declaredPublic[section.title]) || [];
    section.entries.forEach((entry, i) => {
      if (marks[i]) lines.push('// declared-public');
      lines.push(`* ${entry.lead}`);
      if (entry.details.length) {
        lines.push('+', '--');
        entry.details.forEach((para, n) => {
          if (n) lines.push('');
          lines.push(...para);
        });
        lines.push('--');
      }
    });
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
  PRIVATE_LINK_RE,
  ISSUE_REF_STRICT_RE,
  outsideCode,
  stripPrivateReferences,
  markdownInlineToAsciiDoc,
  parseChangieBody,
  renderCandidate,
};

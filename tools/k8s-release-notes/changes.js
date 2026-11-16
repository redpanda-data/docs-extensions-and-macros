// Read a release's changelog entries as data.
//
// The operator repository attaches `changes.json` to each release: the
// release's changelog fragments, with the fields its engineers declare on
// each entry. With it, two things stop being a judgment:
//
// - `audience: "internal"` entries are left out of the release notes.
// - "Before you upgrade" is the entries' own `upgrade.note` and
//   `upgrade.action` text, not something read back out of prose.
//
// An entry written before those fields existed has `audience: null` and
// `upgrade: null`. A release with any such entry is only partly declared, and
// the curation step may still add upgrade notes for those entries.

const { CATEGORIES, markdownInlineToAsciiDoc } = require('./changie');
const { findLeaks, findMarkup } = require('./section');

const SCHEMA = 1;
const KINDS = CATEGORIES.map(([kind]) => kind);
const EFFECTS = [
  'restart-brokers',
  'restart-operator',
  'default-changed',
  'field-rejected',
  'field-ignored',
  'permission-required',
  'telemetry-changed',
];

const TITLES = Object.fromEntries(CATEGORIES);

/**
 * Parses and validates a `changes.json` document.
 *
 * @param {string} text - The JSON text.
 * @param {string} tag - The release tag the document must be for.
 * @return {{tag: string, entries: Array<{kind: string, body: string, audience: string|null, upgrade: {effects: string[], note: string|null, action: string|null}|null}>}}
 * @throws {Error} If the document is not valid JSON, has another schema
 *   version, is for another tag, or has a malformed entry.
 */
function parseChanges(text, tag) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw new Error(`changes.json is not valid JSON: ${err.message}`);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('changes.json must be an object.');
  if (doc.schema !== SCHEMA) throw new Error(`changes.json has schema ${JSON.stringify(doc.schema)}; this version reads schema ${SCHEMA}.`);
  if (doc.tag !== tag) throw new Error(`changes.json is for ${JSON.stringify(doc.tag)}, not ${tag}.`);
  if (!Array.isArray(doc.entries)) throw new Error('changes.json has no entries list.');

  const entries = doc.entries.map((entry, i) => {
    const where = `changes.json entry ${i + 1}`;
    if (!entry || typeof entry !== 'object') throw new Error(`${where} is not an object.`);
    if (!KINDS.includes(entry.kind)) throw new Error(`${where} has an unknown kind: ${JSON.stringify(entry.kind)}.`);
    if (typeof entry.body !== 'string' || !entry.body.trim()) throw new Error(`${where} has no body.`);
    const audience = entry.audience == null ? null : entry.audience;
    if (audience !== null && audience !== 'public' && audience !== 'internal') {
      throw new Error(`${where} has an unknown audience: ${JSON.stringify(entry.audience)}.`);
    }
    let upgrade = null;
    if (entry.upgrade != null) {
      const { effects, note, action } = entry.upgrade;
      if (!Array.isArray(effects) || effects.some((e) => !EFFECTS.includes(e))) {
        throw new Error(`${where} has unknown upgrade effects: ${JSON.stringify(effects)}.`);
      }
      const text = (value, name) => {
        if (value == null) return null;
        if (typeof value !== 'string') throw new Error(`${where} upgrade.${name} must be a string.`);
        return value.trim() || null;
      };
      upgrade = { effects, note: text(note, 'note'), action: text(action, 'action') };
      if (effects.length && !upgrade.note) throw new Error(`${where} declares upgrade effects with no upgrade note.`);
      if (!effects.length && (upgrade.note || upgrade.action)) {
        throw new Error(`${where} has an upgrade note or action but declares no upgrade effects.`);
      }
    }
    return { kind: entry.kind, body: entry.body, audience, upgrade };
  });
  return { tag: doc.tag, entries };
}

/**
 * Returns the entries that are published: everything except the ones declared
 * internal.
 *
 * @param {{entries: Array}} changes - A parsed document.
 * @return {Array} The published entries, in changelog order.
 */
function publishedEntries(changes) {
  return changes.entries.filter((entry) => entry.audience !== 'internal');
}

/**
 * Reports whether every published entry declares its audience and its upgrade
 * effects. When it does, "Before you upgrade" is complete without curation.
 *
 * @param {{entries: Array}} changes - A parsed document.
 * @return {boolean} True if no published entry predates the declared fields.
 */
function isFullyDeclared(changes) {
  return publishedEntries(changes).every((entry) => entry.audience === 'public' && entry.upgrade !== null);
}

/**
 * Builds the "Before you upgrade" items the engineers declared: each entry's
 * upgrade note, followed by its upgrade action if it has one. These lines are
 * published as written, with no curation step in between, so a note that
 * points into private systems or carries markup is an error, not something to
 * repair quietly.
 *
 * @param {{entries: Array}} changes - A parsed document.
 * @return {string[]} One `* ` line per entry with upgrade effects, in
 *   changelog order.
 * @throws {Error} If a note or action has a private reference, or markup
 *   beyond code spans and emphasis.
 */
function declaredUpgradeNotes(changes) {
  const lines = [];
  for (const entry of publishedEntries(changes)) {
    if (!entry.upgrade || !entry.upgrade.effects.length) continue;
    const parts = [entry.upgrade.note, entry.upgrade.action].filter(Boolean).map((text) => text.replace(/\s+/g, ' ').trim());
    for (const part of parts) {
      const problems = [...findLeaks(part), ...findMarkup(part)];
      if (/https?:\/\//.test(part)) problems.push({ kind: 'link', match: part.match(/https?:\/\/\S+/)[0] });
      if (problems.length) {
        throw new Error(`An upgrade note in changes.json cannot be published as written (${problems.map((f) => `${f.kind} "${f.match}"`).join('; ')}): ${JSON.stringify(part)}. Fix the entry in the source repository.`);
      }
    }
    const line = `* ${parts.map(markdownInlineToAsciiDoc).join(' ')}`;
    if (!lines.includes(line)) lines.push(line);
  }
  return lines;
}

/**
 * Counts, per page category, the entries their engineers declared public.
 * Curation may not drop or merge those.
 *
 * @param {{entries: Array}} changes - A parsed document.
 * @return {Object<string, number>} Category title to count.
 */
function declaredPublicCounts(changes) {
  const counts = {};
  for (const entry of changes.entries) {
    if (entry.audience !== 'public') continue;
    counts[TITLES[entry.kind]] = (counts[TITLES[entry.kind]] || 0) + 1;
  }
  return counts;
}

/**
 * Says, per page category and in changelog order, which published entries
 * their engineers declared public. The candidate marks those entries.
 *
 * @param {{entries: Array}} changes - A parsed document.
 * @return {Object<string, boolean[]>} Category title to one flag per entry.
 */
function declaredPublicFlags(changes) {
  const flags = {};
  for (const entry of publishedEntries(changes)) {
    (flags[TITLES[entry.kind]] = flags[TITLES[entry.kind]] || []).push(entry.audience === 'public');
  }
  return flags;
}

/**
 * Renders the published entries the way the changelog tool renders a release
 * body, so one parser reads both.
 *
 * @param {{entries: Array}} changes - A parsed document.
 * @return {string} Markdown: a `### Kind` heading per kind, then `* ` entries.
 */
function changesToMarkdown(changes) {
  const lines = [];
  for (const kind of KINDS) {
    const entries = publishedEntries(changes).filter((entry) => entry.kind === kind);
    if (!entries.length) continue;
    lines.push(`### ${kind}`);
    for (const entry of entries) {
      const [first, ...rest] = entry.body.replace(/\r\n?/g, '\n').replace(/\s+$/, '').split('\n');
      lines.push(`* ${first}`);
      // Keep continuation lines off column zero, where a `* ` or a `###`
      // would start a new entry or kind.
      for (const line of rest) lines.push(line.trim() ? `  ${line}` : '');
    }
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Returns all the text a curated section may draw identifiers from.
 *
 * @param {{entries: Array}} changes - A parsed document.
 * @return {string} Every published body, upgrade note, and upgrade action.
 */
function changesText(changes) {
  return publishedEntries(changes)
    .flatMap((entry) => [entry.body, entry.upgrade && entry.upgrade.note, entry.upgrade && entry.upgrade.action])
    .filter(Boolean)
    .join('\n');
}

module.exports = {
  SCHEMA,
  EFFECTS,
  parseChanges,
  publishedEntries,
  isFullyDeclared,
  declaredUpgradeNotes,
  declaredPublicCounts,
  declaredPublicFlags,
  changesToMarkdown,
  changesText,
};

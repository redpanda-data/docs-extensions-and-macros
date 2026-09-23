// Parse a Self-Managed rpchangelog release body into a structured, de-noised model.
//
// Input is the raw GitHub Release body a release captain pastes into the
// streaming-enterprise release (the output of `rpchangelog.py rel`): markdown
// with `## Features` / `## Bug Fixes` / `## Improvements` sections, each a list
// of `*` bullets carrying `by @author in [#PR](url)` suffixes and, sometimes,
// a leading `[#issue](url)` reference.
//
// This module does ONLY the deterministic, no-judgment work: split into
// sections, join wrapped bullet lines, strip source noise, unescape backticks,
// de-duplicate backport repeats, and normalize category order/case. It does NOT
// rewrite voice, add `Area::` labels, normalize units, phrase CVEs, or drop
// bodyless entries — those need editorial judgment and belong to the curation
// step that runs on the generated page.

const LOG_TAG = '[release-notes]';

// Canonical page order and headings (fixes last), independent of source order
// (rpchangelog emits Features -> Bug Fixes -> Improvements).
const KIND_FEATURE = 'feature';
const KIND_IMPROVEMENT = 'improvement';
const KIND_FIX = 'fix';

const PAGE_ORDER = [KIND_FEATURE, KIND_IMPROVEMENT, KIND_FIX];
const PAGE_TITLE = {
  [KIND_FEATURE]: 'Features',
  [KIND_IMPROVEMENT]: 'Improvements',
  [KIND_FIX]: 'Bug fixes',
};

/**
 * Maps a source `##` heading to a canonical kind by keyword, mirroring ADP's
 * `sectionKind`. Returns null for a heading that is not one of the three
 * release-note categories (for example rpchangelog's `--show-extra` `None` /
 * `Unclear` sections), so the caller can ignore it.
 *
 * @param {string} heading - The heading text after the `##` marker.
 * @return {string|null} One of the KIND_* constants, or null if unrecognized.
 */
function sectionKind(heading) {
  const h = heading.toLowerCase();
  if (h.includes('feature')) return KIND_FEATURE;
  if (h.includes('improvement')) return KIND_IMPROVEMENT;
  if (h.includes('fix')) return KIND_FIX;
  return null;
}

/**
 * Strips the trailing attribution blocks rpchangelog appends to every bullet:
 * ` by @author` optionally followed by ` in [#PR](url)`, repeated once per PR
 * when a change was aggregated from several PRs (the backport case). Works from
 * the end of the string so it only ever removes trailing attribution, never a
 * legitimate mid-sentence "by".
 *
 * @param {string} text - A single bullet's text.
 * @return {string} The text with trailing attribution removed.
 */
function stripAttribution(text) {
  const trailing = /\s+by\s+@[A-Za-z0-9][A-Za-z0-9._-]*(?:\s+in\s+\[#\d+\]\([^)]*\))?\s*$/i;
  let out = text;
  while (trailing.test(out)) {
    out = out.replace(trailing, '');
  }
  return out;
}

/**
 * Strips a leading `[#issue](url)` reference that rpchangelog prepends when a
 * PR body declared `Fixes: #N`. Only the leading reference is removed; links
 * inside the sentence are left alone.
 *
 * @param {string} text - A single bullet's text.
 * @return {string} The text with a leading issue reference removed.
 */
function stripLeadingIssueRef(text) {
  return text.replace(/^\s*\[#\d+\]\([^)]*\)\s+/, '');
}

/**
 * Cleans one bullet: remove attribution and leading issue ref, unescape
 * backslash-escaped backticks (`\`` -> `` ` ``) that survive from the PR body,
 * and collapse whitespace introduced by joining wrapped lines.
 *
 * @param {string} raw - The joined raw bullet text.
 * @return {string} The cleaned entry text.
 */
function cleanEntry(raw) {
  let text = raw.replace(/\s+/g, ' ').trim();
  text = stripLeadingIssueRef(text);
  text = stripAttribution(text);
  text = text.replace(/\\`/g, '`');
  return text.trim();
}

/**
 * Parses a raw rpchangelog release body into de-noised, de-duplicated entries
 * grouped by canonical category in page order.
 *
 * @param {string} body - The raw GitHub Release body markdown.
 * @return {{sections: Array<{kind: string, title: string, entries: string[]}>}}
 *   Sections in page order (Features, Improvements, Bug fixes); a category with
 *   no entries is omitted.
 */
function parseReleaseBody(body) {
  if (typeof body !== 'string' || body.trim() === '') {
    throw new Error('Release body is empty.');
  }

  // Drop HTML comments up front (rpchangelog strips them from PR bodies, but a
  // pasted body may still carry some).
  const cleaned = body.replace(/<!--[\s\S]*?-->/g, '');

  const buckets = {
    [KIND_FEATURE]: [],
    [KIND_IMPROVEMENT]: [],
    [KIND_FIX]: [],
  };

  let currentKind = null; // kind of the section we are inside, or null to ignore
  let current = null; // the bullet text being accumulated, or null between bullets

  const flush = () => {
    if (current !== null && currentKind && buckets[currentKind]) {
      const entry = cleanEntry(current);
      if (entry) buckets[currentKind].push(entry);
    }
    current = null;
  };

  const lines = cleaned.split(/\r?\n/);
  for (const line of lines) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      flush();
      currentKind = sectionKind(heading[1]);
      continue;
    }

    // The changelog footer ends the release notes; nothing after it is an entry.
    if (/^\s*\*\*(?:Partial|Full)\s+Changelog\*\*/i.test(line)) {
      flush();
      currentKind = null;
      continue;
    }

    if (currentKind === null) continue;

    const bullet = line.match(/^\s*[*-]\s+(.*)$/);
    if (bullet) {
      flush();
      current = bullet[1];
      continue;
    }

    if (line.trim() === '') {
      // Blank line: entries in this format are contiguous, so a blank marks the
      // end of the current bullet rather than a continuation.
      flush();
      continue;
    }

    // A non-blank, non-bullet line continues the current wrapped bullet.
    if (current !== null) {
      current += ' ' + line.trim();
    }
  }
  flush();

  const sections = [];
  for (const kind of PAGE_ORDER) {
    const seen = new Set();
    const entries = [];
    for (const entry of buckets[kind]) {
      // De-duplicate backport repeats: the same change aggregated from several
      // PRs yields identical text once attribution is stripped.
      const key = entry.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push(entry);
    }
    if (entries.length > 0) {
      sections.push({ kind, title: PAGE_TITLE[kind], entries });
    }
  }

  if (sections.length === 0) {
    console.warn(`${LOG_TAG} WARN: no Features/Improvements/Bug fixes entries found in the release body.`);
  }

  return { sections };
}

module.exports = {
  parseReleaseBody,
  // Exported for unit tests and reuse.
  sectionKind,
  stripAttribution,
  stripLeadingIssueRef,
  cleanEntry,
  PAGE_ORDER,
  PAGE_TITLE,
  KIND_FEATURE,
  KIND_IMPROVEMENT,
  KIND_FIX,
};

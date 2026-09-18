'use strict';

// The two prefixes `related_topics` has used since it was free text, and the two
// booleans `see_also` replaced them with. Both spellings stay supported: the
// prefix is what 79 entries in the live overrides file are written as, and the
// booleans are what a JSON schema can actually check.
const CLOUD_PREFIX = 'cloud-only:';
const SELF_MANAGED_PREFIX = 'self-managed-only:';

/**
 * Read the audience an override value is scoped to.
 *
 * One parser for every field that can be narrowed to a single docs build, so
 * `see_also`, `links`, description paragraphs and admonitions cannot drift apart
 * on how the scope is spelled. Strings carry the scope as a leading
 * `cloud-only:` / `self-managed-only:` prefix; objects carry it as a
 * `cloud_only` / `self_managed_only` boolean beside a `content` string
 * (`self_hosted_only` is the deprecated spelling of the same flag).
 *
 * Setting both would wrap the value in `ifdef` and `ifndef` at once, so it would
 * render in neither build. The schema rejects that on objects; on a string it
 * cannot happen, since only one prefix can lead.
 *
 * @param {string|{content: string, cloud_only?: boolean, self_managed_only?: boolean}} item
 * @returns {{content: string, cloudOnly: boolean, selfManagedOnly: boolean}|null} Null when the item carries no usable content.
 */
function parseAudience(item) {
  if (typeof item === 'string') {
    const trimmed = item.trim();
    if (trimmed.startsWith(CLOUD_PREFIX)) {
      return { content: trimmed.slice(CLOUD_PREFIX.length).trim(), cloudOnly: true, selfManagedOnly: false };
    }
    if (trimmed.startsWith(SELF_MANAGED_PREFIX)) {
      return { content: trimmed.slice(SELF_MANAGED_PREFIX.length).trim(), cloudOnly: false, selfManagedOnly: true };
    }
    return { content: trimmed, cloudOnly: false, selfManagedOnly: false };
  }
  if (item && typeof item === 'object' && typeof item.content === 'string') {
    return {
      content: item.content.trim(),
      cloudOnly: item.cloud_only === true,
      // self_hosted_only is the old name for the same flag. The product is
      // called Self-Managed and the string prefix has always been
      // `self-managed-only:`, so one concept was going by two different words
      // depending on whether you wrote it as a prefix or a boolean. Still read,
      // because it is in the published schema, but nothing emits it.
      selfManagedOnly: item.self_managed_only === true || item.self_hosted_only === true,
    };
  }
  return null;
}

/**
 * Wrap AsciiDoc in the conditional for one audience, or return it unchanged when
 * it belongs in every build.
 *
 * The blank lines are not cosmetic. A conditional is resolved by the
 * preprocessor, so one glued to neighbouring prose leaves those lines adjacent
 * and Asciidoctor merges them into a single paragraph. Worse, the merge depends
 * on the branch: a conditional wrapping a delimited block renders correctly with
 * the attribute set and merges its neighbours with it unset, so a self-managed
 * preview can look right while cloud-docs silently loses its paragraph breaks.
 * Nothing errors and no text goes missing, so only a structural assertion on
 * rendered HTML catches it -- see __tests__/tools/property-extractor/conditional-rendering.test.js.
 *
 * Emits the bare `endif::[]` and puts the cloud branch first, matching the
 * convention already used throughout templates/property.hbs.
 *
 * @param {string} content - AsciiDoc to wrap.
 * @param {{cloudOnly: boolean, selfManagedOnly: boolean}} scope - Audience, as returned by parseAudience.
 * @returns {string} The content, wrapped in a blank-line-separated conditional when it is scoped.
 */
function wrapForAudience(content, scope) {
  if (!scope || (!scope.cloudOnly && !scope.selfManagedOnly)) return content;
  const directive = scope.cloudOnly ? 'ifdef::env-cloud[]' : 'ifndef::env-cloud[]';
  return `\n${directive}\n${content}\nendif::[]\n`;
}

/**
 * Build the paired conditional for a value that differs by audience, so each
 * build sees its own form of the same passage.
 *
 * Used where a link cannot survive in one build -- a cross-page xref to a page
 * Cloud does not publish -- and the sentence still has to read correctly there.
 * Cloud branch first, same as wrapForAudience.
 *
 * @param {string} cloudContent - What the Cloud build shows.
 * @param {string} selfManagedContent - What the self-managed build shows.
 * @returns {string} Both branches, blank-line separated.
 */
function wrapBothAudiences(cloudContent, selfManagedContent) {
  if (cloudContent === selfManagedContent) return cloudContent;
  return [
    '',
    'ifdef::env-cloud[]',
    cloudContent,
    'endif::[]',
    'ifndef::env-cloud[]',
    selfManagedContent,
    'endif::[]',
    '',
  ].join('\n');
}

/**
 * Find conditionals that are glued to neighbouring content.
 *
 * The complement to the cross-branch paragraph check in the corpus tests, and
 * the only one of the two that catches the symmetric case. When a conditional in
 * prose has no blank line before it, both builds merge the neighbouring
 * paragraphs, so comparing the two renders sees no difference and reports
 * nothing -- yet both are wrong. Reading the source catches it.
 *
 * Scoped to prose: a conditional whose neighbour is a table row (`|`), a block
 * delimiter, a block attribute line (`[...]`), a list item or another
 * conditional is left alone. Table cells have carried their own conditional
 * shape since long before this, and a delimiter terminates the paragraph on its
 * own.
 *
 * @param {string} text - AsciiDoc to inspect.
 * @returns {Array<{line: number, directive: string, neighbour: string, side: ('before'|'after')}>}
 */
function findGluedConditionals(text) {
  if (typeof text !== 'string' || !text.includes('::')) return [];
  const lines = text.split('\n');
  const offenders = [];
  const selfTerminating = (line) => {
    const t = line.trim();
    if (t === '') return true;
    if (/^if(n?)def::/.test(t) || t === 'endif::[]') return true;
    if (/^(?:-{4,}|={4,}|\.{4,}|\*{4,}|_{4,}|\+{4,}|\/{4,})$/.test(t)) return true;
    if (/^\[.*\]$/.test(t)) return true;          // block attribute, e.g. [NOTE] or [cols="1s,2a"]
    if (/^[|!]/.test(t)) return true;             // table row or cell
    if (/^[*.-]+\s/.test(t) || /^\d+\.\s/.test(t)) return true; // list item
    if (/^\.\S/.test(t)) return true;             // block title, e.g. .Enterprise license required
    return false;
  };
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (/^if(n?)def::/.test(trimmed)) {
      const before = i === 0 ? '' : lines[i - 1];
      if (!selfTerminating(before)) {
        offenders.push({ line: i + 1, directive: trimmed, neighbour: before.trim(), side: 'before' });
      }
    }
    if (trimmed === 'endif::[]') {
      const after = i === lines.length - 1 ? '' : lines[i + 1];
      if (!selfTerminating(after)) {
        offenders.push({ line: i + 1, directive: trimmed, neighbour: after.trim(), side: 'after' });
      }
    }
  });
  return offenders;
}

module.exports = parseAudience;
module.exports.parseAudience = parseAudience;
module.exports.wrapForAudience = wrapForAudience;
module.exports.wrapBothAudiences = wrapBothAudiences;
module.exports.findGluedConditionals = findGluedConditionals;
module.exports.CLOUD_PREFIX = CLOUD_PREFIX;
module.exports.SELF_MANAGED_PREFIX = SELF_MANAGED_PREFIX;

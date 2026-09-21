'use strict';

const { parseAudience, wrapBothAudiences, findGluedConditionals } = require('./audienceScope.js');
const canonicalizePropertyXrefs = require('./canonicalizePropertyXrefs.js');

// A line that opens or closes a delimited block. Duplicating a paragraph that
// sits inside one would put a conditional between the delimiters and split the
// block across two branches, so the link is refused there instead.
const DELIMITER_RX = /^(?:-{4,}|={4,}|\.{4,}|\*{4,}|_{4,}|\+{4,}|\/{4,})\s*$/;

// Separates paragraphs: a newline, optional whitespace, another newline.
const PARAGRAPH_BREAK_RX = /\n[ \t]*\n/g;

/**
 * Resolve a property's `links` map into one spec per entry.
 *
 * The map key is the literal text to find in the prose; the value is the target,
 * optionally audience-scoped with the same `cloud-only:` / `self-managed-only:`
 * prefix `see_also` uses. Two target forms:
 *
 *   "#<property_name>"  a property. Emitted as a prop macro, which resolves the
 *                       reference page itself and degrades to plain code in a
 *                       build that does not publish the target -- so a property
 *                       link needs no conditional and cannot dangle.
 *   "xref:<target>"     anything else. Emitted as a literal xref with the key as
 *                       its link text.
 *
 * @param {string} propName - Property that owns the links, for messages.
 * @param {Object<string, string>} links - The `links` override map.
 * @param {Object<string, Object>} properties - Full property map, to validate `#` targets.
 * @returns {{specs: Array<Object>, warnings: Array<string>}}
 */
function resolveLinkSpecs(propName, links, properties) {
  const specs = [];
  const warnings = [];
  if (!links || typeof links !== 'object' || Array.isArray(links)) return { specs, warnings };

  for (const [key, rawValue] of Object.entries(links)) {
    if (typeof key !== 'string' || !key.trim()) {
      warnings.push(`${propName}: links contains an empty key; skipped.`);
      continue;
    }
    if (typeof rawValue !== 'string' || !rawValue.trim()) {
      warnings.push(`${propName}: links["${key}"] has no target; skipped.`);
      continue;
    }

    const scope = parseAudience(rawValue);
    const target = scope.content;
    // The key is the text as it appears in the prose, backticks included. The
    // prop macro wraps the name in its own code element, so its text= takes the
    // bare words; an xref keeps the backticks inside the brackets, matching how
    // see_also entries are written.
    const display = key.trim().replace(/^`+|`+$/g, '');

    if (target.startsWith('#')) {
      const name = target.slice(1).trim();
      if (!properties[name]) {
        // Never emit a prop macro for a name the macro cannot verify: it would
        // publish as literal macro text on the page.
        warnings.push(`${propName}: links["${key}"] targets #${name}, which is not a known property; left as plain text.`);
        continue;
      }
      specs.push({ key: key.trim(), display, scope, kind: 'property', targetName: name });
      continue;
    }

    if (target.startsWith('xref:')) {
      specs.push({ key: key.trim(), display: key.trim(), scope, kind: 'xref', target });
      continue;
    }

    if (target === 'glossterm' || target.startsWith('glossterm:')) {
      // The macro takes the term as its target and looks the definition up in
      // the glossary, so the displayed text is the term. Bare `glossterm` means
      // the key is the term; `glossterm:<Term>` is for prose that says
      // something other than the term's own name.
      const term = target === 'glossterm' ? display : target.slice('glossterm:'.length).trim();
      if (!term) {
        warnings.push(`${propName}: links["${key}"] has a glossterm target with no term; skipped.`);
        continue;
      }
      specs.push({ key: key.trim(), display, scope, kind: 'glossterm', term });
      continue;
    }

    warnings.push(
      `${propName}: links["${key}"] target "${target}" is not "#<property_name>", "xref:..." or "glossterm"; skipped.`
    );
  }

  // Longest key first, so a key that is a substring of another cannot steal its
  // match -- `cloud_storage_enabled` must win over `cloud_storage`.
  specs.sort((a, b) => b.key.length - a.key.length);
  return { specs, warnings };
}

/**
 * Render one link spec as AsciiDoc.
 *
 * @param {Object} spec - A spec from resolveLinkSpecs.
 * @returns {string}
 */
function renderLink(spec) {
  if (spec.kind === 'property') {
    const attrs = ['link=true'];
    if (spec.display && spec.display !== spec.targetName) {
      // A comma would end the attribute early and the rest would become stray
      // positional attributes on the macro.
      attrs.push(spec.display.includes(',') ? `text="${spec.display}"` : `text=${spec.display}`);
    }
    return `prop:${spec.targetName}[${attrs.join(',')}]`;
  }
  if (spec.kind === 'glossterm') {
    // Empty payload: the definition comes from the glossary, not from here.
    return `glossterm:${spec.term}[]`;
  }
  return canonicalizePropertyXrefs(`xref:${spec.target.slice('xref:'.length)}[${spec.display}]`).text;
}

/**
 * Whether an offset sits inside a delimited block.
 *
 * @param {string} text
 * @param {number} index
 * @returns {boolean}
 */
function insideDelimitedBlock(text, index) {
  let open = 0;
  for (const line of text.slice(0, index).split('\n')) {
    if (DELIMITER_RX.test(line)) open += 1;
  }
  return open % 2 === 1;
}

/**
 * Paragraph boundaries around an offset.
 *
 * @param {string} text
 * @param {number} index
 * @returns {{start: number, end: number}}
 */
function paragraphBounds(text, index) {
  let start = 0;
  let end = text.length;
  PARAGRAPH_BREAK_RX.lastIndex = 0;
  let match;
  while ((match = PARAGRAPH_BREAK_RX.exec(text)) !== null) {
    if (match.index + match[0].length <= index) {
      start = match.index + match[0].length;
    } else {
      end = match.index;
      break;
    }
  }
  return { start, end };
}

/**
 * Substitute a property's links into one text surface.
 *
 * Only the first occurrence of a key is linked, so a property named four times
 * in one description links once rather than turning the paragraph into a wall of
 * links.
 *
 * An audience-scoped link cannot be wrapped around the link alone: AsciiDoc
 * preprocessor directives must start a line, so they cannot bracket an inline
 * span. The containing paragraph is therefore emitted twice, linked in the
 * branch the scope names and plain in the other -- the same shape
 * topic-property.hbs already uses for the corresponding-cluster-property row.
 *
 * @param {string} text - AsciiDoc to rewrite.
 * @param {Array<Object>} specs - Specs from resolveLinkSpecs.
 * @param {string} propName - For messages.
 * @param {string} surface - Which field this text came from, for messages.
 * @returns {{text: string, applied: Array<string>, warnings: Array<string>}}
 */
function applyLinksToText(text, specs, propName, surface) {
  const applied = [];
  const warnings = [];
  if (typeof text !== 'string' || !text || !specs.length) return { text, applied, warnings };

  // Two passes, unscoped first. A scoped spec duplicates the paragraph it
  // matches into an ifdef/ifndef pair, and every later substitution uses
  // indexOf, which finds only the FIRST copy. So an unscoped link sharing a
  // paragraph with a scoped one would be applied to one branch and left as
  // plain text in the other, and a reader of that build silently loses a link
  // they should have. Applying every unscoped spec before any duplication
  // makes the result independent of the order the keys happen to sit in the
  // overrides JSON -- which is what it depended on before.
  const ordered = [
    ...specs.filter((spec) => !(spec.scope.cloudOnly || spec.scope.selfManagedOnly)),
    ...specs.filter((spec) => spec.scope.cloudOnly || spec.scope.selfManagedOnly)
  ];

  let out = text;
  for (const spec of ordered) {
    const index = out.indexOf(spec.key);
    if (index === -1) continue;

    const link = renderLink(spec);
    const scoped = spec.scope.cloudOnly || spec.scope.selfManagedOnly;

    if (!scoped) {
      out = out.slice(0, index) + link + out.slice(index + spec.key.length);
      applied.push(spec.key);
      continue;
    }

    if (insideDelimitedBlock(out, index)) {
      // Splitting a listing or example block across two conditional branches
      // would break the block in both. Leave the text plain and say so.
      warnings.push(
        `${propName}: links["${spec.key}"] is audience-scoped but matches inside a delimited block in ${surface}; ` +
        'left as plain text. Move the sentence out of the block, or drop the scope prefix.'
      );
      continue;
    }

    const { start, end } = paragraphBounds(out, index);
    const paragraph = out.slice(start, end);
    const relative = index - start;
    const linked = paragraph.slice(0, relative) + link + paragraph.slice(relative + spec.key.length);
    const both = spec.scope.cloudOnly
      ? wrapBothAudiences(linked, paragraph)
      : wrapBothAudiences(paragraph, linked);
    out = out.slice(0, start) + both + out.slice(end);
    applied.push(spec.key);
  }

  return { text: out, applied, warnings };
}

/**
 * Flatten a description into AsciiDoc, wrapping audience-scoped paragraphs.
 *
 * A description is either a plain string (unchanged) or an array of paragraphs,
 * each optionally carrying a `cloud-only:` / `self-managed-only:` prefix. The
 * array form exists so a Cloud-specific sentence does not have to be written as
 * raw `ifdef::env-cloud[]` inside the JSON string, which is what pinned
 * replication.factor and redpanda.remote.readreplica as permanent overrides: the
 * audit cannot compare prose it cannot separate from markup.
 *
 * @param {string|Array<string>} description
 * @returns {string}
 */
function flattenDescription(description) {
  if (typeof description === 'string') return description;
  if (!Array.isArray(description)) return description;

  const parts = [];
  for (const raw of description) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const scope = parseAudience(raw);
    if (!scope || !scope.content) continue;
    if (scope.cloudOnly) {
      parts.push(`ifdef::env-cloud[]\n${scope.content}\nendif::[]`);
    } else if (scope.selfManagedOnly) {
      parts.push(`ifndef::env-cloud[]\n${scope.content}\nendif::[]`);
    } else {
      parts.push(scope.content);
    }
  }
  // Joined with a blank line, which is what keeps a conditional from gluing to
  // its neighbours. Without it the preprocessor leaves the surrounding lines
  // adjacent and Asciidoctor merges them into one paragraph -- and it does so in
  // only one branch when the conditional wraps a delimited block, so a
  // self-managed preview can look correct while Cloud loses its paragraph breaks.
  return parts.join('\n\n');
}

/**
 * Normalize an `includes` override into what the template renders.
 *
 * A shared partial pulled into a property entry is block-level docs structure:
 * the "internal use only" warning, or the HTTP Proxy ephemeral-credentials
 * breaking-change notice. Written into the description string it is markup the
 * overrides audit cannot separate from the prose, which pinned seven
 * descriptions as permanent overrides. As its own field the prose stays
 * comparable to source and the include still renders in the same place.
 *
 * Each entry is a resource ID, optionally audience-scoped with the same prefix
 * every other field uses. An entry may carry its own `[attrs]`; without them
 * the generator adds the empty brackets the directive requires.
 *
 * @param {string} propName - For messages.
 * @param {Array<string>|string} raw - The `includes` override value.
 * @param {string[]} warnings - Collected warnings, appended to in place.
 * @returns {Array<{target: string, cloud_only?: boolean, self_managed_only?: boolean}>}
 */
function normalizeIncludes(propName, raw, warnings) {
  const items = Array.isArray(raw) ? raw : [raw];
  const out = [];
  for (const entry of items) {
    const scope = parseAudience(entry);
    if (!scope || !scope.content) {
      warnings.push(`${propName}: an includes entry has no resource ID; dropped.`);
      continue;
    }
    let target = scope.content;
    if (target.startsWith('include::')) target = target.slice('include::'.length);
    if (!/\$/.test(target) && !target.includes('$')) {
      // Antora resource IDs for a partial carry a family segment; without one
      // the include silently resolves to nothing at build time.
      warnings.push(
        `${propName}: includes entry "${target}" does not look like an Antora resource ID ` +
        '(expected something like reference:partial$name.adoc); emitted as given.'
      );
    }
    if (!target.endsWith(']')) target = `${target}[]`;
    const item = { target };
    if (scope.cloudOnly) item.cloud_only = true;
    if (scope.selfManagedOnly) item.self_managed_only = true;
    out.push(item);
  }
  return out;
}

/**
 * Why the Cloud build cannot reach a link target, or null when it can.
 *
 * Two separate reasons, and only the first was obvious. `cloud_supported: false`
 * says the control plane does not expose the property to customers. But
 * cloud-docs also publishes no broker properties page and no topic properties
 * page at all, so a link to any broker- or topic-scope property dangles there
 * however the install pack feels about it. That case cannot be read off
 * `cloud_supported`: cloud_config.py annotates cluster scope only and leaves the
 * field absent elsewhere, because "absent" means no opinion rather than false.
 *
 * @param {Object} target - The property being linked to.
 * @returns {string|null} A short reason, or null when the target is reachable.
 */
function cloudUnreachable(target) {
  if (target.cloud_supported === false) return 'cloud_supported: false';
  if (target.config_scope === 'broker') return 'Cloud publishes no broker properties page';
  if (target.config_scope === 'topic') return 'Cloud publishes no topic properties page';
  return null;
}

/**
 * Apply `links` and audience-scoped text to every property in the map, in place.
 *
 * Runs once over the whole map before rendering, because a `#` target has to be
 * checked against the other properties and because the same text reaches the
 * property partials, the deprecated partial and the topic mappings partial.
 *
 * @param {Object<string, Object>} properties - Property map, mutated in place.
 * @returns {{applied: number, unmatched: Array<{property: string, key: string}>, warnings: Array<string>}}
 */
function applyPropertyLinks(properties) {
  const unmatched = [];
  const warnings = [];
  let applied = 0;

  for (const [propName, prop] of Object.entries(properties || {})) {
    if (!prop || typeof prop !== 'object') continue;

    // Flatten first: an array description becomes one string, so a link that
    // matches text in a scoped paragraph is substituted inside the conditional
    // that paragraph already carries rather than triggering a second wrapper.
    if (prop.description !== undefined) {
      prop.description = flattenDescription(prop.description);
    }
    if (prop.includes !== undefined) {
      prop.includes = normalizeIncludes(propName, prop.includes, warnings);
    }
    if (Array.isArray(prop.admonitions)) {
      prop.admonitions = prop.admonitions.filter((item) => {
        if (!item || typeof item !== 'object') return false;
        if (item.cloud_only === true && (item.self_managed_only === true || item.self_hosted_only === true)) {
          warnings.push(
            `${propName}: an admonition sets both cloud_only and self_managed_only, so it would render in neither build; dropped.`
          );
          return false;
        }
        return true;
      });
    }

    const { specs, warnings: specWarnings } = resolveLinkSpecs(propName, prop.links, properties);
    warnings.push(...specWarnings);
    if (!specs.length) continue;

    // A cloud-published property linking to one Cloud cannot reach renders as
    // plain code there and makes the prop macro warn on every build. Catching it
    // here says which override to fix, rather than leaving it to an Antora log.
    for (const spec of specs) {
      if (spec.kind !== 'property') continue;
      if (spec.scope.cloudOnly || spec.scope.selfManagedOnly) continue;
      if (!prop.cloud_supported) continue;
      const target = properties[spec.targetName];
      if (!target) continue;
      const reason = cloudUnreachable(target);
      if (reason) {
        warnings.push(
          `${propName}: links["${spec.key}"] targets ${spec.targetName}, which Cloud cannot reach (${reason}), ` +
          'from a property Cloud does publish. Prefix the target with "self-managed-only:" so the Cloud build gets the plain sentence.'
        );
      }
    }

    const matched = new Set();
    const run = (text, surface) => {
      const result = applyLinksToText(text, specs, propName, surface);
      result.applied.forEach((key) => matched.add(key));
      warnings.push(...result.warnings);
      applied += result.applied.length;
      return result.text;
    };

    if (typeof prop.description === 'string') prop.description = run(prop.description, 'description');
    if (typeof prop.acceptable_values === 'string') {
      prop.acceptable_values = run(prop.acceptable_values, 'acceptable_values');
    }
    if (typeof prop.example === 'string') {
      prop.example = run(prop.example, 'example');
    } else if (Array.isArray(prop.example)) {
      // Joined, and left joined. Two reasons: a match spanning two lines is
      // found, and paragraph bounds mean the same thing here as in a
      // description. Handing the array back would break the page -- property.hbs
      // renders the example with a bare {{{example}}}, so Handlebars would
      // stringify an array with commas and the whole YAML block would collapse
      // onto one line. The Python stage already joins an override's example
      // array before the generator sees it, so a string is also the shape the
      // real pipeline uses.
      prop.example = run(prop.example.join('\n'), 'example');
    }
    if (Array.isArray(prop.admonitions)) {
      prop.admonitions.forEach((item, i) => {
        if (item && typeof item.text === 'string') {
          item.text = run(item.text, `admonitions[${i}].text`);
        }
      });
    }

    for (const spec of specs) {
      if (!matched.has(spec.key)) unmatched.push({ property: propName, key: spec.key });
    }
  }

  // Self-check the prose this pass produced, plus any conditional an override
  // still writes by hand. A conditional with no blank line beside it merges the
  // neighbouring paragraphs in both builds, so comparing the two renders sees
  // nothing wrong -- reading the source is what catches it, and naming the
  // property is what makes it fixable.
  for (const [propName, prop] of Object.entries(properties || {})) {
    if (!prop || typeof prop !== 'object') continue;
    const surfaces = [['description', prop.description]];
    if (Array.isArray(prop.admonitions)) {
      prop.admonitions.forEach((item, i) => {
        if (item && typeof item.text === 'string') surfaces.push([`admonitions[${i}].text`, item.text]);
      });
    }
    for (const [surface, text] of surfaces) {
      for (const offender of findGluedConditionals(text)) {
        warnings.push(
          `${propName}: ${surface} has ${offender.directive} with no blank line ${offender.side} it ` +
          `("${offender.neighbour}"). Both builds will merge the neighbouring paragraphs.`
        );
      }
    }
  }

  return { applied, unmatched, warnings };
}

module.exports = applyPropertyLinks;
module.exports.applyPropertyLinks = applyPropertyLinks;
module.exports.flattenDescription = flattenDescription;
module.exports.resolveLinkSpecs = resolveLinkSpecs;
module.exports.applyLinksToText = applyLinksToText;
module.exports.renderLink = renderLink;
module.exports.cloudUnreachable = cloudUnreachable;
module.exports.normalizeIncludes = normalizeIncludes;

'use strict';

// The reference pages these xrefs target.
const PROPERTY_PAGES = [
  'cluster-properties',
  'object-storage-properties',
  'topic-properties',
  'broker-properties',
];

// Every prefix seen in the wild for the same target:
//   xref:cluster-properties.adoc#x            bare filename
//   xref:./cluster-properties.adoc#x          relative to the current directory
//   xref:reference:cluster-properties.adoc#x  legacy, when the pages sat at the module root
//   xref:reference:properties/...#x           canonical
const PREFIXES = '(?:\\./|reference:properties/|reference:)?';
const PATTERN = new RegExp(
  `xref:${PREFIXES}(${PROPERTY_PAGES.join('|')})\\.adoc(?=[#\\[])`,
  'g'
);

/**
 * Rewrite every reference to a property reference page to one canonical resource ID.
 *
 * The bare and `reference:`-prefixed forms both resolve to the module root, where
 * these pages no longer live. Self-managed papers over that with a
 * `reference:cluster-properties.adoc` page alias, so the broken form renders as a
 * working link there and as an unresolved xref in cloud-docs, which has no such
 * alias. The `./` form works but depends on the including page sitting in
 * `reference/properties/`, which is a constraint on every page that includes a
 * partial rather than a property of the partial.
 *
 * The fully qualified module-and-path form has neither problem: it resolves
 * inside whichever component includes the partial, from any directory.
 *
 * @param {string} text - AsciiDoc source that may contain property-page xrefs.
 * @returns {{text: string, rewrites: number}}
 */
function canonicalizePropertyXrefs(text) {
  if (typeof text !== 'string' || !text.includes('xref:')) {
    return { text, rewrites: 0 };
  }
  let rewrites = 0;
  const out = text.replace(PATTERN, (match, page) => {
    const canonical = `xref:reference:properties/${page}.adoc`;
    if (match === canonical) return match;
    rewrites += 1;
    return canonical;
  });
  return { text: out, rewrites };
}

module.exports = canonicalizePropertyXrefs;
module.exports.PROPERTY_PAGES = PROPERTY_PAGES;

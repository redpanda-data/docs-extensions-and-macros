'use strict';

const { descriptionWithMetadataInclude } = require('../metadata-utils.js');

// AsciiDoc listing/literal block delimiter (`----`, possibly longer). Lines
// inside such blocks must not be treated as headings.
const BLOCK_DELIMITER = /^-{4,}$/;

// Length (characters) above which a heading-less description is reported as a
// candidate for upstream structure. Roughly a screen of prose.
const LONG_HEADINGLESS_THRESHOLD = 1200;

/**
 * True when the description contains at least one structural heading that sits
 * outside a `----` listing block.
 *
 * Used to report long heading-less descriptions during generation. Embedded
 * headings are otherwise passed through unchanged: they render as top-level
 * page sections, which matches every published connector page today. Demoting
 * them is not an option because the description renders before the page's
 * first `==` section, so demoted headings produce "section title out of
 * sequence" errors. Collapsible wrapping was evaluated and rejected: it hides
 * primary content behind unreliable cross-browser find and deep-link behavior,
 * and bodies containing their own `====` delimiters cannot be wrapped at all.
 */
function hasStructuralHeadings (body) {
  const lines = body.split('\n');
  let inBlock = false;
  for (const line of lines) {
    if (BLOCK_DELIMITER.test(line.trim())) { inBlock = !inBlock; continue; }
    if (!inBlock && /^={2,}\s+\S/.test(line)) return true;
  }
  return false;
}

/**
 * Handlebars helper: render a connector's description for the regenerated
 * description partial.
 *
 * The `== Metadata` block is replaced by an include of the metadata partial
 * (de-duplicating it, since metadata is emitted as its own partial).
 * Everything else passes through unchanged: the description is the page's
 * primary content, and structure belongs upstream in the connector source.
 * The generator reports long heading-less descriptions so they get headings
 * added there instead of being hidden by the docs build.
 *
 * @param {object} item connector data (needs `description`, `type`/`typeDir`, `name`)
 * @returns {string}
 */
module.exports = function renderConnectDescription (item) {
  const body = descriptionWithMetadataInclude(item);
  if (!body || !body.trim()) return '';
  return body.trim();
};

module.exports.hasStructuralHeadings = hasStructuralHeadings;
module.exports.LONG_HEADINGLESS_THRESHOLD = LONG_HEADINGLESS_THRESHOLD;

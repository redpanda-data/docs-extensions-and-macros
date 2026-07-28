'use strict';

const { descriptionWithMetadataInclude } = require('../metadata-utils.js');

// A structural AsciiDoc heading (level 2 or deeper) or a listing/literal block
// delimiter. A description that carries its own headings is already navigable,
// so it is passed through unchanged; only heading-less prose "walls" are
// candidates for the collapsible mitigation.
const HEADING = /^={2,}\s+\S/m;
const BLOCK_DELIMITER = /^-{4,}$/;

// Default length (characters) above which a heading-less description is
// considered a large block worth collapsing. Roughly a screen of prose.
const DEFAULT_COLLAPSE_THRESHOLD = 1200;

/**
 * True when the description contains at least one structural heading that sits
 * outside a `----` listing block. Such descriptions provide their own section
 * structure and must not be wrapped in a collapsible delimited block (headings
 * inside a delimited block do not render as sections).
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
 * Split a prose body into its first paragraph and the remainder. The first
 * paragraph stays visible; the remainder is the collapsible tail.
 * @returns {{lead:string, rest:string}}
 */
function splitLeadParagraph (body) {
  const trimmed = body.replace(/^\s+/, '');
  const gap = trimmed.indexOf('\n\n');
  if (gap === -1) return { lead: trimmed.trim(), rest: '' };
  return {
    lead: trimmed.slice(0, gap).trim(),
    rest: trimmed.slice(gap).trim(),
  };
}

/**
 * Handlebars helper: render a connector's description for the regenerated
 * description partial.
 *
 * The `== Metadata` block is replaced by an include of the metadata partial
 * (de-duplicating it, since metadata is emitted as its own partial). Large,
 * heading-less descriptions are mitigated: the first paragraph stays visible
 * and the remainder is moved into an AsciiDoc collapsible block so the page
 * does not open with a wall of text. Descriptions that already carry their own
 * headings are left structured and pass through unchanged.
 *
 * @param {object} item connector data (needs `description`, `type`/`typeDir`, `name`)
 * @param {object} [options] Handlebars options; `options.hash.collapseThreshold`
 *   overrides the character threshold, and `collapse=false` disables it.
 * @returns {string}
 */
module.exports = function renderConnectDescription (item, options) {
  const body = descriptionWithMetadataInclude(item);
  if (!body || !body.trim()) return '';

  const hash = (options && options.hash) || {};
  const collapseEnabled = hash.collapse !== false;
  const threshold = Number.isFinite(hash.collapseThreshold)
    ? hash.collapseThreshold
    : DEFAULT_COLLAPSE_THRESHOLD;

  // Structured or short-enough descriptions render as-is.
  if (!collapseEnabled || body.length <= threshold || hasStructuralHeadings(body)) {
    return body.trim();
  }

  const { lead, rest } = splitLeadParagraph(body);
  if (!rest) return body.trim();

  return `${lead}\n\n` +
    `.More details\n` +
    `[%collapsible]\n` +
    `====\n` +
    `${rest}\n` +
    `====`;
};

module.exports.hasStructuralHeadings = hasStructuralHeadings;
module.exports.splitLeadParagraph = splitLeadParagraph;
module.exports.DEFAULT_COLLAPSE_THRESHOLD = DEFAULT_COLLAPSE_THRESHOLD;

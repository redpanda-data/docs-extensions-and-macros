'use strict';

const { descriptionWithMetadataInclude, FENCE_DELIMITER } = require('../metadata-utils.js');

// AsciiDoc listing/literal block delimiter (`----`, possibly longer). Lines
// inside such blocks must not be treated as headings.
const BLOCK_DELIMITER = /^-{4,}$/;

/**
 * Split `body` into lines annotated with whether each line sits inside (or
 * delimits) a verbatim region: an AsciiDoc `----` listing block or a
 * markdown ```/~~~ fence (FENCE_DELIMITER, shared with metadata-utils'
 * sectionHeadings). Every scanner and rewriter in this module walks the body
 * through this so fence interiors are treated exactly like listing-block
 * interiors: content, never headings or escapable prose. Layered state: while
 * one delimiter kind is open, only its own closer matters — a ---- line
 * inside a fence (or a fence line inside a ---- block) is content.
 * @param {string} body
 * @returns {Array<{line: string, verbatim: boolean}>}
 */
function annotateVerbatimLines (body) {
  let inBlock = false;
  let fence = null;
  return body.split('\n').map((line) => {
    if (inBlock) {
      if (BLOCK_DELIMITER.test(line.trim())) inBlock = false;
      return { line, verbatim: true };
    }
    if (fence) {
      const closer = line.match(FENCE_DELIMITER);
      if (closer && closer[1][0] === fence) fence = null;
      return { line, verbatim: true };
    }
    if (BLOCK_DELIMITER.test(line.trim())) { inBlock = true; return { line, verbatim: true }; }
    const fenceMatch = line.match(FENCE_DELIMITER);
    if (fenceMatch) { fence = fenceMatch[1][0]; return { line, verbatim: true }; }
    return { line, verbatim: false };
  });
}

// Length (characters) above which a heading-less description is reported as a
// candidate for upstream structure. Roughly a screen of prose.
const LONG_HEADINGLESS_THRESHOLD = 1200;

/**
 * True when the description contains at least one structural heading that sits
 * outside a `----` listing block or a markdown ```/~~~ fence.
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
  // AsciiDoc headings only. Markdown-style ## headings deliberately do NOT
  // count: the descriptions that render worst are exactly the ones whose
  // only structure is markdown headings, and counting them here exempted
  // those from the long-description report (they get their own report).
  return annotateVerbatimLines(body)
    .some(({ line, verbatim }) => !verbatim && /^={2,}\s+\S/.test(line));
}

/**
 * True when the description contains a markdown-style heading (`##`) outside
 * listing blocks and fences. These are reported for upstream conversion to
 * `==` (a `#` line inside a fence is a comment in an example, not a heading).
 */
function hasMarkdownHeadings (body) {
  return annotateVerbatimLines(body)
    .some(({ line, verbatim }) => !verbatim && /^#{2,}\s+\S/.test(line));
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
  return escapePlaceholderBraces(ensureHeadingSeparation(body.trim()));
};

/**
 * Insert the blank line Asciidoctor requires before a section title. A
 * heading glued to the paragraph above it renders as literal text and
 * orphans its subsections into "section title out of sequence" warnings
 * (live case: the protobuf processor's "== Operators"). Listing blocks and
 * fences are untouched — a glued `#` comment inside a fenced example must
 * not have a blank line pushed into the example.
 */
function ensureHeadingSeparation (body) {
  const out = [];
  for (const { line, verbatim } of annotateVerbatimLines(body)) {
    if (
      !verbatim &&
      /^(?:={2,6}|#{2,6})\s+\S/.test(line) &&
      out.length > 0 &&
      out[out.length - 1].trim() !== ''
    ) {
      out.push('');
    }
    out.push(line);
  }
  return out.join('\n');
}

/**
 * Escape template placeholders like {endpoint} so Asciidoctor keeps them
 * instead of consuming them as attribute references (which substitutes to
 * nothing and logs "skipping reference to missing attribute" on the
 * published page — live today on salesforce_graphql and otlp_http).
 * Single-backtick spans still apply attribute substitution, so spans are
 * escaped too; `----` listing blocks and ```/~~~ fences are verbatim and stay
 * untouched (a `\{` inside a fence would render as a literal backslash).
 */
function escapePlaceholderBraces (body) {
  return annotateVerbatimLines(body).map(({ line, verbatim }) => (
    verbatim ? line : line.replace(/(?<![\\{])\{([a-z][\w.-]{1,30})\}/g, '\\{$1}')
  )).join('\n');
}

/**
 * Depth of the first structural heading (AsciiDoc `=` or markdown-compat
 * `#`) outside listing blocks and fences, or null when the body has none.
 * Descriptions whose first heading is deeper than level one (`===`, `###`)
 * render "section title out of sequence" on the page, so the generator
 * reports them as upstream fixes (seen on aws_dynamodb_cdc, iceberg,
 * protobuf).
 */
function firstHeadingDepth (body) {
  for (const { line, verbatim } of annotateVerbatimLines(body)) {
    if (verbatim) continue;
    const m = line.match(/^(={2,6}|#{2,6})\s+\S/);
    if (m) return m[1].length;
  }
  return null;
}

module.exports.hasStructuralHeadings = hasStructuralHeadings;
module.exports.hasMarkdownHeadings = hasMarkdownHeadings;
module.exports.escapePlaceholderBraces = escapePlaceholderBraces;
module.exports.ensureHeadingSeparation = ensureHeadingSeparation;
module.exports.firstHeadingDepth = firstHeadingDepth;
module.exports.LONG_HEADINGLESS_THRESHOLD = LONG_HEADINGLESS_THRESHOLD;

'use strict';

// One annotator for every scanner over connector prose, including the ones in
// metadata-utils that run before these. See annotateVerbatimLines there for
// why there is exactly one.
const { descriptionWithMetadataInclude, annotateVerbatimLines } = require('../metadata-utils.js');

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
  return protectCodeSpans(escapePlaceholderBraces(ensureHeadingSeparation(body.trim())));
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
 *
 * The name may start uppercase or with an underscore, because environment
 * variable placeholders are the common case in prose: Asciidoctor downcases
 * a reference before looking it up, so ${SALESFORCE_CLIENT_SECRET} outside a
 * fence is consumed exactly like a lowercase one and logs the missing
 * attribute as salesforce_client_secret.
 */
function escapePlaceholderBraces (body) {
  return annotateVerbatimLines(body).map(({ line, verbatim }) => (
    verbatim ? line : line.replace(/(?<![\\{])\{([A-Za-z_][\w.-]{1,30})\}/g, '\\{$1}')
  )).join('\n');
}

// Doubled characters that Asciidoctor treats as unconstrained emphasis, bold
// and highlight markers. They apply inside a backtick code span and pair up
// across spans, so `__c` and `__b` on one line render as <em> between them,
// and a glob like `'**/*.md'` renders as <strong> (live on the salesforce and
// git inputs).
const UNCONSTRAINED_MARKERS = /__|\*\*|##/;

/**
 * Wrap inline code spans that contain unconstrained formatting markers in a
 * `+...+` passthrough, so the span renders literally. Spans are left alone
 * when they are already passthroughs or start or end with whitespace (which
 * only happens when backticks on a line don't pair up as code spans).
 *
 * Runs after escapePlaceholderBraces: a passthrough applies no attribute
 * substitution, so the `\{` escape it added inside the span would render as a
 * literal backslash and is removed again. Listing blocks and fences are
 * verbatim and stay untouched.
 */
function protectCodeSpans (body) {
  return annotateVerbatimLines(body).map(({ line, verbatim }) => (
    verbatim ? line : line.replace(/`([^`\n]+)`/g, (span, content) => {
      if (!UNCONSTRAINED_MARKERS.test(content)) return span;
      if (/^\+|\+$/.test(content) || /^\s|\s$/.test(content)) return span;
      return `\`+${content.replace(/\\\{/g, '{')}+\``;
    })
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
module.exports.protectCodeSpans = protectCodeSpans;
module.exports.ensureHeadingSeparation = ensureHeadingSeparation;
module.exports.firstHeadingDepth = firstHeadingDepth;
module.exports.LONG_HEADINGLESS_THRESHOLD = LONG_HEADINGLESS_THRESHOLD;

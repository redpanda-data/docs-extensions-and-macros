'use strict';

const { escapeHtml } = require('../extension-utils/html-utils');

/**
 * Iceberg Mode Explorer block.
 *
 * Registers an `[iceberg-explorer]` AsciiDoc block that emits a lightweight,
 * version-aware mount point. The interactive tool itself (Ace editors,
 * controls, rendering) and its translation engine live in the docs-ui bundle;
 * a docs-ui JS module hydrates every element carrying the mount attribute
 * (`MOUNT_SELECTOR` below).
 *
 * This mirrors the "macro emits container -> docs-ui JS hydrates" handshake
 * used by the component metadata block in `rp-connect-components.js` +
 * `docs-ui/src/js/24-move-connector-metadata.js`.
 *
 * MOUNT CONTRACT. docs-ui must hydrate on the `data-iceberg-explorer`
 * attribute, never on a class name that matches the block name. Asciidoctor
 * turns an unrecognized block style into a CSS class, so a page that uses
 * `[iceberg-explorer]` in a site whose playbook forgot to register this macro
 * still renders `<div class="openblock iceberg-explorer">`. Hydrating on
 * `.iceberg-explorer` would dress that accident up as a working explorer
 * showing built-in sample data while the author's JSON body was discarded, with
 * no error anywhere. Only this macro can emit a data attribute, so the
 * attribute is the contract and the class is for styling only.
 *
 * Authoring:
 *
 *   [iceberg-explorer]
 *   --
 *   --
 *
 * or with author-supplied defaults (JSON) as the block body:
 *
 *   [iceberg-explorer]
 *   ----
 *   {
 *     "config": "key:mode=binary;value:mode=schema_id_prefix,layout=flat;headers:value_type=binary"
 *   }
 *   ----
 *
 * The explorer module reads only the "config" key (docs-ui
 * src/js/27-iceberg-explorer.js), rendering its own sample schema and record.
 * Any other key is forwarded verbatim in `data-defaults` and ignored today, so
 * do not advertise author-supplied schemas or records as supported.
 *
 * The block reads the page's component version and stamps it onto the mount
 * point so the UI can fetch the engine build that matches the doc version.
 *
 * @param {Registry} registry - The Antora/Asciidoctor extension registry.
 * @param {Object} context - The Antora context (unused today; kept for parity
 *   with the other macros and for future content-catalog resolution).
 */

// Mount contract shared with docs-ui. Exported so both sides and the tests
// reference one definition instead of a hard-coded string in three places.
const MOUNT_ATTRIBUTE = 'data-iceberg-explorer';
// Bumped only if the emitted attributes change shape, so a docs-ui build can
// refuse a mount point it does not understand.
const MOUNT_CONTRACT_VERSION = '1';
// Styling hook only. Deliberately NOT the block name: see MOUNT CONTRACT above.
const MOUNT_CLASS = 'iceberg-explorer-mount';
const MOUNT_SELECTOR = `[${MOUNT_ATTRIBUTE}]`;

module.exports.register = function (registry, context) {
  // Support both calling conventions:
  //  - Antora passes a registry as the first argument; it exposes `.block()`
  //    directly, so register on it.
  //  - Some preview harnesses (e.g. docs-ui's build-preview-pages) call
  //    `register.call(Asciidoctor.Extensions)` with the Extensions module as
  //    `this` and no arguments. That module exposes `.register(fn)` (not
  //    `.block()`); inside `fn`, `this` is a registry with `.block()`.
  const target = registry || this;
  if (typeof target.block === 'function') {
    defineBlock(target);
  } else if (typeof target.register === 'function') {
    target.register(function () { defineBlock(this); });
  } else {
    throw new Error('iceberg-explorer: no usable Asciidoctor registry provided');
  }
};

function defineBlock (registry) {
  registry.block(function () {
    const self = this;
    self.named('iceberg-explorer');
    // Accept an empty open block (`--`) or a listing/literal/pass block whose
    // body carries author-supplied JSON defaults. `paragraph` is deliberately
    // absent: the processor discards the body, so registering the paragraph
    // context made `[iceberg-explorer]` above ordinary prose delete that
    // paragraph from the published page.
    self.onContext(['open', 'listing', 'literal', 'pass']);
    self.process((parent, reader, attrs) => {
      const attributes = parent.getDocument().getAttributes();
      // Name the page in every warning. Antora sets page-relative-src-path
      // (the convention rp-connect-components.js follows); plain Asciidoctor
      // runs only have docfile.
      const page =
        attributes['page-relative-src-path'] ||
        attributes['docfile'] ||
        'unknown page';
      const warn = (message) => {
        console.warn(`[iceberg-explorer] ${page}: ${message}`);
      };

      // Author-supplied defaults (optional). Validate that the body is a JSON
      // object so a typo surfaces at build time rather than silently shipping
      // bad data. docs-ui reads keys off the parsed value, so a scalar or an
      // array is as unusable as a syntax error, and JSON.parse accepts both.
      let defaults = null;
      const body = reader.getLines().join('\n').trim();
      if (body) {
        let parsed;
        let valid = false;
        try {
          parsed = JSON.parse(body);
          valid = true;
        } catch (err) {
          warn(
            `block body is not valid JSON (${err.message}). ` +
            'Rendering the explorer with built-in defaults instead.'
          );
        }
        if (valid) {
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            warn(
              `block body must be a JSON object with a "config" key, not ${describeJson(parsed)}. ` +
              'Rendering the explorer with built-in defaults instead.'
            );
          } else {
            defaults = parsed;
          }
        }
      }

      // Doc version drives which engine build the UI loads. `page-version` is
      // the short component version (for example, "26.2"); fall back to the
      // component version attribute if present.
      const version =
        attributes['page-version'] ||
        attributes['page-component-version'] ||
        '';

      // Optional named attributes let an author pin behavior without a body.
      // `config` sets the initial DSL string; `height` overrides the min
      // height; `engine-base` overrides where docs-ui fetches the engine from.
      const initialConfig = attrs.config || (defaults && defaults.config) || '';
      const height = cssLength(attrs.height, warn);
      const engineBase = attrs['engine-base'] || '';

      const dataDefaults = defaults
        ? escapeHtml(JSON.stringify(defaults))
        : '';
      const dataConfig = initialConfig ? escapeHtml(initialConfig) : '';
      const styleAttr = height ? ` style="min-height:${height}"` : '';
      const versionAttr = version ? ` data-version="${escapeHtml(version)}"` : '';
      const engineAttr = engineBase ? ` data-engine-base="${escapeHtml(engineBase)}"` : '';

      // The container is a mount point only; docs-ui replaces its contents on
      // hydration. Until then the fallback paragraph is visible, so the two
      // ways this can fail (JS disabled, or a docs-ui build without the
      // explorer module) both show a message instead of a 0px-tall void. It is
      // plain markup, not <noscript>, precisely because the common failure is
      // JS running fine with the module missing, which <noscript> hides.
      const html = `
<div class="${MOUNT_CLASS}" ${MOUNT_ATTRIBUTE}="${MOUNT_CONTRACT_VERSION}"${versionAttr}${engineAttr}${dataConfig ? ` data-config="${dataConfig}"` : ''}${dataDefaults ? ` data-defaults="${dataDefaults}"` : ''}${styleAttr}>
  <p class="iceberg-explorer-fallback">Interactive Iceberg Mode Explorer. If this text is still here, the explorer could not load: it needs JavaScript and a docs-ui build that includes the explorer module. See the Iceberg topic configuration reference for the equivalent settings.</p>
</div>`;

      return self.createBlock(parent, 'pass', html);
    });
  });
};

/**
 * Describe a parsed-but-unusable JSON body for the build warning.
 * @param {*} value
 * @returns {string}
 */
function describeJson (value) {
  if (Array.isArray(value)) return 'an array';
  if (value === null) return 'null';
  return `a ${typeof value}`;
}

/**
 * Validate the `height` attribute as a CSS length. A bare number is the natural
 * thing to write and produces `min-height:400`, which browsers drop, so accept
 * it and add `px`. Anything else is rejected rather than interpolated: the value
 * lands inside a style attribute, where `1px;position:fixed;inset:0` would turn
 * a doc page into a full-viewport overlay.
 * @param {string} raw
 * @param {function(string): void} warn
 * @returns {string} A safe CSS length, or '' to omit the style attribute.
 */
function cssLength (raw, warn) {
  if (!raw) return '';
  const value = String(raw).trim();
  if (/^\d+$/.test(value)) return `${value}px`;
  if (/^\d+(\.\d+)?(px|rem|em|vh|vw|%)$/.test(value)) return value;
  warn(
    `height="${value}" is not a CSS length (for example, 400, 400px, 30rem, 60vh). Ignoring it.`
  );
  return '';
}

module.exports.MOUNT_ATTRIBUTE = MOUNT_ATTRIBUTE;
module.exports.MOUNT_CONTRACT_VERSION = MOUNT_CONTRACT_VERSION;
module.exports.MOUNT_CLASS = MOUNT_CLASS;
module.exports.MOUNT_SELECTOR = MOUNT_SELECTOR;

'use strict';

/**
 * Iceberg Mode Explorer block.
 *
 * Registers an `[iceberg-explorer]` AsciiDoc block that emits a lightweight,
 * version-aware mount point. The interactive tool itself (Ace editors,
 * controls, rendering) and its translation engine live in the docs-ui bundle;
 * a docs-ui JS module hydrates any `.iceberg-explorer` element on the page.
 *
 * This mirrors the "macro emits container -> docs-ui JS hydrates" handshake
 * used by the component metadata block in `rp-connect-components.js` +
 * `docs-ui/src/js/24-move-connector-metadata.js`.
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
 *     "config": "key:mode=binary;value:mode=schema_id_prefix,layout=flat;headers:value_type=binary",
 *     "schema": { ... },
 *     "record": { ... }
 *   }
 *   ----
 *
 * The block reads the page's component version and stamps it onto the mount
 * point so the UI can fetch the engine build that matches the doc version.
 *
 * @param {Registry} registry - The Antora/Asciidoctor extension registry.
 * @param {Object} context - The Antora context (unused today; kept for parity
 *   with the other macros and for future content-catalog resolution).
 */
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
    // body carries author-supplied JSON defaults.
    self.onContext(['open', 'listing', 'literal', 'pass', 'paragraph']);
    self.process((parent, reader, attrs) => {
      const attributes = parent.getDocument().getAttributes();

      // Author-supplied defaults (optional). Validate that the body is JSON so
      // a typo surfaces at build time rather than silently shipping bad data.
      let defaults = null;
      const body = reader.getLines().join('\n').trim();
      if (body) {
        try {
          defaults = JSON.parse(body);
        } catch (err) {
          console.warn(
            `[iceberg-explorer] block body is not valid JSON (${err.message}). ` +
            'Rendering the explorer with built-in defaults instead.'
          );
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
      // `config` sets the initial DSL string; `height` overrides the min height.
      const initialConfig = attrs.config || (defaults && defaults.config) || '';
      const height = attrs.height || '';

      const dataDefaults = defaults
        ? escapeAttr(JSON.stringify(defaults))
        : '';
      const dataConfig = initialConfig ? escapeAttr(initialConfig) : '';
      const styleAttr = height ? ` style="min-height:${escapeAttr(height)}"` : '';
      const versionAttr = version ? ` data-version="${escapeAttr(version)}"` : '';

      // The container is a mount point only. docs-ui hydrates it; if JS is
      // unavailable the noscript fallback points readers at the static docs.
      const html = `
<div class="iceberg-explorer"${versionAttr}${dataConfig ? ` data-config="${dataConfig}"` : ''}${dataDefaults ? ` data-defaults="${dataDefaults}"` : ''}${styleAttr}>
  <noscript>
    <p>The interactive Iceberg Mode Explorer requires JavaScript. See the Iceberg topics documentation for configuration reference.</p>
  </noscript>
</div>`;

      return self.createBlock(parent, 'pass', html);
    });
  });
};

/**
 * Escape a value for safe inclusion inside a double-quoted HTML attribute.
 * @param {string} value
 * @returns {string}
 */
function escapeAttr(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

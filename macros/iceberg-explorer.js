'use strict';

const { escapeHtml } = require('../extension-utils/html-utils');
const icebergMode = require('../extension-utils/iceberg-mode');
// Same logger as the other macros (#283): warnings land in Antora's log with
// a level Antora can fail on, instead of bypassing it through console.warn.
const logger = require('@antora/logger')('iceberg-explorer-macro');

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
 * or with an author-supplied initial config (JSON) as the block body:
 *
 *   [iceberg-explorer]
 *   ----
 *   {
 *     "config": "key:mode=binary;value:mode=schema_id_prefix,layout=flat;headers:value_type=binary"
 *   }
 *   ----
 *
 * Only the "config" key is read. docs-ui renders its own sample schema and
 * record, so any other key draws a build warning and is dropped.
 *
 * The block reads the page's component version and stamps it onto the mount
 * point as `data-version`. The version decides which `redpanda.iceberg.mode`
 * grammar applies (generated per release from Redpanda's source, see
 * tools/iceberg-mode/generate.js) and which engine build the UI loads.
 *
 * @param {Registry} registry - The Antora/Asciidoctor extension registry.
 * PROPERTY METADATA. In an Antora build the block also emits
 * `data-property-meta`: the property's description (plain text), default,
 * is_enterprise, see_also links resolved to URLs, and, on Cloud pages,
 * cloud_supported, all from the generated redpanda-properties-<tag>.json the
 * page's version publishes. The dataset is chosen exactly as the prop: macro
 * chooses it (loadPropertiesFor in macros/prop.js): newest patch of the page's
 * own release series, or the newest GA streaming file on Cloud. A page whose
 * version has no dataset, or whose dataset lacks the property, gets a build
 * warning and no attribute; docs-ui then shows no description rather than one
 * from another release.
 *
 * @param {Registry} registry - The Antora/Asciidoctor extension registry.
 * @param {Object} context - The Antora context: {file, contentCatalog, config}.
 *   Without a content catalog (plain Asciidoctor, the docs-ui preview) the
 *   block emits no property metadata.
 */

// Mount contract shared with docs-ui. Exported so both sides and the tests
// reference one definition instead of a hard-coded string in three places.
const MOUNT_ATTRIBUTE = 'data-iceberg-explorer';
// Bumped only if the emitted attributes change shape, so a docs-ui build can
// refuse a mount point it does not understand.
//   1: data-version, data-config, data-defaults, data-engine-base.
//   2: adds data-property; drops data-defaults; data-config is validated at
//      build time against the grammar for data-version.
const MOUNT_CONTRACT_VERSION = '2';
// The topic property the explorer configures. docs-ui picks its spec by this
// attribute, so the contract can carry another property later.
const MOUNT_PROPERTY = 'redpanda.iceberg.mode';
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
    defineBlock(target, context);
  } else if (typeof target.register === 'function') {
    target.register(function () { defineBlock(this, context); });
  } else {
    throw new Error('iceberg-explorer: no usable Asciidoctor registry provided');
  }
};

function defineBlock (registry, context) {
  registry.block(function () {
    const self = this;
    self.named('iceberg-explorer');
    // Accept an empty open block (`--`) or a listing/literal/pass block whose
    // body carries an author-supplied JSON config. `paragraph` is deliberately
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
        logger.warn(`${page}: ${message}`);
      };

      // Author-supplied initial config (optional). Validate that the body is a
      // JSON object so a typo surfaces at build time rather than silently
      // shipping bad data. Only its "config" key is read, so a scalar or an
      // array is as unusable as a syntax error, and JSON.parse accepts both.
      let bodyConfig = '';
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
            // Contract 1 forwarded the whole body as data-defaults, which
            // docs-ui never read. Say so instead of dropping keys silently.
            const ignored = Object.keys(parsed).filter((k) => k !== 'config');
            if (ignored.length) {
              warn(
                `block body key(s) ${ignored.map((k) => `"${k}"`).join(', ')} are not supported and are ignored. ` +
                'The explorer reads only "config".'
              );
            }
            if (typeof parsed.config === 'string') {
              bodyConfig = parsed.config;
            } else if ('config' in parsed) {
              warn(`block body "config" must be a string, not ${describeJson(parsed.config)}. Ignoring it.`);
            }
          }
        }
      }

      // Doc version drives which config grammar applies and which engine
      // build the UI loads. `page-version` is the short component version
      // (for example, "26.2"); fall back to the component version attribute
      // if present.
      const version =
        attributes['page-version'] ||
        attributes['page-component-version'] ||
        '';

      // Optional named attributes let an author pin behavior without a body.
      // `config` sets the initial DSL string; `height` overrides the min
      // height; `engine-base` overrides where docs-ui fetches the engine from.
      const initialConfig = attrs.config || bodyConfig;
      if (initialConfig) validateConfig(initialConfig, version, warn);
      const height = cssLength(attrs.height, warn);
      const engineBase = rootRelativePath(attrs['engine-base'], warn);

      const dataConfig = initialConfig ? escapeHtml(initialConfig) : '';
      const styleAttr = height ? ` style="min-height:${height}"` : '';
      const versionAttr = version ? ` data-version="${escapeHtml(version)}"` : '';
      const engineAttr = engineBase ? ` data-engine-base="${escapeHtml(engineBase)}"` : '';
      const meta = propertyMeta(context, warn);
      const metaAttr = meta ? ` data-property-meta="${escapeHtml(JSON.stringify(meta))}"` : '';

      // The container is a mount point only; docs-ui replaces its contents on
      // hydration. Until then the fallback paragraph is visible, so the two
      // ways this can fail (JS disabled, or a docs-ui build without the
      // explorer module) both show a message instead of a 0px-tall void. It is
      // plain markup, not <noscript>, precisely because the common failure is
      // JS running fine with the module missing, which <noscript> hides.
      const html = `
<div class="${MOUNT_CLASS}" ${MOUNT_ATTRIBUTE}="${MOUNT_CONTRACT_VERSION}" data-property="${MOUNT_PROPERTY}"${versionAttr}${metaAttr}${engineAttr}${dataConfig ? ` data-config="${dataConfig}"` : ''}${styleAttr}>
  <p class="iceberg-explorer-fallback">Interactive Iceberg Mode Explorer. If this text is still here, the explorer could not load: it needs JavaScript and a docs-ui build that includes the explorer module. See the Iceberg topic configuration reference for the equivalent settings.</p>
</div>`;

      return self.createBlock(parent, 'pass', html);
    });
  });
};

/**
 * `data-property-meta` for the mount, or undefined when there is nothing
 * verified to emit. See PROPERTY METADATA above.
 * @param {{file?: object, contentCatalog?: object, config?: object}} context
 * @param {function(string): void} warn
 * @returns {object|undefined}
 */
// Per page, so a page with several explorers converts and warns once.
const $metaByPage = new WeakMap();

function propertyMeta (context, warn) {
  const contentCatalog = context && context.contentCatalog;
  const file = context && context.file;
  if (!contentCatalog || !file || !file.src) return undefined;
  if (!$metaByPage.has(file)) $metaByPage.set(file, buildPropertyMeta(contentCatalog, file, context.config || {}, warn));
  return $metaByPage.get(file);
}

function buildPropertyMeta (contentCatalog, file, asciidocConfig, warn) {
  // Required here, not at the top: both pull in Antora's AsciiDoc loader, a
  // peer dependency that plain Asciidoctor harnesses do not install.
  const { loadPropertiesFor, isAvailable } = require('./prop');
  const { render, convertXref } = require('../extensions/render-property-descriptions');

  const component = file.src.component || '';
  const version = file.src.version || '';
  const where = `${component || 'unknown component'} ${version || '(unversioned)'}`;
  const registry = loadPropertiesFor(contentCatalog, component, version);
  if (!registry) {
    warn(
      `no redpanda-properties-<tag>.json covers ${where}, so the explorer for ${MOUNT_PROPERTY} carries no ` +
      'property metadata (description, default, see also).'
    );
    return undefined;
  }
  const source = `redpanda-properties-${registry.tag}.json`;
  const entry = Object.prototype.hasOwnProperty.call(registry.properties, MOUNT_PROPERTY)
    ? registry.properties[MOUNT_PROPERTY]
    : undefined;
  if (!entry || typeof entry !== 'object') {
    warn(
      `${MOUNT_PROPERTY} is not in ${source}, the property data for ${where}, so the explorer carries no ` +
      'property metadata. Check that this release has the property.'
    );
    return undefined;
  }

  const meta = {};
  if (typeof entry.description === 'string' && entry.description.trim()) {
    try {
      meta.description = htmlToText(render(entry.description, file, contentCatalog, asciidocConfig) || '');
    } catch (err) {
      warn(`the ${MOUNT_PROPERTY} description in ${source} could not be converted (${err.message}), so it is left out.`);
    }
    if (!meta.description) delete meta.description;
  }
  if (entry.default !== undefined) meta.default = entry.default;
  if (typeof entry.is_enterprise === 'boolean') meta.is_enterprise = entry.is_enterprise;
  if (registry.surface === 'cloud') {
    meta.cloud_supported = typeof entry.cloud_supported === 'boolean' ? entry.cloud_supported : null;
    if (!isAvailable(registry, entry)) {
      warn(`${MOUNT_PROPERTY} is marked cloud_supported: false in ${source}, but this is a Cloud page.`);
    }
  }
  // Datasets generated before see_also existed (v26.1 and earlier) carry the
  // same links as related_topics.
  const links = Array.isArray(entry.see_also) ? entry.see_also
    : Array.isArray(entry.related_topics) ? entry.related_topics : [];
  const seeAlso = links
    .map((item) => seeAlsoLink(item, { file, contentCatalog, asciidocConfig, registry, convertXref, warn, source }))
    .filter(Boolean);
  if (seeAlso.length) meta.see_also = seeAlso;
  meta.source = source;
  return meta;
}

// xref:target[label], the form see_also entries are generated in.
const XREF_ITEM_RX = /^xref:([^[\]\s]+)\[([^\]]*)\]$/;
const URL_ITEM_RX = /^(?:link:)?(https?:\/\/[^[\s]+)\[([^\]]*)\]$/;

/**
 * One see_also entry as {href, text}, resolved by Antora as an xref on this
 * page would be. A target this page's component lacks (Cloud reusing a
 * self-managed link) is retried in the component and version the dataset came
 * from. Anything that resolves nowhere is reported and dropped: a link the
 * build could not verify would be a broken link.
 */
function seeAlsoLink (item, { file, contentCatalog, asciidocConfig, registry, convertXref, warn, source }) {
  if (typeof item !== 'string') return undefined;
  const value = item.trim();
  const url = URL_ITEM_RX.exec(value);
  if (url) return { href: url[1], text: url[2] || url[1] };
  const xref = XREF_ITEM_RX.exec(value);
  if (!xref) {
    warn(`see_also entry "${value}" for ${MOUNT_PROPERTY} in ${source} is not an xref or URL, so it is left out.`);
    return undefined;
  }
  const attempts = [xref[1]];
  // module:path is relative to the dataset's component; qualify it for a page
  // in another component. A target that already names a component is not.
  if (xref[1].split(':').length === 2 && registry.component && registry.component !== file.src.component) {
    const owner = registry.version ? `${registry.version}@${registry.component}` : registry.component;
    attempts.push(`${owner}:${xref[1]}`);
  }
  // Ask the catalog first: converting an xref that does not resolve logs an
  // Asciidoctor error, which a build that fails on errors would fail on.
  const context = { component: file.src.component, version: file.src.version, module: file.src.module };
  const exists = (target) => {
    if (typeof contentCatalog.resolvePage !== 'function') return true;
    try {
      return Boolean(contentCatalog.resolvePage(target.split('#')[0], context));
    } catch {
      return false;
    }
  };
  for (const target of attempts) {
    if (!exists(target)) continue;
    const anchor = convertXref(`xref:${target}[${xref[2]}]`, file, contentCatalog, asciidocConfig);
    if (!anchor) continue;
    const href = /\bhref="([^"]*)"/.exec(anchor);
    if (!href) continue;
    return { href: decodeEntities(href[1]), text: htmlToText(anchor) };
  }
  warn(`see_also entry "${value}" for ${MOUNT_PROPERTY} in ${source} does not resolve to a page, so it is left out.`);
  return undefined;
}

/** Plain text from converted inline HTML, as the contract's description wants. */
function htmlToText (html) {
  return decodeEntities(String(html).replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

function decodeEntities (text) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : match;
    }
    return Object.prototype.hasOwnProperty.call(named, code.toLowerCase()) ? named[code.toLowerCase()] : match;
  });
}

/**
 * Check the author's config with Redpanda's own grammar for the page's
 * version (extension-utils/iceberg-mode.js, which reads which release accepts
 * what from the generated extension-utils/iceberg-mode-releases.json). An invalid value is still
 * emitted unchanged: docs-ui shows the problem in the explorer, and replacing
 * it with defaults would publish a different config than the page's prose
 * describes. The build warning is how the author finds out first.
 * @param {string} config
 * @param {string} version
 * @param {function(string): void} warn
 */
function validateConfig (config, version, warn) {
  const result = icebergMode.validateIcebergMode(config, { version });
  if (result.ok) return;
  if (result.unverified) {
    warn(`config="${config}" was not checked: ${result.error}.`);
    return;
  }
  const forVersion = version ? ` for version ${version}` : '';
  const detail = result.reason ? `${result.error} (${result.reason})` : result.error;
  warn(
    `config="${config}" is not a valid ${MOUNT_PROPERTY} value${forVersion}: ${detail}. ` +
    'The mount keeps this value so the explorer can show the error.'
  );
}

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

/**
 * Validate the `engine-base` attribute as a same-origin, root-relative path.
 * docs-ui loads `<engine-base>/iceberg-engine-<version>.js` as a script, so any
 * other value would let page source run another origin's JavaScript on the docs
 * site. Escaping stops HTML injection but does not make a URL trustworthy, so
 * reject schemes, protocol-relative paths (`//host`), backslashes (which
 * browsers treat as `/`), whitespace, and raw or percent-encoded control
 * characters.
 * @param {string} raw
 * @param {function(string): void} warn
 * @returns {string} A safe root-relative path, or '' to use the docs-ui default.
 */
function rootRelativePath (raw, warn) {
  if (!raw) return '';
  const value = String(raw);
  const safe =
    /^\/(?![\/\\])/.test(value) &&
    !/[\\\s\x00-\x1f\x7f]/.test(value) &&
    !/%(?:[01][0-9a-f]|7f|5c)/i.test(value);
  if (safe) return value;
  warn(
    `engine-base="${value}" is not a root-relative path on this site (for example, /_/engine/26.2). ` +
    'Ignoring it, so docs-ui loads the engine from its default location.'
  );
  return '';
}

module.exports.MOUNT_ATTRIBUTE = MOUNT_ATTRIBUTE;
module.exports.MOUNT_CONTRACT_VERSION = MOUNT_CONTRACT_VERSION;
module.exports.MOUNT_PROPERTY = MOUNT_PROPERTY;
module.exports.MOUNT_CLASS = MOUNT_CLASS;
module.exports.MOUNT_SELECTOR = MOUNT_SELECTOR;
module.exports.rootRelativePath = rootRelativePath;
module.exports.htmlToText = htmlToText;

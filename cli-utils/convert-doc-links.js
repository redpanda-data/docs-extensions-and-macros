const { URL } = require('url');

/**
 * Maps docs.redpanda.com URL path slugs to Antora component names.
 *
 * The generated output of this converter lands in the Self-Managed docs
 * (redpanda-data/docs, Antora component `streaming`), so URLs to other doc
 * sets must emit fully qualified `xref:component:module:page.adoc` resource
 * IDs instead of being treated as a module in the current component.
 *
 * Each entry is verified against the target repo's antora.yml `name:` key.
 * Legacy slugs are included because docs.redpanda.com serves 301 redirects
 * from them to the component-name slug (for example,
 * /redpanda-connect/... -> /connect/...).
 */
const COMPONENT_SLUG_MAP = {
  // rp-connect-docs (antora.yml name: connect)
  'redpanda-connect': 'connect', // legacy slug
  'connect': 'connect',
  // cloud-docs (antora.yml name: cloud-data-platform)
  'redpanda-cloud': 'cloud-data-platform', // legacy slug
  'cloud-data-platform': 'cloud-data-platform',
  // redpanda-labs (docs/antora.yml name: labs on main, the branch the site
  // playbook builds; live check 2026-08-03: /labs/ serves 200 and
  // /redpanda-labs/ serves a 301 to it)
  'redpanda-labs': 'labs', // legacy slug
  'labs': 'labs',
  // redpanda-data/docs (antora.yml name: streaming). Self-qualified so that
  // versioned URLs such as /streaming/current/... resolve correctly.
  'streaming': 'streaming',
  // adp-docs (antora.yml name: agentic-data-plane)
  'agentic-data-plane': 'agentic-data-plane',
  // docs-site umbrella components (home/antora.yml, data-platform/antora.yml,
  // self-managed/antora.yml)
  'home': 'home',
  'data-platform': 'data-platform',
  'self-managed': 'self-managed',
};

/**
 * Landing module:page for components whose antora.yml start_page is not the
 * ROOT module index. A component-only URL such as /connect/ must resolve to
 * the component's real start page: connect and cloud-data-platform have no
 * ROOT index.adoc, so xref:<comp>::index.adoc would be a broken xref.
 * Components absent from this map (labs and the docs-site umbrella
 * components) have a ROOT index.adoc, where ::index.adoc is correct.
 */
const COMPONENT_START_PAGE = {
  'streaming': 'home:index.adoc',
  'connect': 'home:index.adoc',
  'cloud-data-platform': 'home:index.adoc',
  'agentic-data-plane': 'home:index.adoc',
};

// Version path segment that can follow a component slug, for example
// /streaming/current/... or /streaming/25.1/... or /streaming/beta/...
const VERSION_SEGMENT_RE = /^(?:current|beta|v?\d+\.\d+)$/;

/**
 * Converts a docs.redpanda.com URL, optionally suffixed with a label in brackets, into an Antora xref resource ID string.
 *
 * If the input includes a label in square brackets (for example, `[Label]`), the label is preserved and appended to the resulting xref.
 *
 * URLs whose first path segment identifies another Antora component on
 * docs.redpanda.com (see COMPONENT_SLUG_MAP) produce a fully qualified
 * `xref:component:module:page.adoc` resource ID. All other URLs keep the
 * historical behavior: the first path segment is treated as a module in the
 * current component.
 *
 * @param {string} input - A docs.redpanda.com URL, optionally followed by a label in square brackets.
 * @returns {string} The corresponding Antora xref resource ID, with the label preserved if present.
 *
 * @throws {Error} If the input is not a valid URL or does not belong to docs.redpanda.com.
 */
function urlToXref(input) {
  // Peel off an optional “[label]”
  let urlPart  = input;
  let label    = '';
  const mLabel = input.match(/^(.*)\[([^\]]+)\]$/);
  if (mLabel) {
    urlPart = mLabel[1];
    label   = mLabel[2];
  }

  //Parse & validate
  let url;
  try {
    url = new URL(urlPart);
  } catch {
    throw new Error(`Invalid URL: ${input}`);
  }
  if (!/docs\.redpanda\.com$/.test(url.hostname)) {
    throw new Error(`Not a docs.redpanda.com URL: ${input}`);
  }

  // Strip any leading “/docs”, “/docs/vX.Y”, “/docs/current”, “/vX.Y” or “/current”
  let p = url.pathname.replace(
    /^\/(?:docs(?:\/(?:v?\d+\.\d+|current))?|v?\d+\.\d+|current)\/?/,
    ''
  );
  // Legacy URLs carry a /docs or version prefix and always point into the
  // current component, so the slug map only applies when nothing was stripped.
  const hadLegacyPrefix = p !== url.pathname;
  // Drop trailing slash
  p = p.replace(/\/$/, '');
  const segments = p.split('/').filter(Boolean);

  // Build module + path + .adoc
  let xref;
  const component = !hadLegacyPrefix && segments.length > 0
    ? COMPONENT_SLUG_MAP[segments[0]]
    : undefined;
  if (segments.length === 0) {
    xref = 'xref:index.adoc';
  } else if (component) {
    // Cross-component URL: emit a fully qualified resource ID.
    segments.shift();
    // Drop a version segment that may follow the slug (for example
    // /streaming/current/manage/...)
    if (segments.length > 0 && VERSION_SEGMENT_RE.test(segments[0])) {
      segments.shift();
    }
    if (segments.length === 0) {
      const startPage = COMPONENT_START_PAGE[component];
      xref = startPage ? `xref:${component}:${startPage}` : `xref:${component}::index.adoc`;
    } else {
      const moduleName = segments.shift();
      const fileName   = (segments.length > 0 ? segments.join('/') : 'index') + '.adoc';
      xref = `xref:${component}:${moduleName}:${fileName}`;
    }
  } else {
    const moduleName = segments.shift();
    const pagePath   = segments.join('/');
    const fileName   = (pagePath || moduleName) + '.adoc';
    xref = `xref:${moduleName}:${fileName}`;
  }

  // Preserve the URL fragment: deep links like
  // .../cluster-properties/#kafka_batch_max_bytes must keep their anchor
  // (previously the fragment was silently dropped).
  if (url.hash && url.hash.length > 1) {
    xref += url.hash;
  }

  // Re-attach label if there was one
  return label ? `${xref}[${label}]` : xref;
}

module.exports = { urlToXref };

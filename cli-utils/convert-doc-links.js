const { URL } = require('url');

/**
 * Convert a docs.redpanda.com URL (optionally suffixed with “[label]”) into
 * an Antora xref resource ID, preserving that label in brackets.
 *
 * Example:
 *   urlToXref('https://docs.redpanda.com/v25.1/reference/configuration/[Config]')
 *   // → 'xref:reference:configuration.adoc[Config]'
 *
 * @param {string} input
 * @returns {string}
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
  // Drop trailing slash
  p = p.replace(/\/$/, '');
  const segments = p.split('/').filter(Boolean);

  // Build module + path + .adoc
  let xref;
  if (segments.length === 0) {
    xref = 'xref:index.adoc';
  } else {
    const moduleName = segments.shift();
    const pagePath   = segments.join('/');
    const fileName   = (pagePath || moduleName) + '.adoc';
    xref = `xref:${moduleName}:${fileName}`;
  }

  // Re-attach label if there was one
  return label ? `${xref}[${label}]` : xref;
}

module.exports = { urlToXref };

const { URL } = require('url');

/**
 * Converts a docs.redpanda.com URL, optionally suffixed with a label in brackets, into an Antora xref resource ID string.
 *
 * If the input includes a label in square brackets (e.g., `[Label]`), the label is preserved and appended to the resulting xref.
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

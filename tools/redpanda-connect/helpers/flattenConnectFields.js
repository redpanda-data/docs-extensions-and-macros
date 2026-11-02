'use strict';

/**
 * Shared walker for Redpanda Connect field trees.
 *
 * This is a plain module, not a Handlebars helper, so it is deliberately not
 * exported from helpers/index.js. It exists because the same recursion was
 * written four times (the reference-page renderer, the fields-only table
 * extension and the connector delta report), and the copies disagreed about
 * what a field path looks like. The renderer is the authority: the path this
 * module produces must match the `=== ` heading renderConnectFields emits,
 * because the what's-new tables link to those headings.
 */

/**
 * Field name as it appears in the rendered docs: an array-of-object field
 * carries an `[]` marker so the path is a valid config path.
 * @param {object} field - Field definition
 * @returns {string} Display name for the field
 */
function connectFieldName (field) {
  const name = field && field.name;
  if (typeof name === 'string' && field.kind === 'array' && !name.endsWith('[]')) {
    return `${name}[]`;
  }
  return name;
}

/**
 * Walk a field tree depth-first and return one entry per field, in the order
 * the fields appear in the source data.
 *
 * A field nested under an existing group (for example
 * `sqs.zero_key_warn_interval` under aws_s3's pre-existing `sqs` group) is
 * only visible to a set-based diff if the tree is flattened first: a map of
 * top-level names alone treats that as no change at all, because `sqs` itself
 * is not new.
 *
 * Nameless nodes are skipped along with their subtree, matching
 * renderConnectFields: a node with no name gets no heading, so nothing under
 * it is addressable in the published docs.
 *
 * @param {Array} children - Field definitions (each may itself have `children`)
 * @param {object} [opts] - { arrayMarker, skipDeprecated, prefix }
 * @param {boolean} [opts.arrayMarker=false] - Append `[]` to array-of-object names
 * @param {boolean} [opts.skipDeprecated=false] - Skip deprecated fields and their subtrees
 * @param {string} [opts.prefix=''] - Dotted path of the parent, if any
 * @returns {Array<{path: string, name: string, parentPath: (string|null), field: object}>}
 */
function flattenConnectFields (children, opts = {}) {
  const { arrayMarker = false, skipDeprecated = false, prefix = '' } = opts;
  const result = [];

  const walk = (list, currentPrefix, parentPath) => {
    if (!Array.isArray(list)) return;
    list.forEach(field => {
      if (!field || !field.name) return;
      if (skipDeprecated && field.is_deprecated) return;

      const name = arrayMarker ? connectFieldName(field) : field.name;
      const path = currentPrefix ? `${currentPrefix}.${name}` : `${name}`;

      result.push({ path, name, parentPath, field });
      walk(field.children, path, path);
    });
  };

  walk(children, prefix, prefix || null);

  return result;
}

module.exports = { flattenConnectFields, connectFieldName };

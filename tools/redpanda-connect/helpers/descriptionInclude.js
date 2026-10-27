'use strict';

const { descriptionIncludeLine } = require('../metadata-utils.js');

/**
 * Handlebars helper: emit the include directive for a connector's description
 * partial, optionally for one of its tag regions.
 *
 *   {{{descriptionInclude this 'meta'}}}
 *   {{{descriptionInclude this 'body'}}}
 *
 * Drafted pages use this instead of freezing the summary and description into
 * the page, so an upstream wording change reaches the published page on the
 * next generator run. Delegates to descriptionIncludeLine so the path a page
 * carries is built by the same function that decides where the generator
 * writes the file.
 *
 * @param {object} item connector data with `type`/`typeDir` and `name`
 * @param {string} [tag] `meta` or `body`
 * @returns {string}
 */
module.exports = function descriptionInclude (item, tag) {
  return descriptionIncludeLine(item, typeof tag === 'string' ? tag : undefined);
};

'use strict'

// The workspace the original language server suites use: a streaming
// component with the sample property JSON and the shared taxonomy. Built
// with fixture.js, which new feature tests should use directly.

const { buildWorkspace, noFetch } = require('./fixture')

/**
 * @param {Object} [options]
 * @param {string} [options.name='streaming']
 * @param {string|null} [options.version='26.2']
 * @param {Object} [options.attributes]
 * @param {boolean} [options.properties=true] - publish the property JSON
 * @param {boolean} [options.taxonomy=true] - include the shared taxonomy
 * @param {Object<string,string>} [options.pages] - relative path -> content
 * @returns {string} the workspace root
 */
function makeWorkspace ({ name = 'streaming', version = '26.2', attributes = {}, properties = true, taxonomy = true, pages = {} } = {}) {
  return buildWorkspace({ component: { name, version, attributes }, properties, taxonomy, pages })
}

module.exports = { makeWorkspace, noFetch }

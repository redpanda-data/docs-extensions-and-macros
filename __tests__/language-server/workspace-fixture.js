'use strict'

// Builds docs-repository workspaces in a temp directory for the language
// server tests. The data is not hand-written for these tests: the property
// JSON is the excerpt of the published v26.2.4 file that the propval: tests
// use, and the taxonomy, its schema and valid-categories.yml are the fixtures
// the taxonomy and check-metadata tests run on.

const fs = require('fs')
const os = require('os')
const path = require('path')
const yaml = require('js-yaml')

const FIXTURES = path.join(__dirname, '..', 'fixtures')
const PROPERTIES = path.join(FIXTURES, 'propval', 'redpanda-properties-v26.2.4-sample.json')
const TAXONOMY_DIR = path.join(FIXTURES, 'taxonomy')

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-ls-'))
  fs.writeFileSync(path.join(root, 'antora.yml'), yaml.dump({ name, version, asciidoc: { attributes } }))
  if (properties) {
    const dir = path.join(root, 'modules', 'reference', 'attachments')
    fs.mkdirSync(dir, { recursive: true })
    fs.copyFileSync(PROPERTIES, path.join(dir, 'redpanda-properties-v26.2.4.json'))
  }
  if (taxonomy) {
    const dir = path.join(root, 'shared', 'modules', 'ROOT', 'attachments')
    fs.mkdirSync(dir, { recursive: true })
    for (const file of ['taxonomy.yml', 'taxonomy.schema.json']) fs.copyFileSync(path.join(TAXONOMY_DIR, file), path.join(dir, file))
    const partials = path.join(root, 'shared', 'modules', 'ROOT', 'partials')
    fs.mkdirSync(partials, { recursive: true })
    fs.copyFileSync(path.join(TAXONOMY_DIR, 'valid-categories.yml'), path.join(partials, 'valid-categories.yml'))
  }
  for (const [relative, content] of Object.entries(pages)) {
    const abs = path.join(root, relative)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content)
  }
  return root
}

// The published taxonomy is never fetched in tests.
const noFetch = async () => ({ status: 404, ok: false, headers: { get: () => 'text/plain' } })

module.exports = { makeWorkspace, noFetch }

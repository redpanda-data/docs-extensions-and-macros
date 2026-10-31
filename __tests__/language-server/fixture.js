'use strict'

// Builds a docs-repository workspace in a temp directory from named parts, so
// each feature module's tests add the fixtures they need without touching
// another module's. Shared data is copied from the fixtures other suites
// already run on, never hand-written here: the property JSON is the excerpt
// of the published v26.2.4 file that the propval: tests use, and the
// taxonomy, its schema and valid-categories.yml are the taxonomy and
// check-metadata fixtures.
//
//   buildWorkspace({
//     component: { name: 'streaming', version: '26.2', attributes: {} },
//     properties: true,            // or { file, tag }
//     taxonomy: true,
//     terms: { acl: '=== access control list (ACL)\n:hover-text: ...\n' },
//     registry: { features: [...] },   // or YAML text
//     playbook: { site: {...} },       // or { path, content }
//     pages: { 'modules/manage/pages/a.adoc': '= A\n' },
//     files: { 'docs-data/property-overrides.json': { properties: {} } },
//   })
//
// A module with a part of its own passes it as a builder instead of editing
// this file: buildWorkspace(spec, { parts: { myPart: (root, value, spec) => {} } }).

const fs = require('fs')
const os = require('os')
const path = require('path')
const yaml = require('js-yaml')

const FIXTURES = path.join(__dirname, '..', 'fixtures')
const PROPERTIES = path.join(FIXTURES, 'propval', 'redpanda-properties-v26.2.4-sample.json')
const TAXONOMY_DIR = path.join(FIXTURES, 'taxonomy')

const SHARED = path.join('shared', 'modules')

function write (root, relative, content) {
  const abs = path.join(root, relative)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, typeof content === 'string' ? content : JSON.stringify(content, null, 2))
  return abs
}

function copy (from, root, relative) {
  const abs = path.join(root, relative)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.copyFileSync(from, abs)
}

// The shared component's descriptor, as in the docs repo. Written by the
// parts that live in it, so a page under shared/ finds its own component.
function sharedComponent (root) {
  const descriptor = path.join(root, 'shared', 'antora.yml')
  if (!fs.existsSync(descriptor)) write(root, path.join('shared', 'antora.yml'), yaml.dump({ name: 'shared', version: null }))
}

const PARTS = {
  component (root, { name = 'streaming', version = '26.2', attributes = {} } = {}) {
    write(root, 'antora.yml', yaml.dump({ name, version, asciidoc: { attributes } }))
  },
  properties (root, value) {
    if (!value) return
    const { file = PROPERTIES, tag = 'v26.2.4' } = value === true ? {} : value
    copy(file, root, path.join('modules', 'reference', 'attachments', `redpanda-properties-${tag}.json`))
  },
  taxonomy (root, value) {
    if (!value) return
    for (const file of ['taxonomy.yml', 'taxonomy.schema.json']) copy(path.join(TAXONOMY_DIR, file), root, path.join(SHARED, 'ROOT', 'attachments', file))
    copy(path.join(TAXONOMY_DIR, 'valid-categories.yml'), root, path.join(SHARED, 'ROOT', 'partials', 'valid-categories.yml'))
  },
  terms (root, terms) {
    if (!terms) return
    sharedComponent(root)
    for (const [id, content] of Object.entries(terms)) write(root, path.join(SHARED, 'terms', 'partials', `${id}.adoc`), content)
  },
  registry (root, registry) {
    if (!registry) return
    sharedComponent(root)
    write(root, path.join(SHARED, 'ROOT', 'partials', 'enterprise-features.yml'), typeof registry === 'string' ? registry : yaml.dump(registry))
  },
  playbook (root, playbook) {
    if (!playbook) return
    const { path: relative = 'antora-playbook.yml', content = playbook } = playbook.content !== undefined ? playbook : {}
    write(root, relative, typeof content === 'string' ? content : yaml.dump(content))
  },
  pages (root, pages) {
    for (const [relative, content] of Object.entries(pages || {})) write(root, relative, content)
  },
  files (root, files) {
    for (const [relative, content] of Object.entries(files || {})) write(root, relative, content)
  },
}

/**
 * @param {Object} [spec] - part name -> value; `component` is always written
 * @param {Object} [options]
 * @param {Object<string,Function>} [options.parts] - extra part builders
 * @returns {string} the workspace root
 */
function buildWorkspace (spec = {}, { parts = {} } = {}) {
  const builders = { ...PARTS, ...parts }
  const unknown = Object.keys(spec).filter((k) => !builders[k])
  if (unknown.length) throw new Error(`fixture: no part named ${unknown.join(', ')}`)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-ls-'))
  builders.component(root, spec.component, spec)
  for (const [name, value] of Object.entries(spec)) if (name !== 'component') builders[name](root, value, spec)
  return root
}

// The published taxonomy is never fetched in tests.
const noFetch = async () => ({ status: 404, ok: false, headers: { get: () => 'text/plain' } })

module.exports = { buildWorkspace, noFetch, PARTS, write }

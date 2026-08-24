'use strict'

const fs = require('fs')
const path = require('path')
const yaml = require('js-yaml')

const { SourceCache } = require('../source-text')
const { collectGoFiles } = require('../go-source')

/**
 * CRD surface: Go doc comments above struct fields in the operator API
 * types (operator/api/redpanda/...). These comments ship verbatim to the
 * generated CRD reference on docs.redpanda.com AND to `kubectl explain`.
 *
 * User-facing filtering mirrors crd-ref-docs: the surface reads
 * operator/crd-ref-docs-config.yaml for the `hidefromdoc` custom marker and
 * the processor ignoreTypes/ignoreFields regexes, so fields the generator
 * never documents are never linted.
 *
 * Marker lines (+kubebuilder:..., +optional, +required, +genclient, and any
 * other +directive) are stripped before the prose is judged.
 *
 * The signature bad pattern here is a description that leads with the Go
 * field identifier ("ClusterSource is a reference to...") when users type
 * the json key ("cluster") - the docs and kubectl explain both show the
 * json name, so the Go name means nothing to readers.
 */

const CONVENTION = {
  case: 'sentence',
  terminal_period: true,
  verbatim_asciidoc: true
}

const API_ROOT = path.join('operator', 'api', 'redpanda')
const CONFIG_PATH = path.join('operator', 'crd-ref-docs-config.yaml')

/**
 * Compile a list of regex source strings, skipping (with a warning) any
 * pattern that isn't valid JS regex syntax instead of throwing. The config
 * file is written for a Go tool (crd-ref-docs), so it can legally contain
 * Go/RE2-only constructs like `(?i)` or `(?P<name>...)` that JS's RegExp
 * rejects - one such pattern must not abort the entire lint run.
 */
function compilePatterns (patterns, configKey) {
  const compiled = []
  for (const p of patterns) {
    try {
      compiled.push(new RegExp(p))
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`lint-strings: skipping invalid ${configKey} pattern in ${CONFIG_PATH} (${JSON.stringify(p)}): ${err.message}`)
    }
  }
  return compiled
}

/** Load ignore rules from crd-ref-docs-config.yaml (absent file = no rules). */
function loadConfig (repo) {
  const configPath = path.join(repo, CONFIG_PATH)
  const config = { ignoreTypes: [], ignoreFields: [], hiddenMarker: 'hidefromdoc' }
  if (!fs.existsSync(configPath)) return config
  const parsed = yaml.load(fs.readFileSync(configPath, 'utf8')) || {}
  const processor = parsed.processor || {}
  config.ignoreTypes = compilePatterns(processor.ignoreTypes || [], 'processor.ignoreTypes')
  config.ignoreFields = compilePatterns(processor.ignoreFields || [], 'processor.ignoreFields')
  return config
}

function matchesAny (patterns, ...candidates) {
  return patterns.some((pattern) => candidates.some((c) => pattern.test(c)))
}

/**
 * Parse one Go file's struct fields. Exported for tests.
 *
 * @param {string} content - File content
 * @param {string} file - Repo-relative path
 * @param {Object} config - From loadConfig
 * @returns {Array} declarations (without declaration_text)
 */
function scanFile (content, file, config = { ignoreTypes: [], ignoreFields: [], hiddenMarker: 'hidefromdoc' }) {
  const declarations = []
  const lines = content.split('\n')
  const packageMatch = content.match(/^package\s+(\w+)/m)
  const pkg = packageMatch ? packageMatch[1] : ''

  let comment = [] // pending comment lines: { line (0-indexed), text }
  let struct = null // { name, hidden } while inside a struct body
  let depth = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()

    if (struct === null) {
      if (/^\s*\/\//.test(line)) {
        comment.push({ line: i, text: trimmed.replace(/^\/\/\s?/, '') })
        continue
      }
      const typeMatch = line.match(/^type\s+([A-Za-z0-9_]+)\s+struct\s*\{/)
      if (typeMatch) {
        const name = typeMatch[1]
        const hidden = comment.some((c) => c.text.trim().startsWith(`+${config.hiddenMarker}`)) ||
          matchesAny(config.ignoreTypes, name, `${pkg}.${name}`)
        struct = { name, hidden, exported: /^[A-Z]/.test(name) }
        depth = 1
        comment = []
        continue
      }
      if (trimmed !== '') comment = []
      continue
    }

    // Inside a struct body.
    if (/^\s*\/\//.test(line)) {
      comment.push({ line: i, text: trimmed.replace(/^\/\/\s?/, '') })
      continue
    }
    if (trimmed === '') {
      comment = []
      continue
    }

    // Track nested braces (anonymous struct fields) without leaving the type.
    const opens = (trimmed.match(/\{/g) || []).length
    const closes = (trimmed.match(/\}/g) || []).length
    const fieldMatch = line.match(/^\s*([A-Z][A-Za-z0-9_]*)\s+\S/)
    if (fieldMatch && depth === 1 && !struct.hidden && struct.exported) {
      const goName = fieldMatch[1]
      const tagMatch = line.match(/`[^`]*json:"([^",]*)[^`]*`/)
      const jsonName = tagMatch ? tagMatch[1] : null
      const hiddenField = comment.some((c) => c.text.trim().startsWith(`+${config.hiddenMarker}`))
      // Only json-serialized, non-inline, non-ignored fields ship to users.
      if (jsonName && jsonName !== '-' && !hiddenField &&
          !matchesAny(config.ignoreFields, goName, goName.toLowerCase(), jsonName)) {
        const prose = comment
          .filter((c) => !c.text.trim().startsWith('+'))
          .map((c) => c.text)
          .join('\n')
          .trim()
        declarations.push({
          surface: 'crd',
          name: jsonName,
          file,
          line_start: (comment.length > 0 ? comment[0].line : i) + 1,
          line_end: i + 1,
          string: prose || null,
          declaration_text: null,
          convention: CONVENTION,
          meta: {
            kind: 'field',
            struct: struct.name,
            go_name: goName,
            json_name: jsonName
          }
        })
      }
    }
    comment = []
    depth += opens - closes
    if (depth <= 0) struct = null
  }

  return declarations
}

/**
 * Extract CRD field declarations.
 *
 * @param {Object} options - { repo, files (Set of repo-relative paths, diff
 *   mode; when omitted, scans operator/api/redpanda), log }
 */
function extract ({ repo, files = null }) {
  const config = loadConfig(repo)
  let fileList
  if (files) {
    fileList = [...files].filter((f) => f.endsWith('.go') && !f.endsWith('_test.go') && !path.basename(f).startsWith('zz_generated'))
  } else {
    fileList = collectGoFiles(path.join(repo, API_ROOT))
      .filter((f) => !path.basename(f).startsWith('zz_generated'))
      .map((f) => path.join(API_ROOT, f))
  }

  const cache = new SourceCache(repo)
  const declarations = []
  for (const file of fileList) {
    const absPath = path.isAbsolute(file) ? file : path.join(repo, file)
    if (!fs.existsSync(absPath)) continue
    const content = fs.readFileSync(absPath, 'utf8')
    if (!content.includes('struct')) continue
    for (const decl of scanFile(content, file, config)) {
      decl.declaration_text = cache.span(file, decl.line_start, decl.line_end)
      declarations.push(decl)
    }
  }
  return declarations
}

/** Surface-specific convention rules. */
const RULES = [
  {
    name: 'undocumented-field',
    description: 'Exported user-facing field with no doc comment',
    severity: 'warning',
    check: (decl) => {
      if (decl.string !== null) return []
      return [{ message: `Field "${decl.meta.go_name}" (json: "${decl.name}") in ${decl.meta.struct} has no doc comment. It ships blank in the CRD reference and in kubectl explain.` }]
    }
  },
  {
    name: 'go-field-name-first',
    description: 'Description leads with the Go field name instead of the YAML key',
    severity: 'warning',
    check: (decl) => {
      const text = (decl.string || '').trim()
      if (!text) return []
      const firstWord = (text.match(/^[A-Za-z0-9_]+/) || [null])[0]
      if (!firstWord) return []
      if (firstWord === decl.meta.go_name &&
          decl.meta.go_name.toLowerCase() !== decl.meta.json_name.toLowerCase()) {
        return [{ message: `Description starts with the Go field name "${decl.meta.go_name}", but users type "${decl.meta.json_name}" in YAML. Describe the json key: "${decl.meta.json_name}" (or start with what the field does).` }]
      }
      return []
    }
  }
]

module.exports = {
  name: 'crd',
  convention: CONVENTION,
  extract,
  scanFile,
  loadConfig,
  rules: RULES,
  // Missing prose is surfaced by the crd-specific undocumented-field rule
  // (warning, per the docs contract) instead of the generic error.
  skipRules: ['empty-description']
}

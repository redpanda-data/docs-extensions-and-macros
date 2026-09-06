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
 *
 * A field with NO doc comment does not necessarily ship blank.
 * controller-gen falls back to the doc comment of the field's TYPE, so
 *
 *   // +optional
 *   OAUth *KafkaSASLOAuthBearer `json:"oauth,omitempty"`
 *
 * publishes "KafkaSASLOAuthBearer is the config struct for the SASL
 * OAuthBearer mechanism" - the Go type's comment, under the key `oauth`.
 * Verified by running controller-gen v0.20.1 over a fixture covering every
 * shape:
 *
 *   field comment present          -> the field's comment (beats the type's)
 *   no comment, ref to typed X     -> X's doc comment, INHERITED
 *   no comment, ref to undocumented X -> blank
 *   no comment, primitive          -> blank
 *   no comment, []X or map[K]X     -> BLANK on the field itself; X's comment
 *                                     lands on items/additionalProperties
 *
 * So `undocumented-field` must only fire where the description genuinely
 * ships blank. Of 208 findings on operator main it was wrong on 37: 19
 * inheriting a local type's comment and 18 an external one's. The inherited
 * case is still a defect - 18 of those 19 lead with the Go type name - but
 * it is a different one, so it gets its own rule and its own message.
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
 * Go predeclared types. A field of one of these has nothing to inherit a
 * description from, so no comment means it genuinely ships blank.
 */
const GO_BUILTINS = new Set([
  'bool', 'string', 'byte', 'rune', 'error', 'any',
  'int', 'int8', 'int16', 'int32', 'int64',
  'uint', 'uint8', 'uint16', 'uint32', 'uint64', 'uintptr',
  'float32', 'float64', 'complex64', 'complex128'
])

/**
 * Doc comments on the `type` declarations in one file, as
 * `name -> prose`. Marker lines are stripped, matching what controller-gen
 * publishes.
 *
 * Collected per file and merged across the tree by `extract`, because a
 * field's type is usually declared in a different file from the field
 * (`ValueSource` lives in common.go and is referenced from four others).
 */
function collectTypeDocs (content) {
  const docs = new Map()
  const lines = content.split('\n')
  let comment = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('//')) {
      comment.push(trimmed.replace(/^\/\/\s?/, ''))
      continue
    }
    const match = /^type\s+([A-Za-z0-9_]+)\s+/.exec(line)
    if (match) {
      const prose = comment.filter((c) => !c.trim().startsWith('+')).join('\n').trim()
      if (prose) docs.set(match[1], prose)
      comment = []
      continue
    }
    if (trimmed !== '') comment = []
  }
  return docs
}

/**
 * Where an uncommented field's published description will come from.
 *
 * @param {string} line - The field's source line
 * @param {Map} typeDocs - name -> doc comment, from collectTypeDocs
 * @returns {{blank: true}|{blank: false, from: string, external: boolean}}
 */
function describeFallback (line, typeDocs) {
  const match = /^\s*[A-Z][A-Za-z0-9_]*\s+([^`]+?)\s*(?:`|$)/.exec(line)
  if (!match) return { blank: true }
  const typeExpr = match[1].trim()
  // A slice or map inherits onto items/additionalProperties, never onto the
  // field, so the field's own description is blank either way.
  if (/^\[\]|^map\[/.test(typeExpr)) return { blank: true }
  const bare = typeExpr.replace(/^[*&]+/, '')
  if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(bare)) return { blank: true }
  if (GO_BUILTINS.has(bare)) return { blank: true }
  // A qualified name is declared in another package (corev1.ResourceRequirements),
  // whose doc comment is not in this checkout. Empirically all 18 such fields
  // in the operator API inherit real prose, so claiming they ship blank would
  // be wrong 18 times out of 18; report nothing rather than guess.
  if (bare.includes('.')) return { blank: false, from: bare, external: true }
  const doc = typeDocs.get(bare)
  if (!doc) return { blank: true }
  return { blank: false, from: bare, external: false, doc }
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
  // Repo-wide when extract supplies it; this file's own types otherwise, so a
  // standalone scanFile still resolves same-file inheritance.
  const typeDocs = config.typeDocs || collectTypeDocs(content)
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
        // Count the closing brace on this same line. `type X struct{}` opens
        // and closes at once; assuming depth 1 left the parser inside a
        // struct that had already ended, so every following `type ... struct
        // {` was read as a field line and its fields sat at depth 2, where
        // the depth === 1 gate drops them. One such declaration silently
        // blanked the rest of the file.
        const netDepth = (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length
        comment = []
        if (netDepth <= 0) continue
        struct = { name, hidden, exported: /^[A-Z]/.test(name) }
        depth = netDepth
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
        // With no comment of its own, the field publishes its TYPE's comment
        // if that type has one. Resolve which, so the rules can tell a blank
        // description from an inherited one.
        const fallback = prose ? null : describeFallback(lines[i], typeDocs)
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
            json_name: jsonName,
            // Set only when the field has no comment: the type whose comment
            // ships in its place, or null when nothing does.
            inherited_from: fallback && !fallback.blank ? fallback.from : null,
            inherited_external: Boolean(fallback && !fallback.blank && fallback.external),
            inherited_doc: fallback && !fallback.blank ? (fallback.doc || null) : null
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

  // First pass: every type doc comment in the tree, because a field's type is
  // usually declared in another file.
  const typeDocs = new Map()
  const contents = new Map()
  for (const file of fileList) {
    const absPath = path.isAbsolute(file) ? file : path.join(repo, file)
    if (!fs.existsSync(absPath)) continue
    const content = fs.readFileSync(absPath, 'utf8')
    contents.set(file, content)
    for (const [name, doc] of collectTypeDocs(content)) typeDocs.set(name, doc)
  }
  const scanConfig = { ...config, typeDocs }

  const cache = new SourceCache(repo)
  const declarations = []
  for (const file of fileList) {
    const content = contents.get(file)
    if (content === undefined) continue
    if (!content.includes('struct')) continue
    for (const decl of scanFile(content, file, scanConfig)) {
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
      // controller-gen falls back to the field type's own comment, so a
      // missing comment only ships blank when there is nothing to inherit.
      if (decl.meta.inherited_from) return []
      return [{ message: `Field "${decl.meta.go_name}" (json: "${decl.name}") in ${decl.meta.struct} has no doc comment. It ships blank in the CRD reference and in kubectl explain.` }]
    }
  },
  {
    name: 'inherited-type-description',
    description: 'Field with no comment publishes its Go type\'s comment instead',
    severity: 'warning',
    check: (decl) => {
      if (decl.string !== null || !decl.meta.inherited_from) return []
      // An external type's comment is upstream prose we do not own and cannot
      // see from this checkout; k8s' own field docs are generally good, so
      // there is nothing here to act on.
      if (decl.meta.inherited_external) return []
      const doc = (decl.meta.inherited_doc || '').split('\n')[0]
      const leadsWithTypeName = doc.startsWith(decl.meta.inherited_from)
      return [{
        message: `"${decl.name}" has no doc comment of its own, so the CRD reference and kubectl explain publish type \`${decl.meta.inherited_from}\`'s comment under it: "${doc.slice(0, 90)}"${leadsWithTypeName ? `. That opens with the Go type name, which users never type - they type "${decl.name}"` : ''}. Add a comment on the field; it takes precedence over the type's.`
      }]
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

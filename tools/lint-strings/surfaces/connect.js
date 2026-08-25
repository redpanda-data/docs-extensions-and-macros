'use strict'

const fs = require('fs')
const path = require('path')

const { SourceCache } = require('../source-text')
const {
  maskComments,
  findBalancedClose,
  splitTopLevelArgs,
  collectStringConsts,
  evalStringExpr,
  lineOf,
  collectGoFiles
} = require('../go-source')

/**
 * Connect surface: service.NewConfigSpec() Summary/Description strings and
 * service.NewXField(name).Description(...) chains in internal/impl.
 *
 * These strings are AsciiDoc page bodies (connect docs are generated from
 * them directly), so AsciiDoc constructs are LEGITIMATE here: `==` headings,
 * links, code fences, and the `raw + "`literal`" + raw` backtick
 * concatenation idiom all appear in healthy descriptions. The scanner
 * evaluates Go string concatenation (raw strings, interpreted strings, and
 * same-file constants) so those idioms resolve to the exact shipped text.
 * Descriptions built from calls or cross-file values are skipped silently -
 * suggest-only posture means silence beats guessing.
 *
 * Because a connect description IS the page body (not a table cell), the
 * verbatim raw-pipe rule is skipped: a bare `|` is valid AsciiDoc table
 * syntax in this position.
 */

const CONVENTION = {
  case: 'sentence',
  terminal_period: true,
  verbatim_asciidoc: true
}

// Field constructors that ship with NO built-in documentation: a chain on
// one of these without .Description() publishes an empty field description.
// Composite helpers (NewTLSToggledField, NewAutoRetryNacksToggleField,
// NewBatchPolicyField, ...) carry their own docs and are exempt.
const BARE_FIELD_CTORS = new Set([
  'NewStringField', 'NewStringListField', 'NewStringMapField',
  'NewStringEnumField', 'NewStringAnnotatedEnumField',
  'NewIntField', 'NewIntListField', 'NewIntMapField',
  'NewFloatField', 'NewBoolField', 'NewDurationField',
  'NewInterpolatedStringField', 'NewInterpolatedStringListField',
  'NewInterpolatedStringMapField', 'NewInterpolatedStringEnumField',
  'NewBloblangField', 'NewAnyField', 'NewAnyListField', 'NewAnyMapField',
  'NewObjectField', 'NewObjectListField', 'NewURLField'
])

const FIELD_CTOR = /\bNew([A-Z][A-Za-z0-9]*)Field\s*\(/g
const CONFIG_SPEC = /\bNewConfigSpec\s*\(\s*\)/g
const REGISTER_NAME = /\b(?:Must)?Register\w*\(\s*(?:"([^"]+)"|`([^`]+)`)\s*,/

/**
 * Follow a builder chain starting right after `startIndex` (the index just
 * past a closing paren): repeated `.Method(args)`. Returns
 * [{ method, args, openIndex, closeIndex }] and the chain end offset.
 */
function readChain (masked, startIndex) {
  const calls = []
  let i = startIndex
  for (;;) {
    const rest = masked.slice(i)
    const m = rest.match(/^\s*\.\s*([A-Za-z0-9_]+)\s*\(/)
    if (!m) break
    const openIndex = i + m[0].length - 1
    const closeIndex = findBalancedClose(masked, openIndex)
    if (closeIndex === -1) break
    calls.push({
      method: m[1],
      args: masked.slice(openIndex + 1, closeIndex),
      openIndex,
      closeIndex
    })
    i = closeIndex + 1
  }
  return { calls, end: i }
}

/**
 * Scan one file's content for connect declarations. Exported for tests.
 */
function scanFile (content, file) {
  const declarations = []
  const masked = maskComments(content)
  const consts = collectStringConsts(masked)

  // Component name: the registration literal, when the file has exactly one.
  const registerMatches = [...masked.matchAll(new RegExp(REGISTER_NAME.source, 'g'))]
  const componentName = registerMatches.length === 1
    ? (registerMatches[0][1] || registerMatches[0][2])
    : null

  // ConfigSpec chains -> Summary / Description declarations.
  CONFIG_SPEC.lastIndex = 0
  let match
  while ((match = CONFIG_SPEC.exec(masked)) !== null) {
    const { calls } = readChain(masked, match.index + match[0].length)
    for (const call of calls) {
      if (call.method !== 'Summary' && call.method !== 'Description') continue
      const result = evalStringExpr(call.args, consts)
      if (!result.verifiable) continue // built dynamically; skip silently
      declarations.push({
        surface: 'connect',
        name: componentName,
        file,
        line_start: lineOf(masked, call.openIndex),
        line_end: lineOf(masked, call.closeIndex),
        string: result.value.trim() === '' ? null : result.value.trim(),
        declaration_text: null,
        convention: CONVENTION,
        meta: { kind: call.method.toLowerCase() }
      })
    }
  }

  // Field constructor chains -> field description declarations.
  FIELD_CTOR.lastIndex = 0
  while ((match = FIELD_CTOR.exec(masked)) !== null) {
    const ctor = `New${match[1]}Field`
    const openIndex = match.index + match[0].length - 1
    const closeIndex = findBalancedClose(masked, openIndex)
    if (closeIndex === -1) continue

    const ctorArgs = splitTopLevelArgs(masked.slice(openIndex + 1, closeIndex))
    const nameResult = ctorArgs.length > 0 ? evalStringExpr(ctorArgs[0], consts) : { verifiable: false, value: null }
    const fieldName = nameResult.verifiable ? nameResult.value : null

    const { calls, end } = readChain(masked, closeIndex + 1)
    const descriptionCall = calls.find((c) => c.method === 'Description')

    if (descriptionCall) {
      const result = evalStringExpr(descriptionCall.args, consts)
      if (result.verifiable) {
        declarations.push({
          surface: 'connect',
          name: fieldName,
          file,
          line_start: lineOf(masked, match.index),
          line_end: lineOf(masked, descriptionCall.closeIndex),
          string: result.value.trim() === '' ? null : result.value.trim(),
          declaration_text: null,
          convention: CONVENTION,
          meta: { kind: 'field', ctor }
        })
      }
      // Unverifiable description: skip silently (cross-file constant or call).
    } else if (BARE_FIELD_CTORS.has(ctor) && !calls.some((c) => c.method === 'Deprecated')) {
      // Deprecated fields are not part of the user-facing docs contract.
      // A bare constructor with no Description() anywhere in its chain
      // ships an empty field description.
      declarations.push({
        surface: 'connect',
        name: fieldName,
        file,
        line_start: lineOf(masked, match.index),
        line_end: lineOf(masked, Math.max(closeIndex, end - 1)),
        string: null,
        declaration_text: null,
        convention: CONVENTION,
        meta: { kind: 'field', ctor, missing_description: true }
      })
    }
    // Resume INSIDE the constructor args: object fields nest child field
    // constructors (NewObjectField("x", NewStringField("y")...)).
    FIELD_CTOR.lastIndex = openIndex + 1
  }

  return declarations
}

/**
 * Extract connect declarations.
 *
 * @param {Object} options - { repo, files (Set of repo-relative paths, diff
 *   mode; when omitted, scans internal/impl), log }
 */
function extract ({ repo, files = null }) {
  const IMPL_ROOT = path.join('internal', 'impl')
  let fileList
  if (files) {
    fileList = [...files].filter((f) => f.endsWith('.go') && !f.endsWith('_test.go'))
  } else {
    fileList = collectGoFiles(path.join(repo, IMPL_ROOT)).map((f) => path.join(IMPL_ROOT, f))
  }

  const cache = new SourceCache(repo)
  const declarations = []
  for (const file of fileList) {
    const absPath = path.isAbsolute(file) ? file : path.join(repo, file)
    if (!fs.existsSync(absPath)) continue
    const content = fs.readFileSync(absPath, 'utf8')
    if (!content.includes('Field(') && !content.includes('NewConfigSpec')) continue
    for (const decl of scanFile(content, file)) {
      decl.declaration_text = cache.span(file, decl.line_start, decl.line_end)
      declarations.push(decl)
    }
  }
  return declarations
}

/** Surface-specific convention rules. */
const RULES = [
  {
    name: 'missing-field-description',
    description: 'Config field constructed with no .Description()',
    severity: 'warning',
    check: (decl) => {
      if (decl.meta.kind !== 'field' || !decl.meta.missing_description) return []
      return [{ message: `Field ${decl.name ? `"${decl.name}" ` : ''}(${decl.meta.ctor}) has no .Description(). It ships as an undocumented field on the connector page.` }]
    }
  }
]

module.exports = {
  name: 'connect',
  convention: CONVENTION,
  extract,
  scanFile,
  rules: RULES,
  // A connect description is the AsciiDoc page body, not a table cell:
  // bare | is legitimate table syntax there, and missing prose is handled
  // by the connect-specific missing-field-description warning. Brace
  // placeholders ({endpoint}, {my-domain}) are the established URL-template
  // idiom in connect descriptions, so the unknown-attribute check is noise.
  skipRules: ['raw-pipe', 'empty-description', 'unknown-attribute']
}

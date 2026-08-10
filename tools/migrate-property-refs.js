'use strict'

/* One-time migration of plain-backtick property mentions to the prop: macro.
 *
 * Rewrites `property_name` to prop:property_name[] in AsciiDoc prose when the
 * name exists in the published property reference JSON AND contains a
 * separator (_ or .). Separator-free names (admin, brokers, rack, retries,
 * superusers) are exactly the ambiguous words that motivated opt-in marking,
 * so they are never converted automatically.
 *
 * Conservative by design. A conversion is skipped when the mention is:
 *   - inside a delimited listing, literal, or comment block (----, ...., ////)
 *   - inside a fenced code block (```)
 *   - on a heading, attribute-entry, or block-title line
 *   - inside the [] payload of another inline macro (unbalanced [ before it)
 */

const fs = require('fs')
const path = require('path')

const SKIP_LINE_RX = /^(=+\s|:[-\w]+[!]?:|\.[^.\s])/
const DELIMITERS = [
  { rx: /^-{4,}\s*$/, key: 'listing' },
  { rx: /^\.{4,}\s*$/, key: 'literal' },
  { rx: /^\/{4,}\s*$/, key: 'comment' },
  { rx: /^`{3,}/, key: 'fence' },
]

/**
 * Collect convertible property names from a published properties JSON.
 *
 * @param {object} propertiesJson - Parsed redpanda-properties JSON.
 * @returns {{convertible: Set<string>, ambiguous: string[]}}
 */
function classifyNames (propertiesJson) {
  const names = Object.keys(propertiesJson.properties || {})
  const convertible = new Set()
  const ambiguous = []
  for (const name of names) {
    if (name.includes('_') || name.includes('.')) convertible.add(name)
    else ambiguous.push(name)
  }
  return { convertible, ambiguous }
}

/**
 * Convert one line of prose. Exported for unit testing.
 *
 * @param {string} line
 * @param {Set<string>} convertible - Names eligible for conversion.
 * @param {Set<string>} [seen] - Names already marked in the current
 *   paragraph. Repeat mentions stay as plain backticks: one tooltip per
 *   property per paragraph is enough.
 * @returns {{line: string, count: number}}
 */
function convertLine (line, convertible, seen) {
  let count = 0
  // `name` spans: backtick, name, backtick, not adjacent to more backticks.
  const result = line.replace(/(^|[^`\\])`([A-Za-z][A-Za-z0-9_.]*)`(?!`)/g, (match, prefix, name, offset) => {
    if (!convertible.has(name)) return match
    if (seen && seen.has(name)) return match
    // Skip mentions inside another macro's [...] payload.
    const before = line.slice(0, offset + prefix.length)
    const opens = (before.match(/\[/g) || []).length
    const closes = (before.match(/\]/g) || []).length
    if (opens > closes) return match
    if (seen) seen.add(name)
    count++
    return `${prefix}prop:${name}[]`
  })
  return { line: result, count }
}

/**
 * Convert config_ref macro calls to prop macro calls. The old macro's manual
 * path argument is dropped (the prop macro discovers the page dynamically),
 * and its implicit Kubernetes prefixing becomes the explicit, per-property
 * correct helm-path=auto. Names must exist in the published JSON; unknown
 * names are left as config_ref and reported. Exported for unit testing.
 *
 * @param {string} line
 * @param {Set<string>} knownNames - Every name in the published JSON.
 * @returns {{line: string, count: number, skipped: string[]}}
 */
function convertConfigRefLine (line, knownNames) {
  let count = 0
  const skipped = []
  const result = line.replace(/config_ref:([^[,]+)(?:,([^[,]*))?(?:,([^[,]*))?\[([^\]]*)\]/g, (match, name, isLink, _path, payload) => {
    const trimmed = name.trim()
    if (!knownNames.has(trimmed)) {
      skipped.push(trimmed)
      return match
    }
    // A payload of the backticked property name is redundant (the prop macro
    // renders a code element already); anything else becomes a text override.
    const display = (payload || '').trim().replace(/^`|`$/g, '')
    const attrs = [
      ...(isLink === 'true' ? ['link=true'] : []),
      'helm-path=auto',
      ...(display && display !== trimmed ? [`text=${display}`] : []),
    ]
    count++
    return `prop:${trimmed}[${attrs.join(',')}]`
  })
  return { line: result, count, skipped }
}

/**
 * Convert one AsciiDoc document. Exported for unit testing.
 *
 * @param {string} content
 * @param {Set<string>} convertible
 * @returns {{content: string, count: number}}
 */
function convertDocument (content, convertible, options = {}) {
  const lines = content.split('\n')
  const open = {}
  let total = 0
  const skippedConfigRefs = []
  // One prop macro per property per paragraph. Blank lines and list items
  // start a new paragraph; existing prop: calls count as the mention.
  let paragraphSeen = new Set()
  const converted = lines.map((line) => {
    const delimiter = DELIMITERS.find((d) => d.rx.test(line))
    if (delimiter) {
      open[delimiter.key] = !open[delimiter.key]
      paragraphSeen = new Set()
      return line
    }
    if (Object.values(open).some(Boolean)) return line
    if (line.trim() === '' || /^\s*(?:[*\-.]+|\d+\.)\s/.test(line)) {
      paragraphSeen = new Set()
    }
    if (SKIP_LINE_RX.test(line)) {
      paragraphSeen = new Set()
      return line
    }
    let current = line
    if (options.configRefs && options.knownNames) {
      const refResult = convertConfigRefLine(current, options.knownNames)
      total += refResult.count
      skippedConfigRefs.push(...refResult.skipped)
      current = refResult.line
    }
    for (const m of current.matchAll(/prop:([A-Za-z][A-Za-z0-9_.]*)\[/g)) paragraphSeen.add(m[1])
    const result = convertLine(current, convertible, paragraphSeen)
    total += result.count
    return result.line
  })
  return { content: converted.join('\n'), count: total, skippedConfigRefs }
}

/**
 * Walk a modules tree and migrate every .adoc file.
 *
 * @param {object} opts
 * @param {string} opts.docsDir - Repo root containing modules/.
 * @param {object} opts.propertiesJson - Parsed properties JSON.
 * @param {boolean} opts.write - Apply changes (dry run when false).
 * @param {string[]} [opts.exclude] - Path substrings to skip.
 * @returns {{files: number, conversions: number, changed: {file: string, count: number}[], ambiguous: string[]}}
 */
function migrate ({ docsDir, propertiesJson, write, configRefs = false, exclude = [
    'modules/reference/partials/properties/',
    // Autogenerated; hand edits revert on regeneration.
    'modules/reference/pages/rpk/',
    'modules/reference/partials/rpk',
    'modules/reference/pages/k-crd.adoc',
    '-helm-spec.adoc',
    '/attachments/',
    '/examples/',
    '/test-resources/',
  ] }) {
  const { convertible, ambiguous } = classifyNames(propertiesJson)
  const knownNames = new Set(Object.keys(propertiesJson.properties || {}))
  const changed = []
  const skippedConfigRefs = new Set()
  let conversions = 0
  let files = 0

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      const relative = path.relative(docsDir, full)
      if (exclude.some((fragment) => `${relative}/`.includes(fragment) || relative.includes(fragment))) continue
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.name.endsWith('.adoc')) {
        files++
        const original = fs.readFileSync(full, 'utf8')
        const result = convertDocument(original, convertible, { configRefs, knownNames })
        for (const name of result.skippedConfigRefs || []) skippedConfigRefs.add(name)
        if (result.count > 0) {
          changed.push({ file: relative, count: result.count })
          conversions += result.count
          if (write) fs.writeFileSync(full, result.content)
        }
      }
    }
  }

  walk(path.join(docsDir, 'modules'))
  return { files, conversions, changed, ambiguous, skippedConfigRefs: [...skippedConfigRefs] }
}

module.exports = { classifyNames, convertLine, convertConfigRefLine, convertDocument, migrate }

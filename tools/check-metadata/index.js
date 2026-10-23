'use strict'

/**
 * doc-tools check-metadata: the deterministic, model-free taxonomy check for
 * page headers. Docs repos run it on the pages a PR changes, agents run it on
 * what they draft, and the build runs the same rules
 * (extension-utils/metadata-check.js), so the three never disagree.
 *
 * It reads the AsciiDoc header of each page (the attribute entries before the
 * first blank line after the title, including entries inside ifdef/ifndef),
 * loads the taxonomy (extension-utils/taxonomy.js loadTaxonomyFrom), and
 * reports one finding per problem value with file, line, attribute, value,
 * severity, message, and replacement.
 *
 * With --fix, it first rewrites `:page-categories:` in place (fixCategories),
 * then checks the result. Each value becomes the preferred label of the
 * concept it resolves to, and a deprecated value becomes its replacements.
 * A replacement that is a task is dropped rather than written, because the
 * task is derived from the Antora module. A deprecated value with no
 * replacement (Integration, Streaming, GitOps), or whose replacement is a
 * content type (Architecture), needs a judgment call and is left as it is,
 * and so is any value the taxonomy does not know. An attribute left with no
 * values is removed.
 *
 * Exit codes: 0 no errors, 1 errors (or warnings with --strict), 2 the check
 * could not run (no taxonomy, an invalid taxonomy, a bad argument).
 */

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const yaml = require('js-yaml')
const { loadTaxonomyFrom } = require('../../extension-utils/taxonomy')
const { checkPageMetadata, isSolutionPage, CATEGORY_ATTRIBUTE, TOPIC_TYPE_ATTRIBUTE, SOLUTION_FACETS } = require('../../extension-utils/metadata-check')

const CHECKED_ATTRIBUTES = new Set([CATEGORY_ATTRIBUTE, TOPIC_TYPE_ATTRIBUTE, 'page-layout', ...Object.keys(SOLUTION_FACETS)])
const LEGACY_CATEGORIES_PATH = 'shared/modules/ROOT/partials/valid-categories.yml'
const DEFAULT_GLOB = 'modules/**/*.adoc'

const ATTRIBUTE_RE = /^:([A-Za-z0-9_][A-Za-z0-9_-]*)!?:(?:[ \t]+(.*?))?[ \t]*$/
const CONDITIONAL_RE = /^(?:ifdef|ifndef|ifeval|endif)::/

/**
 * Read the attribute entries of an AsciiDoc header.
 *
 * @param {string} content
 * @returns {Array<{name: string, value: string, line: number, start: number}>}
 *   every entry, in order (`start` is its first line, `line` its last when the
 *   value is soft-wrapped); an attribute set in two conditional branches
 *   appears twice
 */
function parseHeader (content) {
  const lines = String(content).split(/\r?\n/)
  const entries = []
  let inBlockComment = false
  let sawTitle = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\/{4,}\s*$/.test(line)) {
      inBlockComment = !inBlockComment
      continue
    }
    if (inBlockComment || /^\/\/(?!\/)/.test(line) || /^\/\/\s*$/.test(line)) continue
    if (/^=\s+\S/.test(line)) {
      if (sawTitle) break
      sawTitle = true
      continue
    }
    if (!line.trim()) {
      if (sawTitle) break
      continue
    }
    if (CONDITIONAL_RE.test(line)) continue
    const m = ATTRIBUTE_RE.exec(line)
    if (!m) break
    let value = m[2] || ''
    const start = i + 1
    // Soft-wrapped value: a line ending in " \" continues on the next.
    while (/\s\\$/.test(value) && i + 1 < lines.length) {
      value = value.replace(/\s\\$/, ' ') + lines[++i].trim()
    }
    entries.push({ name: m[1], value: value.trim(), line: i + 1, start })
  }
  return entries
}

/** The .adoc files changed between the merge base with `base` and HEAD. */
function gitChangedAdoc (root, base) {
  const run = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  const res = run(['diff', '--name-only', '--diff-filter=ACMR', `${base}...HEAD`, '--', '*.adoc'])
  if (res.status !== 0) throw new Error(`git diff against ${base} failed: ${(res.stderr || '').trim()}`)
  return res.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
}

/**
 * The files to check: the changed pages with `changed`, the given paths
 * (files, directories, or globs), or every page under modules/.
 */
function selectFiles ({ root, paths = [], changed }) {
  const { globSync } = require('glob')
  let selected = []
  if (changed) {
    selected = gitChangedAdoc(root, changed)
    if (paths.length) {
      const micromatch = require('micromatch')
      const prefixes = paths.map((p) => p.replace(/\/+$/, '') + '/')
      selected = selected.filter((f) => micromatch.isMatch(f, paths) || prefixes.some((p) => f.startsWith(p)) || paths.includes(f))
    }
  } else if (paths.length) {
    for (const p of paths) {
      const abs = path.resolve(root, p)
      if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
        selected.push(...globSync('**/*.adoc', { cwd: abs, nodir: true, ignore: ['**/node_modules/**'] }).map((f) => path.relative(root, path.join(abs, f))))
      } else if (fs.existsSync(abs)) {
        selected.push(path.relative(root, abs))
      } else {
        selected.push(...globSync(p, { cwd: root, nodir: true, ignore: ['**/node_modules/**'] }))
      }
    }
  } else {
    selected = globSync(DEFAULT_GLOB, { cwd: root, nodir: true, ignore: ['**/node_modules/**'] })
  }
  return [...new Set(selected.map((f) => f.split(path.sep).join('/')))]
    .filter((f) => f.endsWith('.adoc') && fs.existsSync(path.resolve(root, f)))
    .sort()
}

/** valid-categories.yml membership, when the docs checkout has it. */
function loadLegacyCategories (root) {
  const file = path.join(root, LEGACY_CATEGORIES_PATH)
  if (!fs.existsSync(file)) return null
  const list = (yaml.load(fs.readFileSync(file, 'utf8')) || {})['page-valid-categories']
  if (!Array.isArray(list)) return null
  const names = new Set()
  for (const c of list) {
    if (c && c.category) names.add(c.category)
    for (const s of (c && c.subcategories) || []) if (s && s.category) names.add(s.category)
  }
  return (label) => names.has(label)
}

/**
 * Check pages.
 *
 * @param {Object} input
 * @param {string} input.root
 * @param {Array<string>} input.files - relative to root
 * @param {import('../../extension-utils/taxonomy').Taxonomy} input.taxonomy
 * @param {boolean} [input.strict] - warnings become errors
 * @param {(label: string) => boolean} [input.isLegacyCategory]
 */
function checkFiles ({ root, files, taxonomy, strict = false, isLegacyCategory }) {
  const findings = []
  let pages = 0
  let solutions = 0
  for (const file of files) {
    const entries = parseHeader(fs.readFileSync(path.resolve(root, file), 'utf8')).filter((e) => CHECKED_ATTRIBUTES.has(e.name))
    if (!entries.length) continue
    pages++
    // Values that reference attributes resolve only in a build.
    const attributes = {}
    const lineOf = {}
    for (const e of entries) {
      if (e.value.includes('{')) continue
      attributes[e.name] = attributes[e.name] ? `${attributes[e.name]}, ${e.value}` : e.value
      if (!lineOf[e.name]) lineOf[e.name] = []
      lineOf[e.name].push(e)
    }
    const solution = isSolutionPage(attributes)
    if (solution) solutions++
    for (const f of checkPageMetadata(attributes, { taxonomy, solution, isLegacyCategory })) {
      const entry = (lineOf[f.attribute] || []).find((e) => e.value.split(',').map((v) => v.trim()).includes(f.value)) || (lineOf[f.attribute] || [])[0]
      findings.push({
        file,
        line: entry ? entry.line : 1,
        attribute: f.attribute,
        value: f.value,
        severity: strict && f.severity === 'warning' ? 'error' : f.severity,
        rule: f.rule,
        message: f.message,
        replacement: f.replacement,
        replacementIds: f.replacementIds,
        kind: solution ? 'solution' : 'docs',
      })
    }
  }
  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.value.localeCompare(b.value))
  const errors = findings.filter((f) => f.severity === 'error').length
  return {
    files: files.length,
    pages,
    solutions,
    strict,
    findings,
    summary: { errors, warnings: findings.length - errors },
  }
}

// The schemes a page-categories value may name once it is rewritten. A task
// is derived from the module and a content type is :page-topic-type:, so
// neither is written into categories.
const CATEGORY_SCHEMES = new Set(['topic', 'use-case', 'technology', 'industry'])

/**
 * What one page-categories value becomes under --fix.
 *
 * @returns {{values: string[], action: 'keep'|'relabel'|'replace'|'drop', reason?: string}}
 *   `keep` leaves the value as written, with the reason when it needs a person
 */
function fixCategoryValue (value, taxonomy) {
  if (value.includes('{')) return { values: [value], action: 'keep', reason: 'references an attribute' }
  const hit = taxonomy.resolve(value)
  if (!hit) return { values: [value], action: 'keep', reason: 'not in the taxonomy' }
  const { concept } = hit
  if (!hit.deprecated) {
    if (!CATEGORY_SCHEMES.has(concept.scheme)) return { values: [value], action: 'keep', reason: `is a ${concept.scheme}, not a category` }
    return concept.prefLabel === value ? { values: [value], action: 'keep' } : { values: [concept.prefLabel], action: 'relabel' }
  }
  if (!hit.ids.length) return { values: [value], action: 'keep', reason: 'deprecated with no replacement; choose per page' }
  const schemes = hit.ids.map((id) => taxonomy.get(id).scheme)
  if (schemes.some((sc) => !CATEGORY_SCHEMES.has(sc) && sc !== 'task')) {
    return { values: [value], action: 'keep', reason: `replaced by a ${schemes.find((sc) => !CATEGORY_SCHEMES.has(sc) && sc !== 'task')}; choose per page` }
  }
  const values = hit.ids.filter((id) => CATEGORY_SCHEMES.has(taxonomy.get(id).scheme)).map((id) => taxonomy.label(id))
  return { values, action: values.length ? 'replace' : 'drop' }
}

/**
 * Rewrite the `:page-categories:` entries of one page (see the header comment).
 * Soft-wrapped entries are reported and left alone.
 *
 * @param {string} content
 * @param {import('../../extension-utils/taxonomy').Taxonomy} taxonomy
 * @returns {{content: string, changes: Array<{line: number, before: string, after: string|null, edits: Array<Object>}>, kept: Array<{line: number, value: string, reason: string}>}}
 *   `after` is null when the entry was removed
 */
function fixCategories (content, taxonomy) {
  const text = String(content)
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  const changes = []
  const kept = []
  const remove = new Set()
  for (const entry of parseHeader(text)) {
    if (entry.name !== CATEGORY_ATTRIBUTE) continue
    if (entry.start !== entry.line) {
      kept.push({ line: entry.start, value: entry.value, reason: 'soft-wrapped value; fix it by hand' })
      continue
    }
    const out = []
    const seen = new Set()
    const edits = []
    for (const value of entry.value.split(',').map((v) => v.trim()).filter(Boolean)) {
      const fix = fixCategoryValue(value, taxonomy)
      if (fix.reason) kept.push({ line: entry.line, value, reason: fix.reason })
      const written = []
      for (const v of fix.values) {
        const hit = v.includes('{') ? null : taxonomy.resolve(v)
        const key = hit ? hit.concept.id : `value:${v}`
        if (seen.has(key)) continue
        seen.add(key)
        out.push(v)
        written.push(v)
      }
      if (fix.action !== 'keep' || written.length !== fix.values.length) edits.push({ value, action: fix.action === 'keep' ? 'dedupe' : fix.action, to: written })
    }
    if (!edits.length) continue
    const idx = entry.line - 1
    const before = lines[idx]
    const prefix = before.match(/^(:page-categories!?:)/)[1]
    const after = out.length ? `${prefix} ${out.join(', ')}` : null
    if (after === null) remove.add(idx)
    else lines[idx] = after
    changes.push({ line: entry.line, before, after, edits })
  }
  return {
    content: remove.size ? lines.filter((_, i) => !remove.has(i)).join(eol) : lines.join(eol),
    changes,
    kept,
  }
}

/** Apply fixCategories to files, writing the ones that change. */
function fixFiles ({ root, files, taxonomy }) {
  const fixed = []
  for (const file of files) {
    const abs = path.resolve(root, file)
    const content = fs.readFileSync(abs, 'utf8')
    const r = fixCategories(content, taxonomy)
    if (r.changes.length) {
      fs.writeFileSync(abs, r.content)
      fixed.push({ file, changes: r.changes, kept: r.kept })
    } else if (r.kept.length) {
      fixed.push({ file, changes: [], kept: r.kept })
    }
  }
  return fixed
}

function formatText (result) {
  const out = []
  if (result.fixes) {
    for (const f of result.fixes) {
      for (const c of f.changes) out.push(`FIXED   ${f.file}:${c.line} ${c.before.trim()} -> ${c.after === null ? '(removed)' : c.after.trim()}`)
    }
    const changed = result.fixes.filter((f) => f.changes.length).length
    out.push(`check-metadata --fix: rewrote page-categories in ${changed} file(s)`, '')
  }
  for (const f of result.findings) {
    out.push(`${f.severity.toUpperCase().padEnd(7)} ${f.file}:${f.line} [${f.rule}] ${f.message}`)
  }
  if (out.length) out.push('')
  for (const w of result.taxonomy.warnings) out.push(`note: ${w}`)
  out.push(`check-metadata: ${result.pages} page(s) with taxonomy metadata in ${result.files} file(s) (${result.solutions} solution${result.solutions === 1 ? '' : 's'}), taxonomy from ${result.taxonomy.source}: ${result.summary.errors} error(s), ${result.summary.warnings} warning(s)${result.strict ? ' (strict)' : ''}`)
  return out.join('\n')
}

function splitList (values) {
  if (!values) return []
  return [].concat(values).flatMap((v) => String(v).split(',')).map((s) => s.trim()).filter(Boolean)
}

/**
 * @param {Array<string>} paths
 * @param {Object} options - commander options: changed, taxonomy, format, strict, fix, root, output
 * @param {Object} [deps] - { fetch } for tests
 */
async function runCli (paths, options = {}, { fetch } = {}) {
  let result
  try {
    if (options.format && !['text', 'json'].includes(options.format)) throw new Error(`--format must be text or json, got ${options.format}`)
    const root = path.resolve(options.root || process.cwd())
    const loaded = await loadTaxonomyFrom({ source: options.taxonomy, root, ...(fetch ? { fetch } : {}) })
    const files = selectFiles({ root, paths: splitList(paths), changed: options.changed })
    const fixes = options.fix ? fixFiles({ root, files, taxonomy: loaded.taxonomy }) : undefined
    result = checkFiles({ root, files, taxonomy: loaded.taxonomy, strict: Boolean(options.strict), isLegacyCategory: loadLegacyCategories(root) })
    result = { taxonomy: { source: loaded.source, schema: loaded.schemaSource, warnings: loaded.warnings }, ...result, ...(fixes ? { fixes } : {}) }
  } catch (err) {
    console.error(`check-metadata: ${err.message}`)
    process.exitCode = 2
    return null
  }
  if (options.output) {
    fs.mkdirSync(path.dirname(path.resolve(options.output)), { recursive: true })
    fs.writeFileSync(path.resolve(options.output), JSON.stringify(result, null, 2) + '\n')
  }
  console.log(options.format === 'json' ? JSON.stringify(result, null, 2) : formatText(result))
  process.exitCode = result.summary.errors > 0 ? 1 : 0
  return result
}

module.exports = {
  parseHeader,
  selectFiles,
  checkFiles,
  fixCategoryValue,
  fixCategories,
  fixFiles,
  formatText,
  loadLegacyCategories,
  runCli,
}

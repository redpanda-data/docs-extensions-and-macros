'use strict'

/**
 * glossterm: targets, checked against the docs glossary with the parser the
 * build uses (extension-utils/glossary-terms.js, shared with the glossterm
 * macro, aggregate-terms, and doc-tools check-metadata).
 *
 *   diagnostics   a target that is neither a term nor an alt label (and passes
 *                 no inline definition) renders as plain text with a "not yet
 *                 defined" tooltip; a target that is a do-not-use form names
 *                 what to write instead
 *   completion    term names and alt labels after `glossterm:`
 *   hover         the definition, other names, and forms to avoid
 *   code actions  replace a do-not-use form with its replacement
 *
 * The glossary is the term partials in the workspace (a docs checkout),
 * else in $REDPANDA_DOCS_PATH, else the published terms.json.
 */

const fs = require('fs')
const path = require('path')
const { loadTermsFromDir, termsFromJson, indexTerms, labelKey, useInstead, TERMS_PATH, PUBLIC_URL } = require('../../extension-utils/glossary-terms')
const { inertLines, range, contains } = require('../lib/asciidoc')
const { SOURCE, COMPLETION_KIND, diagnostic, markdownHover } = require('../lib/lsp')

// The glossterm macro's own target rule: anything up to '[', spaces included.
const GLOSSTERM_RX = /glossterm:([^[\]\s][^[\]]*?)\[([^\]]*)\]/g

// ---------------------------------------------------------------- data

async function load (ws, { env = process.env, fetch: fetchImpl = globalThis.fetch } = {}) {
  const dirs = [path.join(ws.root, TERMS_PATH)]
  if (env.REDPANDA_DOCS_PATH) dirs.push(path.join(path.resolve(env.REDPANDA_DOCS_PATH), TERMS_PATH))
  for (const dir of dirs) {
    if (fs.existsSync(dir)) return withIndex(loadTermsFromDir(dir), dir)
  }
  // Like the taxonomy: no glossary is a note, not a module failure.
  let res
  try {
    res = await fetchImpl(PUBLIC_URL, { headers: { accept: 'application/json' } })
  } catch (err) {
    res = { ok: false, status: err.message }
  }
  if (!res.ok) {
    ws.notes.push(`glossary not loaded, so glossterm: is not checked: no ${TERMS_PATH} in the workspace or $REDPANDA_DOCS_PATH, and ${PUBLIC_URL} returned ${res.status}`)
    return null
  }
  return withIndex(termsFromJson(await res.json()), PUBLIC_URL)
}

function withIndex (terms, source) {
  const avoided = new Map() // exact form -> term
  for (const t of terms) for (const form of t.doNotUse || []) avoided.set(form, t)
  return { terms, source, index: indexTerms(terms), avoided }
}

/** Every glossterm on a rendered line, with the target's range and whether it has an inline definition. */
function findTerms (text) {
  const lines = String(text).split(/\r?\n/)
  const inert = inertLines(lines)
  const out = []
  lines.forEach((line, lineNo) => {
    if (inert.has(lineNo)) return
    GLOSSTERM_RX.lastIndex = 0
    let m
    while ((m = GLOSSTERM_RX.exec(line))) {
      const target = m[1]
      const start = m.index + 'glossterm:'.length
      // The macro's attributes: positional definition and customText, or
      // named term=, definition=, customText= (as doc-tools check-metadata reads them).
      const named = {}
      const positional = []
      for (const part of m[2].split(',').map((p) => p.trim()).filter(Boolean)) {
        const eq = /^([A-Za-z][\w-]*)=(.*)$/.exec(part)
        if (eq) named[eq[1]] = eq[2].replace(/^(['"])(.*)\1$/, '$2')
        else positional.push(part)
      }
      out.push({
        target: (named.term || target).trim(),
        definition: named.definition || positional[0] || '',
        line: lineNo,
        range: range(lineNo, m.index, m.index + m[0].length),
        targetRange: range(lineNo, start, start + target.length),
      })
    }
  })
  return out
}

// ---------------------------------------------------------------- diagnostics

function glossaryDiagnostics (text, data) {
  if (!data) return []
  const out = []
  for (const g of findTerms(text)) {
    if (g.target.includes('{')) continue // an attribute reference resolves only in a build
    const avoided = data.avoided.get(g.target)
    if (avoided) {
      const instead = useInstead(avoided, g.target)
      out.push({
        ...diagnostic(g.targetRange, `The docs avoid '${g.target}'. Write '${instead}' (glossary term ${avoided.term}).`, 'warning', 'avoided-glossary-form'),
        data: { replacement: instead },
      })
      continue
    }
    if (g.definition || data.index.has(labelKey(g.target))) continue
    out.push(diagnostic(
      g.targetRange,
      `glossterm:${g.target}[] has no glossary entry, so it renders as plain text with a "not yet defined" tooltip. Use an existing term or alt label, or add ${TERMS_PATH}/<term>.adoc in the docs repo.`,
      'warning',
      'unknown-glossary-term'
    ))
  }
  return out
}

// ---------------------------------------------------------------- code actions

function codeActions (diags, uri) {
  const actions = []
  for (const d of diags || []) {
    if (d.source !== SOURCE || d.code !== 'avoided-glossary-form' || !d.data) continue
    actions.push({
      title: `Replace with '${d.data.replacement}'`,
      kind: 'quickfix',
      diagnostics: [d],
      isPreferred: true,
      edit: { changes: { [uri]: [{ range: d.range, newText: d.data.replacement }] } },
    })
  }
  return actions
}

// ---------------------------------------------------------------- completion

function completion (text, position, data) {
  if (!data) return []
  const lines = String(text).split(/\r?\n/)
  if (inertLines(lines).has(position.line)) return []
  const before = (lines[position.line] || '').slice(0, position.character)
  const m = /glossterm:([^[\]]*)$/.exec(before)
  if (!m) return []
  const editRange = range(position.line, position.character - m[1].length, position.character)
  const items = []
  for (const t of data.terms) {
    for (const label of [t.term, ...(t.altLabels || [])]) {
      items.push({
        label,
        kind: COMPLETION_KIND.reference,
        detail: label === t.term ? (t.category || 'glossary term') : `other name for ${t.term}`,
        documentation: t.def,
        textEdit: { range: editRange, newText: `${label}[]` },
        filterText: label,
      })
    }
  }
  return items
}

// ---------------------------------------------------------------- hover

function hover (text, position, data) {
  if (!data) return null
  const g = findTerms(text).find((x) => contains(x.targetRange, position))
  if (!g) return null
  const avoided = data.avoided.get(g.target)
  const term = avoided || data.index.get(labelKey(g.target))
  if (!term) return markdownHover(`'${g.target}' is not in the glossary.`, g.targetRange)
  const parts = [`**${term.term}**${term.category ? ` (${term.category})` : ''}`, term.def]
  if (term.altLabels && term.altLabels.length) parts.push(`Also called: ${term.altLabels.join(', ')}`)
  if (term.doNotUse && term.doNotUse.length) parts.push(`Avoid: ${term.doNotUse.map((f) => `'${f}' (write '${useInstead(term, f)}')`).join(', ')}`)
  return markdownHover(parts.join('\n\n'), g.targetRange)
}

module.exports = {
  id: 'glossary',
  languages: ['asciidoc'],
  watch: [/(^|\/)shared\/modules\/terms\/partials\/[^/]+\.adoc$/],
  triggerCharacters: [':'],
  codeActionKinds: ['quickfix'],
  load,
  diagnostics: (doc, ws) => glossaryDiagnostics(doc.text, ws.data.glossary),
  completion: (doc, position, ws) => completion(doc.text, position, ws.data.glossary),
  hover: (doc, position, ws) => hover(doc.text, position, ws.data.glossary),
  codeActions: (doc, diags, ws) => codeActions(diags, doc.uri),
  // exported for tests
  _findTerms: findTerms,
}

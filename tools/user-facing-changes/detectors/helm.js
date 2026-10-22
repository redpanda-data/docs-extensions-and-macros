'use strict'

const YAML = require('yaml')
const { makeFinding, PAGES } = require('../finding')

/**
 * Helm chart values (charts/<name>/values.yaml, charts/<name>/chart/values.yaml).
 *
 * values.yaml IS the chart's defaults, so a key added or removed and a
 * value changed are each a change to the generated Helm reference. Both
 * sides are parsed as YAML and flattened to dotted paths. A whole subtree
 * added or removed is reported once, at its top-most new key, not once per
 * leaf. YAML cannot be rebuilt from hunk context alone (indentation above
 * the window decides the path), so this detector needs the whole file on
 * both sides and reports the file as unresolved otherwise.
 */

const ROUTES = [/^charts\/([^/]+)\/(?:chart\/)?values\.yaml$/]

function flatten (doc) {
  const out = new Map()
  const lineOf = (node) => (node && node.range ? doc.lineCounter?.linePos(node.range[0]).line : null)
  const walk = (node, prefix) => {
    if (YAML.isMap(node)) {
      for (const pair of node.items) {
        const key = String(pair.key && pair.key.value !== undefined ? pair.key.value : pair.key)
        const p = prefix ? `${prefix}.${key}` : key
        out.set(p, { node: pair.value, line: lineOf(pair.key) || lineOf(pair.value), isMap: YAML.isMap(pair.value) })
        if (YAML.isMap(pair.value)) walk(pair.value, p)
      }
    }
  }
  walk(doc.contents, '')
  return out
}

function valueText (node) {
  if (node == null) return 'null'
  if (YAML.isMap(node)) return null
  const v = node.toJSON ? node.toJSON() : node
  return JSON.stringify(v)
}

function parseValues (text) {
  const lc = new YAML.LineCounter()
  const doc = YAML.parseDocument(text, { lineCounter: lc, keepSourceTokens: false })
  doc.lineCounter = lc
  return flatten(doc)
}

function chartOf (file) {
  const m = ROUTES[0].exec(file)
  return m ? m[1] : null
}

function pageFor (file) {
  const chart = chartOf(file)
  return PAGES.helm[chart] || PAGES.reference
}

function detect ({ files, readBase, readHead, note, excerptAt }) {
  const findings = []
  for (const file of files) {
    const baseText = file.isNew ? '' : (readBase ? readBase(file.oldPath) : null)
    const headText = file.isDeleted ? '' : (readHead ? readHead(file.path) : null)
    if (baseText === null || headText === null) {
      note(`${file.path}: values.yaml needs both sides of the file to resolve key paths; run with --repo`, { file: file.path, line: null })
      continue
    }
    let b, h
    try {
      b = parseValues(baseText)
      h = parseValues(headText)
    } catch (err) {
      note(`${file.path}: could not parse values.yaml: ${err.message}`, { file: file.path, line: null })
      continue
    }
    const chart = chartOf(file.path)
    const common = { detector: 'helm', surface: 'helm', file: file.path, page: pageFor(file.path) }
    const topMost = (keys, other) => keys.filter((k) => {
      const parent = k.includes('.') ? k.slice(0, k.lastIndexOf('.')) : null
      return parent === null || other.has(parent)
    })
    const added = topMost([...h.keys()].filter((k) => !b.has(k)), b)
    const removed = topMost([...b.keys()].filter((k) => !h.has(k)), h)
    for (const key of removed) {
      const e = b.get(key)
      findings.push(makeFinding({
        ...common, name: key, change_kind: 'removed', line: e.line, evidence: excerptAt(file, 'base', e.line),
        summary: `Values key \`${key}\` was removed from the ${chart} chart's \`values.yaml\`. The Helm reference and any page that sets it state a value the chart no longer reads.`
      }))
    }
    for (const key of added) {
      const e = h.get(key)
      const v = valueText(e.node)
      findings.push(makeFinding({
        ...common, name: key, change_kind: 'added', line: e.line, evidence: excerptAt(file, 'head', e.line),
        summary: `New values key \`${key}\`${v !== null ? ` (default \`${v}\`)` : ''} in the ${chart} chart's \`values.yaml\`. The Helm reference lists it on regeneration; the Kubernetes guide for this feature may need it.`
      }))
    }
    for (const [key, e] of h) {
      const prev = b.get(key)
      if (!prev || e.isMap || prev.isMap) continue
      const before = valueText(prev.node)
      const after = valueText(e.node)
      if (before !== after) {
        findings.push(makeFinding({
          ...common, name: key, change_kind: 'default-changed', line: e.line, evidence: excerptAt(file, 'head', e.line),
          summary: `The default of \`${key}\` in the ${chart} chart's \`values.yaml\` changed from \`${before}\` to \`${after}\`. The Helm reference regenerates the default; any page that quotes the old value states the wrong one.`
        }))
      }
    }
  }
  return findings
}

module.exports = { id: 'helm', surface: 'helm', routes: ROUTES, detect, parseValues, needsWholeFiles: true }

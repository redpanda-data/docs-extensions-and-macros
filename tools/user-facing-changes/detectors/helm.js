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

/**
 * Flatten a values document to dotted paths. Keys and lines come from the
 * YAML 1.2 parse (the spelling helm-docs and the reference print); values
 * come from a YAML 1.1 parse of the same text, because Helm reads
 * values.yaml with sigs.k8s.io/yaml (go-yaml, YAML 1.1), where `yes`, `on`
 * and `off` are booleans. Both parses build the same tree, so the two are
 * walked in step.
 */
function flatten (doc, doc11) {
  const out = new Map()
  const lc = doc.lineCounter
  const lineOf = (node) => (node && node.range ? lc?.linePos(node.range[0]).line : null)
  // Last line of a value: its range end, which points past the trailing
  // newline for a block scalar or nested map.
  const endLineOf = (node, fallback) => {
    if (!node || !node.range || !lc) return fallback
    const end = node.range[1]
    const pos = lc.linePos(Math.max(node.range[0], end - 1))
    return Math.max(fallback || pos.line, pos.line)
  }
  const walk = (node, node11, prefix) => {
    if (!YAML.isMap(node)) return
    node.items.forEach((pair, idx) => {
      const pair11 = YAML.isMap(node11) ? node11.items[idx] : null
      const key = String(pair.key && pair.key.value !== undefined ? pair.key.value : pair.key)
      const p = prefix ? `${prefix}.${key}` : key
      const line = lineOf(pair.key) || lineOf(pair.value)
      out.set(p, {
        node: pair.value,
        value: pair11 ? pair11.value : pair.value,
        line,
        lineEnd: YAML.isMap(pair.value) ? line : endLineOf(pair.value, line),
        isMap: YAML.isMap(pair.value)
      })
      if (YAML.isMap(pair.value)) walk(pair.value, pair11 ? pair11.value : null, p)
    })
  }
  walk(doc.contents, doc11 ? doc11.contents : null, '')
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
  if (doc.errors && doc.errors.length) throw doc.errors[0]
  const doc11 = YAML.parseDocument(text, { version: '1.1' })
  return flatten(doc, doc11.errors && doc11.errors.length ? null : doc11)
}

function chartOf (file) {
  const m = ROUTES[0].exec(file)
  return m ? m[1] : null
}

function pageFor (file) {
  const chart = chartOf(file)
  return PAGES.helm[chart] || PAGES.reference
}

/**
 * Evidence for a changed value: the key's own lines, not the whole hunk
 * around it. The head excerpt carries the old line when it sits next to the
 * new one (an edit in place); a key that moved gets its base lines too.
 */
function keyExcerpt (excerpt, file, prev, cur) {
  const head = excerpt(file, 'head', cur.line, cur.lineEnd)
  if (head.split('\n').some((l) => l.startsWith('-'))) return head
  const base = excerpt(file, 'base', prev.line, prev.lineEnd)
  return [base, head].filter(Boolean).join('\n')
}

function detect ({ files, readBase, readHead, note, excerpt }) {
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
        ...common, name: key, change_kind: 'removed', line: e.line, evidence: excerpt(file, 'base', e.line, e.lineEnd),
        summary: `Values key \`${key}\` was removed from the ${chart} chart's \`values.yaml\`. The Helm reference and any page that sets it state a value the chart no longer reads.`
      }))
    }
    for (const key of added) {
      const e = h.get(key)
      const v = valueText(e.value)
      findings.push(makeFinding({
        ...common, name: key, change_kind: 'added', line: e.line, evidence: excerpt(file, 'head', e.line, e.lineEnd),
        summary: `New values key \`${key}\`${v !== null ? ` (default \`${v}\`)` : ''} in the ${chart} chart's \`values.yaml\`. The Helm reference lists it on regeneration; the Kubernetes guide for this feature may need it.`
      }))
    }
    for (const [key, e] of h) {
      const prev = b.get(key)
      if (!prev || e.isMap || prev.isMap) continue
      // Parsed values, not text: `"x"` to `'x'`, `1` to `1.0` and (YAML 1.1)
      // `true` to `yes` are the same value to Helm.
      const before = valueText(prev.value)
      const after = valueText(e.value)
      if (before !== after) {
        findings.push(makeFinding({
          ...common,
          name: key,
          change_kind: 'default-changed',
          line: e.line,
          evidence: keyExcerpt(excerpt, file, prev, e),
          summary: `The default of \`${key}\` in the ${chart} chart's \`values.yaml\` changed from \`${before}\` to \`${after}\`. The Helm reference regenerates the default; any page that quotes the old value states the wrong one.`
        }))
      }
    }
  }
  return findings
}

module.exports = { id: 'helm', surface: 'helm', routes: ROUTES, detect, parseValues, needsWholeFiles: true }

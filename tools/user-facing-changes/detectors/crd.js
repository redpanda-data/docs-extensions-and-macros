'use strict'

const { makeFinding, PAGES } = require('../finding')

/**
 * Operator CRD fields (operator/api/**, non-test Go).
 *
 * crd-ref-docs publishes each struct field under its json tag, with the
 * doc comment above it and any +kubebuilder:default marker as the default.
 * This detector reads the struct, the Go field name, the json name, the
 * default marker and a `Deprecated` word in the comment, on both sides,
 * and compares per struct and json name. The same Go field under a new
 * json name is a rename. Fields tagged `json:"-"`, inlined embeds and
 * fields marked +hidefromdoc are not published and are not reported.
 */

const ROUTES = [/^operator\/api\/(?:.*\/)?(?!.*_test\.go$)[^/]+\.go$/]

const TYPE_OPEN = /^\s*type\s+([A-Za-z_][A-Za-z0-9_]*)\s+struct\s*\{\s*$/
const FIELD = /^\s*([A-Z][A-Za-z0-9_]*)\s+([^`]+?)\s*`([^`]*json:"([^"]*)"[^`]*)`/
const DEFAULT = /\+kubebuilder:default:?=\s*(.+?)\s*$/

function parseStructs (snippets) {
  const fields = new Map()
  for (const { startLine, text } of snippets) {
    const lines = text.split('\n')
    let struct = null
    let comments = []
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const lineNo = startLine + i
      const open = TYPE_OPEN.exec(line)
      if (open) { struct = open[1]; comments = []; continue }
      if (struct && /^\}/.test(line)) { struct = null; comments = []; continue }
      if (!struct) continue
      if (/^\s*\/\//.test(line)) { comments.push(line.replace(/^\s*\/\/\s?/, '')); continue }
      if (!line.trim()) { comments = []; continue }
      const f = FIELD.exec(line)
      if (f) {
        const jsonName = f[4].split(',')[0]
        const inline = /,inline/.test(f[4])
        if (jsonName && jsonName !== '-' && !inline && !comments.some((c) => /\+hidefromdoc/.test(c))) {
          let def = null
          for (const c of comments) {
            const d = DEFAULT.exec(c)
            if (d) def = d[1]
          }
          fields.set(`${struct}.${jsonName}`, {
            struct,
            goName: f[1],
            jsonName,
            type: f[2].trim(),
            line: lineNo,
            default: def,
            deprecated: comments.some((c) => /\bDeprecated\b/.test(c))
          })
        }
      }
      comments = []
    }
  }
  return fields
}

function detect ({ files, sides, excerpt }) {
  const findings = []
  for (const file of files) {
    const { base, head } = sides(file)
    const b = parseStructs(base)
    const h = parseStructs(head)
    if (b.size === 0 && h.size === 0) continue
    const common = { detector: 'crd', surface: 'crd', file: file.path, page: PAGES.crd }
    const removed = [...b.keys()].filter((k) => !h.has(k))
    const added = [...h.keys()].filter((k) => !b.has(k))
    const paired = new Set()
    for (const key of removed) {
      const old = b.get(key)
      const match = added.find((k) => !paired.has(k) && h.get(k).struct === old.struct && h.get(k).goName === old.goName)
      if (match) {
        paired.add(match)
        const nf = h.get(match)
        findings.push(makeFinding({
          ...common, name: match, change_kind: 'renamed', line: nf.line, evidence: excerpt(file, 'head', nf.line, nf.line),
          summary: `CRD field \`${old.jsonName}\` of \`${old.struct}\` was renamed to \`${nf.jsonName}\` in \`${file.path}\` (Go field \`${nf.goName}\`). Every manifest example that sets the old key no longer applies.`
        }))
        continue
      }
      findings.push(makeFinding({
        ...common, name: key, change_kind: 'removed', line: old.line, evidence: excerpt(file, 'base', old.line, old.line),
        summary: `CRD field \`${old.jsonName}\` of \`${old.struct}\` was removed in \`${file.path}\`. The CRD reference and every manifest example that sets it state a field the operator no longer reads.`
      }))
    }
    for (const key of added) {
      if (paired.has(key)) continue
      const nf = h.get(key)
      findings.push(makeFinding({
        ...common, name: key, change_kind: nf.deprecated ? 'deprecated' : 'added', line: nf.line, evidence: excerpt(file, 'head', nf.line, nf.line),
        summary: `New CRD field \`${nf.jsonName}\` (\`${nf.type}\`) on \`${nf.struct}\`${nf.default !== null ? ` with default \`${nf.default}\`` : ''} in \`${file.path}\`. The CRD reference lists it on regeneration; the Kubernetes guide for this feature may need a manifest example.`
      }))
    }
    for (const [key, nf] of h) {
      const of = b.get(key)
      if (!of) continue
      if (nf.deprecated && !of.deprecated) {
        findings.push(makeFinding({
          ...common, name: key, change_kind: 'deprecated', line: nf.line, evidence: excerpt(file, 'head', nf.line, nf.line),
          summary: `CRD field \`${nf.jsonName}\` of \`${nf.struct}\` is now marked Deprecated in \`${file.path}\`. Manifest examples that set it now recommend a deprecated field.`
        }))
      } else if (of.default !== nf.default && (of.default !== null || nf.default !== null)) {
        findings.push(makeFinding({
          ...common, name: key, change_kind: 'default-changed', line: nf.line, evidence: excerpt(file, 'head', nf.line, nf.line),
          summary: `The default of CRD field \`${nf.jsonName}\` of \`${nf.struct}\` changed from \`${of.default === null ? 'none' : of.default}\` to \`${nf.default === null ? 'none' : nf.default}\` in \`${file.path}\`. The CRD reference regenerates it; any page that quotes the old default states the wrong value.`
        }))
      }
    }
  }
  return findings
}

module.exports = { id: 'crd', surface: 'crd', routes: ROUTES, detect, parseStructs }

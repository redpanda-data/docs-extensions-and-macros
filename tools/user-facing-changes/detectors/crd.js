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

// Generated code is not the API: client-go apply configurations
// (operator/api/applyconfiguration/), deepcopy and other zz_generated
// files, and conversion functions mirror every field of the real types,
// and their findings would crowd the real ones out of the dispatch cap.
const ROUTES = [/^operator\/api\/(?!(?:.*\/)?(?:applyconfiguration|conversion)\/)(?:.*\/)?(?!.*_test\.go$)(?!zz_generated)[^/]+\.go$/]

const TYPE_OPEN = /^\s*type\s+([A-Za-z_][A-Za-z0-9_]*)\s+struct\s*\{\s*(?:\/\/.*)?$/
const TYPE_ALIAS = /^\s*type\s+([A-Za-z_][A-Za-z0-9_]*)\s+[A-Za-z_][\w.]*\s*(?:\/\/.*)?$/
const ENUM_MARKER = /\+kubebuilder:validation:Enum=?\s*(.+?)\s*$/

/** Enum values a +kubebuilder:validation:Enum marker allows. */
function enumValues (marker) {
  return marker.split(';').map((v) => v.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean)
}

/**
 * Whether two kubebuilder default markers hold the same value: JSON
 * defaults (`{"a":1}` and `{"a": 1}`) compare parsed, anything else by
 * whitespace-collapsed text.
 */
function sameDefault (a, b) {
  if (a === b) return true
  if (a === null || b === null) return false
  try { return JSON.stringify(canonJson(JSON.parse(a))) === JSON.stringify(canonJson(JSON.parse(b))) } catch (_) {}
  return a.replace(/\s+/g, '') === b.replace(/\s+/g, '')
}

function canonJson (v) {
  if (Array.isArray(v)) return v.map(canonJson)
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonJson(v[k])]))
  return v
}

/** A Go type compared without its package qualifier (`v1.Duration` = `metav1.Duration`). */
const typeKey = (t) => String(t).replace(/\s+/g, '').replace(/(^|[^\w.])(?:[a-z]\w*\.)+(?=[A-Z])/g, '$1')
const FIELD = /^\s*([A-Z][A-Za-z0-9_]*)\s+([^`]+?)\s*`([^`]*json:"([^"]*)"[^`]*)`/
const DEFAULT = /\+kubebuilder:default:?=\s*(.+?)\s*$/

function parseStructs (snippets) {
  const fields = new Map()
  // Named string types with an Enum marker: type name -> { values, line }.
  const enums = new Map()
  fields.enums = enums
  for (const { startLine, text } of snippets) {
    const lines = text.split('\n')
    let struct = null
    let comments = []
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const lineNo = startLine + i
      if (!struct) {
        const alias = TYPE_ALIAS.exec(line)
        if (alias) {
          const marker = comments.map((c) => ENUM_MARKER.exec(c)).filter(Boolean).pop()
          if (marker) enums.set(alias[1], { values: enumValues(marker[1]), line: lineNo })
          comments = []
          continue
        }
        if (/^\s*\/\//.test(line)) { comments.push(line.replace(/^\s*\/\/\s?/, '')); continue }
        if (!TYPE_OPEN.test(line)) comments = []
      }
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
          let enumMarker = null
          for (const c of comments) {
            const d = DEFAULT.exec(c)
            if (d) def = d[1]
            const e = ENUM_MARKER.exec(c)
            if (e) enumMarker = enumValues(e[1])
          }
          fields.set(`${struct}.${jsonName}`, {
            struct,
            goName: f[1],
            jsonName,
            type: f[2].trim(),
            line: lineNo,
            default: def,
            enum: enumMarker,
            deprecated: comments.some((c) => /\bDeprecated\b/.test(c))
          })
        }
      }
      comments = []
    }
  }
  return fields
}

/**
 * Pair a struct that exists only on the base side with one that exists only
 * on the head side when their published json names are the same set: a Go
 * type rename (`Migration` to `DeprecatedMigration`) publishes the same
 * fields, so it is not a removal plus an addition. Returns head struct ->
 * base struct.
 */
function renamedStructs (b, h) {
  const byStruct = (m) => {
    const out = new Map()
    for (const f of m.values()) {
      if (!out.has(f.struct)) out.set(f.struct, new Set())
      out.get(f.struct).add(f.jsonName)
    }
    return out
  }
  const bs = byStruct(b)
  const hs = byStruct(h)
  const same = (x, y) => x.size === y.size && [...x].every((k) => y.has(k))
  const pairs = new Map()
  const used = new Set()
  for (const [hn, hk] of hs) {
    if (bs.has(hn)) continue
    const match = [...bs].find(([bn, bk]) => !hs.has(bn) && !used.has(bn) && same(bk, hk))
    if (match) { pairs.set(hn, match[0]); used.add(match[0]) }
  }
  return pairs
}

function detect ({ files, sides, excerpt }) {
  const findings = []
  for (const file of files) {
    const { base, head } = sides(file)
    const b = parseStructs(base)
    const h = parseStructs(head)
    const common = { detector: 'crd', surface: 'crd', file: file.path, page: PAGES.crd }
    // Enum values of named string types (a field of that type accepts them).
    for (const [type, he] of h.enums) {
      const be = b.enums.get(type)
      if (!be) continue
      for (const v of he.values.filter((x) => !be.values.includes(x))) {
        findings.push(makeFinding({
          ...common, name: `${type}=${v}`, change_kind: 'added', line: he.line, evidence: excerpt(file, 'head', he.line, he.line), detail: 'enum-value-added',
          summary: `\`${type}\` accepts a new value \`${v}\` (+kubebuilder:validation:Enum in \`${file.path}\`). The CRD reference lists it on regeneration; pages that list the accepted values need it.`
        }))
      }
      for (const v of be.values.filter((x) => !he.values.includes(x))) {
        findings.push(makeFinding({
          ...common, name: `${type}=${v}`, change_kind: 'removed', line: he.line, evidence: excerpt(file, 'head', he.line, he.line), detail: 'enum-value-removed',
          summary: `\`${type}\` no longer accepts \`${v}\` (+kubebuilder:validation:Enum in \`${file.path}\`). Manifests and pages that use the value state one the API server now rejects.`
        }))
      }
    }
    if (b.size === 0 && h.size === 0) continue
    // A renamed Go type keeps its fields: read the base struct under the
    // head name before comparing.
    const renamed = renamedStructs(b, h)
    if (renamed.size) {
      const back = new Map([...renamed].map(([hn, bn]) => [bn, hn]))
      for (const [key, f] of [...b]) {
        if (!back.has(f.struct)) continue
        b.delete(key)
        const struct = back.get(f.struct)
        b.set(`${struct}.${f.jsonName}`, { ...f, struct })
      }
    }
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
      findings.push({
        ...makeFinding({
          ...common, name: key, change_kind: 'removed', line: old.line, evidence: excerpt(file, 'base', old.line, old.line),
          summary: `CRD field \`${old.jsonName}\` of \`${old.struct}\` was removed in \`${file.path}\`. The CRD reference and every manifest example that sets it state a field the operator no longer reads.`
        }),
        moveValue: old.default === null ? null : { text: old.default, same: sameDefault }
      })
    }
    for (const key of added) {
      if (paired.has(key)) continue
      const nf = h.get(key)
      findings.push({
        ...makeFinding({
          ...common, name: key, change_kind: nf.deprecated ? 'deprecated' : 'added', line: nf.line, evidence: excerpt(file, 'head', nf.line, nf.line),
          summary: `New CRD field \`${nf.jsonName}\` (\`${nf.type}\`) on \`${nf.struct}\`${nf.default !== null ? ` with default \`${nf.default}\`` : ''} in \`${file.path}\`. The CRD reference lists it on regeneration; the Kubernetes guide for this feature may need a manifest example.`
        }),
        moveValue: nf.default === null ? null : { text: nf.default, same: sameDefault }
      })
    }
    for (const [key, nf] of h) {
      const of = b.get(key)
      if (!of) continue
      if (nf.deprecated && !of.deprecated) {
        findings.push(makeFinding({
          ...common, name: key, change_kind: 'deprecated', line: nf.line, evidence: excerpt(file, 'head', nf.line, nf.line),
          summary: `CRD field \`${nf.jsonName}\` of \`${nf.struct}\` is now marked Deprecated in \`${file.path}\`. Manifest examples that set it now recommend a deprecated field.`
        }))
        continue
      }
      if (!sameDefault(of.default, nf.default)) {
        findings.push(makeFinding({
          ...common, name: key, change_kind: 'default-changed', line: nf.line, evidence: excerpt(file, 'head', nf.line, nf.line),
          summary: `The default of CRD field \`${nf.jsonName}\` of \`${nf.struct}\` changed from \`${of.default === null ? 'none' : of.default}\` to \`${nf.default === null ? 'none' : nf.default}\` in \`${file.path}\`. The CRD reference regenerates it; any page that quotes the old default states the wrong value.`
        }))
      }
      if (typeKey(of.type) !== typeKey(nf.type) && !renamed.has(typeKey(nf.type).replace(/^[*[\]]+/, ''))) {
        findings.push(makeFinding({
          ...common, name: key, change_kind: 'behaviour', line: nf.line, evidence: excerpt(file, 'head', nf.line, nf.line), detail: 'type-changed',
          summary: `CRD field \`${nf.jsonName}\` of \`${nf.struct}\` changed type from \`${of.type}\` to \`${nf.type}\` in \`${file.path}\`. Manifest examples that set it in the old shape no longer validate.`
        }))
      }
      const be = (of.enum || []).join(';')
      const he = (nf.enum || []).join(';')
      if (be !== he && of.enum && nf.enum) {
        const gained = nf.enum.filter((v) => !of.enum.includes(v))
        const lost = of.enum.filter((v) => !nf.enum.includes(v))
        if (gained.length || lost.length) {
          findings.push(makeFinding({
            ...common, name: key, change_kind: 'behaviour', severity: lost.length ? 'high' : undefined, line: nf.line, evidence: excerpt(file, 'head', nf.line, nf.line), detail: 'enum-changed',
            summary: `The accepted values of CRD field \`${nf.jsonName}\` of \`${nf.struct}\` changed in \`${file.path}\`${gained.length ? `: added ${gained.map((v) => `\`${v}\``).join(', ')}` : ''}${lost.length ? `${gained.length ? ';' : ':'} removed ${lost.map((v) => `\`${v}\``).join(', ')}` : ''}. Pages that list the accepted values need the change.`
          }))
        }
      }
    }
  }
  return findings
}

module.exports = { id: 'crd', surface: 'crd', routes: ROUTES, detect, parseStructs, sameDefault }

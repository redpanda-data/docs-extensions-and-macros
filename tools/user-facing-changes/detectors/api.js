'use strict'

const { stripComments, matchBracket, lineAt, normalize } = require('../source')
const { makeFinding, PAGES } = require('../finding')

/**
 * API protos: the rpcs a service exposes, the fields of its messages and
 * the values of its enums, on every proto tree the lint's api surface
 * routes (console's data plane and Console protos under proto/redpanda/api,
 * cloudv2's control plane under proto/public, core's Admin API v2 under
 * proto/redpanda/core/admin/v2).
 *
 * The lint reviews the comments and openapiv2 strings. This detector reads
 * the structure around them. A proto field's number is its identity on the
 * wire, so the same number under a new name is a rename and a new number
 * is an addition, with no guessing. An rpc is identified by service and
 * name; an enum value by enum and name. `[deprecated = true]` on a field
 * and `option deprecated = true;` in an rpc are read as deprecations. A
 * changed openapiv2 summary or description is reported at low severity:
 * the API reference regenerates it, and the lint already reviews the text.
 */

const ROUTES = [
  /^proto\/(?:redpanda\/api|public\/[^/]+\/redpanda\/api)\/.*\.proto$/,
  /^proto\/redpanda\/core\/(?:admin\/v2|common)\/.*\.proto$/
]

const FIELD = /^\s*(?:(?:optional|repeated|required)\s+)?(map\s*<[^>]*>|[A-Za-z_][A-Za-z0-9_.]*)\s+([a-z_][a-zA-Z0-9_]*)\s*=\s*(\d+)\s*(;|\[)/
const ENUM_VALUE = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(-?\d+)\s*(;|\[)/
const BLOCK = /^\s*(service|message|enum|oneof)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/
const RPC = /^\s*rpc\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/
const OPENAPI_STRING = /^\s*(summary|description)\s*:\s*"((?:[^"\\]|\\.)*)"\s*,?\s*$/

function parseProto (snippets) {
  const rpcs = new Map()
  const fields = new Map()
  const enums = new Map()
  const unresolved = []
  for (const { startLine, text: raw } of snippets) {
    const text = stripComments(raw)
    const lines = text.split('\n')
    const stack = [] // { kind, name }
    let depthAtBlock = []
    let depth = 0
    let currentRpc = null
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const lineNo = startLine + i
      const block = BLOCK.exec(line)
      const scope = () => stack.filter((s) => s.kind !== 'oneof').map((s) => s.name).join('.')
      if (block && block[1] !== 'oneof') {
        stack.push({ kind: block[1], name: block[2] })
        depthAtBlock.push(depth)
      } else if (block) {
        stack.push({ kind: 'oneof', name: block[2] })
        depthAtBlock.push(depth)
      }
      const rpc = RPC.exec(line)
      if (rpc && stack.some((s) => s.kind === 'service')) {
        const service = [...stack].reverse().find((s) => s.kind === 'service').name
        const key = `${service}.${rpc[1]}`
        // The rpc body runs to the matching `}` or to `;` for a bodiless rpc.
        const offset = lines.slice(0, i).reduce((n, l) => n + l.length + 1, 0) + line.indexOf('rpc')
        const brace = text.indexOf('{', offset)
        const semi = text.indexOf(';', offset)
        let end
        if (brace !== -1 && (semi === -1 || brace < semi)) {
          end = matchBracket(text, brace)
          if (end === -1) { unresolved.push({ line: lineNo, what: `rpc ${rpc[1]}` }); end = text.length }
        } else end = semi === -1 ? text.length : semi
        const body = text.slice(offset, end)
        const strings = {}
        for (const bl of body.split('\n')) {
          const sm = OPENAPI_STRING.exec(bl)
          if (sm && !(sm[1] in strings)) strings[sm[1]] = sm[2]
        }
        rpcs.set(key, {
          service,
          name: rpc[1],
          line: lineNo,
          lineEnd: lineAt(text, end, startLine),
          deprecated: /\boption\s+deprecated\s*=\s*true\s*;/.test(body),
          summary: strings.summary || null,
          description: strings.description || null
        })
        currentRpc = key
      }
      const inMessage = stack.length > 0 && [...stack].reverse().find((s) => s.kind !== 'oneof')
      if (inMessage && inMessage.kind === 'message' && !currentRpc) {
        const f = FIELD.exec(line)
        if (f && !/^(message|enum|oneof|option|reserved|extensions|map)$/.test(f[1])) {
          const path = scope()
          const key = `${path}#${f[3]}`
          let options = ''
          if (f[4] === '[') {
            const offset = lines.slice(0, i).reduce((n, l) => n + l.length + 1, 0) + line.indexOf('[')
            const end = matchBracket(text, offset)
            options = end === -1 ? line.slice(line.indexOf('[')) : text.slice(offset, end + 1)
          }
          fields.set(key, {
            message: path,
            name: f[2],
            number: parseInt(f[3], 10),
            type: normalize(f[1]),
            line: lineNo,
            deprecated: /\bdeprecated\s*=\s*true\b/.test(options)
          })
        }
      }
      if (inMessage && inMessage.kind === 'enum') {
        const ev = ENUM_VALUE.exec(line)
        if (ev) {
          const path = scope()
          enums.set(`${path}.${ev[1]}`, { enum: path, name: ev[1], number: parseInt(ev[2], 10), line: lineNo })
        }
      }
      // Brace tracking (comment-free text, strings may hold braces: rare in protos).
      for (const c of line) {
        if (c === '{') depth++
        else if (c === '}') {
          depth--
          if (depthAtBlock.length && depth === depthAtBlock[depthAtBlock.length - 1]) {
            stack.pop()
            depthAtBlock.pop()
          }
          if (currentRpc && depth <= (depthAtBlock.length ? depthAtBlock[depthAtBlock.length - 1] + 1 : 0)) currentRpc = null
        }
      }
      if (currentRpc && /;\s*$/.test(line) && !/\{/.test(line) && RPC.test(line)) currentRpc = null
    }
  }
  return { rpcs, fields, enums, unresolved }
}

/**
 * A field type without its package: a message or enum moved to another
 * package (`common.ACLResourceType` to `common.v1.ACLResourceType`,
 * `TLSSettings` to `redpanda.core.common.v1.TLSSettings`) is the same type
 * on the wire and in JSON. Map key and value types are compared the same way.
 */
function typeName (type) {
  return String(type).replace(/\s+/g, '').replace(/[A-Za-z_][\w]*\.(?=[A-Za-z_])/g, '')
}

function pageFor (file) {
  if (/^proto\/redpanda\/core\//.test(file)) return PAGES.api.admin
  if (/^proto\/public\//.test(file)) return PAGES.api.controlplane
  if (/^proto\/redpanda\/api\/dataplane\//.test(file)) return PAGES.api.dataplane
  return PAGES.api.index
}

function detect ({ files, sides, excerpt, note }) {
  const findings = []
  for (const file of files) {
    const { base, head, partial } = sides(file)
    const b = parseProto(base)
    const h = parseProto(head)
    if (partial) {
      for (const u of [...b.unresolved, ...h.unresolved]) {
        note(`${file.path}:${u.line}: ${u.what} is cut by the hunk; run with --repo to read the whole file`, { file: file.path, line: u.line })
      }
    }
    const common = { detector: 'api', surface: 'api', file: file.path, page: pageFor(file.path) }
    for (const [key, r] of b.rpcs) {
      if (!h.rpcs.has(key)) {
        findings.push(makeFinding({
          ...common, name: key, change_kind: 'removed', line: r.line, evidence: excerpt(file, 'base', r.line, r.lineEnd),
          summary: `rpc \`${r.name}\` was removed from service \`${r.service}\` in \`${file.path}\`. The API reference and any guide that calls the endpoint state an operation that no longer exists.`
        }))
      }
    }
    for (const [key, r] of h.rpcs) {
      const prev = b.rpcs.get(key)
      if (!prev) {
        findings.push(makeFinding({
          ...common, name: key, change_kind: r.deprecated ? 'deprecated' : 'added', line: r.line, evidence: excerpt(file, 'head', r.line, r.lineEnd),
          summary: `New rpc \`${r.name}\` on service \`${r.service}\` in \`${file.path}\`. The API reference lists it on regeneration; any guide for this API that should call it needs the step.`
        }))
        continue
      }
      if (r.deprecated && !prev.deprecated) {
        findings.push(makeFinding({
          ...common, name: key, change_kind: 'deprecated', line: r.line, evidence: excerpt(file, 'head', r.line, r.lineEnd),
          summary: `rpc \`${r.name}\` on service \`${r.service}\` is now deprecated in \`${file.path}\`. Guides that call it now recommend a deprecated operation.`
        }))
        continue
      }
      for (const k of ['summary', 'description']) {
        if (prev[k] !== null && r[k] !== null && prev[k] !== r[k]) {
          findings.push(makeFinding({
            ...common, name: key, change_kind: 'behaviour', severity: 'low', line: r.line, evidence: excerpt(file, 'head', r.line, r.lineEnd), detail: `openapiv2-${k}-changed`,
            summary: `The openapiv2 ${k} of rpc \`${r.name}\` (service \`${r.service}\`) changed in \`${file.path}\`. The API reference regenerates it; check pages that paraphrase the operation.`
          }))
        }
      }
    }
    for (const [key, f] of b.fields) {
      if (h.fields.has(key)) continue
      findings.push({
        ...makeFinding({
          ...common, name: `${f.message}.${f.name}`, change_kind: 'removed', line: f.line, evidence: excerpt(file, 'base', f.line, f.line),
          summary: `Field \`${f.name}\` (number ${f.number}) was removed from message \`${f.message}\` in \`${file.path}\`. Request or response examples that carry it are wrong.`
        }),
        // A message moved to another file (a common package) keeps its
        // fields' names and numbers: that pair is a move, not a change.
        moveKey: `${f.message}.${f.name}#${f.number}`
      })
    }
    for (const [key, f] of h.fields) {
      const prev = b.fields.get(key)
      if (!prev) {
        findings.push({
          ...makeFinding({
            ...common, name: `${f.message}.${f.name}`, change_kind: f.deprecated ? 'deprecated' : 'added', line: f.line, evidence: excerpt(file, 'head', f.line, f.line),
            summary: `New field \`${f.name}\` (\`${f.type}\`, number ${f.number}) on message \`${f.message}\` in \`${file.path}\`. The API reference lists it on regeneration; examples for this message may need it.`
          }),
          moveKey: `${f.message}.${f.name}#${f.number}`
        })
        continue
      }
      if (prev.name !== f.name) {
        findings.push(makeFinding({
          ...common, name: `${f.message}.${f.name}`, change_kind: 'renamed', line: f.line, evidence: excerpt(file, 'head', f.line, f.line),
          summary: `Field number ${f.number} of message \`${f.message}\` was renamed from \`${prev.name}\` to \`${f.name}\` in \`${file.path}\`. JSON clients and every example that uses the old key break.`
        }))
      } else if (f.deprecated && !prev.deprecated) {
        findings.push(makeFinding({
          ...common, name: `${f.message}.${f.name}`, change_kind: 'deprecated', line: f.line, evidence: excerpt(file, 'head', f.line, f.line),
          summary: `Field \`${f.name}\` of message \`${f.message}\` is now deprecated in \`${file.path}\`. Examples that set it now recommend a deprecated field.`
        }))
      } else if (typeName(prev.type) !== typeName(f.type)) {
        findings.push(makeFinding({
          ...common, name: `${f.message}.${f.name}`, change_kind: 'behaviour', line: f.line, evidence: excerpt(file, 'head', f.line, f.line), detail: 'type-changed',
          summary: `Field \`${f.name}\` of message \`${f.message}\` changed type from \`${prev.type}\` to \`${f.type}\` in \`${file.path}\`. Examples that carry the old shape are wrong.`
        }))
      }
    }
    for (const [key, e] of b.enums) {
      if (h.enums.has(key)) continue
      findings.push(makeFinding({
        ...common, name: key, change_kind: 'removed', line: e.line, evidence: excerpt(file, 'base', e.line, e.line),
        summary: `Enum value \`${e.name}\` was removed from \`${e.enum}\` in \`${file.path}\`. Pages that list the accepted values state one the API no longer accepts.`
      }))
    }
    for (const [key, e] of h.enums) {
      if (b.enums.has(key)) continue
      findings.push(makeFinding({
        ...common, name: key, change_kind: 'added', line: e.line, evidence: excerpt(file, 'head', e.line, e.line),
        summary: `New enum value \`${e.name}\` in \`${e.enum}\` in \`${file.path}\`. Pages that list the accepted values need it.`
      }))
    }
  }
  return findings
}

module.exports = { id: 'api', surface: 'api', routes: ROUTES, detect, parseProto, typeName }

'use strict'

/* The Connect engine of check-reference-values.
 *
 * Against one connect-<version>.json:
 *
 *   Reference: every pipeline config in a YAML listing block or an examples
 *   file is walked from its root keys. A component name the data does not
 *   have is unknown-component, a field the component does not have is
 *   unknown-field, and deprecated components and fields are warnings.
 *
 *   Comment defaults: a YAML comment that states a field's default
 *   ("# Optional (default: \"benthos\")") is compared with the default the
 *   reference prints, and reported as example output that matches or is
 *   stale.
 *
 *   Values: a callout ("<3> ... The default is `1024`.") or a sentence that
 *   states a field's default by hand is compared with what connectval:
 *   renders for that field.
 */

const fs = require('fs')
const path = require('path')
const YAML = require('yaml')
const {
  walkAdoc,
  PHRASES,
  QUALIFIER_RX,
  HISTORICAL_RX,
  ASSOCIATION_WINDOW,
  sentenceBounds,
} = require('../migrate-property-values')
const { DEFAULT_EXCLUDE } = require('../migrate-property-refs')
const connectValues = require('../../extension-utils/connect-values')
const { normalizeType, typeFromRelative } = require('../../extensions/util/connect-catalog')
const { formatConnectDefault } = require('../redpanda-connect/helpers/formatConnectDefault')
const shared = require('./shared')
const { countFindings, blockLanguage } = require('./rpk')

// The keys Connect's runtime accepts beside the component name in a component
// map: a label on any component, and processors on inputs and outputs.
const COMPONENT_WRAPPER_KEYS = { label: 'any', processors: ['input', 'output'] }

const CONNECT_EXCLUDE = DEFAULT_EXCLUDE.concat([
  'modules/components/partials/fields/',
  'modules/components/partials/examples/',
  'modules/components/partials/descriptions/',
  'modules/components/partials/metadata/',
])
// '/examples/' in DEFAULT_EXCLUDE keeps .adoc scans out of examples; the YAML
// walk of examples directories uses this list instead.
const EXAMPLE_EXCLUDE = DEFAULT_EXCLUDE.filter((fragment) => fragment !== '/examples/')
const HISTORICAL_CONNECT_RX = /(?:^|\/)migration\//

const YAML_LANGUAGES = new Set(['yaml', 'yml'])
// Root keys only a Connect pipeline config has. A document with none of
// them (redpanda:, http:, logger: alone) is as likely a broker or Helm config,
// so it is walked only on a page about Connect.
const PIPELINE_KEYS = new Set(['input', 'output', 'pipeline', 'buffer', 'input_resources', 'output_resources', 'processor_resources', 'cache_resources', 'rate_limit_resources'])
const DEFAULT_PHRASES = PHRASES.filter((p) => p.field === 'default')
const DEFAULT_OF_RX = /\bdefault\s+(`[a-z_][\w.]*`)\s+(?:of|is)\s+/gi
const COMMENT_DEFAULT_RX = [/\(default:?\s*([^)]*)\)/i, /\bdefault:\s*(\S+)/i]
const CALLOUT_TRAILING_RX = /\s+(?:#\s*)?<(\d+)>\s*$/
const CALLOUT_ITEM_RX = /^<(\d+)>\s+(.*)$/

const unquoteOnce = (text) => {
  const t = String(text).trim().replace(/[.,;]$/, '')
  const m = t.match(/^"([\s\S]*)"$/) || t.match(/^'([\s\S]*)'$/)
  return m ? m[1] : t
}

/**
 * Prepare YAML for parsing: strip callouts (recording which line carried
 * each), and swap {attribute} references and ${...} interpolations for
 * placeholders of the same length, so line and column positions hold.
 */
function prepareYaml (text) {
  const callouts = {}
  const lines = text.split('\n').map((line, i) => {
    let out = line
    const m = out.match(CALLOUT_TRAILING_RX)
    if (m) {
      callouts[m[1]] = i
      out = out.slice(0, m.index)
    }
    out = out.replace(/\$\{!?[^}]*\}|\{[\w-]+\}/g, (s) => 'x'.repeat(s.length))
    return out
  })
  return { text: lines.join('\n'), callouts }
}

// The comment on one line of YAML, outside quotes.
function commentOf (line) {
  let quote = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) {
      if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") { quote = c; continue }
    if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(i + 1)
  }
  return undefined
}

function componentIndex (data) {
  const types = connectValues.componentTypes(data)
  const byName = new Map()
  for (const [type, key] of Object.entries(types)) {
    for (const entry of data[key] || []) {
      if (!entry || !entry.name) continue
      if (!byName.has(entry.name)) byName.set(entry.name, [])
      byName.get(entry.name).push({ type, key, entry })
    }
  }
  return { types, byName }
}

// Every field path in a component, with its field.
function fieldPaths (children, prefix = '', out = []) {
  for (const c of children || []) {
    if (!c || !c.name) continue
    const name = c.name.replace(/\[\]$/, '')
    const p = prefix ? `${prefix}.${name}` : name
    out.push({ path: p, field: c })
    if (Array.isArray(c.children)) fieldPaths(c.children, p, out)
  }
  return out
}

/**
 * Walk one parsed YAML document.
 *
 * @param {object} opts
 * @param {(f: object) => void} opts.report - A reference or example finding.
 * @param {(line: number, info: object) => void} opts.noteLine - Field info per
 *   line, for callouts.
 */
function walkYamlDocument (doc, lineCounter, lines, { data, index, cloudSurface, report, noteLine, usedComponents, connectContext = false }) {
  const root = doc.contents
  if (!root || !YAML.isMap(root)) return
  const rootFields = Array.isArray(data.config) ? data.config : []
  const keyName = (pair) => (pair && pair.key && YAML.isScalar(pair.key) ? String(pair.key.value) : undefined)
  const lineOf = (node) => (node && node.range ? lineCounter.linePos(node.range[0]).line - 1 : undefined)
  const rootKeys = root.items.map(keyName)
  const known = rootKeys.filter((k) => rootFields.some((f) => f.name === k))
  // A fragment: no root config key, or mostly keys that are not root config
  // fields (a template definition, a component on its own).
  if (!known.length || known.length * 2 < rootKeys.length) return
  if (!rootKeys.some((k) => PIPELINE_KEYS.has(k)) && !connectContext) return

  const commentDefault = (line, field, info) => {
    if (line === undefined) return
    const comment = commentOf(lines[line] || '')
    if (comment === undefined) return
    let claim
    for (const rx of COMMENT_DEFAULT_RX) {
      const m = comment.match(rx)
      if (m) { claim = m[1]; break }
    }
    if (claim === undefined) return
    const written = unquoteOnce(claim)
    const def = formatConnectDefault(field)
    const base = { line, status: 'example-output', reason: 'comment-default', written, field: 'default', ...info }
    if (!def.ok || (field.default === '' && /\(default:?\s/i.test(String(field.description || '')))) {
      report({ ...base, verdict: 'unverifiable', note: `the data has no inline default (${def.ok ? 'description-default' : def.reason})` })
      return
    }
    const data = def.text === '""' ? '' : def.text
    report({ ...base, dataValue: def.text, verdict: written === data || written === def.text ? 'matches' : 'stale' })
  }

  const walkChildren = (node, children, info) => {
    if (!YAML.isMap(node)) return
    for (const pair of node.items) {
      const key = keyName(pair)
      if (key === undefined) continue
      const line = lineOf(pair.key)
      const field = (children || []).find((c) => c && c.name && c.name.replace(/\[\]$/, '') === key)
      const fieldPath = info.fieldPath ? `${info.fieldPath}.${key}` : key
      if (!field) {
        const suggestions = require('../../extension-utils/attachment-datasets').suggest(key, (children || []).map((c) => c && c.name).filter(Boolean))
        report({ line, status: 'reference', reason: 'unknown-field', severity: 'error', ...info, fieldPath, note: `'${key}' is not a field of ${info.componentLabel}${info.fieldPath ? `.${info.fieldPath}` : ''} in the Connect data${suggestions.length ? `. Did you mean: ${suggestions.join(', ')}?` : ''}` })
        continue
      }
      const here = { ...info, fieldPath, fieldEntry: field }
      if (noteLine && line !== undefined) noteLine(line, here)
      if (field.is_deprecated === true) {
        report({ line, status: 'reference', reason: 'deprecated-field', severity: 'warning', ...info, fieldPath, note: `${fieldPath} is deprecated in the Connect data; the reference does not list it` })
      }
      commentDefault(line, field, { ...info, fieldPath })
      if (YAML.isScalar(pair.value)) {
        const def = formatConnectDefault(field)
        if (def.ok && String(pair.value.value) === def.text) index.counts.yamlRestatingDefault++
      }
      walkField(pair.value, field, here)
    }
  }

  const walkComponent = (node, type, info) => {
    if (!YAML.isMap(node)) return
    const wrappers = node.items.filter((p) => {
      const k = keyName(p)
      const allowed = COMPONENT_WRAPPER_KEYS[k]
      return allowed === 'any' || (Array.isArray(allowed) && allowed.includes(type))
    })
    const named = node.items.filter((p) => !wrappers.includes(p))
    for (const p of wrappers) {
      if (keyName(p) === 'processors' && YAML.isSeq(p.value)) {
        for (const item of p.value.items) walkComponent(item, 'processor', { ...info, parent: info.componentLabel })
      }
    }
    // The explicit form, type: <name> beside or instead of the <name> key.
    const explicit = named.find((p) => keyName(p) === 'type' && YAML.isScalar(p.value))
    let pair = named.length === 1 ? named[0] : undefined
    if (explicit) {
      const others = named.filter((p) => p !== explicit)
      if (others.length > 1) return
      pair = others[0] || { key: explicit.value, value: undefined }
      if (others.length && keyName(others[0]) !== String(explicit.value.value)) return
    }
    if (!pair) return
    const name = keyName(pair)
    const line = lineOf(pair.key)
    const typeKey = index.types[type]
    const entry = typeKey && (data[typeKey] || []).find((c) => c && c.name === name)
    const label = `${typeKey ? typeKey.replace(/-/g, '_') : type}/${name}`
    if (!entry) {
      if (cloudSurface) {
        report({ line, status: 'unverifiable', reason: 'not-in-connect-data', componentType: type, component: name, note: `${type} '${name}' is not in the OSS Connect data; Cloud-only components are not in it` })
      } else {
        const suggestions = require('../../extension-utils/attachment-datasets').suggest(name, (data[typeKey] || []).map((c) => c && c.name).filter(Boolean))
        report({ line, status: 'reference', reason: 'unknown-component', severity: 'error', componentType: type, component: name, note: `'${name}' is not ${/^[aeiou]/.test(type) ? 'an' : 'a'} ${type} component in the Connect data${suggestions.length ? `. Did you mean: ${suggestions.join(', ')}?` : ''}` })
      }
      return
    }
    usedComponents.add(`${typeKey}/${name}`)
    const compInfo = { componentType: type, componentKey: typeKey, component: name, componentLabel: label, entry }
    if (entry.status === 'deprecated') {
      report({ line, status: 'reference', reason: 'deprecated-component', severity: 'warning', ...compInfo, note: `${type} '${name}' is deprecated in the Connect data` })
    }
    const children = entry.config && Array.isArray(entry.config.children) ? entry.config.children : undefined
    if (children) walkChildren(pair.value, children, { ...compInfo, fieldPath: '' })
  }

  const walkField = (node, field, info) => {
    if (!node) return
    const componentType = normalizeType(field.type)
    if (index.types[componentType] && field.type !== 'object') {
      if (field.kind === 'array' && YAML.isSeq(node)) for (const item of node.items) walkComponent(item, componentType, info)
      else if (field.kind === 'map' && YAML.isMap(node)) for (const p of node.items) walkComponent(p.value, componentType, info)
      else walkComponent(node, componentType, info)
      return
    }
    if (field.type === 'unknown' || field.bloblang === true) return
    if (!Array.isArray(field.children) || !field.children.length) return
    if ((field.kind === 'array' || field.kind === '2darray') && YAML.isSeq(node)) {
      for (const item of node.items) walkChildren(item, field.children, info)
    } else if (field.kind === 'map' && YAML.isMap(node)) {
      for (const p of node.items) walkChildren(p.value, field.children, info)
    } else {
      walkChildren(node, field.children, info)
    }
  }

  const configInfo = { componentType: 'config', componentKey: 'config', component: '', componentLabel: 'config' }
  for (const pair of root.items) {
    const key = keyName(pair)
    const field = rootFields.find((f) => f.name === key)
    const line = lineOf(pair.key)
    if (!field) {
      report({ line, status: 'reference', reason: 'unknown-field', severity: 'error', ...configInfo, fieldPath: key, note: `'${key}' is not a root config field in the Connect data` })
      continue
    }
    const here = { ...configInfo, fieldPath: key, fieldEntry: field }
    if (noteLine && line !== undefined) noteLine(line, here)
    walkField(pair.value, field, here)
  }
}

/**
 * Resolve include::...example$<path>[tag=...] lines in a block to the lines
 * they include, each remembered with its own file and line.
 */
function expandBlock (b, { docsDir, relative, component }) {
  const out = []
  const pageModule = (relative.match(/^modules\/([^/]+)\//) || [])[1]
  for (const { index, text } of b.lines) {
    const inc = text.trim().match(/^include::(?:([\w-]+):)?(?:([\w-]+):)?example\$([^[]+)\[([^\]]*)\]$/)
    if (!inc) {
      out.push({ text, file: relative, line: index })
      continue
    }
    // [component:]module:example$path; a bare module:example$ is this
    // component.
    const [, first, second, target, attrs] = inc
    const comp = second ? first : undefined
    const mod = second || first || pageModule
    if (comp && comp !== component) continue
    const exampleRelative = path.join('modules', mod, 'examples', target)
    const full = path.join(docsDir, exampleRelative)
    if (!fs.existsSync(full)) continue
    const lines = fs.readFileSync(full, 'utf8').split('\n')
    const tag = (attrs.match(/tags?=([\w-]+)/) || [])[1]
    let inside = !tag
    lines.forEach((line, i) => {
      if (tag && new RegExp(`tag::${tag}\\[\\]`).test(line)) { inside = true; return }
      if (tag && new RegExp(`end::${tag}\\[\\]`).test(line)) { inside = false; return }
      if (/(?:tag|end)::[\w-]+\[\]/.test(line)) return
      if (inside) out.push({ text: line, file: exampleRelative, line: i })
    })
  }
  return out
}

/**
 * Parse and walk YAML text; report findings with each line's own file.
 *
 * @returns {{callouts: object, parsed: boolean}}
 */
function scanYaml (entries, ctx) {
  const raw = entries.map((e) => e.text).join('\n')
  const { text, callouts } = prepareYaml(raw)
  const lineCounter = new YAML.LineCounter()
  let docs
  try {
    docs = YAML.parseAllDocuments(text, { lineCounter, uniqueKeys: false })
  } catch (error) {
    ctx.counts.yamlUnparsed++
    return { callouts: {}, parsed: false }
  }
  if (!Array.isArray(docs)) docs = [docs]
  if (docs.some((d) => d.errors && d.errors.length)) {
    ctx.counts.yamlUnparsed++
    return { callouts: {}, parsed: false }
  }
  const lineInfo = {}
  const lines = raw.split('\n').map((l) => l.replace(CALLOUT_TRAILING_RX, ''))
  for (const doc of docs) {
    walkYamlDocument(doc, lineCounter, lines, {
      data: ctx.data,
      index: ctx.index,
      cloudSurface: ctx.cloudSurface,
      usedComponents: ctx.usedComponents,
      connectContext: ctx.connectContext,
      noteLine: (line, info) => { lineInfo[line] = info },
      report: (f) => {
        const at = entries[f.line] || entries[0]
        const { entry, fieldEntry, componentLabel, line, ...rest } = f
        ctx.report({ ...rest, file: at.file, line: at.line + 1, text: String(at.text).trim(), kind: 'connect', target: targetOf(f) })
      },
    })
  }
  const calloutFields = {}
  for (const [n, line] of Object.entries(callouts)) {
    if (lineInfo[line]) calloutFields[n] = lineInfo[line]
  }
  return { callouts: calloutFields, parsed: true }
}

function targetOf (f) {
  if (!f.fieldPath) return undefined
  const component = f.componentKey === 'config' ? 'config' : f.componentKey ? `${f.componentKey.replace(/-/g, '_')}/${f.component}` : undefined
  return component ? `connectval:${f.fieldPath}[component=${component}]` : undefined
}

/**
 * The Connect engine. Scans one checkout against one Connect registry.
 */
function scanConnect ({ docsDir, registry, files: only, write = false, cloudSurface = false, renderGuard, component: ownComponent }) {
  const data = registry.data
  const cindex = { ...componentIndex(data), counts: undefined }
  const counts = { yamlRestatingDefault: 0, yamlUnparsed: 0 }
  cindex.counts = counts
  const findings = []
  const seen = new Set()
  let files = 0
  let skippedGenerated = 0
  let changedFiles = 0
  const fieldNames = new Set()
  for (const { byName } of [cindex]) {
    for (const list of byName.values()) {
      for (const { entry } of list) for (const p of fieldPaths(entry.config && entry.config.children)) fieldNames.add(p.path.split('.').pop())
    }
  }
  const report = (f) => {
    const key = `${f.file}:${f.line}:${f.status}:${f.reason}:${f.fieldPath || f.component || ''}`
    if (seen.has(key)) return
    seen.add(key)
    findings.push(f)
  }
  const isHistorical = (relative) => HISTORICAL_RX.test(relative) || HISTORICAL_CONNECT_RX.test(relative)

  // Examples files, walked on their own.
  for (const relative of shared.walkFiles(docsDir, { exclude: EXAMPLE_EXCLUDE, extensions: ['.yaml', '.yml'], only, include: (r) => /^modules\/[^/]+\/examples\//.test(r) })) {
    files++
    const text = fs.readFileSync(path.join(docsDir, relative), 'utf8')
    const entries = text.split('\n').map((t, i) => ({ text: t, file: relative, line: i }))
    scanYaml(entries, { data, index: cindex, cloudSurface, counts, report, usedComponents: new Set(), connectContext: ownComponent === 'connect' || /(?:^|\/)(?:connect|rpcn|redpanda-connect)[^/]*\//.test(relative) })
  }

  for (const relative of shared.walkFiles(docsDir, { exclude: CONNECT_EXCLUDE, only })) {
    const full = path.join(docsDir, relative)
    const original = fs.readFileSync(full, 'utf8')
    if (shared.isGenerated(original)) { skippedGenerated++; continue }
    files++
    const historical = isHistorical(relative)
    const tagged = /^\s*\/\/\s*tag::[^[\s]+\[\]\s*$/m.test(original) || /(?:^|\/)partials\//.test(relative)
    const usedComponents = new Set()
    // Prose that names a Connect field with no component to check it against
    // is reported only on pages about Connect: elsewhere `offset` or
    // `target` is something else (a SQL argument, a Kafka Connect setting).
    const connectPage = /^modules\/components\//.test(relative) || /xref:(?:connect:)?components:|rpk connect\b|Redpanda Connect/.test(original)
    // First pass: the components the page's YAML uses, for prose context.
    let callouts = {}
    const pageFindings = []
    const ctx = { data, index: cindex, cloudSurface, counts, usedComponents, report: (f) => pageFindings.push(f), connectContext: ownComponent === 'connect' || /(?:^|\/)(?:connect|rpcn|redpanda-connect)[^/]*\//.test(relative) }
    const blocks = []
    walkAdoc(original, { onBlock: (b) => blocks.push(b) }, { cloudSurface })
    for (const b of blocks) {
      if (!YAML_LANGUAGES.has(blockLanguage(b.style))) continue
      scanYaml(expandBlock(b, { docsDir, relative, component: ownComponent }), { ...ctx, counts: { yamlRestatingDefault: 0, yamlUnparsed: 0 }, index: { ...cindex, counts: { yamlRestatingDefault: 0 } }, report: () => {} })
    }

    const proseLine = (index, line, ctxLine) => {
      const callout = line.match(CALLOUT_ITEM_RX)
      const claims = []
      if (callout && callouts[callout[1]]) {
        claims.push(...lineClaims(line, { calloutField: callouts[callout[1]], offset: line.indexOf(callout[2]) }))
      } else {
        if (line.trim() && !callout) callouts = {}
        claims.push(...lineClaims(line, {}))
      }
      let rewritten = line
      const lineFindings = []
      for (const claim of claims) {
        const f = classifyClaim(claim, { index, line, relative, data, componentIndex: cindex, usedComponents, historical, tagged, cloudSurface, ctxLine, fieldNames })
        if (f && (f.reason !== 'no-component-context' || connectPage || usedComponents.size)) lineFindings.push(f)
      }
      for (const f of [...lineFindings].sort((a, b) => b.start - a.start)) {
        if (write && f.autoSafe) {
          const candidate = rewritten.slice(0, f.start) + f.proposed + rewritten.slice(f.end)
          if (renderGuard && !renderGuard(relative, rewritten, candidate)) {
            f.autoSafe = false
            f.applied = false
            f.note = 'render-changed'
            continue
          }
          rewritten = candidate
          f.applied = true
        }
      }
      for (const f of lineFindings) {
        delete f.start
        delete f.end
        pageFindings.push(f)
      }
      return rewritten
    }

    const out = walkAdoc(original, {
      onBlock: (b) => {
        if (!YAML_LANGUAGES.has(blockLanguage(b.style))) return
        const result = scanYaml(expandBlock(b, { docsDir, relative, component: ownComponent }), ctx)
        callouts = result.callouts
      },
      onProse: (index, line, ctxLine) => {
        if (ctxLine.inner !== undefined) {
          const inner = proseLine(index, ctxLine.inner, ctxLine)
          return inner === ctxLine.inner ? line : line.slice(0, ctxLine.offset) + inner + line.slice(ctxLine.offset + ctxLine.inner.length)
        }
        return proseLine(index, line, ctxLine)
      },
      onTableLine: (index, line, ctxLine) => {
        for (const claim of lineClaims(line, {})) {
          const f = classifyClaim(claim, { index, line, relative, data, componentIndex: cindex, usedComponents, historical, tagged, cloudSurface, ctxLine, fieldNames, table: true })
          if (f && (f.reason !== 'no-component-context' || connectPage || usedComponents.size)) {
            delete f.start
            delete f.end
            pageFindings.push(f)
          }
        }
        return line
      },
    }, { cloudSurface })
    for (const f of pageFindings) report(f)
    if (write && out !== original && !historical) {
      fs.writeFileSync(full, out)
      changedFiles++
    }
  }
  for (const f of findings) {
    if (isHistorical(f.file)) f.historical = true
  }
  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
  return {
    files,
    skippedGenerated,
    yamlUnparsed: counts.yamlUnparsed,
    findings,
    counts: { ...countFindings(findings), yamlRestatingDefault: counts.yamlRestatingDefault },
    changedFiles,
  }
}

// Field mentions on a prose line: backticked names or dotted paths, and
// connectval: macros.
function fieldMentions (line) {
  const mentions = []
  for (const span of shared.backtickSpans(line)) {
    if (/^[a-z_][a-z0-9_]*(?:\.[a-z0-9_]+)*$/.test(span.text)) mentions.push({ path: span.text, start: span.start, end: span.end })
  }
  for (const m of line.matchAll(/connectval:([\w.]+)\[([^\]]*)\]/g)) {
    const component = (m[2].match(/(?:^|,)\s*component=([^,\]]*)/) || [])[1]
    mentions.push({ path: m[1], start: m.index, end: m.index + m[0].length, component: component && component.trim(), macro: true })
  }
  return mentions.sort((a, b) => a.start - b.start)
}

function lineClaims (line, { calloutField, offset = 0 }) {
  const claims = []
  const claimed = new Set()
  const { sentenceAt, text } = sentenceBounds(line)
  const mentions = fieldMentions(line)
  const add = (owner, phrase, valueStart) => {
    if (claimed.has(valueStart)) return
    const { parsed, skip } = shared.parseAfterFiller(line.slice(valueStart))
    if (!parsed) return
    claimed.add(valueStart)
    const ownSentence = text(sentenceAt(valueStart), sentenceAt(valueStart))
    const context = owner.mention ? text(sentenceAt(owner.mention.start), sentenceAt(valueStart)) : ownSentence
    const qualifier = context.replace(/\bconnectval:[^[\s]+\[[^\]]*\]/g, 'connectval:x[]').match(QUALIFIER_RX) || ownSentence.match(/^\s*(?:If|When|Unless|Suppose)\b/)
    claims.push({ ...owner, phrase, parsed, start: valueStart + skip, end: valueStart + skip + parsed.length, sentence: context, soleTarget: mentions.filter((m) => !owner.mention || m.path !== owner.mention.path).length === 0, ...(qualifier ? { qualifier: qualifier[0].trim() } : {}) })
  }
  const ownerOf = (at) => {
    if (calloutField) return { calloutField, association: 'callout' }
    const before = mentions.filter((m) => m.end <= at)
    const mention = before[before.length - 1]
    if (!mention) return undefined
    if (mentions.some((x) => x.start >= mention.end && x.start < at && x.path !== mention.path)) return undefined
    if (at - mention.end > ASSOCIATION_WINDOW) return undefined
    if (sentenceAt(at) === sentenceAt(mention.end)) return { mention, association: 'same-sentence' }
    if (sentenceAt(at) - sentenceAt(mention.end) === 1) return { mention, association: 'previous-sentence' }
    return undefined
  }
  for (const phrase of DEFAULT_PHRASES) {
    for (const p of line.matchAll(phrase.rx)) {
      if (p.index < offset) continue
      const owner = ownerOf(p.index)
      if (owner) add(owner, p[0].trim(), p.index + p[0].length)
    }
  }
  for (const m of line.matchAll(DEFAULT_OF_RX)) {
    const name = m[1].replace(/`/g, '')
    const mention = mentions.find((x) => x.path === name && x.start === m.index + m[0].indexOf(m[1]))
    if (mention) add({ mention, association: 'same-sentence' }, 'default of', m.index + m[0].length)
  }
  return claims
}

/**
 * Which component and field a prose claim is about.
 */
function resolveClaimField (claim, { data, componentIndex: index, usedComponents, relative }) {
  if (claim.calloutField) {
    const f = claim.calloutField
    return { componentKey: f.componentKey, component: f.component, componentType: f.componentType, fieldPath: f.fieldPath, field: f.fieldEntry, entry: f.entry, from: 'callout' }
  }
  const mention = claim.mention
  const candidatesIn = (key, name) => {
    const entry = key === 'config' ? undefined : (data[key] || []).find((c) => c && c.name === name)
    const children = key === 'config' ? data.config : entry && entry.config && entry.config.children
    return fieldPaths(children)
      .filter((p) => p.path === mention.path || p.path.endsWith(`.${mention.path}`))
      .map((p) => ({ componentKey: key, component: name, componentType: key === 'config' ? 'config' : normalizeType((entry || {}).type || key), fieldPath: p.path, field: p.field, entry }))
  }
  if (mention.component) {
    const parsed = connectValues.parseComponent(mention.component)
    if (!parsed) return { error: 'no-component-context' }
    const resolved = connectValues.resolveComponent(data, parsed.type, parsed.name)
    if (!resolved.ok) return { error: 'no-component-context' }
    const found = candidatesIn(resolved.key, parsed.name).filter((c) => c.fieldPath === mention.path)
    return found.length === 1 ? { ...found[0], from: 'macro' } : { error: 'no-component-context' }
  }
  // A dotted path from a root config field (pipeline.threads).
  if (mention.path.includes('.')) {
    const root = candidatesIn('config', '').filter((c) => c.fieldPath === mention.path)
    if (root.length === 1) return { ...root[0], from: 'config' }
  }
  // An xref to a component page, or a backticked component name that exists
  // in exactly one type, in the same sentence.
  const sentence = claim.sentence || ''
  const named = []
  for (const m of sentence.matchAll(/xref:(?:[\w-]+:)?components:([a-z_]+)\/([\w-]+)\.adoc/g)) {
    const key = index.types[normalizeType(m[1])]
    if (key) named.push({ key, name: m[2] })
  }
  for (const span of shared.backtickSpans(sentence)) {
    const list = index.byName.get(span.text)
    if (list && list.length === 1) named.push({ key: list[0].key, name: span.text })
  }
  const unique = [...new Map(named.map((n) => [`${n.key}/${n.name}`, n])).values()]
  const fromNamed = unique.flatMap((n) => candidatesIn(n.key, n.name))
  if (fromNamed.length === 1) return { ...fromNamed[0], from: 'sentence' }
  if (fromNamed.length > 1) return { error: 'ambiguous-component' }
  // A component reference page (modules/components/pages/inputs/kafka.adoc)
  // is about its own component.
  const pageType = typeFromRelative(relative)
  if (pageType && index.types[pageType]) {
    const name = path.basename(relative, '.adoc')
    const own = candidatesIn(index.types[pageType], name)
    if (own.length === 1) return { ...own[0], from: 'page' }
  }
  // The components the page's YAML uses, when exactly one has the field.
  const fromPage = [...usedComponents].flatMap((k) => {
    const [key, name] = k.split('/')
    return candidatesIn(key, name)
  })
  if (fromPage.length === 1) return { ...fromPage[0], from: 'page' }
  if (fromPage.length > 1) return { error: 'ambiguous-component' }
  return { error: 'no-component-context' }
}

function classifyClaim (claim, { index, line, relative, data, componentIndex, usedComponents, historical, tagged, cloudSurface, ctxLine, fieldNames, table = false }) {
  const resolved = resolveClaimField(claim, { data, componentIndex, usedComponents, relative })
  const base = {
    file: relative,
    line: index + 1,
    text: line.trim(),
    kind: 'connect',
    field: 'default',
    phrase: claim.phrase,
    written: claim.parsed.written,
    association: claim.association,
    autoSafe: false,
    start: claim.start,
    end: claim.end,
    ...(claim.qualifier ? { qualifier: claim.qualifier } : {}),
  }
  if (resolved.error) {
    const name = claim.mention && claim.mention.path.split('.').pop()
    if (!name || !fieldNames.has(name)) return undefined
    return { ...base, fieldPath: claim.mention.path, status: 'unverifiable', reason: resolved.error }
  }
  const field = resolved.field
  Object.assign(base, { componentType: resolved.componentType, component: resolved.component, fieldPath: resolved.fieldPath })
  base.target = targetOf({ ...resolved })
  if (claim.parsed.bareWord && field.type !== 'string') return undefined
  if (cloudSurface && resolved.entry) {
    const available = resolved.entry.cloudSupported
    if (available === false) return { ...base, status: 'unverifiable', reason: 'cloud-unavailable', note: 'cloudSupported: false in the Connect data' }
  }
  const value = connectValues.fieldValue(field, 'default', {})
  if (!value.ok) {
    const reason = value.reason === 'missing' ? 'missing-field' : value.reason === 'complex' ? 'complex-default' : value.reason
    return { ...base, status: 'unverifiable', reason }
  }
  base.dataValue = value.text
  if (claim.qualifier) return { ...base, status: 'unverifiable', reason: 'qualified' }
  const status = shared.compareWritten(claim.parsed, value.text, { bool: field.type === 'bool', stringType: field.type === 'string' })
  if (status === 'not-comparable') return { ...base, status: 'unverifiable', reason: 'not-comparable' }
  base.status = status
  if (status === 'exact' || status === 'equivalent') base.proposed = claim.parsed.backticked ? `\`${base.target}\`` : base.target
  if (status !== 'exact') return base
  const why = (() => {
    if (!['same-sentence', 'callout'].includes(claim.association)) return `tied to the field by ${claim.association}: proposed only`
    if (!claim.soleTarget) return 'another field is named on the line: proposed only'
    if (['""', '[]', '{}'].includes(value.text)) return 'an empty default: proposed only'
    if (table) return 'in a table: proposed only'
    if (historical) return 'release, upgrade or migration notes: proposed only'
    if (!cloudSurface && tagged && !ctxLine.cloudExcluded && resolved.entry && resolved.entry.cloudSupported === false) return 'page may be single-sourced; wrap in ifndef::env-cloud[] first'
    return undefined
  })()
  if (why) base.note = why
  else base.autoSafe = true
  return base
}

module.exports = {
  scanConnect,
  prepareYaml,
  commentOf,
  walkYamlDocument,
  expandBlock,
  fieldMentions,
  lineClaims,
  resolveClaimField,
  COMPONENT_WRAPPER_KEYS,
  CONNECT_EXCLUDE,
}

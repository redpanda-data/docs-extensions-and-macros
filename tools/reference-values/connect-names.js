'use strict'

/* Former and deprecated Connect and Bloblang names in check-reference-values
 * (names.js): on a prose line, the connect:, connectval:, blobl: and
 * bloblval: macros, a backticked component name followed by its type
 * (`kafka_franz` input), and in Connect content a backticked Bloblang call
 * (`meta()`, `.format_timestamp()`).
 *
 *   renamed-component (status alias)  a component the data does not have,
 *       whose page path the connect docs alias to another component's page
 *       (outputs/kafka_migrator -> outputs/redpanda_migrator).
 *   deprecated-component, deprecated-field (reference warnings)  with the
 *       replacement extension-utils/connect-links.js referenceAdvice finds.
 *   deprecated-function, deprecated-method (reference warnings)  the data
 *       names no replacement, so these are never written.
 *
 * A rewrite keeps the call's label, field and attributes, and is writable
 * only for a replacement of the same type that has the same field path, on
 * a line that is not about the name, with the replacement not already
 * written nearby.
 */

const connectLinks = require('../../extension-utils/connect-links')
const connectValues = require('../../extension-utils/connect-values')
const bloblang = require('../../extension-utils/bloblang-values')
const { normalizeType } = require('../../extensions/util/connect-catalog')
const shared = require('./shared')
const mentions = require('./mentions')
const oldNames = require('./names')

const TYPE_WORDS = 'input|output|processor|cache|buffer|rate limit|tracer|scanner|metrics(?: exporter)?'
const TYPE_AFTER_RX = new RegExp(`^\\s+(${TYPE_WORDS})\\b`, 'i')

const escapeRx = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The old-name findings of one prose line.
 *
 * @param {string} line
 * @param {object} opts
 * @param {number} opts.index - The line's index in the file.
 * @param {string} opts.relative - The file.
 * @param {object} opts.data - The Connect data.
 * @param {object} [opts.catalog] - The scan's content catalog, for page aliases.
 * @param {string} [opts.dataset] - describeDataset of the data.
 * @param {boolean} [opts.bloblangToo] - Whether backticked calls on the line are Bloblang.
 * @param {string} [opts.nearby] - The lines around it.
 * @param {boolean} [opts.historical]
 * @returns {object[]} findings, with start, end and proposed for a rewrite.
 */
function connectNameFindings (line, { index, relative, data, catalog, dataset = 'the Connect data', bloblangToo = false, nearby = line, elsewhere = '', historical = false }) {
  const out = []
  const allowed = oldNames.lineAllowsRewrite(line)
  const types = connectValues.componentTypes(data)
  const base = { file: relative, line: index + 1, text: line.trim(), kind: 'connect', check: 'name', severity: 'warning' }
  const ranges = mentions.linkRanges(line)
  const inMacro = (start, end) => ranges.some(([a, b]) => start >= a && end <= b)
  // The replacement already written near the line: as a span or in a macro.
  const nearbyHas = (ref) => {
    const { component, path } = connectValues.parseFieldTarget(ref)
    const name = component.split('/')[1]
    // A field path is the same on both components, so only the full
    // reference counts for one.
    const span = path ? '' : `\`${escapeRx(name)}\`|`
    return new RegExp(`${span}${escapeRx(component)}${path ? `\\.${escapeRx(path)}` : ''}(?![\\w.])`).test(nearby)
  }

  const componentFinding = ({ start, end, written, ref, proposed }) => {
    const advice = connectLinks.referenceAdvice(catalog, data, ref)
    if (!advice) return
    const { component, path } = connectValues.parseFieldTarget(ref)
    const parsed = connectValues.parseComponent(component) || {}
    const finding = {
      ...base,
      status: advice.kind === 'renamed' ? oldNames.STATUS : 'reference',
      reason: advice.kind === 'renamed' ? 'renamed-component' : advice.kind,
      componentType: normalizeType(parsed.type || ''),
      component: parsed.name,
      ...(path ? { fieldPath: path } : {}),
      written,
      proposed: advice.ref ? proposed(advice.ref) : undefined,
      replacement: advice.kind === 'deprecated-field' ? advice.field : advice.replacement ? `${connectLinks.typeDir(advice.replacement.key)}/${advice.replacement.name}` : undefined,
      rename: undefined,
      start,
      end,
      note: connectLinks.adviceSentence(advice, { written: ref, dataset, suggest: (r) => proposed(r) || r }).replace(/\.$/, ''),
    }
    finding.rename = finding.proposed ? { before: written, after: finding.proposed, links: advice.kind === 'renamed' ? 'same' : 'any' } : undefined
    let writable = Boolean(finding.proposed) && advice.writable
    let why
    if (writable && historical) [writable, why] = [false, 'release, upgrade and migration notes record the names of their time, so --write leaves them']
    else if (writable && !allowed.writable) [writable, why] = [false, allowed.note]
    else if (writable && nearbyHas(advice.ref)) [writable, why] = [false, `${advice.ref} is already written nearby, so the old name may be listed on purpose; change it by hand`]
    else if (writable && new RegExp(`(?<![\\w.-])${escapeRx(parsed.name)}(?![\\w-])`).test(elsewhere)) [writable, why] = [false, `the page also names ${parsed.name} elsewhere, such as in an example, so change them together by hand`]
    finding.writable = writable
    if (why) finding.note = `${finding.note}; ${why}`
    out.push(finding)
  }

  const bloblangFinding = ({ start, end, written, call, field }) => {
    const parsed = bloblang.parseCall(call)
    if (!parsed.ok) return
    const resolved = bloblang.resolveCall(data, parsed)
    if (!resolved.ok || resolved.entry.status !== 'deprecated') return
    if (field && ['status', 'deprecated'].includes(String(field).trim().toLowerCase())) return
    out.push({
      ...base,
      status: 'reference',
      reason: `deprecated-${resolved.kind}`,
      target: bloblang.callText(resolved.kind, resolved.entry.name),
      written,
      writable: false,
      start,
      end,
      note: bloblang.deprecationNote(resolved.kind, resolved.entry, dataset).replace(/\.$/, ''),
    })
  }

  // connect:[<type>/<name>[.<path>](,label)]
  for (const m of line.matchAll(/(?<![\w:])connect:\[([^\],]*)((?:,(?:\\\]|[^\]])*)?)\]/g)) {
    componentFinding({ start: m.index, end: m.index + m[0].length, written: m[0], ref: m[1].trim(), proposed: (ref) => `connect:[${ref}${m[2]}]` })
  }
  // connectval:[...], connectval::[...], connectval:<path>[...,component=...]
  for (const m of line.matchAll(/(?<![\w:])connectval(::?)\[([^\],]*)((?:,(?:\\\]|[^\]])*)?)\]/g)) {
    const field = (m[3].match(/^,\s*([^,=\]]+?)\s*(?:,|$)/) || [])[1]
    if (field && ['status', 'deprecated'].includes(field.toLowerCase())) {
      // Asking whether a component is deprecated: only a former name matters.
      const advice = connectLinks.referenceAdvice(catalog, data, m[2].trim())
      if (!advice || advice.kind !== 'renamed') continue
    }
    componentFinding({ start: m.index, end: m.index + m[0].length, written: m[0], ref: m[2].trim(), proposed: (ref) => `connectval${m[1]}[${ref}${m[3]}]` })
  }
  for (const m of line.matchAll(/(?<![\w:])connectval:([\w.[\]]+)\[([^\]]*)\]/g)) {
    const attr = m[2].match(/(^|,)(\s*component=)([^,\]]*)/)
    if (!attr) continue
    const valueStart = attr.index + attr[1].length + attr[2].length
    componentFinding({
      start: m.index,
      end: m.index + m[0].length,
      written: m[0],
      ref: `${attr[3].trim()}.${m[1]}`,
      proposed: (ref) => {
        const to = connectValues.parseFieldTarget(ref)
        return `connectval:${to.path}[${m[2].slice(0, valueStart)}${to.component}${m[2].slice(valueStart + attr[3].length)}]`
      },
    })
  }
  // blobl:[call(,label)] and bloblval:[call,field]
  for (const m of line.matchAll(/(?<![\w:])(blobl|bloblval)(?:::?)\[([^\],]*)((?:,(?:\\\]|[^\]])*)?)\]/g)) {
    const field = m[1] === 'bloblval' ? (m[3].match(/^,\s*([^,=\]]+?)\s*(?:,|$)/) || [])[1] : undefined
    bloblangFinding({ start: m.index, end: m.index + m[0].length, written: m[0], call: m[2].trim(), field })
  }

  // Prose spans: `name` <type>, and Bloblang calls in Connect content.
  for (const span of shared.backtickSpans(line)) {
    if (inMacro(span.start, span.end)) continue
    const rest = line.slice(span.end)
    const typeWord = rest.match(TYPE_AFTER_RX)
    if (typeWord && /^[a-z0-9_]+$/.test(span.text)) {
      const type = normalizeType(typeWord[1].toLowerCase().replace(/ exporter$/, '').replace(/ /g, '_'))
      const key = types[type]
      if (!key) continue
      const written = line.slice(span.start, span.end)
      componentFinding({
        start: span.start,
        end: span.end,
        written,
        ref: `${connectLinks.typeDir(key)}/${span.text}`,
        proposed: (ref) => {
          const to = connectValues.parseFieldTarget(ref)
          return to.path ? undefined : written.replace(span.text, to.component.split('/')[1])
        },
      })
      continue
    }
    if (!bloblangToo) continue
    if (/^\.?[a-z_][a-z0-9_]*\(\)$/.test(span.text)) bloblangFinding({ start: span.start, end: span.end, written: line.slice(span.start, span.end), call: span.text })
  }
  return out.sort((a, b) => a.start - b.start)
}

module.exports = { connectNameFindings }

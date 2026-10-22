'use strict'

const { stripComments, matchBracket, splitArgs, literalValue, lineAt } = require('../source')
const { makeFinding, PAGES } = require('../finding')

/**
 * Metrics (src/v/**, non-test C++): the metric names registered through
 * `sm::make_gauge("name", ...)`, `make_counter`, `make_histogram` and the
 * other make_* factories, grouped by the enclosing `add_group(...)` call:
 *
 *     _public_metrics.add_group(
 *       prometheus_sanitize::metrics_name("cluster:partition"),
 *       { sm::make_gauge("start_offset", ...), ... });
 *
 * The lint reviews the sm::description text; this detector reads the name
 * and the group, which together form the published metric name. Which
 * registry the group goes into decides the page: a receiver named
 * *public* publishes to /public/metrics as redpanda_<group>_<name>, any
 * other to /metrics as vectorized_<group>_<name>. A factory call outside
 * any add_group (a helper returning the definition) keeps its bare name.
 */

const ROUTES = [/^src\/v\/(?!config\/)(?!(?:.*\/)?tests?\/)(?!(?:.*\/)?test\/).*\.(?:cc|h)$/]

// `_metrics.add_group(`, `_public_metrics->add_group(`, `group->add_group(`.
const ADD_GROUP = /([A-Za-z_][A-Za-z0-9_.>-]*?)\s*(?:\.|->)\s*add_group\s*\(/g
const MAKE = /\b(?:sm::|ss::metrics::)?make_([a-z0-9_]+)\s*\(/g

function parseMetrics (snippets) {
  const metrics = new Map()
  const unresolved = []
  for (const { startLine, text: raw } of snippets) {
    const text = stripComments(raw)
    if (!/make_[a-z0-9_]+\s*\(/.test(text)) continue
    // Group spans: [open, close, group, registry].
    const groups = []
    ADD_GROUP.lastIndex = 0
    let m
    while ((m = ADD_GROUP.exec(text)) !== null) {
      const open = m.index + m[0].length - 1
      const close = matchBracket(text, open)
      if (close === -1) { unresolved.push({ line: lineAt(text, m.index, startLine), what: 'add_group call' }); continue }
      const args = splitArgs(text.slice(open + 1, close))
      let group = null
      if (args.length > 0) {
        const lit = /metrics_name\s*\(\s*("(?:[^"\\]|\\.)*")\s*\)/.exec(args[0])
        group = lit ? literalValue(lit[1]) : literalValue(args[0])
      }
      const receiver = m[1]
      groups.push({ open, close, group: group ? group.replace(/[^A-Za-z0-9_]/g, '_') : null, registry: /public/i.test(receiver) ? 'public' : 'internal' })
    }
    MAKE.lastIndex = 0
    while ((m = MAKE.exec(text)) !== null) {
      const kind = m[1]
      if (!/^(gauge|counter|histogram|total_bytes|total_operations|derive|current_bytes|queue_length|summary)$/.test(kind) && !/^(gauge|counter|histogram)/.test(kind)) continue
      const open = m.index + m[0].length - 1
      const close = matchBracket(text, open)
      const line = lineAt(text, m.index, startLine)
      if (close === -1) { unresolved.push({ line, what: `make_${kind} call` }); continue }
      const args = splitArgs(text.slice(open + 1, close))
      const name = literalValue(args[0])
      if (!name) continue
      // Inside an add_group(...) call the group is the enclosing one. A
      // definition built into a vector first (`defs.emplace_back(make_...)`
      // then `_metrics.add_group(name, std::move(defs))`) belongs to the
      // nearest add_group that follows it in the same snippet.
      const enclosing = groups.find((g) => m.index > g.open && m.index < g.close) ||
        groups.filter((g) => g.open > m.index).sort((a, b) => a.open - b.open)[0] || null
      const group = enclosing ? enclosing.group : null
      const registry = enclosing ? enclosing.registry : 'internal'
      const prefix = registry === 'public' ? 'redpanda' : 'vectorized'
      const full = group ? `${prefix}_${group}_${name}` : name
      metrics.set(full, { name, group, registry, full, kind, line, lineEnd: lineAt(text, close, startLine) })
    }
  }
  return { metrics, unresolved }
}

function detect ({ files, sides, excerpt, note }) {
  const findings = []
  for (const file of files) {
    const { base, head, partial } = sides(file)
    const b = parseMetrics(base)
    const h = parseMetrics(head)
    if (b.metrics.size === 0 && h.metrics.size === 0) continue
    if (partial) {
      for (const u of [...b.unresolved, ...h.unresolved]) {
        note(`${file.path}:${u.line}: ${u.what} is cut by the hunk; run with --repo to read the whole file`, { file: file.path, line: u.line })
      }
    }
    const removed = [...b.metrics.keys()].filter((k) => !h.metrics.has(k))
    const added = [...h.metrics.keys()].filter((k) => !b.metrics.has(k))
    const common = { detector: 'metrics', surface: 'metrics', file: file.path }
    const pageFor = (metric) => (metric.registry === 'public' ? PAGES.publicMetrics : PAGES.internalMetrics)
    // One removed and one added in the same group is a rename.
    const pairedAdded = new Set()
    for (const key of removed) {
      const old = b.metrics.get(key)
      const candidates = added.filter((k) => !pairedAdded.has(k) && h.metrics.get(k).group === old.group && h.metrics.get(k).registry === old.registry)
      const removedInGroup = removed.filter((k) => b.metrics.get(k).group === old.group && b.metrics.get(k).registry === old.registry)
      if (candidates.length === 1 && removedInGroup.length === 1) {
        const nk = candidates[0]
        const nm = h.metrics.get(nk)
        pairedAdded.add(nk)
        findings.push(makeFinding({
          ...common,
          page: pageFor(nm),
          name: nm.full,
          change_kind: 'renamed',
          line: nm.line,
          evidence: excerpt(file, 'head', nm.line, nm.lineEnd),
          summary: `Metric \`${old.full}\` was removed and \`${nm.full}\` was added in the same group in \`${file.path}\`; read as a rename unless the PR says otherwise. Dashboards and alert examples that query the old name stop matching; the metrics reference regenerates under the new name.`
        }))
        continue
      }
      findings.push(makeFinding({
        ...common,
        page: pageFor(old),
        name: old.full,
        change_kind: 'removed',
        line: old.line,
        evidence: excerpt(file, 'base', old.line, old.lineEnd),
        summary: `Metric \`${old.full}\` (${old.registry} registry) was removed in \`${file.path}\`. The metrics reference and any monitoring page that queries it state a metric the broker no longer exposes.`
      }))
    }
    for (const key of added) {
      if (pairedAdded.has(key)) continue
      const nm = h.metrics.get(key)
      findings.push(makeFinding({
        ...common,
        page: pageFor(nm),
        name: nm.full,
        change_kind: 'added',
        line: nm.line,
        evidence: excerpt(file, 'head', nm.line, nm.lineEnd),
        summary: `New ${nm.kind.replace(/_/g, ' ')} metric \`${nm.full}\` (${nm.registry} registry) in \`${file.path}\`. The metrics reference lists it on regeneration; the monitoring page for this subsystem needs it if operators should alert on it.`
      }))
    }
  }
  return findings
}

module.exports = { id: 'metrics', surface: 'metrics', routes: ROUTES, detect, parseMetrics }

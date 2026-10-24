'use strict'

const { stripComments, matchBracket, splitArgs, literalValue, lineAt, normalize } = require('../source')
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
 * and the group, which together form the published metric name, and the
 * labels. Which registry the group goes into decides the page: a receiver
 * declared `metrics::public_metric_groups` (a member, an optional, a
 * parameter) publishes to /public_metrics as redpanda_<group>_<name>, an
 * internal one to /metrics as vectorized_<group>_<name>; the receiver's
 * name decides only when no declaration is in view. A group name held in a
 * variable or constant is followed to its literal. Families that
 * `replicate_metric_families` copies to the public endpoint are read too.
 * A factory call outside any add_group (a helper returning the definition)
 * keeps its bare name, and so does one whose group is built at run time;
 * the finding says so.
 */

const ROUTES = [/^src\/v\/(?!config\/)(?!(?:.*\/)?tests?\/)(?!(?:.*\/)?test\/).*\.(?:cc|h)$/]

// `_metrics.add_group(`, `_public_metrics->add_group(`, and through an
// accessor: `_internal_metrics.value().add_group(`,
// `x.emplace().add_group(`. The receiver's first identifier is the one
// whose declared type decides the registry.
const ADD_GROUP = /((?:[A-Za-z_]\w*(?:\(\s*\))?\s*(?:\.|->)\s*)+)add_group\s*\(/g
const MAKE = /\b(?:sm::|ss::metrics::)?make_([a-z0-9_]+)\s*\(/g
// seastar::metrics::replicate_metric_families(handle, {{"name", public_metrics_handle}, ...})
const REPLICATE = /\breplicate_metric_families\s*\(/g

/**
 * Which registry a receiver variable belongs to, from its declaration in
 * the given text (`metrics::public_metric_groups _service_metrics;`,
 * `std::optional<metrics::internal_metric_groups> _metrics;`, a
 * `metrics::public_metric_groups& mgs` parameter), or null when no
 * declaration is in view.
 */
function declaredRegistry (name, declText, preceding = '') {
  if (!name) return null
  const re = new RegExp(`\\b(public_metric_groups|internal_metric_groups|metric_groups)\\b\\s*>?\\s*[&*]?\\s*${name}\\b`, 'g')
  // The declaration nearest above the call wins: one file can declare a
  // parameter `mgs` as internal in one function and public in the next.
  let last = null
  let m
  while ((m = re.exec(preceding)) !== null) last = m
  if (!last && declText) { re.lastIndex = 0; last = re.exec(declText) }
  if (!last) return null
  return last[1] === 'public_metric_groups' ? 'public' : 'internal'
}

/**
 * The string literal a variable or constant was last set to above `at`
 * (or anywhere in `declText`), looking through `metrics_name(...)`.
 */
function constantString (name, preceding, declText) {
  const re = new RegExp(`\\b${name}\\s*(?:=\\s*|\\{\\s*|\\(\\s*)(?:[\\w:]*metrics_name\\s*\\(\\s*)?("(?:[^"\\\\]|\\\\.)*")`, 'g')
  let last = null
  let m
  while ((m = re.exec(preceding)) !== null) last = m
  if (!last && declText) { re.lastIndex = 0; last = re.exec(declText) }
  return last ? literalValue(last[1]) : null
}

/**
 * @param {Array<{startLine: number, text: string}>} snippets
 * @param {string} [declText] - whole-file text (the file and its header)
 *   to resolve receiver declarations in; the snippets are searched too
 */
function parseMetrics (snippets, declText = '') {
  const metrics = new Map()
  const unresolved = []
  const decls = stripComments([declText, ...snippets.map((s) => s.text)].join('\n'))
  for (const { startLine, text: raw } of snippets) {
    const text = stripComments(raw)
    if (!/make_[a-z0-9_]+\s*\(|replicate_metric_families/.test(text)) continue
    // Group spans: [open, close, group, registry, args text].
    const groups = []
    ADD_GROUP.lastIndex = 0
    let m
    while ((m = ADD_GROUP.exec(text)) !== null) {
      const open = m.index + m[0].length - 1
      const close = matchBracket(text, open)
      if (close === -1) { unresolved.push({ line: lineAt(text, m.index, startLine), what: 'add_group call' }); continue }
      const argsText = text.slice(open + 1, close)
      const args = splitArgs(argsText)
      let group = null
      if (args.length > 0) {
        // The group name: a literal, `metrics_name("...")`, or a variable or
        // constant holding a literal (`constexpr auto prefix = "cluster";`,
        // `auto group_name = prometheus_sanitize::metrics_name("x");`).
        const inner = (/metrics_name\s*\(\s*([\s\S]*?)\s*\)\s*$/.exec(args[0]) || [null, args[0]])[1]
        group = literalValue(inner)
        if (group === null && /^[A-Za-z_]\w*$/.test(inner.trim())) group = constantString(inner.trim(), text.slice(0, m.index), decls)
      }
      const receiver = m[1]
      const root = (/^[A-Za-z_]\w*/.exec(receiver.trim()) || [null])[0]
      const registry = declaredRegistry(root, decls, text.slice(0, m.index)) || (/public/i.test(receiver) ? 'public' : 'internal')
      // Group-level labels (add_group's third and fourth arguments).
      const groupLabels = normalize(args.slice(2).join(', '))
      groups.push({ open, close, group: group ? group.replace(/[^A-Za-z0-9_]/g, '_') : null, registry, argsText, groupLabels })
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
      // Labels: the definition's label list and any `.aggregate({...})`
      // chained on it. Dropping a label changes every query that uses it.
      let labels = args.length > 3 ? normalize(args.slice(3).join(', ')) : ''
      const after = /^\s*\.\s*aggregate\s*\(/.exec(text.slice(close + 1))
      if (after) {
        const aOpen = close + 1 + after[0].length - 1
        const aClose = matchBracket(text, aOpen)
        if (aClose !== -1) labels += ` aggregate(${normalize(text.slice(aOpen + 1, aClose))})`
      }
      // Inside an add_group(...) call the group is the enclosing one. A
      // definition built into a vector first (`defs.emplace_back(make_...)`
      // then `_metrics.add_group(name, std::move(defs))`) belongs to every
      // add_group that passes that vector, or, when the vector cannot be
      // named, to the nearest add_group that follows it in the snippet.
      let targets = groups.filter((g) => m.index > g.open && m.index < g.close)
      if (targets.length > 1) targets = [targets.sort((a, b) => b.open - a.open)[0]]
      if (targets.length === 0) {
        const pushed = /([A-Za-z_]\w*)\s*\.\s*(?:emplace_back|push_back)\s*\(\s*$/.exec(text.slice(Math.max(0, m.index - 200), m.index).replace(/\b(?:sm::|ss::metrics::)?$/, ''))
        if (pushed) targets = groups.filter((g) => g.open > m.index && new RegExp(`\\b${pushed[1]}\\b`).test(g.argsText))
        if (targets.length === 0) {
          const next = groups.filter((g) => g.open > m.index).sort((a, b) => a.open - b.open)[0]
          if (next) targets = [next]
        }
      }
      const add = (group, registry, groupLabels) => {
        const prefix = registry === 'public' ? 'redpanda' : 'vectorized'
        const full = group ? `${prefix}_${group}_${name}` : name
        metrics.set(full, { name, group, registry, full, kind, line, lineEnd: lineAt(text, close, startLine), labels, groupLabels })
      }
      if (targets.length === 0) add(null, 'internal', '')
      for (const g of targets) add(g.group, g.registry, g.groupLabels)
    }
    // Seastar's own families copied to the public endpoint by name.
    REPLICATE.lastIndex = 0
    while ((m = REPLICATE.exec(text)) !== null) {
      const open = m.index + m[0].length - 1
      const close = matchBracket(text, open)
      if (close === -1) { unresolved.push({ line: lineAt(text, m.index, startLine), what: 'replicate_metric_families call' }); continue }
      const body = text.slice(open + 1, close)
      const entry = /\{\s*("(?:[^"\\]|\\.)*")\s*,\s*([^{}]*?public[^{}]*?)\s*\}/g
      let e
      while ((e = entry.exec(body)) !== null) {
        const name = literalValue(e[1])
        if (!name) continue
        const line = lineAt(text, open + 1 + e.index, startLine)
        const full = `redpanda_${name}`
        metrics.set(full, { name, group: null, registry: 'public', full, kind: 'replicated', line, lineEnd: line, labels: '', groupLabels: '' })
      }
    }
  }
  return { metrics, unresolved }
}

function detect ({ files, sides, excerpt, note, readBase, readHead }) {
  const findings = []
  for (const file of files) {
    const { base, head, partial } = sides(file)
    // The receiver of add_group is usually declared in the file's header
    // (`metrics::public_metric_groups _service_metrics;` in probe.h).
    const header = file.path.replace(/\.cc$/, '.h')
    const declOf = (reader, p, own) => [own, header !== p && reader ? reader(header) : null].filter(Boolean).join('\n')
    const b = parseMetrics(base, declOf(readBase, file.oldPath, null))
    const h = parseMetrics(head, declOf(readHead, file.path, null))
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
    const bareNote = (metric) => (metric.group || metric.kind === 'replicated' ? '' : ` Its group name is built at run time, so \`${metric.name}\` is the bare metric name: the published name carries a group prefix this detector could not resolve.`)
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
        summary: `Metric \`${old.full}\` (${old.registry} registry) was removed in \`${file.path}\`. The metrics reference and any monitoring page that queries it state a metric the broker no longer exposes.${bareNote(old)}`
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
        summary: nm.kind === 'replicated'
          ? `\`${nm.name}\` is now replicated to the public metrics endpoint as \`${nm.full}\` in \`${file.path}\`. The public metrics reference and any monitoring page for it need the metric.`
          : `New ${nm.kind.replace(/_/g, ' ')} metric \`${nm.full}\` (${nm.registry} registry) in \`${file.path}\`. The metrics reference lists it on regeneration; the monitoring page for this subsystem needs it if operators should alert on it.${bareNote(nm)}`
      }))
    }
    // A group's own labels (add_group's aggregation) changed: one finding
    // for the group, not one per metric in it.
    const groupChanged = new Map()
    for (const [key, nm] of h.metrics) {
      const old = b.metrics.get(key)
      if (!old || old.groupLabels === nm.groupLabels || !nm.group) continue
      const gk = `${nm.registry}\0${nm.group}`
      if (!groupChanged.has(gk)) groupChanged.set(gk, { old, nm, count: 0 })
      groupChanged.get(gk).count++
    }
    for (const { old, nm, count } of groupChanged.values()) {
      const prefix = nm.registry === 'public' ? 'redpanda' : 'vectorized'
      findings.push(makeFinding({
        ...common,
        page: pageFor(nm),
        name: `${prefix}_${nm.group}_*`,
        change_kind: 'behaviour',
        line: nm.line,
        evidence: excerpt(file, 'head', nm.line, nm.lineEnd),
        detail: 'labels-changed',
        summary: `The labels of the ${count} metric(s) in group \`${prefix}_${nm.group}\` changed in \`${file.path}\` (add_group labels \`${old.groupLabels || 'none'}\` to \`${nm.groupLabels || 'none'}\`). Queries and dashboards that filter or aggregate on a dropped label stop matching; the metrics reference lists the labels.`
      }))
    }
    for (const [key, nm] of h.metrics) {
      const old = b.metrics.get(key)
      if (!old || old.labels === nm.labels) continue
      findings.push(makeFinding({
        ...common,
        page: pageFor(nm),
        name: nm.full,
        change_kind: 'behaviour',
        line: nm.line,
        evidence: excerpt(file, 'head', nm.line, nm.lineEnd),
        detail: 'labels-changed',
        summary: `The labels of metric \`${nm.full}\` changed in \`${file.path}\` (\`${old.labels || 'none'}\` to \`${nm.labels || 'none'}\`). Queries and dashboards that filter or aggregate on a dropped label stop matching; the metrics reference lists the labels.`
      }))
    }
  }
  return findings
}

module.exports = { id: 'metrics', surface: 'metrics', routes: ROUTES, detect, parseMetrics }

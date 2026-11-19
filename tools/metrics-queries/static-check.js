'use strict'

/**
 * The static layer of `doc-tools check-queries`: check a parsed query against
 * the metrics dataset (redpanda-metrics-<tag>.json) without a cluster.
 *
 * Rules:
 * - unknown-metric: every selector names a series the dataset has.
 * - histogram-series: a histogram is queried through _bucket, _count or _sum.
 * - unknown-label: every label in a matcher, by, without, on, ignoring,
 *   group_left, group_right, label_replace or label_join is a label the
 *   expression has at that point.
 * - rate-on-gauge: rate, irate and increase take a counter or a histogram series.
 * - quantile-needs-bucket: histogram_quantile takes _bucket series that still
 *   carry the le label.
 * - exporter-mixed: a file with the `exporter` setting names no metric that
 *   the dataset has. Under that setting no other rule here runs, apart from
 *   syntax.
 *
 * Limits: function names and argument counts are not checked here (Prometheus
 * checks them in the live layer), label values are not checked, and a selector
 * with no metric name (`{job="x"}`) has unknown labels, so nothing downstream
 * of it is checked.
 */

const { parse, selectors, selectorText, PromqlSyntaxError, COMPARISONS, SET_OPERATORS } = require('./promql')

// Labels Prometheus puts on every scraped series.
const PROMETHEUS_LABELS = ['__name__', 'instance', 'job']
// Series Prometheus writes for every target. They carry only job and instance.
const PROMETHEUS_METRICS = [
  'up', 'scrape_duration_seconds', 'scrape_samples_scraped',
  'scrape_samples_post_metric_relabeling', 'scrape_series_added'
]
const HISTOGRAM_SUFFIXES = ['_bucket', '_count', '_sum']
const RATE_FUNCTIONS = new Set(['rate', 'irate', 'increase'])
// Aggregators that keep every label of the series they pick.
const KEEPS_LABELS = new Set(['topk', 'bottomk', 'limitk', 'limit_ratio'])

/**
 * Index a dataset for lookups.
 *
 * @param {object} dataset - Parsed redpanda-metrics-<tag>.json.
 */
function indexDataset (dataset) {
  if (!dataset || typeof dataset !== 'object' || !dataset.metrics || typeof dataset.metrics !== 'object' || Array.isArray(dataset.metrics)) {
    throw new Error('the dataset has no "metrics" object. Expected a redpanda-metrics-<tag>.json file')
  }
  const families = new Map(Object.entries(dataset.metrics))
  // Every series name a selector can use, mapped to its family and suffix.
  const series = new Map()
  for (const [name, metric] of families) {
    if (metric.type === 'histogram') {
      const suffixes = (metric.histogram && metric.histogram.series) || HISTOGRAM_SUFFIXES
      for (const suffix of suffixes) series.set(`${name}${suffix}`, { family: name, metric, suffix })
    } else if (metric.type === 'summary') {
      series.set(name, { family: name, metric, suffix: null })
      for (const suffix of ['_count', '_sum']) series.set(`${name}${suffix}`, { family: name, metric, suffix })
    } else {
      series.set(name, { family: name, metric, suffix: null })
    }
  }
  // A family named like another family's series keeps its own entry: eight
  // real gauges end in _sum or _count.
  for (const [name, metric] of families) {
    if (metric.type !== 'histogram') series.set(name, { family: name, metric, suffix: null })
  }
  return { families, series, version: dataset.redpanda_version || null }
}

function resolveSeries (index, name) {
  if (PROMETHEUS_METRICS.includes(name)) {
    return { family: name, suffix: null, prometheus: true, metric: { name, type: 'gauge', labels: [], observed: true } }
  }
  return index.series.get(name) || null
}

function levenshtein (a, b, limit) {
  if (Math.abs(a.length - b.length) > limit) return limit + 1
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    previous = current
  }
  return previous[b.length]
}

// Names a writer may have meant: a few edits away, or with every word of the
// name in it (redpanda_uptime_seconds_total, redpanda_application_uptime_seconds_total).
function closeNames (index, name) {
  const scored = []
  const words = name.split('_').filter(Boolean)
  for (const candidate of index.series.keys()) {
    const distance = levenshtein(name, candidate, 4)
    if (distance <= 4) { scored.push([distance, candidate]); continue }
    const has = candidate.split('_')
    if (words.length > 1 && words.every((word) => has.includes(word))) scored.push([5 + has.length - words.length, candidate])
  }
  return scored.sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1])).slice(0, 3).map(([, candidate]) => candidate)
}

const list = (names) => names.length ? [...names].sort().join(', ') : 'none'

/**
 * Check one query.
 *
 * @param {string} query - The query, placeholders already replaced.
 * @param {object} index - From indexDataset.
 * @param {object} [options]
 * @param {string[]} [options.extraLabels] - Labels the reader's Prometheus adds to every series.
 * @param {string} [options.exporter] - The file's `exporter` setting. The query is on metrics from
 *   that exporter, which the dataset does not have, so only its syntax is checked. A selector for
 *   a metric the dataset has fails: that part of the query would go unchecked.
 * @returns {{ ast: object|null, problems: object[], notes: string[], selectors: object[] }}
 */
function checkQuery (query, index, options = {}) {
  const extraLabels = options.extraLabels || []
  const exporter = options.exporter || null
  const problems = []
  const notes = []
  const note = (text) => { if (!notes.includes(text)) notes.push(text) }
  const problem = (rule, message, extra = {}) => problems.push({ rule, message, ...extra })

  let ast
  try {
    ast = parse(query)
  } catch (error) {
    if (!(error instanceof PromqlSyntaxError)) throw error
    problem('syntax', `not a PromQL expression: ${error.message}`)
    return { ast: null, problems, notes, selectors: [] }
  }

  const selectorInfo = new Map()
  const unknown = (sources = []) => ({ kind: 'vector', labels: null, sources, bucket: false })

  function describeLabels (labels) {
    const own = [...labels].filter((label) => !PROMETHEUS_LABELS.includes(label) && !extraLabels.includes(label))
    return list(own)
  }

  function checkLabels (labels, value, where) {
    if (!value.labels) return
    for (const label of labels) {
      if (value.labels.has(label)) continue
      const of = value.sources.length ? value.sources.join(', ') : 'the expression'
      problem('unknown-label', `${where} names the label "${label}", which ${of} does not have at that point. Labels there: ${describeLabels(value.labels)}`, {
        label, metric: value.sources[0], known_labels: [...value.labels].sort()
      })
    }
  }

  function selectorValue (node) {
    const text = selectorText(node)
    const named = node.matchers.find((matcher) => matcher.name === '__name__')
    let resolved = []
    let names = []
    if (node.name) names = [node.name]
    else if (named && named.op === '=') names = [named.value]
    else if (named && named.op === '=~') {
      let pattern = null
      try { pattern = new RegExp(`^(?:${named.value})$`) } catch (_) {
        if (!exporter) note(`${text}: the __name__ pattern could not be read here, so the selector was not checked`)
      }
      if (pattern) {
        names = [...index.series.keys(), ...PROMETHEUS_METRICS].filter((name) => pattern.test(name))
        if (!names.length && !exporter) {
          problem('unknown-metric', `${text} matches no metric in the dataset`, { metric: text })
          selectorInfo.set(node, { selector: text, metrics: [] })
          return unknown([text])
        }
      }
    }
    if (exporter) return exporterSelectorValue(node, text, names)
    if (!names.length) {
      note(`${text}: no metric name, so its labels were not checked`)
      selectorInfo.set(node, { selector: text, metrics: [] })
      return { ...unknown([text]), kind: node.range ? 'matrix' : 'vector' }
    }

    for (const name of names) {
      const found = resolveSeries(index, name)
      if (found) { resolved.push({ name, ...found }); continue }
      const family = index.families.get(name)
      if (family && family.type === 'histogram') {
        problem('histogram-series', `${name} is a histogram. Query ${name}_bucket, ${name}_count or ${name}_sum`, { metric: name })
        continue
      }
      const suffix = HISTOGRAM_SUFFIXES.find((candidate) => name.endsWith(candidate))
      const base = suffix && index.families.get(name.slice(0, -suffix.length))
      const close = closeNames(index, name)
      const hint = base
        ? ` ${name.slice(0, -suffix.length)} is a ${base.type}, not a histogram, so it has no ${suffix} series`
        : close.length ? ` Close names: ${close.join(', ')}` : ''
      problem('unknown-metric', `${name} is not a metric in the dataset.${hint}`, { metric: name })
    }
    selectorInfo.set(node, {
      selector: text,
      metrics: resolved.map((entry) => ({ name: entry.name, family: entry.family, type: entry.metric.type, observed: entry.metric.observed !== false }))
    })
    if (!resolved.length) return { ...unknown(names), kind: node.range ? 'matrix' : 'vector' }

    const value = {
      kind: node.range ? 'matrix' : 'vector',
      labels: new Set([...PROMETHEUS_LABELS, ...extraLabels]),
      sources: resolved.map((entry) => entry.name),
      bucket: resolved.every((entry) => entry.metric.type === 'histogram' && entry.suffix === '_bucket'),
      resolved
    }
    let unobserved = false
    for (const entry of resolved) {
      if (entry.metric.observed === false) {
        unobserved = true
        note(`${entry.name}: the dataset has no labels for this metric (it was not exported by the cluster the dataset came from), so its labels were not checked`)
        continue
      }
      for (const label of entry.metric.labels || []) value.labels.add(label.name)
      if (entry.metric.type === 'histogram' && entry.suffix === '_bucket') value.labels.add('le')
      if (entry.metric.type === 'summary' && !entry.suffix) value.labels.add('quantile')
    }
    if (unobserved) value.labels = null
    if (value.labels) {
      for (const matcher of node.matchers) {
        if (value.labels.has(matcher.name)) continue
        const metric = value.sources.join(', ')
        const real = describeLabels(value.labels)
        problem('unknown-label', `${metric} has no label "${matcher.name}". Its labels: ${real}`, {
          label: matcher.name, metric: value.sources[0], known_labels: [...value.labels].sort()
        })
      }
    }
    return value
  }

  // Under the exporter setting a selector is not compared with the dataset.
  // It only must not name a Redpanda metric: the file would mix two sources,
  // and nothing would check the Redpanda part.
  function exporterSelectorValue (node, text, names) {
    const mixed = names.filter((name) => !PROMETHEUS_METRICS.includes(name) && (index.series.has(name) || index.families.has(name)))
    if (mixed.length) {
      const shown = mixed.slice(0, 3).join(', ') + (mixed.length > 3 ? ` and ${mixed.length - 3} more` : '')
      const subject = node.name ? `${node.name} is a Redpanda metric in the dataset` : `${text} matches Redpanda metrics in the dataset (${shown})`
      problem('exporter-mixed', `${subject}, and the file is marked exporter: ${exporter}, so nothing checks that part of the query. Split the query into one file for each source, or drop the exporter setting`, { metric: mixed[0] })
    }
    selectorInfo.set(node, { selector: text, metrics: [] })
    return { ...unknown(), kind: node.range ? 'matrix' : 'vector' }
  }

  const unwrap = (node) => node.type === 'paren' ? unwrap(node.expr) : node
  const stringArg = (node) => { const inner = node && unwrap(node); return inner && inner.type === 'string' ? inner.value : null }
  const withLabels = (value, change) => {
    if (!value.labels) return value
    const labels = new Set(value.labels)
    change(labels)
    return { ...value, labels }
  }

  function callValue (node) {
    const args = node.args.map(evaluate)
    const first = args.find((arg) => arg.kind === 'vector' || arg.kind === 'matrix')

    if (RATE_FUNCTIONS.has(node.name)) {
      const target = node.args[0] && unwrap(node.args[0])
      if (target && target.type === 'selector' && target.range) {
        for (const entry of args[0].resolved || []) {
          const type = entry.metric.type
          if (type === 'counter' || type === 'histogram' || (type === 'summary' && entry.suffix)) continue
          if (type === 'gauge') {
            problem('rate-on-gauge', `${node.name}() is applied to ${entry.name}, which is a gauge. ${node.name}() is for counters. For a gauge use delta(), deriv() or the value itself`, { metric: entry.name })
          } else {
            note(`${entry.name}: the dataset has no type for this metric, so ${node.name}() on it was not checked`)
          }
        }
      } else if (target && target.type !== 'subquery') {
        problem('syntax', `${node.name}() needs a range, for example ${node.name}(metric[5m])`)
      }
    }

    if (node.name === 'histogram_quantile' || node.name === 'histogram_fraction') {
      const buckets = args[args.length - 1]
      if (!buckets || buckets.kind === 'scalar' || buckets.kind === 'string') return unknown()
      if (buckets.labels || buckets.sources.length) {
        if (exporter) {
          // Whether the series are _bucket series is not known. That le is gone is.
          if (buckets.labels && !buckets.labels.has('le')) {
            problem('quantile-needs-bucket', `${node.name}() needs the le label, and the expression inside it aggregates le away. Add le to by (...)`)
          }
        } else if (!buckets.bucket) {
          const of = buckets.sources.length ? buckets.sources.join(', ') : 'an expression'
          problem('quantile-needs-bucket', `${node.name}() is applied to ${of}, which is not a _bucket series of a histogram`, { metric: buckets.sources[0] })
        } else if (buckets.labels && !buckets.labels.has('le')) {
          problem('quantile-needs-bucket', `${node.name}() needs the le label, and the expression inside it aggregates le away. Add le to by (...)`, { metric: buckets.sources[0] })
        }
      }
      return { ...withLabels(buckets, (labels) => labels.delete('le')), kind: 'vector', bucket: false }
    }

    if (node.name === 'label_replace' || node.name === 'label_join') {
      if (!first) return unknown()
      const destination = stringArg(node.args[1])
      const sourceLabels = node.name === 'label_replace' ? [stringArg(node.args[3])] : node.args.slice(3).map(stringArg)
      checkLabels(sourceLabels.filter(Boolean), first, `${node.name}()`)
      return { ...withLabels(first, (labels) => { if (destination) labels.add(destination) }), kind: 'vector' }
    }

    if (node.name === 'scalar' || node.name === 'time' || node.name === 'pi') return { kind: 'scalar', labels: new Set(), sources: [], bucket: false }
    if (node.name === 'vector') return { kind: 'vector', labels: new Set(), sources: [], bucket: false }
    if (node.name === 'absent' || node.name === 'absent_over_time') return unknown(first ? first.sources : [])
    if (!first) return { kind: 'scalar', labels: new Set(), sources: [], bucket: false }
    return { ...first, kind: 'vector', resolved: undefined }
  }

  function aggregationValue (node) {
    if (node.param) evaluate(node.param)
    const input = evaluate(node.expr)
    const grouping = node.grouping
    if (grouping) checkLabels(grouping.labels, input, `${node.op} ${grouping.kind} (...)`)
    let labels = null
    if (KEEPS_LABELS.has(node.op)) labels = input.labels
    else if (!grouping) labels = new Set()
    else if (grouping.kind === 'by') labels = new Set(grouping.labels)
    else if (input.labels) {
      labels = new Set(input.labels)
      for (const label of grouping.labels) labels.delete(label)
      labels.delete('__name__')
    }
    if (labels && node.op === 'count_values') {
      const added = stringArg(node.param)
      if (added) { labels = new Set(labels); labels.add(added) }
    }
    return { kind: 'vector', labels, sources: input.sources, bucket: input.bucket }
  }

  function binaryValue (node) {
    const left = evaluate(node.left)
    const right = evaluate(node.right)
    const isVector = (value) => value.kind === 'vector' || value.kind === 'matrix'
    if (!isVector(left) && !isVector(right)) return { kind: 'scalar', labels: new Set(), sources: [], bucket: false }
    if (!isVector(left)) return right
    if (!isVector(right)) return left

    const sources = [...new Set([...left.sources, ...right.sources])]
    const matching = node.matching
    if (matching && matching.kind === 'on') {
      checkLabels(matching.labels, left, `on (...), left side of ${node.op},`)
      checkLabels(matching.labels, right, `on (...), right side of ${node.op},`)
    } else if (matching && left.labels && right.labels) {
      const either = { labels: new Set([...left.labels, ...right.labels]), sources }
      checkLabels(matching.labels, either, 'ignoring (...)')
    }
    const many = node.group && node.group.side === 'group_right' ? right : left
    const one = many === left ? right : left
    if (node.group) checkLabels(node.group.labels, one, `${node.group.side} (...)`)

    let labels = null
    if (node.op === 'or') labels = left.labels && right.labels ? new Set([...left.labels, ...right.labels]) : null
    else if (SET_OPERATORS.has(node.op) || (COMPARISONS.has(node.op) && !node.bool)) labels = many.labels
    else if (node.group) labels = many.labels ? new Set([...many.labels, ...node.group.labels]) : null
    else if (matching && matching.kind === 'on') labels = new Set(matching.labels)
    else if (matching && left.labels) {
      labels = new Set(left.labels)
      for (const label of matching.labels) labels.delete(label)
    } else labels = left.labels
    if (labels && !SET_OPERATORS.has(node.op) && !(COMPARISONS.has(node.op) && !node.bool)) {
      labels = new Set(labels)
      labels.delete('__name__')
    }
    return { kind: 'vector', labels, sources, bucket: many.bucket }
  }

  function evaluate (node) {
    switch (node.type) {
      case 'number': return { kind: 'scalar', labels: new Set(), sources: [], bucket: false }
      case 'string': return { kind: 'string', labels: new Set(), sources: [], bucket: false }
      case 'paren': return evaluate(node.expr)
      case 'unary': return evaluate(node.expr)
      case 'subquery': return { ...evaluate(node.expr), kind: 'matrix', resolved: undefined }
      case 'selector': return selectorValue(node)
      case 'call': return callValue(node)
      case 'aggregation': return aggregationValue(node)
      case 'binary': return binaryValue(node)
      default: throw new Error(`unknown node type ${node.type}`)
    }
  }

  const result = evaluate(ast)
  return {
    ast,
    problems,
    notes,
    kind: result.kind,
    selectors: selectors(ast).map((node) => selectorInfo.get(node) || { selector: selectorText(node), metrics: [] })
  }
}

module.exports = { PROMETHEUS_LABELS, PROMETHEUS_METRICS, checkQuery, indexDataset, resolveSeries }

'use strict'

/**
 * The live layer of `doc-tools check-queries`: run each query on a real
 * Prometheus that scrapes a real cluster, and compare what comes back with
 * the file's `expect` setting.
 *
 * A query that returns nothing can be right (an alert condition on a healthy
 * cluster) or wrong (a label that does not exist). To tell the two apart,
 * every vector selector of the query is also run by itself and must match at
 * least one series.
 */

const { selectors, selectorText, ranges } = require('./promql')

/**
 * A client for the Prometheus HTTP API.
 *
 * @param {string} baseUrl - For example http://localhost:19090.
 * @param {object} [options]
 * @param {Function} [options.fetch] - A fetch implementation (tests pass a recorded one).
 * @param {number} [options.timeoutMs]
 */
function prometheusClient (baseUrl, options = {}) {
  const doFetch = options.fetch || globalThis.fetch
  const timeoutMs = options.timeoutMs || 30000
  const root = baseUrl.replace(/\/+$/, '')

  async function call (pathname, params) {
    const url = `${root}${pathname}`
    const request = params
      ? { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString() }
      : { method: 'GET' }
    let response
    try {
      response = await doFetch(url, { ...request, signal: AbortSignal.timeout(timeoutMs) })
    } catch (error) {
      const failure = new Error(`Prometheus at ${root} did not answer: ${error.cause ? error.cause.message || error.cause.code : error.message}`)
      failure.unreachable = true
      throw failure
    }
    let body
    try {
      body = await response.json()
    } catch (_) {
      const failure = new Error(`Prometheus at ${root} answered ${pathname} with HTTP ${response.status} and no JSON. Is this a Prometheus URL?`)
      failure.unreachable = true
      throw failure
    }
    return body
  }

  return {
    baseUrl: root,
    // An instant query. A query Prometheus rejects comes back as { status: 'error' }, it does not throw.
    query: (query) => call('/api/v1/query', { query }),
    targets: () => call('/api/v1/targets?state=active')
  }
}

/**
 * Compare an instant query response with what the file expects.
 *
 * @returns {{ ok: boolean, got: string, type: string|null, series: number|null, error: string|null }}
 */
function judge (expect, response) {
  if (!response || response.status !== 'success' || !response.data) {
    const error = response && response.error ? `${response.errorType || 'error'}: ${response.error}` : 'no usable response'
    return { ok: false, got: `Prometheus rejected the query (${error})`, type: null, series: null, error }
  }
  const type = response.data.resultType
  const result = response.data.result
  if (type === 'scalar' || type === 'string') {
    const value = Array.isArray(result) ? result[1] : null
    return {
      ok: expect === 'scalar' && type === 'scalar',
      got: `a ${type} (${value})`,
      type,
      series: null,
      error: null
    }
  }
  const series = Array.isArray(result) ? result.length : 0
  const got = series === 0 ? 'no series' : `${series} series`
  if (expect === 'series') return { ok: series > 0, got, type, series, error: null }
  if (expect === 'empty') return { ok: series === 0, got, type, series, error: null }
  return { ok: false, got: `${got} (an instant vector, not a scalar)`, type, series, error: null }
}

const EXPECTED = {
  series: 'at least one series',
  empty: 'no series',
  scalar: 'a scalar'
}

function labelNames (response) {
  const names = new Set()
  if (response && response.status === 'success' && Array.isArray(response.data.result)) {
    for (const sample of response.data.result) for (const name of Object.keys(sample.metric || {})) names.add(name)
  }
  names.delete('__name__')
  return [...names].sort()
}

const seriesCount = (response) => response && response.status === 'success' && Array.isArray(response.data.result) ? response.data.result.length : 0

/**
 * Run one selector by itself. When it matches nothing, find out why: which
 * matcher matches nothing, and which labels the metric really has.
 */
async function diagnoseSelector (client, node) {
  const text = selectorText(node)
  const response = await client.query(text)
  const out = { selector: text, series: seriesCount(response) }
  if (response.status !== 'success') {
    out.error = `${response.errorType || 'error'}: ${response.error}`
    return out
  }
  if (out.series > 0 || !node.name) return out

  const bare = await client.query(node.name)
  out.metric_series = seriesCount(bare)
  if (!out.metric_series) {
    out.reason = `${node.name} has no series on this cluster`
    return out
  }
  out.actual_labels = labelNames(bare)
  out.dead_matchers = []
  for (const matcher of node.matchers) {
    const one = selectorText({ name: node.name, matchers: [matcher] })
    if (!seriesCount(await client.query(one))) out.dead_matchers.push(one.slice(node.name.length + 1, -1))
  }
  const labels = `${node.name} has the labels ${out.actual_labels.join(', ') || 'none'}`
  out.reason = out.dead_matchers.length
    ? `${out.dead_matchers.join(' and ')} ${out.dead_matchers.length === 1 ? 'matches' : 'each match'} nothing. ${labels}`
    : `each matcher matches some series, but no series matches all of them. ${labels}`
  return out
}

/**
 * Run one query file's query and judge it.
 *
 * @param {object} client - From prometheusClient.
 * @param {object} entry - { expect, resolved, ast }.
 * @param {object} [options]
 * @param {number} [options.scrapeInterval] - Seconds. A range shorter than two intervals cannot hold two samples.
 * @returns {Promise<object>} { ok, expected, got, result_type, series, problems, selectors }
 */
async function runQuery (client, entry, options = {}) {
  const problems = []
  const out = { ok: true, expected: EXPECTED[entry.expect], got: null, result_type: null, series: null, problems, selectors: [] }

  const interval = options.scrapeInterval
  const shortest = Math.min(...ranges(entry.ast))
  if (interval && Number.isFinite(shortest) && shortest < interval * 2) {
    problems.push(`a range of ${shortest}s holds fewer than two samples at this Prometheus's scrape interval of ${interval}s, so the query cannot return a rate here`)
  }

  const verdict = judge(entry.expect, await client.query(entry.resolved))
  out.got = verdict.got
  out.result_type = verdict.type
  out.series = verdict.series
  if (!verdict.ok) problems.push(`expected ${out.expected}, got ${verdict.got}`)

  // Selectors are run for a query that should be empty, and to explain a failure.
  if (!verdict.error && (entry.expect === 'empty' || problems.length)) {
    for (const node of selectors(entry.ast)) {
      const selector = await diagnoseSelector(client, node)
      out.selectors.push(selector)
      if (selector.series === 0) problems.push(`the selector ${selector.selector} matches no series${selector.reason ? `: ${selector.reason}` : ''}`)
      else if (selector.error) problems.push(`the selector ${selector.selector} failed: ${selector.error}`)
    }
  }
  out.ok = problems.length === 0
  return out
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function parseInterval (text) {
  const { durationSeconds } = require('./promql')
  return durationSeconds(String(text || ''))
}

/**
 * How many samples a range must hold before the queries are run: as many as
 * fit, at least two (rate needs two), at most four.
 */
function samplesNeeded (rangeSeconds, intervalSeconds) {
  if (!Number.isFinite(rangeSeconds) || !intervalSeconds) return 1
  return Math.max(2, Math.min(4, Math.floor(rangeSeconds / intervalSeconds)))
}

/**
 * Wait until every target is up and Prometheus holds enough samples for the
 * shortest range in the queries. Throws when the cap passes first.
 *
 * @param {object} client
 * @param {object} options
 * @param {number[]} options.ranges - Every range in the queries to run, in seconds.
 * @param {number} [options.capSeconds] - Give up after this long (default 120).
 * @param {number} [options.minTargets] - Fewest targets that must be up (default 1).
 * @param {Function} [options.sleep], [options.now], [options.log]
 * @returns {Promise<{ scrapeInterval: number, targets: number, waited: number, samples: number }>}
 */
async function waitForSamples (client, options = {}) {
  const cap = options.capSeconds === undefined ? 120 : options.capSeconds
  const minTargets = options.minTargets || 1
  const pause = options.sleep || sleep
  const now = options.now || Date.now
  const log = options.log || (() => {})
  const shortest = Math.min(...(options.ranges || []))
  const started = now()
  let last = 'no answer yet'

  while (true) {
    const waited = Math.round((now() - started) / 1000)
    const targets = await client.targets()
    const active = (targets.data && targets.data.activeTargets) || []
    const down = active.filter((target) => target.health !== 'up')
    if (active.length < minTargets) last = `${active.length} of ${minTargets} scrape targets found`
    else if (down.length) last = `targets not up: ${down.map((target) => `${target.scrapeUrl} (${target.lastError || target.health})`).join(', ')}`
    else {
      const scrapeInterval = Math.max(...active.map((target) => parseInterval(target.scrapeInterval)))
      const needed = samplesNeeded(shortest, scrapeInterval)
      // The window is the shortest range, or wide enough to count the samples when that range is too short for two.
      const window = Number.isFinite(shortest) ? Math.max(shortest, Math.ceil(scrapeInterval * needed)) : Math.ceil(scrapeInterval * 2)
      const counted = await client.query(`min(count_over_time(up[${window}s]))`)
      const samples = counted.status === 'success' && counted.data.result.length ? Number(counted.data.result[0].value[1]) : 0
      if (samples >= needed) return { scrapeInterval, targets: active.length, waited, samples }
      last = `${samples} of ${needed} samples per target`
    }
    if (waited >= cap) throw new Error(`Prometheus was not ready after ${cap}s: ${last}`)
    log(`   ${waited}s: ${last}`)
    await pause(Math.min(5000, Math.max(1000, (cap - waited) * 1000)))
  }
}

module.exports = { EXPECTED, diagnoseSelector, judge, labelNames, prometheusClient, runQuery, samplesNeeded, waitForSamples }

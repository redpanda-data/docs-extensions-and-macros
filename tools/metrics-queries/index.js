'use strict'

/**
 * `doc-tools check-queries`: check example PromQL query files (.promql)
 * against the metrics dataset, and run them on a real cluster.
 *
 * Exit codes: 0 every query passed, 1 a query failed, 2 usage or setup error.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const { parseQueryFile } = require('./query-file')
const { checkQuery, indexDataset } = require('./static-check')
const { ranges } = require('./promql')
const { prometheusClient, runQuery, waitForSamples, EXPECTED } = require('./live-check')

const EXIT_OK = 0
const EXIT_FAILED = 1
const EXIT_SETUP = 2
const DATASET_DIR = path.join('modules', 'reference', 'attachments')
const DATASET_NAME = /^redpanda-metrics-v?(\d+)\.(\d+)\.(\d+)(.*)\.json$/

class SetupError extends Error {}

/**
 * Every .promql file under the given files and directories, sorted.
 */
function collectFiles (paths, cwd) {
  const found = new Set()
  const visit = (target) => {
    const stat = fs.statSync(target)
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(target).sort()) {
        if (name === 'node_modules' || name === '.git') continue
        const child = path.join(target, name)
        const childStat = fs.statSync(child)
        if (childStat.isDirectory() || name.endsWith('.promql')) visit(child)
      }
    } else found.add(target)
  }
  for (const given of paths) {
    const target = path.resolve(cwd, given)
    if (!fs.existsSync(target)) throw new SetupError(`${given} does not exist`)
    if (fs.statSync(target).isFile() && !target.endsWith('.promql')) throw new SetupError(`${given} is not a .promql file`)
    visit(target)
  }
  return [...found].sort()
}

/**
 * The dataset to check against: --dataset, or the one for --tag in
 * modules/reference/attachments, or the newest one there.
 */
function findDataset (options, cwd) {
  if (options.dataset) {
    const file = path.resolve(cwd, options.dataset)
    if (!fs.existsSync(file)) throw new SetupError(`the dataset ${options.dataset} does not exist`)
    return file
  }
  const dir = path.join(cwd, DATASET_DIR)
  const names = fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => DATASET_NAME.test(name)) : []
  if (options.tag) {
    const wanted = `redpanda-metrics-${options.tag}.json`
    if (names.includes(wanted)) return path.join(dir, wanted)
  }
  // A release (no suffix) sorts after its own release candidates.
  const key = (name) => { const m = DATASET_NAME.exec(name); return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ? 0 : 1] }
  names.sort((a, b) => {
    const ka = key(a); const kb = key(b)
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return kb[i] - ka[i]
    return b.localeCompare(a)
  })
  if (!names.length) throw new SetupError(`no dataset. Pass --dataset <redpanda-metrics-<tag>.json>, or run from a docs repository that has one in ${DATASET_DIR}`)
  return path.join(dir, names[0])
}

function loadDataset (file) {
  let dataset
  try {
    dataset = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    throw new SetupError(`the dataset ${file} is not JSON: ${error.message}`)
  }
  try {
    return indexDataset(dataset)
  } catch (error) {
    throw new SetupError(`${file}: ${error.message}`)
  }
}

// Relative to the working directory when the file is inside it.
function displayPath (file, cwd) {
  const relative = path.relative(cwd, file)
  return !relative || relative.startsWith('..') ? file : relative
}

/**
 * Read and statically check one file.
 */
function checkFile (file, index, cwd) {
  const parsed = parseQueryFile(fs.readFileSync(file, 'utf8'))
  const entry = {
    file: displayPath(file, cwd),
    status: 'pass',
    expect: parsed.settings.expect,
    query: parsed.query,
    skip_run: parsed.settings.skipRun,
    exporter: parsed.settings.exporter,
    syntax_only: Boolean(parsed.settings.exporter),
    format_errors: parsed.errors,
    static: { problems: [], notes: [], selectors: [] },
    live: null
  }
  let ast = null
  if (parsed.resolved !== null) {
    const result = checkQuery(parsed.resolved, index, { extraLabels: parsed.settings.extraLabels, exporter: parsed.settings.exporter })
    ast = result.ast
    entry.static = { problems: result.problems, notes: result.notes, selectors: result.selectors }
    if (ast && parsed.settings.expect === 'scalar' && result.kind !== 'scalar') {
      entry.static.problems.push({ rule: 'expect', message: 'expect is scalar, and the query returns an instant vector. Wrap it in scalar() or use expect: series' })
    }
    if (ast && parsed.settings.expect !== 'scalar' && result.kind === 'scalar') {
      entry.static.problems.push({ rule: 'expect', message: `expect is ${parsed.settings.expect}, and the query returns a scalar. Use expect: scalar` })
    }
  }
  if (entry.format_errors.length || entry.static.problems.length) entry.status = 'fail'
  return { entry, ast, resolved: parsed.resolved }
}

// A file runs when its query parsed, it has no skip-run, and its metrics come from Redpanda.
const canRun = (item) => Boolean(item.ast && !item.entry.skip_run && !item.entry.exporter)

async function runLive (work, prometheusUrl, options, log) {
  const runnable = work.filter(canRun)
  const client = prometheusClient(prometheusUrl, { fetch: options.fetch })
  let ready
  try {
    ready = await waitForSamples(client, {
      ranges: runnable.flatMap((item) => ranges(item.ast)),
      capSeconds: options.waitCap,
      minTargets: options.minTargets === undefined ? undefined : Number(options.minTargets),
      sleep: options.sleep,
      log
    })
  } catch (error) {
    throw new SetupError(error.message)
  }
  log(`Prometheus at ${client.baseUrl} is ready: ${ready.targets} targets up, scrape interval ${ready.scrapeInterval}s, waited ${ready.waited}s.`)
  for (const item of runnable) {
    let result
    try {
      result = await runQuery(client, { expect: item.entry.expect, resolved: item.resolved, ast: item.ast }, { scrapeInterval: ready.scrapeInterval })
    } catch (error) {
      if (error.unreachable) throw new SetupError(error.message)
      throw error
    }
    item.entry.live = result
    if (!result.ok) item.entry.status = 'fail'
  }
  return { prometheus_url: client.baseUrl, targets: ready.targets, scrape_interval_seconds: ready.scrapeInterval, waited_seconds: ready.waited }
}

function summarize (results) {
  return {
    files: results.length,
    passed: results.filter((entry) => entry.status === 'pass').length,
    failed: results.filter((entry) => entry.status === 'fail').length,
    run: results.filter((entry) => entry.live).length,
    static_only: results.filter((entry) => !entry.live && !entry.syntax_only).length,
    syntax_only: results.filter((entry) => entry.syntax_only).length
  }
}

function renderText (report) {
  const lines = []
  for (const entry of report.results) {
    const live = entry.exporter
      ? `syntax only; needs the ${entry.exporter} exporter`
      : entry.live
        ? `live: ${entry.live.got}`
        : entry.skip_run ? `not run: ${entry.skip_run}` : report.live ? 'not run' : 'static only'
    lines.push(`${entry.status === 'pass' ? 'PASS' : 'FAIL'} ${entry.file} (expect ${entry.expect}; ${live})`)
    for (const error of entry.format_errors) lines.push(`  file: ${error}`)
    for (const problem of entry.static.problems) lines.push(`  static, ${problem.rule}: ${problem.message}`)
    if (entry.live) for (const problem of entry.live.problems) lines.push(`  live: ${problem}`)
    for (const note of entry.static.notes) lines.push(`  note: ${note}`)
  }
  const s = report.summary
  lines.push('')
  // Files with the exporter setting pass without a run, so they get their own count.
  const syntaxOnly = s.syntax_only ? ` ${s.syntax_only} checked for syntax only (metrics from another exporter).` : ''
  lines.push(`${s.files} query file${s.files === 1 ? '' : 's'}: ${s.passed} passed, ${s.failed} failed. ${s.run} run on a cluster, ${s.static_only} checked against the dataset only.${syntaxOnly}`)
  return lines.join('\n')
}

/**
 * Start the metrics cluster with Prometheus, run this command inside the
 * cluster script against it, and read the result it wrote.
 */
function runOnCluster (files, datasetFile, options) {
  const script = path.join(__dirname, '..', '..', 'cli-utils', 'generate-cluster-docs.sh')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-queries-'))
  const resultFile = path.join(dir, 'result.json')
  try {
    const inner = ['--dataset', datasetFile, '--result-file', resultFile, ...files]
    if (options.waitCap !== undefined) inner.unshift('--wait-cap', String(options.waitCap))
    const args = ['queries', options.tag, options.dockerRepo, options.consoleTag, options.consoleDockerRepo, ...inner]
    // The script runs this command again inside the cluster run, with the same Node.
    const env = { ...process.env, NODE: process.execPath }
    if (options.readyTimeout !== undefined) env.CLUSTER_READY_TIMEOUT = String(options.readyTimeout)
    if (options.settleTimeout !== undefined) env.METRICS_SETTLE_MAX = String(options.settleTimeout)
    // The script's output is progress, not the result, so it goes to stderr.
    const child = spawnSync('bash', [script, ...args], { stdio: ['ignore', 2, 2], env })
    if (!fs.existsSync(resultFile)) {
      throw new SetupError(`the cluster run ended with exit code ${child.status === null ? 'unknown' : child.status} before any query was checked`)
    }
    const report = JSON.parse(fs.readFileSync(resultFile, 'utf8'))
    // The teardown can fail after the queries were checked.
    if (child.status !== EXIT_OK && child.status !== EXIT_FAILED) {
      throw new SetupError(`the cluster run ended with exit code ${child.status === null ? 'unknown' : child.status}`)
    }
    return report
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * @param {string[]} paths - Files and directories.
 * @param {object} options - Command options, plus `fetch`, `sleep`, `cwd`, `stdout` and `stderr` for tests.
 * @returns {Promise<number>} The exit code.
 */
async function runCli (paths, options = {}) {
  const cwd = options.cwd || process.cwd()
  const out = options.stdout || ((text) => process.stdout.write(`${text}\n`))
  const err = options.stderr || ((text) => process.stderr.write(`${text}\n`))
  try {
    if (!paths || !paths.length) throw new SetupError('no query files given. Pass .promql files or directories')
    if (options.tag && options.prometheusUrl) throw new SetupError('pass --tag or --prometheus-url, not both')
    if (options.prometheusUrl && !/^https?:\/\//.test(options.prometheusUrl)) throw new SetupError(`--prometheus-url must start with http:// or https://, got "${options.prometheusUrl}"`)
    for (const [flag, value] of [['--wait-cap', options.waitCap], ['--min-targets', options.minTargets], ['--ready-timeout', options.readyTimeout], ['--settle-timeout', options.settleTimeout]]) {
      if (value !== undefined && !/^[0-9]+$/.test(String(value))) throw new SetupError(`${flag} must be a whole number of seconds, got "${value}"`)
    }
    const waitCap = options.waitCap === undefined ? undefined : Number(options.waitCap)

    const files = collectFiles(paths, cwd)
    if (!files.length) throw new SetupError('no .promql files found')
    const datasetFile = findDataset(options, cwd)

    let report
    if (options.tag) {
      // The static layer needs no cluster, so a file that cannot run does not start one.
      const index = loadDataset(datasetFile)
      const work = files.map((file) => checkFile(file, index, cwd))
      if (work.some(canRun)) {
        report = runOnCluster(files, datasetFile, { ...options, waitCap })
      } else {
        err('No query can be run, so no cluster was started.')
        report = buildReport(work, datasetFile, index, null)
      }
    } else {
      const index = loadDataset(datasetFile)
      const work = files.map((file) => checkFile(file, index, cwd))
      let live = null
      if (options.prometheusUrl && work.some(canRun)) {
        live = await runLive(work, options.prometheusUrl, { ...options, waitCap }, err)
      }
      report = buildReport(work, datasetFile, index, live)
    }

    // The run inside the cluster script writes its results to a file. The
    // command that started the script prints them.
    if (options.resultFile) fs.writeFileSync(path.resolve(cwd, options.resultFile), `${JSON.stringify(report, null, 2)}\n`)
    else out(options.json ? JSON.stringify(report, null, 2) : renderText(report))
    return report.summary.failed ? EXIT_FAILED : EXIT_OK
  } catch (error) {
    if (!(error instanceof SetupError)) throw error
    err(`Error: ${error.message}`)
    return EXIT_SETUP
  }
}

function buildReport (work, datasetFile, index, live) {
  const results = work.map((item) => item.entry)
  return {
    dataset: datasetFile,
    redpanda_version: index.version,
    live,
    summary: summarize(results),
    results
  }
}

module.exports = { EXIT_FAILED, EXIT_OK, EXIT_SETUP, EXPECTED, checkFile, collectFiles, findDataset, renderText, runCli }

'use strict'

/**
 * `doc-tools check-queries` as a command: its exit codes, how it finds query
 * files and the dataset, and how --tag hands the run to
 * generate-cluster-docs.sh in queries mode. No cluster is started: a stand-in
 * for bash on PATH records what the command would run. The cluster script's
 * own queries mode (which cluster it starts, its exit codes, its teardown)
 * and the Prometheus overlay are checked here too.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const yaml = require('js-yaml')

const ROOT = path.join(__dirname, '..', '..')
const CLI = path.join(ROOT, 'bin', 'doc-tools.js')
const FIXTURE_DATASET = path.join(__dirname, 'fixtures', 'metrics-queries', 'redpanda-metrics-v26.2.7.json')
const BUNDLE = path.join(ROOT, 'docker-compose', '25.1')
const METRICS = path.join(ROOT, 'docker-compose', 'metrics')
const itOnPosix = process.platform === 'win32' ? it.skip : it

const GOOD = ['# tag::query[]', 'sum by (instance) (redpanda_memory_allocated_memory)', '# end::query[]']
const WRONG_LABEL = ['# expect: empty', '# tag::query[]', 'sum(redpanda_raft_leader_for{namespace="redpanda",topic="controller",partition="0"}) == 0', '# end::query[]']

let workDir
const write = (name, lines) => {
  const file = path.join(workDir, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${lines.join('\n')}\n`)
  return file
}
const run = (args, env = {}) => spawnSync(process.execPath, [CLI, 'check-queries', ...args], { cwd: workDir, encoding: 'utf8', env: { ...process.env, ...env } })

beforeEach(() => { workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'metrics-queries-cli-'))) })
afterEach(() => { fs.rmSync(workDir, { recursive: true, force: true }) })

describe('doc-tools check-queries, static', () => {
  it('exits 0 and lists each file when every query passes', () => {
    write('modules/manage/examples/monitor/memory.promql', GOOD)
    const result = run(['modules', '--dataset', FIXTURE_DATASET])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('PASS modules/manage/examples/monitor/memory.promql (expect series; static only)')
    expect(result.stdout).toContain('1 query file: 1 passed, 0 failed. 0 run on a cluster, 1 checked against the dataset only.')
  })

  it('exits 1 when a query fails, and still reports the ones that pass', () => {
    write('a/memory.promql', GOOD)
    write('a/no-leader.promql', WRONG_LABEL)
    const result = run(['a', '--dataset', FIXTURE_DATASET])
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('PASS a/memory.promql')
    expect(result.stdout).toContain('FAIL a/no-leader.promql (expect empty; static only)')
    expect(result.stdout).toContain('redpanda_raft_leader_for has no label "namespace"')
  })

  it('exits 1 on a file with a bad format', () => {
    write('q.promql', ['sum(up)'])
    const result = run(['q.promql', '--dataset', FIXTURE_DATASET])
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('  file: line 1: only settings (# name: value) and blank lines are allowed outside the query tag')
    expect(result.stdout).toContain('  file: no query tag.')
  })

  it('prints machine-readable results with --json', () => {
    write('a/memory.promql', GOOD)
    write('a/no-leader.promql', WRONG_LABEL)
    const result = run(['a', '--dataset', FIXTURE_DATASET, '--json'])
    expect(result.status).toBe(1)
    const report = JSON.parse(result.stdout)
    expect(report).toMatchObject({ dataset: FIXTURE_DATASET, redpanda_version: 'v26.2.7', live: null, summary: { files: 2, passed: 1, failed: 1, run: 0, static_only: 2 } })
    expect(report.results[0]).toEqual({
      file: 'a/memory.promql',
      status: 'pass',
      expect: 'series',
      query: 'sum by (instance) (redpanda_memory_allocated_memory)',
      skip_run: null,
      exporter: null,
      syntax_only: false,
      format_errors: [],
      static: {
        problems: [],
        notes: [],
        selectors: [{ selector: 'redpanda_memory_allocated_memory', metrics: [{ name: 'redpanda_memory_allocated_memory', family: 'redpanda_memory_allocated_memory', type: 'gauge', observed: true }] }]
      },
      live: null
    })
    expect(report.results[1].static.problems.map((problem) => [problem.rule, problem.label])).toEqual([
      ['unknown-label', 'namespace'], ['unknown-label', 'topic'], ['unknown-label', 'partition']
    ])
  })

  it('checks a file with exporter for syntax only, and counts it apart', () => {
    write('a/memory.promql', GOOD)
    write('a/operator.promql', ['# exporter: redpanda-operator', '# tag::query[]', 'count({__name__=~"operator_.*|controller_runtime_.*|workqueue_.*"})', '# end::query[]'])
    const result = run(['a', '--dataset', FIXTURE_DATASET])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('PASS a/operator.promql (expect series; syntax only; needs the redpanda-operator exporter)')
    expect(result.stdout).toContain('2 query files: 2 passed, 0 failed. 0 run on a cluster, 1 checked against the dataset only. 1 checked for syntax only (metrics from another exporter).')
    const report = JSON.parse(run(['a', '--dataset', FIXTURE_DATASET, '--json']).stdout)
    expect(report.summary).toEqual({ files: 2, passed: 2, failed: 0, run: 0, static_only: 1, syntax_only: 1 })
    expect(report.results[1]).toMatchObject({ file: 'a/operator.promql', status: 'pass', exporter: 'redpanda-operator', syntax_only: true, live: null })

    // The same file without the setting fails.
    write('a/operator.promql', ['# tag::query[]', 'count({__name__=~"operator_.*|controller_runtime_.*|workqueue_.*"})', '# end::query[]'])
    const without = run(['a', '--dataset', FIXTURE_DATASET])
    expect(without.status).toBe(1)
    expect(without.stdout).toContain('FAIL a/operator.promql (expect series; static only)')
    expect(without.stdout).not.toContain('syntax only')
  })

  it('writes the results to --result-file and prints nothing, as the cluster run needs', () => {
    write('a/no-leader.promql', WRONG_LABEL)
    const result = run(['a', '--dataset', FIXTURE_DATASET, '--result-file', 'out.json'])
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(JSON.parse(fs.readFileSync(path.join(workDir, 'out.json'), 'utf8')).summary.failed).toBe(1)
  })

  it('searches directories for .promql files only, and takes files by name', () => {
    write('modules/a/examples/one.promql', GOOD)
    write('modules/b/examples/deep/two.promql', GOOD)
    write('modules/b/examples/notes.txt', ['not a query'])
    write('node_modules/pkg/three.promql', ['not a query'])
    const all = run(['.', '--dataset', FIXTURE_DATASET, '--json'])
    expect(JSON.parse(all.stdout).results.map((entry) => entry.file)).toEqual(['modules/a/examples/one.promql', 'modules/b/examples/deep/two.promql'])
    const one = run(['modules/a/examples/one.promql', 'modules/a', '--dataset', FIXTURE_DATASET, '--json'])
    expect(JSON.parse(one.stdout).results.map((entry) => entry.file)).toEqual(['modules/a/examples/one.promql'])
  })

  it.each([
    ['no paths', () => [], /missing required argument 'paths'/, 1],
    ['a path that does not exist', () => ['nope', '--dataset', FIXTURE_DATASET], /Error: nope does not exist/, 2],
    ['a file that is not .promql', () => { write('q.txt', GOOD); return ['q.txt', '--dataset', FIXTURE_DATASET] }, /Error: q.txt is not a \.promql file/, 2],
    ['a directory with no query files', () => { write('d/x.txt', GOOD); return ['d', '--dataset', FIXTURE_DATASET] }, /Error: no \.promql files found/, 2],
    ['no dataset', () => { write('q.promql', GOOD); return ['q.promql'] }, /Error: no dataset\. Pass --dataset/, 2],
    ['a dataset that does not exist', () => { write('q.promql', GOOD); return ['q.promql', '--dataset', 'gone.json'] }, /Error: the dataset gone.json does not exist/, 2],
    ['a dataset that is not JSON', () => { write('q.promql', GOOD); write('d.json', ['{']); return ['q.promql', '--dataset', 'd.json'] }, /is not JSON/, 2],
    ['a file that is not a dataset', () => { write('q.promql', GOOD); write('d.json', ['{"public": {}}']); return ['q.promql', '--dataset', 'd.json'] }, /has no "metrics" object/, 2],
    ['--tag with --prometheus-url', () => { write('q.promql', GOOD); return ['q.promql', '--dataset', FIXTURE_DATASET, '--tag', 'v26.2.7', '--prometheus-url', 'http://x'] }, /pass --tag or --prometheus-url, not both/, 2],
    ['a URL with no scheme', () => { write('q.promql', GOOD); return ['q.promql', '--dataset', FIXTURE_DATASET, '--prometheus-url', 'localhost:9090'] }, /must start with http/, 2],
    ['a wait cap that is not a number', () => { write('q.promql', GOOD); return ['q.promql', '--dataset', FIXTURE_DATASET, '--wait-cap', 'soon'] }, /--wait-cap must be a whole number of seconds/, 2]
  ])('a usage or setup error exits non-zero with a message: %s', (_, args, message, status) => {
    const result = run(args())
    expect(result.status).toBe(status)
    expect(result.stderr).toMatch(message)
    expect(result.stdout).toBe('')
  })

  it('finds the dataset in a docs repository: the one for --tag, or the newest', () => {
    const dataset = fs.readFileSync(FIXTURE_DATASET, 'utf8')
    for (const tag of ['v25.3.9', 'v26.2.7', 'v26.10.1-rc2', 'v26.10.1', 'v26.9.12']) {
      write(`modules/reference/attachments/redpanda-metrics-${tag}.json`, [dataset.replace('"redpanda_version": "v26.2.7"', `"redpanda_version": "${tag}"`)])
    }
    write('q.promql', GOOD)
    expect(JSON.parse(run(['q.promql', '--json']).stdout).redpanda_version).toBe('v26.10.1')
  })
})

describe('doc-tools check-queries --tag', () => {
  // A stand-in for bash: records its arguments and environment, prints noise
  // on stdout as the real script does, and writes the result file the way the
  // inner run would.
  function standIn ({ report, status = 0 }) {
    const bin = path.join(workDir, 'bin')
    fs.mkdirSync(bin)
    const argsFile = path.join(workDir, 'args.txt')
    const envFile = path.join(workDir, 'env.txt')
    const reportFile = path.join(workDir, 'report.json')
    if (report) fs.writeFileSync(reportFile, JSON.stringify(report))
    fs.writeFileSync(path.join(bin, 'bash'), [
      '#!/bin/sh',
      `printf '%s\\n' "$@" > "${argsFile}"`,
      `printf '%s\\n%s\\n%s\\n' "$NODE" "$CLUSTER_READY_TIMEOUT" "$METRICS_SETTLE_MAX" > "${envFile}"`,
      'echo "cluster progress on stdout"',
      'while [ $# -gt 0 ]; do if [ "$1" = "--result-file" ]; then out="$2"; fi; shift; done',
      report ? `cp "${reportFile}" "$out"` : ':',
      `exit ${status}`
    ].join('\n') + '\n', { mode: 0o755 })
    return {
      env: { PATH: `${bin}${path.delimiter}${process.env.PATH}` },
      args: () => fs.readFileSync(argsFile, 'utf8').trim().split('\n'),
      envSeen: () => fs.readFileSync(envFile, 'utf8').split('\n'),
      ran: () => fs.existsSync(argsFile)
    }
  }

  const report = (failed) => ({
    dataset: FIXTURE_DATASET,
    redpanda_version: 'v26.2.7',
    live: { prometheus_url: 'http://localhost:19090', targets: 6, scrape_interval_seconds: 5, waited_seconds: 0 },
    summary: { files: 1, passed: failed ? 0 : 1, failed: failed ? 1 : 0, run: 1, static_only: 0 },
    results: [{
      file: 'q.promql', status: failed ? 'fail' : 'pass', expect: 'series', query: 'up', skip_run: null, format_errors: [],
      static: { problems: [], notes: [], selectors: [] },
      live: { ok: !failed, expected: 'at least one series', got: failed ? 'no series' : '3 series', problems: failed ? ['expected at least one series, got no series'] : [], selectors: [] }
    }]
  })

  itOnPosix('runs the cluster script in queries mode with the files, the dataset and a result file', () => {
    const file = write('q.promql', GOOD)
    const stub = standIn({ report: report(false) })
    const result = run(['q.promql', '--dataset', FIXTURE_DATASET, '--tag', 'v26.2.7', '--wait-cap', '90', '--ready-timeout', '200', '--settle-timeout', '150'], stub.env)
    expect(result.status).toBe(0)
    const args = stub.args()
    expect(args[0]).toBe(path.join(ROOT, 'cli-utils', 'generate-cluster-docs.sh'))
    expect(args.slice(1, 6)).toEqual(['queries', 'v26.2.7', 'redpanda', 'latest', 'console'])
    expect(args.slice(6, 10)).toEqual(['--wait-cap', '90', '--dataset', FIXTURE_DATASET])
    expect(args[10]).toBe('--result-file')
    expect(args.slice(12)).toEqual([file])
    expect(stub.envSeen().slice(0, 3)).toEqual([process.execPath, '200', '150'])
    // The result file's directory is gone once the command has read it.
    expect(fs.existsSync(path.dirname(args[11]))).toBe(false)
    expect(result.stdout).toContain('PASS q.promql (expect series; live: 3 series)')
  })

  itOnPosix('keeps the script\'s output off stdout, so --json is only the results', () => {
    write('q.promql', GOOD)
    const stub = standIn({ report: report(true), status: 1 })
    const result = run(['q.promql', '--dataset', FIXTURE_DATASET, '--tag', 'v26.2.7', '--json'], stub.env)
    expect(result.status).toBe(1)
    expect(JSON.parse(result.stdout).summary.failed).toBe(1)
    expect(result.stderr).toContain('cluster progress on stdout')
  })

  itOnPosix('exits 2 when the cluster run ends before it checks a query', () => {
    write('q.promql', GOOD)
    const stub = standIn({ report: null, status: 2 })
    const result = run(['q.promql', '--dataset', FIXTURE_DATASET, '--tag', 'v26.2.7'], stub.env)
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('Error: the cluster run ended with exit code 2 before any query was checked')
    expect(result.stdout).toBe('')
  })

  itOnPosix('exits 2 when the cluster run fails after the queries passed', () => {
    write('q.promql', GOOD)
    const stub = standIn({ report: report(false), status: 3 })
    const result = run(['q.promql', '--dataset', FIXTURE_DATASET, '--tag', 'v26.2.7'], stub.env)
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('Error: the cluster run ended with exit code 3')
  })

  itOnPosix('starts no cluster when no file can be run', () => {
    write('bad.promql', ['# tag::query[]', 'rate(a[5m]),', 'rate(b[5m])', '# end::query[]'])
    write('skipped.promql', ['# skip-run: needs the operator', ...GOOD])
    const stub = standIn({ report: report(false) })
    const result = run(['.', '--dataset', FIXTURE_DATASET, '--tag', 'v26.2.7'], stub.env)
    expect(result.status).toBe(1)
    expect(stub.ran()).toBe(false)
    expect(result.stderr).toContain('No query can be run, so no cluster was started.')
    expect(result.stdout).toContain('PASS skipped.promql (expect series; not run: needs the operator)')
    expect(result.stdout).toContain('FAIL bad.promql')
  })

  itOnPosix('starts no cluster for files with exporter, and starts one when another file can run', () => {
    write('connect.promql', ['# expect: empty', '# exporter: kafka-connect', '# tag::query[]', 'kafka_consumer_lag_max > 1000', '# end::query[]'])
    const stub = standIn({ report: report(false) })
    const result = run(['.', '--dataset', FIXTURE_DATASET, '--tag', 'v26.2.7'], stub.env)
    expect(result.status).toBe(0)
    expect(stub.ran()).toBe(false)
    expect(result.stderr).toContain('No query can be run, so no cluster was started.')
    expect(result.stdout).toContain('PASS connect.promql (expect empty; syntax only; needs the kafka-connect exporter)')
    expect(result.stdout).toContain('1 query file: 1 passed, 0 failed. 0 run on a cluster, 0 checked against the dataset only. 1 checked for syntax only (metrics from another exporter).')

    write('q.promql', GOOD)
    expect(run(['.', '--dataset', FIXTURE_DATASET, '--tag', 'v26.2.7'], stub.env).status).toBe(0)
    expect(stub.ran()).toBe(true)
  })
})

describe('the Prometheus overlay', () => {
  const read = (file) => fs.readFileSync(file, 'utf8')
  const compose = yaml.load(read(path.join(BUNDLE, 'docker-compose.yml')))
  const overlay = yaml.load(read(path.join(METRICS, 'prometheus.overlay.yml')))
  const config = yaml.load(read(path.join(METRICS, 'prometheus.yml')))
  const brokers = Object.keys(compose.services).filter((name) => /^redpanda-\d+$/.test(name))
  const service = overlay.services['metrics-prometheus']

  it('adds one service, with a name the cluster scripts do not count as a broker', () => {
    expect(Object.keys(overlay.services)).toEqual(['metrics-prometheus'])
    expect(service.container_name).toBe('metrics-prometheus')
    expect(Object.keys(compose.services)).not.toContain('metrics-prometheus')
  })

  it('pins the image to a version tag on Docker Hub', () => {
    expect(service.image).toMatch(/^prom\/prometheus:v\d+\.\d+\.\d+$/)
  })

  it('joins the cluster network and publishes its port on localhost only', () => {
    expect(service.networks).toEqual(compose.services['redpanda-0'].networks)
    // eslint-disable-next-line no-template-curly-in-string
    expect(service.ports).toEqual(['127.0.0.1:${PROMETHEUS_PORT:-19090}:9090'])
  })

  it('mounts the configuration read only at the path Prometheus is told to read', () => {
    expect(service.volumes).toEqual(['../metrics/prometheus.yml:/etc/prometheus/prometheus.yml:ro'])
    expect(service.command).toContain('--config.file=/etc/prometheus/prometheus.yml')
  })

  it('scrapes both endpoints of every broker', () => {
    expect(brokers.length).toBeGreaterThanOrEqual(3)
    const paths = config.scrape_configs.map((job) => job.metrics_path).sort()
    expect(paths).toEqual(['/metrics', '/public_metrics'])
    for (const job of config.scrape_configs) {
      expect(job.static_configs).toHaveLength(1)
      expect([...job.static_configs[0].targets].sort()).toEqual(brokers.map((name) => `${name}:9644`).sort())
    }
  })

  // Prometheus sets instance to the target address unless something changes
  // it. The same address in both jobs is what gives one broker one instance.
  it('leaves instance as the broker address in both jobs', () => {
    for (const job of config.scrape_configs) {
      expect(job.relabel_configs).toBeUndefined()
      expect(job.metric_relabel_configs).toBeUndefined()
      expect(job.static_configs[0].labels).toBeUndefined()
      expect(job.honor_labels).toBeUndefined()
    }
    expect(new Set(config.scrape_configs.map((job) => job.job_name)).size).toBe(2)
  })

  it('scrapes often enough for a short range, with a timeout below the interval', () => {
    expect(config.global.scrape_interval).toBe('5s')
    expect(parseInt(config.global.scrape_timeout, 10)).toBeLessThan(parseInt(config.global.scrape_interval, 10))
  })
})

describe('queries mode in generate-cluster-docs.sh', () => {
  const script = fs.readFileSync(path.join(ROOT, 'cli-utils', 'generate-cluster-docs.sh'), 'utf8')
  const slice = (from, to) => {
    const start = script.indexOf(from)
    const end = script.indexOf(to, start)
    if (start === -1 || end === -1) throw new Error(`the script no longer has ${from} ... ${to}`)
    return script.slice(start, end)
  }
  const bash = (body, args = []) => {
    const file = path.join(workDir, 'part.sh')
    fs.writeFileSync(file, body)
    return spawnSync('bash', [file, ...args], { encoding: 'utf8', cwd: workDir })
  }

  // Runs the script's own selection of bundle, extras and compose files.
  const select = (tag, mode) => {
    const first = slice('MAJOR_MINOR="latest"', 'export REDPANDA_VERSION')
    const second = slice('COMPOSE_DIR="$SCRIPT_DIR/../docker-compose/25.1"', 'teardown() {')
    const third = slice('if (( METRICS_EXTRAS )); then\n  METRICS_BOOTSTRAP_FILE="$(mktemp', '###############################################################################\n# Metrics mode: list every metric family')
      .replace(/METRICS_BOOTSTRAP_FILE="\$\(mktemp[^\n]*\n\s*cat [^\n]*\n/, 'METRICS_BOOTSTRAP_FILE=/dev/null\n').replace(/\n\s*chmod [^\n]*/, '')
    const result = bash(`set -euo pipefail\nSCRIPT_DIR=/x/cli-utils\nMETRICS_DIR=/x/docker-compose/metrics\nTAG="$1"\nMODE="$2"\n${first}\n${second}\n${third}\necho "$METRICS_CLUSTER|$METRICS_EXTRAS|\${COMPOSE_FILE:-}"\n`, [tag, mode])
    return { status: result.status, stderr: result.stderr, line: result.stdout.trim().split('\n').pop() }
  }

  itOnPosix('starts the metrics cluster with the extras and adds the Prometheus overlay last', () => {
    expect(select('v26.2.7', 'queries').line).toBe('1|1|docker-compose.yml:/x/docker-compose/metrics/metrics.overlay.yml:/x/docker-compose/metrics/prometheus.overlay.yml')
  })

  itOnPosix('adds only the Prometheus overlay for a release that cannot take the extras', () => {
    expect(select('v25.2.13', 'queries').line).toBe('1|0|docker-compose.yml:/x/docker-compose/metrics/prometheus.overlay.yml')
  })

  itOnPosix('leaves metrics mode and rpk mode without Prometheus', () => {
    expect(select('v26.2.7', 'metrics').line).toBe('1|1|docker-compose.yml:/x/docker-compose/metrics/metrics.overlay.yml')
    expect(select('v26.2.7', 'rpk').line).toBe('0|0|')
  })

  itOnPosix('refuses a release older than the quickstart the overlay is written for, as a setup error', () => {
    const result = select('v24.3.9', 'queries')
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('Queries mode needs Redpanda 25.1 or later')
  })

  // Runs the script's own teardown with a stand-in for docker, ending the
  // script the way each kind of run ends.
  const teardown = ({ mode, checked, ending, keep = '0' }) => {
    const log = path.join(workDir, 'docker.log')
    const bootstrap = path.join(workDir, 'bootstrap.tmp')
    fs.writeFileSync(bootstrap, 'x')
    fs.rmSync(log, { force: true })
    const result = bash([
      'set -euo pipefail',
      `docker() { echo "$*" >> "${log}"; }`,
      `MODE=${mode}; PROJECT_NAME=redpanda_quickstart; COMPOSE_DIR="${workDir}"; ORIGINAL_PWD="${workDir}"`,
      `METRICS_BOOTSTRAP_FILE="${bootstrap}"; METRICS_INVENTORY_FILE=""; METRICS_INVENTORY_KEEP=0`,
      `export KEEP_CLUSTER=${keep}`,
      'QUERIES_CHECKED=0',
      'RUN_FINISHED=0',
      // These runs got as far as starting the cluster.
      'CLUSTER_STARTING=1',
      slice('teardown() {', 'if (( METRICS_EXTRAS )); then'),
      `QUERIES_CHECKED=${checked}`,
      ending
    ].join('\n') + '\n')
    return {
      status: result.status,
      stdout: result.stdout,
      docker: fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [],
      bootstrapLeft: fs.existsSync(bootstrap)
    }
  }
  const DOWN = 'compose -p redpanda_quickstart down --volumes'

  itOnPosix('exits 0 when every query passed, and tears down', () => {
    const result = teardown({ mode: 'queries', checked: 1, ending: 'RUN_FINISHED=1' })
    expect(result).toMatchObject({ status: 0, docker: [DOWN], bootstrapLeft: false })
  })

  itOnPosix('exits 1 when a query failed, tears down, and prints no cluster state', () => {
    const result = teardown({ mode: 'queries', checked: 1, ending: 'exit 1' })
    expect(result).toMatchObject({ status: 1, docker: [DOWN], bootstrapLeft: false })
    expect(result.stdout).not.toContain('docker compose ps')
  })

  itOnPosix('exits 2 when the run fails before the queries are checked, and prints the cluster state', () => {
    const result = teardown({ mode: 'queries', checked: 0, ending: 'exit 1' })
    expect(result.status).toBe(2)
    expect(result.docker).toEqual(['compose -p redpanda_quickstart ps -a', 'logs --tail 40 redpanda-0', DOWN])
    expect(result.bootstrapLeft).toBe(false)
    expect(result.stdout).toContain('run failed with exit code 2')
  })

  itOnPosix('exits 2 when the checker reports a setup error', () => {
    const result = teardown({ mode: 'queries', checked: 1, ending: 'exit 2' })
    expect(result.status).toBe(2)
    expect(result.docker).toContain(DOWN)
  })

  // On bash 3.2, a script that set -u stops reaches the trap with $? of 0.
  itOnPosix('exits 2, not 0, when the script stops early without an exit code', () => {
    const result = teardown({ mode: 'queries', checked: 0, ending: 'exit 0' })
    expect(result.status).toBe(2)
    expect(result.docker).toContain(DOWN)
  })

  itOnPosix('keeps exit 1 for a failed metrics run', () => {
    const result = teardown({ mode: 'metrics', checked: 0, ending: 'exit 1' })
    expect(result.status).toBe(1)
    expect(result.docker).toContain(DOWN)
  })

  itOnPosix('KEEP_CLUSTER=1 leaves the cluster and the bootstrap file it mounts', () => {
    const result = teardown({ mode: 'queries', checked: 1, ending: 'exit 1', keep: '1' })
    expect(result).toMatchObject({ status: 1, docker: [], bootstrapLeft: true })
    expect(result.stdout).toContain('KEEP_CLUSTER=1: leaving the cluster running')
  })

  it('runs the checker on the Prometheus it started, with two targets for each broker', () => {
    const call = slice('elif [[ "$MODE" == "queries" ]]; then', '\nelse')
    expect(call).toContain('QUERIES_CHECKED=1')
    expect(call).toContain('check-queries')
    expect(call).toContain('--prometheus-url "http://localhost:$PROMETHEUS_PORT"')
    expect(call).toContain('--min-targets "$(( EXPECTED_BROKERS * 2 ))"')
    // The flag is set before the checker runs, so its exit code is kept.
    expect(call.indexOf('QUERIES_CHECKED=1')).toBeLessThan(call.indexOf('check-queries'))
  })
})

'use strict'

/**
 * In metrics mode, generate-cluster-docs.sh turns on the features that
 * register extra metric families: it appends
 * docker-compose/metrics/bootstrap-extra.yml to the quickstart bootstrap file
 * and mounts the result over each broker's bootstrap file with
 * docker-compose/metrics/metrics.overlay.yml.
 *
 * A broker that the overlay misses starts without the extra properties, and
 * the scrape then silently lacks their metrics. These tests keep the overlay
 * and the extra properties in step with the quickstart bundle, and check how
 * the scripts choose a bundle and when the extras apply.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const yaml = require('js-yaml')

const ROOT = path.join(__dirname, '..', '..')
const BUNDLE = path.join(ROOT, 'docker-compose', '25.1')
const METRICS = path.join(ROOT, 'docker-compose', 'metrics')
const BOOTSTRAP_TARGET = '/etc/redpanda/.bootstrap.yaml'

const read = (file) => fs.readFileSync(file, 'utf8')
const compose = yaml.load(read(path.join(BUNDLE, 'docker-compose.yml')))
const overlay = yaml.load(read(path.join(METRICS, 'metrics.overlay.yml')))
const bootstrap = yaml.load(read(path.join(BUNDLE, 'bootstrap.yml')))
const extra = yaml.load(read(path.join(METRICS, 'bootstrap-extra.yml')))

const target = (volume) => String(volume).split(':').pop()
const brokers = Object.keys(compose.services).filter((name) =>
  (compose.services[name].volumes || []).some((volume) => target(volume) === BOOTSTRAP_TARGET)
)

describe('metrics overlay', () => {
  it('finds the brokers in the quickstart bundle', () => {
    expect(brokers.length).toBeGreaterThanOrEqual(3)
  })

  it('covers every broker that mounts a bootstrap file, and nothing else', () => {
    expect(Object.keys(overlay.services).sort()).toEqual([...brokers].sort())
  })

  it.each(brokers)('%s mounts the merged bootstrap file at the same path', (broker) => {
    const volumes = overlay.services[broker].volumes
    expect(volumes).toHaveLength(1)
    expect(volumes[0]).toMatch(/^\$\{METRICS_BOOTSTRAP_FILE[^}]*\}:\/etc\/redpanda\/\.bootstrap\.yaml$/)
  })

  it('changes nothing but the volume', () => {
    for (const broker of brokers) expect(Object.keys(overlay.services[broker])).toEqual(['volumes'])
  })
})

describe('extra bootstrap properties', () => {
  it('has at least one property', () => {
    expect(Object.keys(extra).length).toBeGreaterThan(0)
  })

  it('repeats no property the quickstart already sets', () => {
    expect(Object.keys(extra).filter((key) => key in bootstrap)).toEqual([])
  })

  it('still parses once appended to the quickstart bootstrap file', () => {
    const merged = yaml.load(`${read(path.join(BUNDLE, 'bootstrap.yml'))}\n${read(path.join(METRICS, 'bootstrap-extra.yml'))}`)
    expect(merged).toMatchObject({ ...bootstrap, ...extra })
  })
})

describe('bundle and extras selection in the cluster scripts', () => {
  const script = read(path.join(ROOT, 'cli-utils', 'generate-cluster-docs.sh'))

  // Runs the script's own selection block for a tag and mode, without Docker.
  const select = (tag, mode = 'metrics') => {
    const start = script.indexOf('MAJOR_MINOR="latest"')
    const first = script.slice(start, script.indexOf('export REDPANDA_VERSION', start))
    const from = script.indexOf('COMPOSE_DIR="$SCRIPT_DIR/../docker-compose/25.1"')
    const second = script.slice(script.lastIndexOf('\n#', from), script.indexOf('teardown() {', from))
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metrics-extras-'))
    try {
      const file = path.join(dir, 'select.sh')
      fs.writeFileSync(file, `set -euo pipefail\nSCRIPT_DIR=/x/cli-utils\nTAG="$1"\nMODE="$2"\n${first}\n${second}\necho "$COMPOSE_DIR $METRICS_EXTRAS"\n`)
      const result = spawnSync('bash', [file, tag, mode], { encoding: 'utf8' })
      if (result.status !== 0) throw new Error(result.stderr)
      const [composeDir, extras] = result.stdout.trim().split('\n').pop().split(' ')
      return { bundle: composeDir.replace('/x/cli-utils/../', ''), extras: extras === '1' }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  it.each([
    ['v26.2.7', 'docker-compose/25.1', true],
    ['v25.3.1', 'docker-compose/25.1', true],
    ['dev', 'docker-compose/25.1', true],
    ['latest', 'docker-compose/25.1', true],
    ['my-feature-branch', 'docker-compose/25.1', true],
    ['v25.2.13', 'docker-compose/25.1', false],
    ['v25.1.1', 'docker-compose/25.1', false],
    ['v24.3.9', 'docker-compose', false]
  ])('%s uses %s, extras %s', (tag, bundle, extras) => {
    expect(select(tag)).toEqual({ bundle, extras })
  })

  it('leaves the cluster alone outside metrics mode', () => {
    expect(select('v26.2.7', 'rpk')).toEqual({ bundle: 'docker-compose/25.1', extras: false })
  })

  it('start-cluster.sh picks the same bundle', () => {
    const start = read(path.join(ROOT, 'cli-utils', 'start-cluster.sh'))
    expect(start).toContain('QUICKSTART_DIR="$PACKAGE_ROOT/docker-compose/25.1"')
    expect(start).toMatch(/major < 25 \)\) \|\| \(\( major == 25 && minor < 1 \)\)/)
  })
})

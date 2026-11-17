'use strict'

/**
 * tools/metrics/extract_source.py lists every metric family the Redpanda
 * source can register, and tools/metrics/reconcile.py compares that inventory
 * with a scrape. Together they prove the metrics reference is complete: a
 * live cluster exports a family only when the feature behind it is in use, so
 * a scrape on its own can never show what is missing.
 *
 * The extractor reads a git ref without checking it out, so these tests build
 * a small throwaway repository of synthetic C++ and tag it. They cover:
 *
 * - endpoint and prefix resolution (internal, public, both),
 * - group name sanitizing and a group held in a variable, using the nearest
 *   assignment before the add_group call,
 * - helper types that Prometheus exposes as counter or gauge,
 * - a description built at run time,
 * - Seastar built-ins and the families copied to the public endpoint, and
 * - the reconcile gate, with negative controls: a family dropped from the
 *   scrape, a family the extractor does not know, a changed type and an empty
 *   HELP line must each fail.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const REPO_ROOT = path.join(__dirname, '..', '..')
const EXTRACT = path.join(REPO_ROOT, 'tools', 'metrics', 'extract_source.py')
const RECONCILE = path.join(REPO_ROOT, 'tools', 'metrics', 'reconcile.py')

function pythonBinary () {
  for (const candidate of ['python3', 'python']) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' })
    if (probe.status === 0) return candidate
  }
  return null
}

const PYTHON = pythonBinary()
const HAS_GIT = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0
const describeIfReady = PYTHON && HAS_GIT ? describe : describe.skip

const SOURCES = {
  'src/v/metrics/metrics.h': `
#pragma once
namespace metrics {
class internal_metric_groups {};
class public_metric_groups {};
class all_metrics_groups {};
}
`,
  'src/v/widget/probe.cc': `
#include "widget/probe.h"
namespace widget {
void probe::setup_internal() {
    namespace sm = ss::metrics;
    _metrics.add_group(
      prometheus_sanitize::metrics_name("widget:cache"),
      {
        sm::make_counter(
          "hits",
          [this] { return _hits; },
          sm::description("Number of cache hits")),
        sm::make_total_bytes(
          "read_bytes",
          [this] { return _read; },
          sm::description("Bytes read from the cache")),
        sm::make_current_bytes(
          "size_bytes",
          [this] { return _size; },
          sm::description("Bytes held in the cache")),
        // sm::make_gauge("commented_out", ...) must not be picked up
      });
}
void probe::setup_public() {
    namespace sm = ss::metrics;
    _public_metrics.add_group(
      prometheus_sanitize::metrics_name("widget"),
      {
        sm::make_histogram(
          "request_latency_seconds",
          [this] { return _hist.public_histogram_logform(); },
          sm::description("Latency of widget requests")),
        sm::make_gauge(
          "active",
          [this] { return _active; },
          sm::description(ssx::sformat("{}: active widgets", _name))),
      });
}
}
`,
  'src/v/widget/probe.h': `
#pragma once
namespace widget {
class probe {
    metrics::internal_metric_groups _metrics;
    metrics::public_metric_groups _public_metrics;
};
}
`,
  'src/v/gadget/probes.cc': `
#include "gadget/probes.h"
namespace gadget {
void first_probe::setup() {
    namespace sm = ss::metrics;
    auto group_name = prometheus_sanitize::metrics_name("gadget_first");
    _metrics.add_group(
      group_name,
      {sm::make_gauge("depth", [this] { return _depth; }, sm::description("Queue depth"))});
}
void second_probe::setup() {
    namespace sm = ss::metrics;
    auto group_name = prometheus_sanitize::metrics_name("gadget_second");
    _metrics.add_group(
      group_name,
      {sm::make_counter("errors_total", [this] { return _errors; }, sm::description("Errors seen"))});
}
void shared_probe::setup() {
    namespace sm = ss::metrics;
    _all.add_group(
      prometheus_sanitize::metrics_name("gadget_shared"),
      {sm::make_gauge("up", [this] { return 1; }, sm::description("Whether the gadget is up"))});
}
}
`,
  'src/v/gadget/probes.h': `
#pragma once
namespace gadget {
class first_probe { metrics::internal_metric_groups _metrics; };
class second_probe { metrics::internal_metric_groups _metrics; };
class shared_probe { metrics::all_metrics_groups _all; };
}
`,
  'src/v/gadget/tests/probe_test.cc': `
void t() { _metrics.add_group("test_only", {sm::make_gauge("ignored", [] { return 0; }, sm::description("x"))}); }
`
}

const SEASTAR = [
  { group: 'reactor', name: 'aio_reads', type: 'counter', file: 'src/core/reactor.cc' },
  { group: 'memory', name: 'free_memory', type: 'current_bytes', file: 'src/core/reactor.cc' },
  { group: 'execution_stages', name: 'tasks_scheduled', type: 'counter', file: 'src/core/execution_stage.cc', condition: 'never' }
]

function git (cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout
}

function buildRepo (dir) {
  for (const [file, content] of Object.entries(SOURCES)) {
    const target = path.join(dir, file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
  }
  git(dir, 'init', '-q')
  git(dir, 'add', '.')
  git(dir, '-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fixture')
  git(dir, 'tag', 'v0.0.1')
}

function run (script, args) {
  // -I: isolated mode, so nothing in a fixture directory can shadow stdlib imports.
  const result = spawnSync(PYTHON, ['-I', script, ...args], { encoding: 'utf8' })
  return { ...result, combined: `${result.stdout || ''}${result.stderr || ''}` }
}

function exposition (families) {
  return families
    .map(([name, type, help]) => `# HELP ${name}${help === '' ? '' : ` ${help || 'Some help'}`}\n# TYPE ${name} ${type}\n${name}{shard="0"} 1\n`)
    .join('')
}

describeIfReady('metrics source inventory', () => {
  let workDir
  let repoDir
  let seastarFile
  let inventory
  let inventoryFile

  beforeAll(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metrics-source-'))
    repoDir = path.join(workDir, 'repo')
    fs.mkdirSync(repoDir)
    buildRepo(repoDir)
    seastarFile = path.join(workDir, 'seastar.json')
    fs.writeFileSync(seastarFile, JSON.stringify(SEASTAR))
    const result = run(EXTRACT, ['--repo', repoDir, '--ref', 'v0.0.1', '--seastar-json', seastarFile])
    if (result.status !== 0) throw new Error(result.combined)
    inventory = JSON.parse(result.stdout)
    inventoryFile = path.join(workDir, 'inventory.json')
    fs.writeFileSync(inventoryFile, result.stdout)
  })

  afterAll(() => {
    fs.rmSync(workDir, { recursive: true, force: true })
  })

  describe('extract_source.py', () => {
    it('records the ref and resolves every registration', () => {
      expect(inventory.ref).toBe('v0.0.1')
      expect(inventory.unresolved).toEqual([])
    })

    it('puts internal groups on /metrics with the vectorized prefix and a sanitized group', () => {
      expect(inventory.internal.vectorized_widget_cache_hits).toMatchObject({
        type: 'counter',
        help: 'Number of cache hits',
        help_runtime: false,
        defined_in: 'src/v/widget/probe.cc',
        group: 'widget_cache',
        origin: 'src/v'
      })
      expect(inventory.public.redpanda_widget_cache_hits).toBeUndefined()
    })

    it('maps byte helpers to the type Prometheus exposes', () => {
      expect(inventory.internal.vectorized_widget_cache_read_bytes.type).toBe('counter')
      expect(inventory.internal.vectorized_widget_cache_size_bytes.type).toBe('gauge')
    })

    it('puts public groups on /public_metrics with the redpanda prefix', () => {
      expect(inventory.public.redpanda_widget_request_latency_seconds).toMatchObject({
        type: 'histogram',
        help: 'Latency of widget requests'
      })
      expect(inventory.internal.vectorized_widget_request_latency_seconds).toBeUndefined()
    })

    it('marks a description built at run time and gives no text for it', () => {
      const entry = inventory.public.redpanda_widget_active
      expect(entry.help).toBeNull()
      expect(entry.help_runtime).toBe(true)
      expect(entry.help_expr).toContain('active widgets')
    })

    it('resolves a group variable from the nearest assignment before add_group', () => {
      expect(inventory.internal.vectorized_gadget_first_depth).toBeDefined()
      expect(inventory.internal.vectorized_gadget_second_errors_total).toBeDefined()
      expect(inventory.internal.vectorized_gadget_first_errors_total).toBeUndefined()
      expect(inventory.internal.vectorized_gadget_second_depth).toBeUndefined()
    })

    it('registers an all_metrics_groups family on both endpoints', () => {
      expect(inventory.internal.vectorized_gadget_shared_up).toBeDefined()
      expect(inventory.public.redpanda_gadget_shared_up).toBeDefined()
    })

    it('ignores commented-out registrations and test sources', () => {
      const names = [...Object.keys(inventory.internal), ...Object.keys(inventory.public)]
      expect(names.some((name) => name.includes('commented_out'))).toBe(false)
      expect(names.some((name) => name.includes('test_only'))).toBe(false)
    })

    it('adds Seastar built-ins as internal families and keeps their condition', () => {
      expect(inventory.internal.vectorized_reactor_aio_reads).toMatchObject({ type: 'counter', origin: 'seastar' })
      expect(inventory.internal.vectorized_memory_free_memory.type).toBe('gauge')
      expect(inventory.internal.vectorized_execution_stages_tasks_scheduled.condition).toBe('never')
    })

    it('adds the Seastar families Redpanda copies to the public endpoint', () => {
      expect(inventory.public.redpanda_reactor_aio_reads).toMatchObject({ type: 'counter', origin: 'seastar-replicated' })
      expect(inventory.public.redpanda_memory_free_memory.type).toBe('gauge')
    })

    it('fails clearly when the ref is not a Redpanda source tree', () => {
      const result = run(EXTRACT, ['--repo', repoDir, '--ref', 'no-such-ref'])
      expect(result.status).not.toBe(0)
      expect(result.combined).toMatch(/metrics\.h not found/)
    })
  })

  describe('reconcile.py', () => {
    const typeOf = (entry) => entry.type
    let publicFamilies
    let internalFamilies

    const write = (name, families) => {
      const file = path.join(workDir, name)
      fs.writeFileSync(file, exposition(families))
      return file
    }

    const reconcile = (publicFile, internalFile, extra = []) =>
      run(RECONCILE, ['--inventory', inventoryFile, '--public-file', publicFile, '--internal-file', internalFile, '--json', ...extra])

    beforeAll(() => {
      publicFamilies = Object.entries(inventory.public).map(([name, entry]) => [name, typeOf(entry)])
      internalFamilies = Object.entries(inventory.internal)
        .filter(([, entry]) => entry.condition !== 'never')
        .map(([name, entry]) => [name, typeOf(entry)])
    })

    it('passes when every family is scraped or can never be registered', () => {
      const result = reconcile(write('pub-ok.txt', publicFamilies), write('int-ok.txt', internalFamilies))
      const report = JSON.parse(result.stdout)
      expect(result.status).toBe(0)
      expect(report.ok).toBe(true)
      expect(report.internal.missing_explained).toEqual({ vectorized_execution_stages_tasks_scheduled: 'never registered' })
    })

    it('takes the union of several brokers', () => {
      const half = Math.ceil(internalFamilies.length / 2)
      const result = run(RECONCILE, [
        '--inventory', inventoryFile,
        '--public-file', write('pub-union.txt', publicFamilies),
        '--internal-file', write('int-a.txt', internalFamilies.slice(0, half)),
        '--internal-file', write('int-b.txt', internalFamilies.slice(half)),
        '--json'
      ])
      expect(result.status).toBe(0)
    })

    it('fails when a family is dropped from the scrape', () => {
      const dropped = publicFamilies.filter(([name]) => name !== 'redpanda_widget_active')
      const result = reconcile(write('pub-dropped.txt', dropped), write('int-ok2.txt', internalFamilies))
      const report = JSON.parse(result.stdout)
      expect(result.status).toBe(1)
      expect(report.public.missing_unexplained).toEqual(['redpanda_widget_active'])
    })

    it('accepts a dropped family once it has a written reason', () => {
      const dropped = publicFamilies.filter(([name]) => name !== 'redpanda_widget_active')
      const reasons = path.join(workDir, 'expected-absent.json')
      fs.writeFileSync(reasons, JSON.stringify({ 'redpanda_widget_act*': 'needs a widget license' }))
      const result = reconcile(write('pub-dropped2.txt', dropped), write('int-ok3.txt', internalFamilies), ['--expected-absent', reasons])
      const report = JSON.parse(result.stdout)
      expect(result.status).toBe(0)
      expect(report.public.missing_explained).toEqual({ redpanda_widget_active: 'needs a widget license' })
    })

    it('fails when the scrape has a family the inventory does not', () => {
      const extra = [...internalFamilies, ['vectorized_unknown_family', 'gauge']]
      const result = reconcile(write('pub-ok4.txt', publicFamilies), write('int-extra.txt', extra))
      const report = JSON.parse(result.stdout)
      expect(result.status).toBe(1)
      expect(report.internal.scrape_only).toEqual(['vectorized_unknown_family'])
    })

    it('fails when a type differs between source and scrape', () => {
      const changed = publicFamilies.map(([name, type]) => (name === 'redpanda_widget_active' ? [name, 'counter'] : [name, type]))
      const result = reconcile(write('pub-type.txt', changed), write('int-ok5.txt', internalFamilies))
      const report = JSON.parse(result.stdout)
      expect(result.status).toBe(1)
      expect(report.public.type_mismatch).toEqual([{ name: 'redpanda_widget_active', source: 'gauge', scrape: 'counter' }])
    })

    it('fails when a scraped family has an empty HELP line', () => {
      const blank = publicFamilies.map(([name, type]) => (name === 'redpanda_widget_active' ? [name, type, ''] : [name, type]))
      const result = reconcile(write('pub-help.txt', blank), write('int-ok6.txt', internalFamilies))
      const report = JSON.parse(result.stdout)
      expect(result.status).toBe(1)
      expect(report.public.empty_help).toEqual(['redpanda_widget_active'])
    })

    it('exits 2 on unusable input', () => {
      const result = run(RECONCILE, ['--inventory', path.join(workDir, 'missing.json'), '--public-file', 'x', '--internal-file', 'y'])
      expect(result.status).toBe(2)
    })
  })
})

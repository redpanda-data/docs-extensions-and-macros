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
 * - Seastar built-ins and the families copied to the public endpoint, read
 *   from the source at the ref,
 * - definitions appended to a vector and registered by a later add_group,
 * - a group created with the public handle,
 * - a receiver whose endpoint cannot be determined: it must be reported as
 *   unresolved, with exit code 3, and never guessed,
 * - clear errors for a bad repository, ref, source tree or Seastar file, and
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
  'src/v/knob/probe.cc': `
#include "knob/probe.h"
namespace knob {
void probe::setup_first() {
    namespace sm = ss::metrics;
    sm::description help("Turns of the first knob");
    _public_and_internal.add_group(
      prometheus_sanitize::metrics_name("knob_first"),
      {sm::make_counter("turns_total", [this] { return _turns; }, help)});
}
void probe::setup_second() {
    namespace sm = ss::metrics;
    sm::description help("Turns of the second knob");
    _metrics.add_group(
      prometheus_sanitize::metrics_name("knob_second"),
      {sm::make_counter("turns_total", [this] { return _turns; }, help)});
}
void probe::setup_status() {
    namespace sm = ss::metrics;
    _public_status.add_group(
      prometheus_sanitize::metrics_name("knob_status"),
      {sm::make_gauge("up", [this] { return 1; }, sm::description("Whether the knob is up"))});
}
}
`,
  'src/v/knob/probe.h': `
#pragma once
namespace knob {
class probe {
    metrics::all_metrics_groups _public_and_internal;
    metrics::internal_metric_groups _metrics;
    metrics::internal_metric_groups _public_status;
};
}
`,
  'src/v/knob/wrapped.cc': `
#include "knob/probe.h"
namespace knob {
void wrapped::setup() {
    namespace sm = ss::metrics;
    _metrics.add_group(
      prometheus_sanitize::metrics_name("knob_wrapped"),
      {sm::make_gauge
        ("depth", [this] { return _depth; }, sm::description("Depth of the wrapped knob"))});
}
}
`,
  'src/v/knob/wrapped.h': `
#pragma once
namespace knob {
class wrapped { metrics::internal_metric_groups _metrics; };
}
`,
  'src/v/gadget/tests/probe_test.cc': `
void t() { _metrics.add_group("test_only", {sm::make_gauge("ignored", [] { return 0; }, sm::description("x"))}); }
`
}

// A second tree for the paths that need more than a literal name inside an
// enclosing add_group. One registration in it cannot be resolved on purpose.
const EDGE_SOURCES = {
  'src/v/metrics/metrics.h': SOURCES['src/v/metrics/metrics.h'],
  'src/v/edge/vec_probe.cc': `
#include "edge/vec_probe.h"
namespace edge {
void vec_probe::setup() {
    namespace sm = ss::metrics;
    std::vector<sm::metric_definition> defs;
    defs.emplace_back(sm::make_counter("appended_total", [this] { return _n; }, sm::description("Items appended")));
    std::vector<sm::metric_definition> other;
    other.push_back(sm::make_gauge("other_depth", [this] { return _d; }, sm::description("Other depth")));
    _metrics.add_group(prometheus_sanitize::metrics_name("edge:vec"), defs);
    _public_metrics.add_group(prometheus_sanitize::metrics_name("edge:other"), other);
}
}
`,
  'src/v/edge/vec_probe.h': `
#pragma once
namespace edge {
class vec_probe {
    metrics::internal_metric_groups _metrics;
    metrics::public_metric_groups _public_metrics;
};
}
`,
  'src/v/edge/handle_probe.cc': `
#include "edge/handle_probe.h"
namespace edge {
void handle_probe::add_topic(const key& k) {
    namespace sm = ss::metrics;
    auto [it, inserted] = _per_topic.emplace(k, metrics::public_metrics_handle);
    it->second.add_group(
      prometheus_sanitize::metrics_name("edge:emplaced"),
      {sm::make_gauge("replicas", [this] { return 3; }, sm::description("Replica count"))});
}
void handle_probe::setup_raw() {
    namespace sm = ss::metrics;
    _raw.add_group(
      prometheus_sanitize::metrics_name("edge:constructed"),
      {sm::make_gauge("handles", [this] { return 1; }, sm::description("Handle count"))});
}
void handle_probe::setup_lookup(const key& k) {
    namespace sm = ss::metrics;
    auto it = _things.find(k);
    it->second.add_group(
      prometheus_sanitize::metrics_name("edge:mystery"),
      {sm::make_gauge("lost", [this] { return 0; }, sm::description("Cannot be placed"))});
}
}
`,
  'src/v/edge/handle_probe.h': `
#pragma once
namespace edge {
class handle_probe {
    std::map<key, thing> _per_topic;
    std::map<key, thing> _things;
    ss::metrics::metric_groups _raw{metrics::public_metrics_handle};
};
}
`,
  'src/v/edge/queue_probe.cc': `
#include "edge/queue_probe.h"
namespace edge {
void queue_probe::setup() {
    namespace sm = ss::metrics;
    _metrics.add_group(
      prometheus_sanitize::metrics_name("edge:queue"),
      {sm::make_queue_length("pending", [this] { return _pending; }, sm::description("Items waiting"))});
}
}
`,
  'src/v/edge/queue_probe.h': `
#pragma once
namespace edge {
class queue_probe { metrics::internal_metric_groups _metrics; };
}
`,
  'src/v/redpanda/application.cc': `
void application::setup_metrics() {
    ss::metrics::replicate_metric_families(
      ss::metrics::default_handle(),
      {{"memory_free_memory", metrics::public_metrics_handle},
       {"io_queue_total_read_ops", metrics::public_metrics_handle}});
}
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

function buildRepo (dir, sources = SOURCES) {
  fs.mkdirSync(dir, { recursive: true })
  for (const [file, content] of Object.entries(sources)) {
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

    it('reads the endpoint from the declaration when the receiver name says both', () => {
      expect(inventory.public.redpanda_knob_first_turns_total).toBeDefined()
      expect(inventory.internal.vectorized_knob_first_turns_total).toBeDefined()
    })

    it('reads the endpoint from the declaration before the receiver name', () => {
      expect(inventory.internal.vectorized_knob_status_up).toBeDefined()
      expect(inventory.public.redpanda_knob_status_up).toBeUndefined()
    })

    it('takes a description variable from the function that registers with it', () => {
      expect(inventory.public.redpanda_knob_first_turns_total.help).toBe('Turns of the first knob')
      expect(inventory.internal.vectorized_knob_second_turns_total.help).toBe('Turns of the second knob')
    })

    it('finds a registration whose "(" is on the next line', () => {
      expect(inventory.internal.vectorized_knob_wrapped_depth).toMatchObject({ type: 'gauge', help: 'Depth of the wrapped knob' })
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
    })

    it('keeps source expressions out of the output unless --debug is given', () => {
      expect(JSON.stringify(inventory)).not.toContain('help_expr')
      expect(JSON.stringify(inventory)).not.toContain('sformat')
      const result = run(EXTRACT, ['--repo', repoDir, '--ref', 'v0.0.1', '--debug'])
      expect(result.status).toBe(0)
      expect(JSON.parse(result.stdout).public.redpanda_widget_active.help_expr).toContain('active widgets')
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

    it('uses the built-in list of copied families when the source has none', () => {
      const copied = Object.keys(inventory.public).filter((name) => inventory.public[name].origin === 'seastar-replicated')
      expect(copied).toHaveLength(13)
    })

    describe('bad input', () => {
      const expectError = (args, pattern) => {
        const result = run(EXTRACT, args)
        expect(result.status).toBe(2)
        expect(result.stdout).toBe('')
        expect(result.stderr).toMatch(pattern)
        expect(result.stderr).not.toMatch(/Traceback/)
      }

      it('names a repository path that does not exist', () => {
        expectError(['--repo', path.join(workDir, 'nowhere'), '--ref', 'v0.0.1'], /repository path .* does not exist/)
      })

      it('names a directory that is not a git repository', () => {
        const plain = path.join(workDir, 'plain')
        fs.mkdirSync(plain)
        expectError(['--repo', plain, '--ref', 'v0.0.1'], /is not a git repository/)
      })

      it('names a ref that does not exist', () => {
        expectError(['--repo', repoDir, '--ref', 'no-such-ref'], /ref no-such-ref not found/)
      })

      it('names a repository that is not a Redpanda source tree', () => {
        const other = path.join(workDir, 'other')
        buildRepo(other, { 'README.md': 'not Redpanda\n' })
        expectError(['--repo', other, '--ref', 'v0.0.1'], /not a Redpanda source tree/)
      })

      it('names a --seastar-json file that cannot be read', () => {
        expectError(['--repo', repoDir, '--ref', 'v0.0.1', '--seastar-json', path.join(workDir, 'missing.json')], /cannot read --seastar-json/)
      })
    })
  })

  describe('extract_source.py on registrations that need more than a literal', () => {
    let edgeDir
    let edgeRun
    let edge

    beforeAll(() => {
      edgeDir = path.join(workDir, 'edge')
      buildRepo(edgeDir, EDGE_SOURCES)
      edgeRun = run(EXTRACT, ['--repo', edgeDir, '--ref', 'v0.0.1'])
      edge = JSON.parse(edgeRun.stdout)
    })

    it('follows definitions appended to a vector to the add_group that registers it', () => {
      expect(edge.internal.vectorized_edge_vec_appended_total).toMatchObject({ type: 'counter', help: 'Items appended' })
      expect(edge.public.redpanda_edge_other_other_depth).toMatchObject({ type: 'gauge' })
      expect(edge.public.redpanda_edge_other_appended_total).toBeUndefined()
      expect(edge.internal.vectorized_edge_vec_other_depth).toBeUndefined()
    })

    it('puts a group emplaced with the public handle on the public endpoint only', () => {
      expect(edge.public.redpanda_edge_emplaced_replicas).toMatchObject({ type: 'gauge', resolution: 'clean' })
      expect(edge.internal.vectorized_edge_emplaced_replicas).toBeUndefined()
    })

    it('puts a group constructed with the public handle on the public endpoint only', () => {
      expect(edge.public.redpanda_edge_constructed_handles).toBeDefined()
      expect(edge.internal.vectorized_edge_constructed_handles).toBeUndefined()
    })

    it('reports a receiver with no known endpoint as unresolved, once, and does not guess', () => {
      expect(edge.unresolved).toEqual([
        { file: 'src/v/edge/handle_probe.cc', line: expect.any(Number), kind: 'gauge', reason: 'endpoint not resolvable' }
      ])
      const names = [...Object.keys(edge.internal), ...Object.keys(edge.public)]
      expect(names.filter((name) => name.includes('mystery'))).toEqual([])
    })

    it('exits 3 and prints one line per unresolved registration on stderr', () => {
      expect(edgeRun.status).toBe(3)
      const lines = edgeRun.stderr.split('\n').filter((line) => line.startsWith('unresolved: '))
      expect(lines).toHaveLength(1)
      expect(lines[0]).toMatch(/^unresolved: src\/v\/edge\/handle_probe\.cc:\d+ make_gauge: endpoint not resolvable$/)
    })

    it('adds the unresolved expression only with --debug', () => {
      const result = run(EXTRACT, ['--repo', edgeDir, '--ref', 'v0.0.1', '--debug'])
      expect(result.status).toBe(3)
      expect(JSON.parse(result.stdout).unresolved[0].expr).toBe('it->second')
    })

    it('reads the copied Seastar families from the source at the ref', () => {
      const copied = Object.keys(edge.public).filter((name) => edge.public[name].origin === 'seastar-replicated')
      expect(copied.sort()).toEqual(['redpanda_io_queue_total_read_ops', 'redpanda_memory_free_memory'])
      expect(edge.public.redpanda_reactor_aio_reads).toBeUndefined()
    })

    it('scans a file that only uses make_queue_length and maps it to gauge', () => {
      expect(edge.internal.vectorized_edge_queue_pending).toMatchObject({ type: 'gauge', help: 'Items waiting' })
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

    it('fails when one broker of several reports another type, whichever comes first', () => {
      const changed = publicFamilies.map(([name, type]) => (name === 'redpanda_widget_active' ? [name, 'counter'] : [name, type]))
      const good = write('pub-type-a.txt', publicFamilies)
      const bad = write('pub-type-b.txt', changed)
      for (const order of [[good, bad], [bad, good]]) {
        const result = run(RECONCILE, ['--inventory', inventoryFile, '--public-file', order[0], '--public-file', order[1],
          '--internal-file', write('int-ok7.txt', internalFamilies), '--json'])
        const report = JSON.parse(result.stdout)
        expect(result.status).toBe(1)
        expect(report.public.type_mismatch).toEqual([{ name: 'redpanda_widget_active', source: 'gauge', scrape: 'counter, gauge' }])
      }
    })

    it('fails when a scraped family has no TYPE line: it is untyped', () => {
      const text = exposition(publicFamilies).replace(/^# TYPE redpanda_widget_active .*\n/m, '')
      const file = path.join(workDir, 'pub-untyped.txt')
      fs.writeFileSync(file, text)
      const result = reconcile(file, write('int-ok8.txt', internalFamilies))
      const report = JSON.parse(result.stdout)
      expect(result.status).toBe(1)
      expect(report.public.type_mismatch).toEqual([{ name: 'redpanda_widget_active', source: 'gauge', scrape: 'untyped' }])
    })

    it('fails on a family that has samples and no HELP or TYPE line', () => {
      const file = path.join(workDir, 'int-sample-only.txt')
      fs.writeFileSync(file, exposition(internalFamilies) + 'vectorized_sample_only{shard="0"} 1\n')
      const result = reconcile(write('pub-ok9.txt', publicFamilies), file)
      const report = JSON.parse(result.stdout)
      expect(result.status).toBe(1)
      expect(report.internal.scrape_only).toEqual(['vectorized_sample_only'])
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

'use strict'

/**
 * The metrics surface of the overrides audit compares each description in
 * docs-data/metric-overrides.json with the help string the Redpanda source
 * registers, as listed by tools/metrics/extract_source.py.
 *
 * Each rule has a negative control, so a rule that stopped working cannot
 * pass by classifying everything the same way.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const { runAudit, formatHumanReport } = require('../../../tools/overrides-audit')
const { CLASSES } = require('../../../tools/overrides-audit/classify')
const { stripTerminalPeriod } = require('../../../tools/overrides-audit/adapters/metrics')
const { buildTriagePrompt, triageCandidate } = require('../../../tools/overrides-audit/triage')

const family = (help, file, line, extra = {}) => ({
  type: 'gauge', help, help_runtime: false, defined_in: file, line, group: 'g', resolution: 'clean', call_sites: 1, origin: 'src/v', ...extra
})

const INVENTORY = {
  ref: 'v0.0.1',
  public: {
    redpanda_widget_active: family('Number of active widgets', 'src/v/widget/probe.cc', 10),
    redpanda_widget_errors_total: family('Errors seen', 'src/v/widget/probe.cc', 20, { type: 'counter' }),
    redpanda_widget_built: family(null, 'src/v/widget/probe.cc', 30, { help_runtime: true }),
    redpanda_widget_bare: family(null, 'src/v/widget/probe.cc', 35),
    redpanda_memory_free_memory: { type: 'gauge', help: null, help_runtime: false, defined_in: 'src/v/redpanda/application.cc', group: 'memory', resolution: 'rule', call_sites: 1, origin: 'seastar-replicated' },
    redpanda_gadget_up: family('Whether the gadget is up', 'src/v/gadget/probes.cc', 40),
    redpanda_gadget_requests_total: family('Requests', 'src/v/gadget/probes.cc', 50, { call_sites: 3 })
  },
  internal: {
    vectorized_gadget_up: family('Whether the gadget is up', 'src/v/gadget/probes.cc', 40),
    vectorized_gadget_depth: family('Queue depth', 'src/v/gadget/probes.cc', 60)
  },
  unresolved: []
}

describe('overrides audit, metrics surface', () => {
  let tmpDir
  let inventoryPath

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overrides-audit-metrics-'))
    inventoryPath = path.join(tmpDir, 'inventory.json')
    fs.writeFileSync(inventoryPath, JSON.stringify(INVENTORY))
  })

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  let counter = 0
  const audit = (metrics) => {
    counter += 1
    const overridesPath = path.join(tmpDir, `overrides-${counter}.json`)
    fs.writeFileSync(overridesPath, JSON.stringify({ metrics }))
    return runAudit({ overrides: overridesPath, extracted: inventoryPath, surface: 'metrics' })
  }
  const rows = (metrics) => Object.fromEntries(audit(metrics).manifest.map((row) => [`${row.name}|${row.field}`, row]))
  const descriptionRow = (name, description, extra = {}) => rows({ [name]: { description, ...extra } })[`${name}|description`]

  describe('comparison with the help string', () => {
    test('text identical to the help string is REDUNDANT', () => {
      const row = descriptionRow('redpanda_widget_active', 'Number of  active widgets')
      expect(row.class).toBe(CLASSES.REDUNDANT)
      expect(row.upstream_candidate_text).toBeUndefined()
    })

    test('control: different text is UPSTREAMABLE, with the source location from the inventory', () => {
      const row = descriptionRow('redpanda_widget_active', 'Number of widgets that are serving requests.', { upstream_ref: 'redpanda-data/streaming-enterprise#1' })
      expect(row.class).toBe(CLASSES.UPSTREAMABLE)
      expect(row.source_file).toBe('src/v/widget/probe.cc')
      expect(row.source_line).toBe(10)
      expect(row.source_text).toBe('Number of active widgets')
      expect(row.upstream_ref).toBe('redpanda-data/streaming-enterprise#1')
      expect(row.content_hash).toMatch(/^[0-9a-f]{16}$/)
    })

    test('a candidate row is what the triage prompt needs', () => {
      const prompt = buildTriagePrompt(descriptionRow('redpanda_widget_active', 'Number of widgets that are serving requests.'))
      expect(prompt).toContain('src/v/widget/probe.cc:10')
      expect(prompt).toContain('Number of widgets that are serving requests')
    })
  })

  describe('help-string convention', () => {
    test('the candidate has no terminal period', () => {
      const row = descriptionRow('redpanda_widget_active', 'Number of widgets that are serving requests.')
      expect(row.upstream_candidate_text).toBe('Number of widgets that are serving requests')
    })

    test('a period inside the text and an ellipsis stay', () => {
      expect(stripTerminalPeriod('First. Second.')).toBe('First. Second')
      expect(stripTerminalPeriod('And so on...')).toBe('And so on...')
      expect(stripTerminalPeriod('No period')).toBe('No period')
    })

    test('text that differs only by the terminal period is REDUNDANT, so an upstreamed override can retire', () => {
      const row = descriptionRow('redpanda_widget_active', 'Number of active widgets.')
      expect(row.class).toBe(CLASSES.REDUNDANT)
      expect(row.upstream_candidate_text).toBeUndefined()
      expect(row.note).toMatch(/terminal period/)
    })

    test('control: a period in the middle is a difference', () => {
      const row = descriptionRow('redpanda_widget_active', 'Number of active. widgets')
      expect(row.class).toBe(CLASSES.UPSTREAMABLE)
    })

    test('docs markup is stripped from the candidate, and the override is kept until it ships', () => {
      const row = descriptionRow('redpanda_widget_active', 'Number of widgets that serve requests. See xref:manage:widgets.adoc[Widgets].')
      expect(row.class).toBe(CLASSES.KEEP_UNTIL_UPSTREAMED)
      expect(row.note).toMatch(/^SPLIT:/)
      expect(row.upstream_candidate_text).toBe('Number of widgets that serve requests. See Widgets')
    })

    test('control: markup around text that already matches is KEEP', () => {
      const row = descriptionRow('redpanda_widget_active', 'Number of active glossterm:widgets[].')
      expect(row.class).toBe(CLASSES.KEEP)
      expect(row.upstream_candidate_text).toBeUndefined()
    })
  })

  describe('a family with no help string to rewrite', () => {
    test('help built at run time is REVIEW, with the reason', () => {
      const row = descriptionRow('redpanda_widget_built', 'Number of widgets built.')
      expect(row.class).toBe(CLASSES.REVIEW)
      expect(row.upstream_candidate_text).toBeUndefined()
      expect(row.note).toMatch(/built at run time/)
      expect(row.source_file).toBe('src/v/widget/probe.cc')
    })

    test('a Seastar family and a registration without help are REVIEW', () => {
      const seastar = descriptionRow('redpanda_memory_free_memory', 'Free memory in bytes.')
      expect(seastar.class).toBe(CLASSES.REVIEW)
      expect(seastar.note).toMatch(/Seastar/)
      const bare = descriptionRow('redpanda_widget_bare', 'A widget.')
      expect(bare.class).toBe(CLASSES.REVIEW)
      expect(bare.note).toMatch(/no help string/)
    })

    test('control: the same override on a family with a literal help string is a candidate', () => {
      expect(descriptionRow('redpanda_widget_errors_total', 'Number of widgets built.').class).toBe(CLASSES.UPSTREAMABLE)
    })
  })

  describe('one registration on both endpoints', () => {
    test('overrides with the same text give one candidate', () => {
      const result = rows({
        redpanda_gadget_up: { description: 'Whether the gadget accepts requests.' },
        vectorized_gadget_up: { description: 'Whether the gadget accepts requests.' }
      })
      const first = result['redpanda_gadget_up|description']
      const second = result['vectorized_gadget_up|description']
      expect(first.class).toBe(CLASSES.UPSTREAMABLE)
      expect(first.upstream_candidate_text).toBe('Whether the gadget accepts requests')
      expect(first.shared_with).toEqual(['vectorized_gadget_up'])
      expect(second.class).toBe(CLASSES.KEEP_UNTIL_UPSTREAMED)
      expect(second.upstream_candidate_text).toBeUndefined()
      expect(second.same_source_as).toBe('redpanda_gadget_up')
      // The workflows select a KEEP_UNTIL_UPSTREAMED row only when its note starts with SPLIT:.
      expect(second.note).not.toMatch(/^SPLIT:/)
    })

    test('overrides with different text give no candidate at all', () => {
      const result = rows({
        redpanda_gadget_up: { description: 'Whether the gadget accepts requests.' },
        vectorized_gadget_up: { description: 'Whether the gadget is running.' }
      })
      for (const name of ['redpanda_gadget_up', 'vectorized_gadget_up']) {
        const row = result[`${name}|description`]
        expect(row.class).toBe(CLASSES.REVIEW)
        expect(row.upstream_candidate_text).toBeUndefined()
        expect(row.note).toMatch(/different text for the one help string at src\/v\/gadget\/probes\.cc:40/)
      }
    })

    test('an override that matches the help string and one that does not give no candidate', () => {
      const result = rows({
        redpanda_gadget_up: { description: 'Whether the gadget is up.' },
        vectorized_gadget_up: { description: 'Whether the gadget is running.' }
      })
      for (const name of ['redpanda_gadget_up', 'vectorized_gadget_up']) {
        const row = result[`${name}|description`]
        expect(row.class).toBe(CLASSES.REVIEW)
        expect(row.upstream_candidate_text).toBeUndefined()
        expect(row.note).toMatch(/different text for the one help string at src\/v\/gadget\/probes\.cc:40/)
      }
    })

    test('control: two overrides that both match the help string stay redundant', () => {
      const result = rows({
        redpanda_gadget_up: { description: 'Whether the gadget is up.' },
        vectorized_gadget_up: { description: 'Whether the gadget is up' }
      })
      expect(result['redpanda_gadget_up|description'].class).toBe(CLASSES.REDUNDANT)
      expect(result['vectorized_gadget_up|description'].class).toBe(CLASSES.REDUNDANT)
    })

    test('an override on one name only is a plain candidate', () => {
      const row = descriptionRow('vectorized_gadget_up', 'Whether the gadget accepts requests.')
      expect(row.class).toBe(CLASSES.UPSTREAMABLE)
      expect(row.shared_with).toBeUndefined()
    })

    test('control: different text on two registrations gives two candidates', () => {
      const result = rows({
        redpanda_gadget_up: { description: 'Whether the gadget accepts requests.' },
        vectorized_gadget_depth: { description: 'Number of requests waiting in the gadget queue.' }
      })
      expect(result['redpanda_gadget_up|description'].upstream_candidate_text).toBe('Whether the gadget accepts requests')
      expect(result['vectorized_gadget_depth|description'].upstream_candidate_text).toBe('Number of requests waiting in the gadget queue')
    })

    test('a family registered at several call sites says so', () => {
      expect(descriptionRow('redpanda_gadget_requests_total', 'Requests the gadget served.').note).toMatch(/3 call sites/)
      expect(descriptionRow('redpanda_gadget_up', 'Whether the gadget accepts requests.').note).not.toMatch(/call sites/)
    })
  })

  describe('audience paragraphs', () => {
    const CLOUD = 'cloud-only: In Serverless, this counts your widgets only.'

    test('only the unprefixed text is the candidate, and the override stays (SPLIT)', () => {
      const row = descriptionRow('redpanda_widget_active', ['Number of widgets that are serving requests.', CLOUD])
      expect(row.class).toBe(CLASSES.KEEP_UNTIL_UPSTREAMED)
      expect(row.note).toMatch(/^SPLIT: /)
      expect(row.upstream_candidate_text).toBe('Number of widgets that are serving requests')
      expect(row.audience_scoped_text).toEqual([CLOUD])
      expect(row.note).toMatch(/1 audience paragraph\(s\) stay/)
    })

    test('triage cannot retire an override that carries audience paragraphs', () => {
      const row = descriptionRow('redpanda_widget_active', ['Number of widgets that are serving requests.', CLOUD])
      const triaged = triageCandidate(row, JSON.stringify({ verdict: 'RETIRE_OVERRIDE', reason: 'Source says the same.' }))
      expect(triaged.agent_verdict).toBe('AMBIGUOUS')
    })

    test('control: plain prose with no audience paragraphs stays UPSTREAMABLE', () => {
      const row = descriptionRow('redpanda_widget_active', 'Number of widgets that are serving requests.')
      expect(row.class).toBe(CLASSES.UPSTREAMABLE)
    })

    test('unprefixed text that matches the help string is REDUNDANT whatever the audience paragraphs say', () => {
      const row = descriptionRow('redpanda_widget_active', ['Number of active widgets', CLOUD])
      expect(row.class).toBe(CLASSES.REDUNDANT)
      expect(row.audience_scoped_text).toEqual([CLOUD])
    })

    test('an override that is only audience paragraphs has nothing to upstream', () => {
      const row = descriptionRow('redpanda_widget_active', [CLOUD, 'self-managed-only: Counts every widget.'])
      expect(row.class).toBe(CLASSES.KEEP)
      expect(row.upstream_candidate_text).toBeUndefined()
    })

    test('control: an audience prefix inside a plain string is never a candidate', () => {
      const row = descriptionRow('redpanda_widget_active', CLOUD)
      expect(row.class).toBe(CLASSES.REVIEW)
      expect(row.upstream_candidate_text).toBeUndefined()
    })
  })

  describe('other entries', () => {
    describe('an override that cannot be moved upstream', () => {
      test('is listed for review once, with how to stop it being listed', () => {
        const row = descriptionRow('redpanda_widget_built', 'Number of widgets built.')
        expect(row.class).toBe(CLASSES.REVIEW)
        expect(row.note).toMatch(/set upstream_not_possible on it with the reason/)
      })

      test('is kept, and not listed again, once a person has recorded why', () => {
        const row = descriptionRow('redpanda_widget_built', 'Number of widgets built.', { upstream_not_possible: 'The help string is built from the widget name.' })
        expect(row.class).toBe(CLASSES.KEEP)
        expect(row.note).toMatch(/Marked upstream_not_possible: The help string is built from the widget name\./)
        expect(row.upstream_candidate_text).toBeUndefined()
      })

      test('the marker is an annotation, so it gets no row of its own', () => {
        const all = rows({ redpanda_widget_built: { description: 'Number of widgets built.', upstream_not_possible: 'The help string is built from the widget name.' } })
        expect(Object.keys(all)).toEqual(['redpanda_widget_built|description'])
      })

      test('the same goes for a Seastar metric', () => {
        const row = descriptionRow('redpanda_memory_free_memory', 'Free memory.', { upstream_not_possible: 'The metric comes from Seastar.' })
        expect(row.class).toBe(CLASSES.KEEP)
      })

      test('negative control: the marker does not hide an override the source can take', () => {
        const row = descriptionRow('redpanda_widget_active', 'How many widgets are active right now', { upstream_not_possible: 'Out of date.' })
        expect(row.class).toBe(CLASSES.UPSTREAMABLE)
        expect(row.note).toMatch(/Marked upstream_not_possible, but the source has a plain help string/)
      })

      test('negative control: an empty marker records nothing', () => {
        const row = descriptionRow('redpanda_widget_built', 'Number of widgets built.', { upstream_not_possible: '  ' })
        expect(row.class).toBe(CLASSES.REVIEW)
      })
    })

    test('every row says which surface it came from, for the shared prompt and report', () => {
      const result = audit({ redpanda_widget_active: { description: 'How many widgets are active right now', category: 'Widgets' } })
      expect(result.manifest.length).toBeGreaterThan(0)
      for (const row of result.manifest) expect(row.surface).toBe('metrics')
    })

    test('a metric that is not in the inventory is REVIEW', () => {
      const row = descriptionRow('redpanda_gone_total', 'A metric that was removed.')
      expect(row.class).toBe(CLASSES.REVIEW)
      expect(row.note).toMatch(/not present in the source inventory/)
      expect(row.source_file).toBeUndefined()
    })

    test('a description marked retirement_pending is not a candidate', () => {
      const pending = descriptionRow('redpanda_widget_active', 'Number of widgets that are serving requests.', { retirement_pending: { reason: 'Source caught up.' } })
      expect(pending.class).toBe(CLASSES.KEEP)
      expect(pending.upstream_candidate_text).toBeUndefined()
    })

    test('other fields are KEEP, and annotations get no row', () => {
      const result = rows({
        redpanda_widget_active: {
          _comment: 'note',
          upstream_ref: 'redpanda-data/streaming-enterprise#1',
          description: 'Number of active widgets',
          unit: 'widgets',
          labels: [{ name: 'shard' }],
          category: 'Widget metrics'
        }
      })
      expect(Object.keys(result).sort()).toEqual([
        'redpanda_widget_active|category',
        'redpanda_widget_active|description',
        'redpanda_widget_active|labels',
        'redpanda_widget_active|unit'
      ])
      expect(result['redpanda_widget_active|unit'].class).toBe(CLASSES.KEEP)
      expect(result['redpanda_widget_active|unit'].note).toMatch(/release run/)
      expect(result['redpanda_widget_active|category'].class).toBe(CLASSES.KEEP)
    })

    test('an entry that is not an object is REVIEW', () => {
      expect(audit({ redpanda_widget_active: 'text' }).manifest[0].class).toBe(CLASSES.REVIEW)
    })
  })

  describe('wiring', () => {
    test('the result names the surface and the source ref, and has a summary', () => {
      const result = audit({ redpanda_widget_active: { description: 'Number of active widgets' } })
      expect(result.surface).toBe('metrics')
      expect(result.source_ref).toBe('v0.0.1')
      expect(result.summary.byClass[CLASSES.REDUNDANT]).toBe(1)
      const report = formatHumanReport(result)
      expect(report).toContain('surface: metrics')
      expect(report).toContain('Source ref: v0.0.1')
    })

    test('needs --extracted or --repo', () => {
      const overridesPath = path.join(tmpDir, 'needs.json')
      fs.writeFileSync(overridesPath, JSON.stringify({ metrics: {} }))
      expect(() => runAudit({ overrides: overridesPath, surface: 'metrics' })).toThrow(/--extracted .* or --repo/)
    })

    test('rejects an overrides file without a metrics object and a file that is not an inventory', () => {
      const bad = path.join(tmpDir, 'bad.json')
      fs.writeFileSync(bad, JSON.stringify({ properties: {} }))
      expect(() => runAudit({ overrides: bad, extracted: inventoryPath, surface: 'metrics' })).toThrow(/no top-level "metrics" object/)
      const good = path.join(tmpDir, 'good.json')
      fs.writeFileSync(good, JSON.stringify({ metrics: {} }))
      expect(() => runAudit({ overrides: good, extracted: bad, surface: 'metrics' })).toThrow(/extract_source\.py/)
    })

    test('--ref is for the metrics surface only', () => {
      expect(() => runAudit({ overrides: 'x.json', extracted: 'y.json', ref: 'v1', surface: 'rpk' })).toThrow(/--ref applies to the metrics surface only/)
    })
  })
})

const PYTHON = ['python3', 'python'].find((candidate) => spawnSync(candidate, ['--version'], { encoding: 'utf8' }).status === 0)
const HAS_GIT = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0
const describeIfReady = PYTHON && HAS_GIT ? describe : describe.skip

// Synthetic C++, shaped like a metric registration.
const SOURCES = {
  'src/v/metrics/metrics.h': '#pragma once\nnamespace metrics {\nclass internal_metric_groups {};\nclass public_metric_groups {};\n}\n',
  'src/v/widget/probe.h': '#pragma once\nnamespace widget {\nclass probe {\n    metrics::public_metric_groups _public_metrics;\n};\n}\n',
  'src/v/widget/probe.cc': `#include "widget/probe.h"
namespace widget {
void probe::setup_public() {
    namespace sm = ss::metrics;
    _public_metrics.add_group(
      prometheus_sanitize::metrics_name("widget"),
      {
        sm::make_gauge(
          "active",
          [this] { return _active; },
          sm::description("Number of active widgets")),
        sm::make_gauge(
          "named",
          [this] { return _named; },
          sm::description(ssx::sformat("{}: named widgets", _name))),
      });
}
}
`
}

describeIfReady('overrides audit, metrics surface, from a checkout', () => {
  let repoDir
  let overridesPath

  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: repoDir, encoding: 'utf8' })
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  }
  const commit = (message) => {
    git('add', '.')
    git('-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message)
  }

  beforeAll(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overrides-audit-metrics-repo-'))
    for (const [file, content] of Object.entries(SOURCES)) {
      fs.mkdirSync(path.dirname(path.join(repoDir, file)), { recursive: true })
      fs.writeFileSync(path.join(repoDir, file), content)
    }
    git('init', '-q')
    commit('fixture')
    git('tag', 'v0.0.1')
    // HEAD moves on: the help string now says what the override says.
    fs.writeFileSync(path.join(repoDir, 'src/v/widget/probe.cc'),
      SOURCES['src/v/widget/probe.cc'].replace('Number of active widgets', 'Number of widgets that are serving requests'))
    commit('reword')
    overridesPath = path.join(repoDir, '..', `${path.basename(repoDir)}-overrides.json`)
    fs.writeFileSync(overridesPath, JSON.stringify({
      metrics: {
        redpanda_widget_active: { description: 'Number of widgets that are serving requests' },
        redpanda_widget_named: { description: 'Number of named widgets.' }
      }
    }))
  })

  afterAll(() => {
    fs.rmSync(repoDir, { recursive: true, force: true })
    fs.rmSync(overridesPath, { force: true })
  })

  const classes = (options) => Object.fromEntries(
    runAudit({ overrides: overridesPath, repo: repoDir, surface: 'metrics', ...options }).manifest.map((row) => [row.name, row]))

  test('--repo reads the checkout at HEAD', () => {
    const result = classes({})
    expect(result.redpanda_widget_active.class).toBe(CLASSES.REDUNDANT)
    expect(result.redpanda_widget_named.class).toBe(CLASSES.REVIEW)
    expect(result.redpanda_widget_named.note).toMatch(/built at run time/)
  })

  test('--ref reads another ref, with the file and line of the registration', () => {
    const row = classes({ ref: 'v0.0.1' }).redpanda_widget_active
    expect(row.class).toBe(CLASSES.UPSTREAMABLE)
    expect(row.source_file).toBe('src/v/widget/probe.cc')
    expect(row.source_line).toBe(8)
    expect(row.source_text).toBe('Number of active widgets')
  })

  test('a ref that does not exist is an error', () => {
    expect(() => classes({ ref: 'v9.9.9' })).toThrow(/extractor failed/)
  })
})

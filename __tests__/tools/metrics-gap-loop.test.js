'use strict'

/**
 * tools/metrics/gap_loop.py judges the loop in
 * .github/workflows/metrics-close-gaps.yml, where a model proposes changes to
 * the metrics cluster so that it exports more metrics. The model must never
 * judge its own work, so every rule lives in that script: the attempt cap,
 * what counts as a closed gap, which paths may change, and when a requirement
 * may say measured. Each rule here has a negative control.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const ROOT = path.join(__dirname, '..', '..')
const SCRIPT = path.join(ROOT, 'tools', 'metrics', 'gap_loop.py')
const WRAPPER = path.join(ROOT, 'tools', 'metrics', 'gap_loop_run.sh')
const BOOTSTRAP = 'docker-compose/metrics/bootstrap-extra.yml'
const OVERLAY = 'docker-compose/metrics/metrics.overlay.yml'
const REQUIREMENTS = 'docker-compose/metrics/requirements.json'
const EXPECTED_ABSENT = 'docker-compose/metrics/expected-absent.json'
const CLUSTER_SCRIPT = 'cli-utils/generate-cluster-docs.sh'
const TRACKED = [BOOTSTRAP, OVERLAY, REQUIREMENTS, EXPECTED_ABSENT, CLUSTER_SCRIPT, 'docker-compose/metrics/shadow-link.yaml']

function pythonBinary () {
  for (const candidate of ['python3', 'python']) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' })
    if (probe.status === 0) return candidate
  }
  return null
}

const PYTHON = pythonBinary()
const describeIfPython = PYTHON ? describe : describe.skip

const GAP_A = { name: 'redpanda_feature_a_total', endpoint: 'public', defined_in: 'src/v/feature/probe.cc' }
const GAP_B = { name: 'vectorized_feature_b_errors', endpoint: 'internal', defined_in: 'src/v/big/big_probe.cc' }
const STEADY = ['redpanda_cluster_brokers', 'redpanda_kafka_records_total']

const dataset = (exported, notExported = []) => ({
  redpanda_version: 'v0.0.1',
  metrics: Object.fromEntries([
    ...exported.map((name) => [name, { endpoint: name.startsWith('redpanda_') ? 'public' : 'internal', observed: true }]),
    ...notExported.map((name) => [name, { endpoint: name.startsWith('redpanda_') ? 'public' : 'internal', observed: false }])
  ])
})
const gapsFile = (gaps) => ({ count: gaps.length, not_scraped: gaps })

// A line long enough to count as copied source when it shows up in a change.
const SOURCE_LINE = '    return ss::make_ready_future<private_probe_state>(compute_private_state());'

describeIfPython('metrics gap loop', () => {
  let workDir
  let counter = 0

  const run = (args, options = {}) => {
    const result = spawnSync(PYTHON, ['-I', SCRIPT, ...args], { encoding: 'utf8', ...options })
    return { status: result.status, out: result.stdout, err: result.stderr }
  }
  const git = (repo, ...args) => {
    const result = spawnSync('git', ['-C', repo, '-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' })
    if (result.status !== 0) throw new Error(result.stderr)
    return result.stdout
  }
  const writeJson = (file, data) => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(data))
    return file
  }
  const read = (repo, file) => fs.readFileSync(path.join(repo, file), 'utf8')

  /** A scratch area with a git copy of the cluster setup files, a stand-in source tree and a baseline of two gaps. */
  const scene = () => {
    counter += 1
    const dir = path.join(workDir, `scene-${counter}`)
    const repo = path.join(dir, 'repo')
    for (const file of TRACKED) {
      fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true })
      fs.copyFileSync(path.join(ROOT, file), path.join(repo, file))
    }
    fs.writeFileSync(path.join(repo, 'README.md'), 'fixture\n')
    git(repo, 'init', '-q')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', 'fixture')

    const source = path.join(dir, 'source')
    const small = ['#include "feature/probe.h"', 'void probe::setup() {', '  if (!config::shard_local_cfg().feature_a_enabled()) { return; }', '  add_group("feature", { make_counter("a_total", [] { return 0; }) });', SOURCE_LINE, '}']
    const filler = Array.from({ length: 600 }, (_, i) => `int unrelated_helper_function_number_${i}(int value) { return value + ${i}; }`)
    const big = [...filler.slice(0, 300), 'void big_probe::setup() {', '  make_counter("b_errors", [] { return 0; });', '}', ...filler.slice(300)]
    fs.mkdirSync(path.join(source, 'src/v/feature'), { recursive: true })
    fs.mkdirSync(path.join(source, 'src/v/big'), { recursive: true })
    fs.writeFileSync(path.join(source, 'src/v/feature/probe.cc'), small.join('\n') + '\n')
    fs.writeFileSync(path.join(source, 'src/v/big/big_probe.cc'), big.join('\n') + '\n')
    fs.writeFileSync(path.join(source, 'src/v/feature/extra.h'), '// extra header\n' + 'x'.repeat(20000) + '\n')

    const state = path.join(dir, 'state')
    const start = {
      gaps: writeJson(path.join(dir, 'start-gaps.json'), gapsFile([GAP_A, GAP_B])),
      dataset: writeJson(path.join(dir, 'start-dataset.json'), dataset(STEADY, [GAP_A.name, GAP_B.name]))
    }
    const baseline = run(['baseline', '--state', state, '--gaps', start.gaps, '--dataset', start.dataset])
    if (baseline.status !== 0) throw new Error(baseline.err)

    let files = 0
    const outcome = (exported, stillGaps) => {
      files += 1
      const names = stillGaps.map((gap) => gap.name)
      return {
        gaps: writeJson(path.join(dir, `gaps-${files}.json`), gapsFile(stillGaps)),
        dataset: writeJson(path.join(dir, `dataset-${files}.json`), dataset(exported, names))
      }
    }
    const compare = (exported, stillGaps, extra = []) => {
      const files = outcome(exported, stillGaps)
      return run(['compare', '--state', state, '--gaps', files.gaps, '--dataset', files.dataset, ...extra])
    }
    const compareFile = (exported, stillGaps) => {
      const result = compare(exported, stillGaps, ['--json'])
      return writeJson(path.join(dir, `compare-${files}.json`), JSON.parse(result.out))
    }
    const attempt = (max = 4) => run(['attempt', '--state', state, '--max', String(max)])
    const apply = (response, extra = []) => {
      const file = path.join(dir, 'response.json')
      fs.writeFileSync(file, typeof response === 'string' ? response : JSON.stringify(response))
      return run(['apply', '--state', state, '--repo', repo, '--response', file, ...extra])
    }
    const context = () => {
      const out = path.join(dir, 'context.md')
      const result = run(['context', '--state', state, '--repo', repo, '--source', source, '--out', out])
      return { ...result, text: result.status === 0 ? fs.readFileSync(out, 'utf8') : '' }
    }
    const summary = (number) => JSON.parse(fs.readFileSync(path.join(state, 'attempts', String(number).padStart(2, '0'), 'summary.json'), 'utf8'))
    return { dir, repo, source, state, compare, compareFile, outcome, attempt, apply, context, summary }
  }

  const withProperty = (repo, line = 'feature_a_enabled: true') => `${read(repo, BOOTSTRAP)}# redpanda_feature_a_total\n${line}\n`
  const REQUIREMENT = { id: 'feature-a', metrics: ['redpanda_feature_a_*'], requires: [{ property: 'feature_a_enabled', value: true }] }

  beforeAll(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metrics-gap-loop-'))
  })

  afterAll(() => {
    fs.rmSync(workDir, { recursive: true, force: true })
  })

  describe('compare', () => {
    it('exits 0 and lists what closed when a gap closed and nothing was lost', () => {
      const s = scene()
      const result = s.compare([...STEADY, GAP_A.name], [GAP_B])
      expect(result.status).toBe(0)
      expect(result.out).toMatch(/Closed: 1\. Remaining: 1\. Lost: 0\./)
      expect(result.out).toMatch(/closed\s+redpanda_feature_a_total \(public\)/)
      expect(result.out).toMatch(/remaining\s+vectorized_feature_b_errors \(internal\)/)
    })

    it('exits 1 when nothing closed', () => {
      const s = scene()
      expect(s.compare(STEADY, [GAP_A, GAP_B]).status).toBe(1)
    })

    it('exits 3 and names the metric when one that was exported is gone', () => {
      const s = scene()
      const result = s.compare([STEADY[0], GAP_A.name], [GAP_B])
      expect(result.status).toBe(3)
      expect(result.out).toMatch(/lost\s+redpanda_kafka_records_total \(public\)/)
    })

    // A written reason or an override takes a metric off the list without
    // the cluster exporting it. That is not a closed gap.
    it('does not count a gap that left the list without being exported', () => {
      const s = scene()
      const files = s.outcome(STEADY, [])
      const result = run(['compare', '--state', s.state, '--gaps', files.gaps, '--dataset', files.dataset, '--json'])
      expect(result.status).toBe(1)
      expect(JSON.parse(result.out).closed).toEqual([])
      expect(JSON.parse(result.out).remaining.map((gap) => gap.listed)).toEqual([false, false])
    })

    it('limits the baseline to the metrics asked for', () => {
      const s = scene()
      const result = run(['baseline', '--state', s.state, '--only', `${GAP_B.name},redpanda_not_a_gap`,
        '--gaps', writeJson(path.join(s.dir, 'g.json'), gapsFile([GAP_A, GAP_B])),
        '--dataset', writeJson(path.join(s.dir, 'd.json'), dataset(STEADY, [GAP_A.name, GAP_B.name]))])
      expect(result.out).toMatch(/Baseline: 1 gaps to close/)
      expect(result.out).toMatch(/redpanda_not_a_gap is not a gap in this run/)
    })
  })

  describe('attempt cap', () => {
    it('counts attempts and refuses the one after the cap', () => {
      const s = scene()
      expect(s.attempt(2).out.trim()).toBe('1')
      expect(s.attempt(2).out.trim()).toBe('2')
      const third = s.attempt(2)
      expect(third.status).not.toBe(0)
      expect(third.err).toMatch(/cap of 2 attempts is reached/)
      expect(run(['status', '--state', s.state, '--max', '2']).out).toMatch(/^stop: The cap of 2 attempts is reached/)
      expect(run(['status', '--state', s.state, '--max', '3']).out.trim()).toBe('continue')
    })
  })

  describe('check-diff', () => {
    const allow = ['--allow', BOOTSTRAP, '--allow', OVERLAY, '--allow', REQUIREMENTS, '--allow', CLUSTER_SCRIPT, '--allow-new', 'docker-compose/metrics/*']
    const check = (repo, extra = allow) => run(['check-diff', '--repo', repo, '--base', 'HEAD', ...extra])

    it('passes for changes to the allowed files and a new file beside them', () => {
      const s = scene()
      fs.writeFileSync(path.join(s.repo, BOOTSTRAP), withProperty(s.repo))
      fs.writeFileSync(path.join(s.repo, 'docker-compose/metrics/new-mock.py'), 'print("mock")\n')
      const result = check(s.repo)
      expect(result.err).toBe('')
      expect(result.status).toBe(0)
    })

    it('fails for a change outside the allowed paths', () => {
      const s = scene()
      fs.writeFileSync(path.join(s.repo, 'README.md'), 'changed\n')
      const result = check(s.repo)
      expect(result.status).toBe(1)
      expect(result.err).toMatch(/README\.md changed and is outside the allowed paths/)
    })

    it('fails for a new file outside the allowed paths', () => {
      const s = scene()
      fs.writeFileSync(path.join(s.repo, 'tools-extra.py'), 'x = 1\n')
      expect(check(s.repo).err).toMatch(/tools-extra\.py changed and is outside the allowed paths/)
    })

    it('fails for an edit to expected-absent.json, even when a glob allows it', () => {
      const s = scene()
      const file = path.join(s.repo, EXPECTED_ABSENT)
      fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), 'redpanda_feature_a_*': 'No cluster exports this metric family at all' }))
      for (const extra of [allow, ['--allow', 'docker-compose/metrics/*'], ['--allow', '*']]) {
        const result = check(s.repo, extra)
        expect(result.status).toBe(1)
        expect(result.err).toMatch(/expected-absent\.json changed\. Only a person edits it/)
      }
    })

    it('fails for a change to a file that already exists beside the allowed ones', () => {
      const s = scene()
      fs.appendFileSync(path.join(s.repo, 'docker-compose/metrics/shadow-link.yaml'), '# changed\n')
      expect(check(s.repo).err).toMatch(/shadow-link\.yaml changed and is outside the allowed paths/)
    })

    it('fails for a change to the cluster script outside the action functions', () => {
      const s = scene()
      fs.writeFileSync(path.join(s.repo, CLUSTER_SCRIPT), read(s.repo, CLUSTER_SCRIPT).replace('METRICS_SETTLE_MAX:-300', 'METRICS_SETTLE_MAX:-900'))
      const result = check(s.repo)
      expect(result.status).toBe(1)
      expect(result.err).toMatch(/generate-cluster-docs\.sh changed outside the functions/)
    })
  })

  describe('apply', () => {
    const refused = (s, response, pattern, extra) => {
      s.attempt()
      const before = git(s.repo, 'status', '--porcelain')
      const result = s.apply(response, extra)
      expect(result.err).toMatch(pattern)
      expect(result.status).toBe(4)
      expect(git(s.repo, 'status', '--porcelain')).toBe(before)
      return result
    }

    it('applies a property, a requirement and a note, and records the diff', () => {
      const s = scene()
      s.attempt()
      const result = s.apply({
        edits: [{ path: BOOTSTRAP, content: withProperty(s.repo) }],
        requirements: [REQUIREMENT],
        notes: [{ metric: GAP_B.name, tried: 'Nothing yet.', saw: 'Not exported.' }],
        done: false
      })
      expect(result.err).toBe('')
      expect(result.status).toBe(0)
      expect(read(s.repo, BOOTSTRAP)).toMatch(/feature_a_enabled: true/)
      const diff = fs.readFileSync(path.join(s.state, 'attempts', '01', 'applied.diff'), 'utf8')
      expect(diff).toMatch(/\+feature_a_enabled: true/)
      expect(JSON.parse(fs.readFileSync(path.join(s.state, 'notes.json'), 'utf8')).notes[0].metric).toBe(GAP_B.name)
    })

    it('refuses a response that is not JSON, or has a key it does not know', () => {
      refused(scene(), 'not json', /cannot be read as JSON/)
      refused(scene(), { edits: [], verdict: 'all gaps closed' }, /key that is not allowed: verdict/)
      refused(scene(), { edits: 'none' }, /edits is not a list/)
      refused(scene(), { edits: [{ path: BOOTSTRAP }] }, /needs a path and a content/)
    })

    it('counts a refused response as an attempt and shows the reason in the next input', () => {
      const s = scene()
      refused(s, { edits: [{ path: 'README.md', content: 'x' }] }, /README\.md is outside what can be changed/)
      expect(s.summary(1).status).toBe('invalid')
      expect(s.attempt(1).status).not.toBe(0)
      expect(s.context().text).toMatch(/Why it was refused: the path README\.md is outside what can be changed/)
    })

    it.each([
      ['tools/metrics/metrics.py', /outside what can be changed/],
      ['../outside.txt', /not a plain path inside the repository/],
      ['/etc/passwd', /not a plain path inside the repository/],
      ['docker-compose/metrics/shadow-link.yaml', /outside what can be changed/],
      ['docker-compose/metrics/sub/dir.yml', /outside what can be changed/],
      [REQUIREMENTS, /changed through the requirements list/]
    ])('refuses an edit to %s', (file, pattern) => {
      refused(scene(), { edits: [{ path: file, content: 'x\n' }] }, pattern)
    })

    it('refuses an edit to expected-absent.json, by any path', () => {
      for (const file of [EXPECTED_ABSENT, 'docker-compose/metrics/../metrics/expected-absent.json', 'expected-absent.json']) {
        const s = scene()
        refused(s, { edits: [{ path: file, content: '{}' }] }, /expected-absent\.json is never editable/)
        expect(read(s.repo, EXPECTED_ABSENT)).toBe(fs.readFileSync(path.join(ROOT, EXPECTED_ABSENT), 'utf8'))
      }
    })

    it('writes source as the evidence, whatever the response says', () => {
      const s = scene()
      s.attempt()
      const result = s.apply({ requirements: [{ ...REQUIREMENT, evidence: 'measured' }] })
      expect(result.status).toBe(0)
      const added = JSON.parse(read(s.repo, REQUIREMENTS)).requirements.find((item) => item.id === 'feature-a')
      expect(added).toEqual({ ...REQUIREMENT, evidence: 'source' })
    })

    it('adds a requirement and leaves every other line of the file as it was', () => {
      const s = scene()
      const before = read(s.repo, REQUIREMENTS)
      s.attempt()
      s.apply({ requirements: [REQUIREMENT] })
      const removed = git(s.repo, 'diff', '--numstat').trim().split('\t')[1]
      // Lines are only added: git reads the new entry as an insertion.
      expect(removed).toBe('0')
      expect(JSON.parse(read(s.repo, REQUIREMENTS)).requirements.length).toBe(JSON.parse(before).requirements.length + 1)
    })

    it('refuses to replace a requirement that is marked measured', () => {
      refused(scene(), { requirements: [{ ...REQUIREMENT, id: 'health-monitor' }] }, /health-monitor is marked measured, so it cannot be replaced/)
    })

    it.each([
      [{ condition: 'a topic exists.' }, /not one sentence/],
      [{ condition: 'A topic exists' }, /not one sentence/],
      [{ condition: 'The property prop:feature_a_enabled is on.' }, /Write prop:<name>\[link=true\]/],
      [{ condition: 'The property prop:feature_a_enabled[] is on.' }, /Write prop:<name>\[link=true\]/],
      [{ note: 'x' }, /neither \{property, value\} nor \{condition\}/]
    ])('refuses the requirement item %j', (item, pattern) => {
      refused(scene(), { requirements: [{ ...REQUIREMENT, requires: [item] }] }, pattern)
    })

    it('accepts a condition that links a property', () => {
      const s = scene()
      s.attempt()
      expect(s.apply({ requirements: [{ ...REQUIREMENT, requires: [{ condition: 'A topic with prop:feature_a_enabled[link=true] set exists.' }] }] }).status).toBe(0)
    })

    it('replaces one function of the cluster script and leaves the rest byte for byte', () => {
      const s = scene()
      const before = read(s.repo, CLUSTER_SCRIPT)
      const body = '  local rpk_auth=(-X "user=$ADMIN_USER" -X "pass=$ADMIN_PASS")\n  docker exec redpanda-0 rpk topic create metrics-feature-a "${rpk_auth[@]}" || echo "Could not create the topic."\n'
      s.attempt()
      const result = s.apply({ edits: [{ path: CLUSTER_SCRIPT, function: 'run_metrics_actions', content: body }] })
      expect(result.err).toBe('')
      expect(result.status).toBe(0)
      const after = read(s.repo, CLUSTER_SCRIPT)
      const start = before.indexOf('run_metrics_actions() {\n') + 'run_metrics_actions() {\n'.length
      const end = before.indexOf('\n}\n', start) + 1
      expect(after).toBe(before.slice(0, start) + body + before.slice(end))
      expect(after.slice(0, start)).toBe(before.slice(0, start))
      expect(after.slice(start + body.length)).toBe(before.slice(end))
      expect(run(['check-diff', '--repo', s.repo, '--base', 'HEAD', '--allow', CLUSTER_SCRIPT]).status).toBe(0)
    })

    it('refuses a function it does not offer, a body that ends the function early, and a body that does not parse', () => {
      refused(scene(), { edits: [{ path: CLUSTER_SCRIPT, function: 'teardown', content: '  :\n' }] }, /only these functions can be replaced/)
      refused(scene(), { edits: [{ path: CLUSTER_SCRIPT, content: '#!/bin/bash\n' }] }, /only these functions can be replaced/)
      refused(scene(), { edits: [{ path: CLUSTER_SCRIPT, function: 'setup_quota_probe', content: '  :\n}\nrm -rf /tmp/x\nfoo() {\n  :\n' }] }, /would end the function early/)
      refused(scene(), { edits: [{ path: CLUSTER_SCRIPT, function: 'setup_quota_probe', content: '  if true; then\n' }] }, /no longer parses/)
    })

    it('refuses a response that repeats a line of the Redpanda source', () => {
      const s = scene()
      refused(s, { edits: [{ path: 'docker-compose/metrics/notes.txt', content: `copied:\n${SOURCE_LINE}\n` }] }, /repeats a line of the Redpanda source/, ['--source', s.source])
      expect(fs.existsSync(path.join(s.repo, 'docker-compose/metrics/notes.txt'))).toBe(false)
    })

    it('stops the loop without a run when the model is done and changed nothing', () => {
      const s = scene()
      s.attempt()
      expect(s.apply({ done: true, notes: [{ metric: GAP_A.name, tried: 'Everything.', saw: 'Nothing.' }] }).status).toBe(5)
      expect(run(['status', '--state', s.state, '--max', '4']).out).toMatch(/stop: The model said it has nothing more to try/)
    })
  })

  describe('record', () => {
    const applied = (s) => {
      s.attempt()
      const result = s.apply({ edits: [{ path: BOOTSTRAP, content: withProperty(s.repo) }, { path: 'docker-compose/metrics/new-mock.py', content: 'print("mock")\n' }], requirements: [REQUIREMENT] })
      expect(result.status).toBe(0)
      expect(git(s.repo, 'status', '--porcelain')).not.toBe('')
    }
    const record = (s, ...args) => run(['record', '--state', s.state, '--repo', s.repo, ...args])

    it('keeps a change that closed a gap and lost nothing', () => {
      const s = scene()
      applied(s)
      const result = record(s, '--compare', s.compareFile([...STEADY, GAP_A.name], [GAP_B]))
      expect(result.out).toMatch(/closed 1 gaps\. The change was kept/)
      expect(read(s.repo, BOOTSTRAP)).toMatch(/feature_a_enabled/)
      expect(s.summary(1)).toMatchObject({ status: 'kept', newly_closed: ['public:redpanda_feature_a_total'] })
      expect(run(['status', '--state', s.state, '--max', '4']).out.trim()).toBe('continue')
    })

    it('reverts a change that lost a metric, new file included, and says so in the next input', () => {
      const s = scene()
      applied(s)
      const result = record(s, '--compare', s.compareFile([STEADY[0], GAP_A.name], [GAP_B]))
      expect(result.out).toMatch(/a metric that was exported before is gone\. The change was reverted/)
      expect(git(s.repo, 'status', '--porcelain')).toBe('')
      expect(s.summary(1)).toMatchObject({ status: 'reverted', kept: false, lost: ['public:redpanda_kafka_records_total'] })
      const text = s.context().text
      expect(text).toMatch(/A metric that was exported before is gone, so the change was reverted/)
      expect(text).toMatch(/Lost: redpanda_kafka_records_total\./)
      expect(text).toMatch(/Open \(2\)/)
    })

    it('reverts a change that closed nothing', () => {
      const s = scene()
      applied(s)
      record(s, '--compare', s.compareFile(STEADY, [GAP_A, GAP_B]))
      expect(git(s.repo, 'status', '--porcelain')).toBe('')
      expect(s.summary(1).outcome).toMatch(/closed no gap, so it was reverted/)
    })

    it('reverts a change whose run failed and keeps the end of the output', () => {
      const s = scene()
      applied(s)
      const log = path.join(s.dir, 'run.log')
      fs.writeFileSync(log, Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n') + '\nredpanda-0 exited: unknown property feature_a_enabled\n')
      record(s, '--failed', '--log', log)
      expect(git(s.repo, 'status', '--porcelain')).toBe('')
      expect(s.summary(1).status).toBe('run_failed')
      const text = s.context().text
      expect(text).toMatch(/unknown property feature_a_enabled/)
      expect(text).not.toMatch(/^line 100$/m)
    })

    it('reverts a later change that reopens a gap an earlier one closed', () => {
      const s = scene()
      applied(s)
      record(s, '--compare', s.compareFile([...STEADY, GAP_A.name], [GAP_B]))
      s.attempt()
      s.apply({ edits: [{ path: OVERLAY, content: read(s.repo, OVERLAY) + '# second change\n' }] })
      record(s, '--compare', s.compareFile([...STEADY, GAP_B.name], [GAP_A]))
      expect(read(s.repo, OVERLAY)).not.toMatch(/second change/)
      expect(read(s.repo, BOOTSTRAP)).toMatch(/feature_a_enabled/)
      expect(s.summary(2)).toMatchObject({ status: 'reverted', reopened: ['public:redpanda_feature_a_total'] })
    })

    it('stops the loop when every gap is closed', () => {
      const s = scene()
      applied(s)
      record(s, '--compare', s.compareFile([...STEADY, GAP_A.name, GAP_B.name], []))
      expect(run(['status', '--state', s.state, '--max', '4']).out).toMatch(/stop: Every listed gap is closed/)
    })
  })

  describe('context', () => {
    it('shows a small source file whole and trims a large one to its registration', () => {
      const s = scene()
      const result = s.context()
      expect(result.status).toBe(0)
      expect(result.out).toMatch(/Context: \d+ bytes, about \d+ tokens/)
      expect(result.out).toMatch(/Trimmed: src\/v\/big\/big_probe\.cc trimmed\./)
      expect(result.text).toContain('make_counter("a_total"')
      expect(result.text).toContain('make_counter("b_errors"')
      expect(result.text).toMatch(/Trimmed to the registrations and the lines that look like guards\./)
      expect(result.text).toMatch(/\[\.\.\. lines 1 to \d+ left out \.\.\.\]/)
      const section = result.text.slice(result.text.indexOf('### src/v/big/big_probe.cc'), result.text.indexOf('### src/v/feature/probe.cc'))
      expect(Buffer.byteLength(section)).toBeLessThan(8000 + 500)
      expect(section).not.toContain('unrelated_helper_function_number_0(')
    })

    it('gives an extra source file only when asked, cut at its cap', () => {
      const s = scene()
      expect(s.context().text).not.toContain('extra header')
      s.attempt()
      s.apply({ need_files: ['src/v/feature/extra.h', 'src/v/feature/missing.h'] })
      const result = s.context()
      expect(result.text).toContain('extra header')
      expect(result.text).toMatch(/Cut at 8000 bytes\./)
      expect(result.text).toMatch(/No such file in the source checkout/)
      expect(result.out).toMatch(/src\/v\/feature\/extra\.h cut/)
    })

    it('refuses to read outside the source checkout', () => {
      const s = scene()
      s.attempt()
      expect(s.apply({ need_files: ['src/../../repo/README.md'] }).err).toMatch(/need_files takes paths under src\//)
      expect(s.apply({ need_files: ['/etc/passwd'] }).err).toMatch(/need_files takes paths under src\//)
    })

    it('shows the files the model can change and only the action functions of the script', () => {
      const s = scene()
      const { text } = s.context()
      expect(text).toContain('health_monitor_metrics_enabled: true')
      expect(text).toContain('"id": "health-monitor"')
      expect(text).toContain('rpk shadow create')
      expect(text).toContain('QUOTA_PROBE_READY=1')
      expect(text).not.toContain('CLUSTER_READY_TIMEOUT')
      expect(text).not.toContain('Seastar registers its cross-shard queue metrics disabled')
    })

    it('puts what changes least first: the contract, the source, the files, the gaps, then the history', () => {
      const s = scene()
      const first = s.context().text
      const order = ['## What you can change, and how to answer', '## Redpanda source that registers the open gaps', '## The files you can change, as they are now', '## Gaps', '## History']
      const positions = order.map((heading) => first.indexOf(heading))
      expect(positions.every((position) => position >= 0)).toBe(true)
      expect([...positions].sort((a, b) => a - b)).toEqual(positions)

      // An attempt that was reverted changes only the end of the input.
      s.attempt()
      s.apply({ edits: [{ path: BOOTSTRAP, content: withProperty(s.repo) }] })
      run(['record', '--state', s.state, '--repo', s.repo, '--compare', s.compareFile(STEADY, [GAP_A, GAP_B])])
      const second = s.context().text
      const stable = first.indexOf('## History')
      expect(second.slice(0, stable)).toBe(first.slice(0, stable))
      expect(second.slice(stable)).not.toBe(first.slice(stable))
    })

    it('keeps the history bounded: one line for each older attempt, the detail for the last', () => {
      const s = scene()
      for (const value of ['one', 'two', 'three']) {
        s.attempt(6)
        s.apply({ edits: [{ path: BOOTSTRAP, content: withProperty(s.repo, `feature_a_mode: ${value}`) }] })
        run(['record', '--state', s.state, '--repo', s.repo, '--compare', s.compareFile(STEADY, [GAP_A, GAP_B])])
      }
      const history = s.context().text.split('## History')[1]
      expect(history).toMatch(/^- Attempt 1: reverted\. Changed: bootstrap-extra\.yml\. .*$/m)
      expect(history).toMatch(/^- Attempt 2: reverted\./m)
      expect(history).toMatch(/### Attempt 3, the last one/)
      expect(history).toContain('+feature_a_mode: three')
      expect(history).not.toContain('feature_a_mode: one')
      expect(history).not.toContain('feature_a_mode: two')
      expect(history.match(/```diff/g)).toHaveLength(1)
    })

    it('cuts a long diff of the last attempt', () => {
      const s = scene()
      s.attempt()
      s.apply({ edits: [{ path: 'docker-compose/metrics/large.txt', content: Array.from({ length: 2000 }, (_, i) => `row ${i}`).join('\n') + '\n' }] })
      run(['record', '--state', s.state, '--repo', s.repo, '--compare', s.compareFile(STEADY, [GAP_A, GAP_B])])
      const history = s.context().text.split('## History')[1]
      expect(history).toMatch(/The change \(cut at 6000 bytes\):/)
      expect(Buffer.byteLength(history)).toBeLessThan(7000)
    })
  })

  describe('requirements evidence', () => {
    const withRequirement = (s, evidence, metrics = REQUIREMENT.metrics) => {
      const doc = JSON.parse(read(s.repo, REQUIREMENTS))
      doc.requirements.push({ ...REQUIREMENT, metrics, evidence })
      fs.writeFileSync(path.join(s.repo, REQUIREMENTS), JSON.stringify(doc, null, 2) + '\n')
    }
    const check = (s, compare) => run(['check-requirements', '--state', s.state, '--repo', s.repo, '--base', 'HEAD', '--compare', compare])

    it('passes when nothing changed, and for a new requirement that says source', () => {
      const s = scene()
      const compare = s.compareFile([...STEADY, GAP_A.name], [GAP_B])
      expect(check(s, compare).status).toBe(0)
      withRequirement(s, 'source')
      expect(check(s, compare).status).toBe(0)
    })

    it('passes for measured when one of its metrics is a gap the run closed', () => {
      const s = scene()
      withRequirement(s, 'measured')
      expect(check(s, s.compareFile([...STEADY, GAP_A.name], [GAP_B])).status).toBe(0)
    })

    it('fails for measured when the gap did not close', () => {
      const s = scene()
      withRequirement(s, 'measured')
      const result = check(s, s.compareFile([...STEADY, GAP_B.name], [GAP_A]))
      expect(result.status).toBe(1)
      expect(result.err).toMatch(/The requirement feature-a says measured, and none of its metrics is a gap this run closed/)
    })

    it('marks a requirement measured only when every metric it matches is a closed gap', () => {
      const s = scene()
      s.attempt()
      s.apply({ requirements: [REQUIREMENT, { ...REQUIREMENT, id: 'too-wide', metrics: ['redpanda_*'] }, { ...REQUIREMENT, id: 'feature-b', metrics: [GAP_B.name] }] })
      const before = read(s.repo, REQUIREMENTS)
      const files = s.outcome([...STEADY, GAP_A.name], [GAP_B])
      const compare = writeJson(path.join(s.dir, 'final-compare.json'), JSON.parse(run(['compare', '--state', s.state, '--gaps', files.gaps, '--dataset', files.dataset, '--json']).out))
      const result = run(['upgrade-evidence', '--repo', s.repo, '--base', 'HEAD', '--compare', compare, '--dataset', files.dataset])
      expect(result.out).toMatch(/Marked measured: feature-a\./)
      const evidence = Object.fromEntries(JSON.parse(read(s.repo, REQUIREMENTS)).requirements.map((item) => [item.id, item.evidence]))
      expect(evidence).toMatchObject({ 'feature-a': 'measured', 'too-wide': 'source', 'feature-b': 'source' })
      expect(read(s.repo, REQUIREMENTS)).toBe(before.replace('"id": "feature-a",\n      "metrics": ["redpanda_feature_a_*"],\n      "requires": [{ "property": "feature_a_enabled", "value": true }],\n      "evidence": "source"', '"id": "feature-a",\n      "metrics": ["redpanda_feature_a_*"],\n      "requires": [{ "property": "feature_a_enabled", "value": true }],\n      "evidence": "measured"'))
      expect(check(s, compare).status).toBe(0)
    })
  })

  describe('check-leak', () => {
    it('fails when a changed line is a line of the Redpanda source, and passes otherwise', () => {
      const s = scene()
      const leak = (extra = []) => run(['check-leak', '--repo', s.repo, '--base', 'HEAD', '--source', s.source, ...extra])
      fs.writeFileSync(path.join(s.repo, BOOTSTRAP), withProperty(s.repo))
      expect(leak().status).toBe(0)
      const body = path.join(s.dir, 'body.md')
      fs.writeFileSync(body, `- Tried: ${SOURCE_LINE.trim()}\n`)
      expect(leak(['--text', body]).status).toBe(0)
      fs.writeFileSync(body, `${SOURCE_LINE.trim()}\n`)
      expect(leak(['--text', body]).status).toBe(1)
      fs.writeFileSync(path.join(s.repo, 'docker-compose/metrics/copied.txt'), `${SOURCE_LINE}\n`)
      const result = leak()
      expect(result.status).toBe(1)
      expect(result.err).toMatch(/1 changed lines are also lines of the Redpanda source/)
    })
  })

  describe('report', () => {
    it('lists what closed, what is open with what was tried, and proposals as text only', () => {
      const s = scene()
      s.attempt()
      s.apply({
        notes: [{ metric: GAP_B.name, tried: 'Set a property.\nAsked @someone.', saw: 'Still not exported.' }],
        not_exportable: [{ metric: GAP_B.name, reason: 'It needs hardware a container does not have.', tried: 'Two properties.' }]
      })
      const result = run(['report', '--state', s.state, '--compare', s.compareFile([...STEADY, GAP_A.name], [GAP_B]),
        '--notes', path.join(s.state, 'notes.json'), '--run-url', 'https://github.com/example/repo/actions/runs/1'])
      expect(result.status).toBe(0)
      expect(result.out).toMatch(/made by an agent and verified by a cluster run in this workflow: https:\/\/github\.com\/example\/repo\/actions\/runs\/1/)
      expect(result.out).toMatch(/### Closed, verified by a cluster run \(1\)\n\n- `redpanda_feature_a_total` \(public\), registered in `src\/v\/feature\/probe\.cc`/)
      expect(result.out).toMatch(/### Still open \(1\)\n\n- `vectorized_feature_b_errors` \(internal\).*Tried: Set a property\. Asked @ someone\. Saw: Still not exported\./)
      expect(result.out).toMatch(/### Proposed as not exportable, for a person to decide \(1\)/)
      expect(result.out).toMatch(/could not edit `docker-compose\/metrics\/expected-absent\.json`, and this change does not touch it/)
      expect(result.out).toMatch(/- `vectorized_feature_b_errors`\. Reason: It needs hardware a container does not have\./)
      expect(git(s.repo, 'status', '--porcelain')).toBe('')
    })
  })

  // The wrapper is what the workflow calls for each attempt. A stand-in for
  // node writes the output a cluster run would, so no cluster is needed.
  describe('gap_loop_run.sh attempt', () => {
    const wrapper = (s, files, max = '4') => {
      const bin = path.join(s.dir, 'bin')
      fs.mkdirSync(bin, { recursive: true })
      fs.writeFileSync(path.join(bin, 'node'), [
        '#!/usr/bin/env bash',
        'while [ $# -gt 0 ]; do if [ "$1" = "--output-dir" ]; then out="$2"; fi; shift; done',
        '[ -n "${FAKE_FAIL:-}" ] && { echo "cluster did not start"; exit 1; }',
        'cp "$FAKE_GAPS" "$out/metrics-gaps.json"',
        'cp "$FAKE_DATASET" "$out/redpanda-metrics-v0.0.1.json"',
        'echo "generated"'
      ].join('\n') + '\n', { mode: 0o755 })
      const response = path.join(s.dir, 'model-response.json')
      fs.writeFileSync(response, JSON.stringify({ edits: [{ path: BOOTSTRAP, content: withProperty(s.repo) }], requirements: [REQUIREMENT] }))
      return spawnSync('bash', [WRAPPER, 'attempt', 'v0.0.1', s.source, s.state, max, response], {
        cwd: s.repo,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PYTHON, FAKE_GAPS: files.gaps || '', FAKE_DATASET: files.dataset || '', FAKE_FAIL: files.fail || '' }
      })
    }

    it('keeps a change whose run closed a gap', () => {
      const s = scene()
      const result = wrapper(s, s.outcome([...STEADY, GAP_A.name], [GAP_B]))
      expect(result.status).toBe(0)
      expect(result.stdout).toMatch(/Attempt 1: closed 1 gaps\. The change was kept/)
      expect(read(s.repo, BOOTSTRAP)).toMatch(/feature_a_enabled/)
    })

    it('reverts a change whose run lost a metric', () => {
      const s = scene()
      const result = wrapper(s, s.outcome([STEADY[0], GAP_A.name], [GAP_B]))
      expect(result.status).toBe(0)
      expect(result.stdout).toMatch(/The change was reverted/)
      expect(git(s.repo, 'status', '--porcelain')).toBe('')
      expect(s.summary(1).status).toBe('reverted')
    })

    it('reverts a change whose run failed', () => {
      const s = scene()
      const result = wrapper(s, { fail: '1' })
      expect(result.status).toBe(0)
      expect(git(s.repo, 'status', '--porcelain')).toBe('')
      expect(s.summary(1)).toMatchObject({ status: 'run_failed', tail: expect.stringContaining('cluster did not start') })
    })

    it('changes nothing and runs nothing once the cap is reached', () => {
      const s = scene()
      s.attempt(1)
      const result = wrapper(s, s.outcome([...STEADY, GAP_A.name], [GAP_B]), '1')
      expect(result.stderr).toMatch(/cap of 1 attempts is reached/)
      expect(result.stdout).not.toMatch(/generated/)
      expect(git(s.repo, 'status', '--porcelain')).toBe('')
    })
  })
})

'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync, spawnSync } = require('child_process')

const review = require('../../../tools/doc-strings-review')
const { lintStrings } = require('../../../tools/lint-strings')

const FIXTURE = path.join(__dirname, '../../../tools/lint-strings/fixtures/metrics/lint_probe.cc')
const REL = 'src/v/cluster/lint_probe.cc'
const BIN = path.join(__dirname, '../../../bin/doc-tools.js')

/**
 * A metrics repo whose PR rewords start_offset (line 19), linted the way the
 * workflow lints it, so every test builds from a real lint report and real
 * declaration keys.
 */
function prRepo ({ text = 'Offset of the first record in the partition', mergeAbove = 0 } = {}) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'build-review-'))
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe', encoding: 'utf8' })
  fs.mkdirSync(path.join(repo, path.dirname(REL)), { recursive: true })
  fs.copyFileSync(FIXTURE, path.join(repo, REL))
  git('init', '--quiet', '-b', 'main')
  git('config', 'user.email', 'test@example.invalid')
  git('config', 'user.name', 'test')
  git('add', '.')
  git('commit', '--quiet', '-m', 'base')
  const base = git('rev-parse', 'HEAD').trim()
  git('checkout', '--quiet', '-b', 'pr')
  const abs = path.join(repo, REL)
  fs.writeFileSync(abs, fs.readFileSync(abs, 'utf8').replace('sm::description("start offset")', `sm::description("${text}")`))
  git('commit', '--quiet', '-am', 'reword')
  const head = git('rev-parse', 'HEAD').trim()
  let lintBase = base
  if (mergeAbove) {
    // The base branch moves on after the PR branched: lines added above the
    // string shift it in the merge commit the lint runs on.
    // Built like refs/pull/N/merge: first parent the base, second the head.
    git('checkout', '--quiet', 'main')
    const lines = fs.readFileSync(abs, 'utf8').split('\n')
    lines.splice(1, 0, ...Array.from({ length: mergeAbove }, (_, i) => `// added on main ${i}`))
    fs.writeFileSync(abs, lines.join('\n'))
    git('commit', '--quiet', '-am', 'main moves')
    git('checkout', '--quiet', '--detach')
    git('merge', '--quiet', '--no-ff', '--no-edit', 'pr')
    lintBase = git('rev-parse', 'HEAD^1').trim()
  }
  const lint = lintStrings({ repo, diffBase: lintBase, surfaces: ['metrics'], log: () => {} })
  return { repo, base, head, lintBase, lint, git }
}

function build (fx, findings, extra = {}) {
  const isMerge = spawnSync('git', ['rev-parse', '--verify', '--quiet', 'HEAD^2'], { cwd: fx.repo }).status === 0
  return review.buildReview({
    findings,
    lint: fx.lint,
    hunks: review.hunksFromGit(fx.repo, fx.base, fx.head),
    readMerge: (p) => fs.readFileSync(path.join(fx.repo, p), 'utf8'),
    readHead: (p) => execFileSync('git', ['show', `${isMerge ? 'HEAD^2' : 'HEAD'}:${p}`], { cwd: fx.repo, encoding: 'utf8' }),
    headSha: fx.head,
    ...extra
  })
}

function lineOf (fx, needle) {
  const lines = fs.readFileSync(path.join(fx.repo, REL), 'utf8').split('\n')
  return lines.findIndex((l) => l.includes(needle)) + 1
}

let fx
afterEach(() => {
  if (fx) fs.rmSync(fx.repo, { recursive: true, force: true })
  fx = null
})

describe('build-review: what reaches the PR', () => {
  test('a wrong default on a changed line is exactly one inline comment, with a suggestion and its markers', () => {
    fx = prRepo()
    const [decl] = fx.lint.declarations
    const line = lineOf(fx, 'Offset of the first record')
    const out = build(fx, {
      checked: [decl.key],
      issues: [{ key: decl.key, path: REL, start_line: line, line, tier: 'wrong', rule: 'correctness', problem: 'The gauge reports the log start offset, not the first record.', replacement: '          sm::description("Log start offset of the partition"),' }]
    })
    expect(out.action).toBe('post')
    expect(out.review.comments).toHaveLength(1)
    const [c] = out.review.comments
    expect(c).toMatchObject({ path: REL, line, side: 'RIGHT' })
    expect(c.start_line).toBeUndefined()
    expect(c.body).toMatch(/```suggestion\n {10}sm::description\("Log start offset of the partition"\),\n```/)
    expect(c.body).toContain(`<!-- doc-strings-review:key=${decl.key} issue=correctness -->`)
    expect(out.review.commit_id).toBe(fx.head)
    expect(out.review.event).toBe('COMMENT')
    expect(out.review.body).toContain(`<!-- doc-strings-review:keys=${decl.key} -->`)
    expect(out.keys).toEqual([decl.key])
  })

  test('style-only issues post nothing, go to the job summary, and still close the key', () => {
    fx = prRepo()
    const [decl] = fx.lint.declarations
    const line = lineOf(fx, 'Offset of the first record')
    const out = build(fx, {
      checked: [decl.key],
      issues: [
        { key: decl.key, path: REL, start_line: line, line, tier: 'style', rule: 'latin-abbreviation', problem: 'Write "for example" instead of E.g.', replacement: null },
        { key: decl.key, path: REL, start_line: line, line, tier: 'style', rule: 'long-sentence', problem: 'Split this 31-word sentence.', replacement: null }
      ]
    })
    expect(out.review.comments).toHaveLength(0)
    expect(out.action).toBe('put')
    expect(out.keys).toEqual([decl.key])
    expect(out.summary).toMatch(/### Style findings \(not posted on the PR\)/)
    expect(out.summary).toMatch(/latin-abbreviation \(review\)/)
    expect(out.summary).toMatch(/long-sentence \(review\)/)
  })

  test('style_comments posts style issues inline', () => {
    fx = prRepo()
    const [decl] = fx.lint.declarations
    const line = lineOf(fx, 'Offset of the first record')
    const out = build(fx, {
      checked: [decl.key],
      issues: [{ key: decl.key, path: REL, start_line: line, line, tier: 'style', rule: 'long-sentence', problem: 'Split it.', replacement: null }]
    }, { styleComments: true })
    expect(out.review.comments).toHaveLength(1)
  })

  test('a lint rule\'s tier outranks the tier the model gave it', () => {
    fx = prRepo({ text: 'Offset of the first record.' })
    const [decl] = fx.lint.declarations
    const finding = fx.lint.findings.find((f) => f.key === decl.key)
    expect(finding.rules.map((r) => [r.id, r.tier])).toContainEqual(['trailing-period', 'style'])
    const line = lineOf(fx, 'Offset of the first record')
    const out = build(fx, {
      checked: [decl.key],
      issues: [{ key: decl.key, path: REL, start_line: line, line, tier: 'wrong', rule: 'trailing-period', problem: 'Drop the period.', replacement: null }]
    })
    expect(out.review.comments).toHaveLength(0)
    expect(out.summary).toMatch(/trailing-period/)
  })

  test('committable_suggestions false carries the rewrite in a text block only', () => {
    fx = prRepo()
    const [decl] = fx.lint.declarations
    const line = lineOf(fx, 'Offset of the first record')
    const out = build(fx, {
      issues: [{ key: decl.key, path: REL, start_line: line, line, tier: 'unclear', rule: 'prose', problem: 'Say which offset.', replacement: '          sm::description("Log start offset"),' }]
    }, { committable: false })
    expect(out.review.comments[0].body).toMatch(/```text\n/)
    expect(out.review.comments[0].body).not.toMatch(/```suggestion/)
  })

  test('an issue on a closed declaration is a late finding: never on the PR, always in the summary', () => {
    fx = prRepo()
    const [decl] = fx.lint.declarations
    const line = lineOf(fx, 'Offset of the first record')
    const out = build(fx, {
      issues: [{ key: decl.key, path: REL, start_line: line, line, tier: 'wrong', rule: 'correctness', problem: 'Now contradicts the code.', replacement: null }]
    }, { closedKeys: new Set([decl.key]) })
    expect(out.review.comments).toHaveLength(0)
    expect(out.summary).toMatch(/Late finding on `start_offset`/)
  })

  test('a key the lint never handed the review is dropped and reported', () => {
    fx = prRepo()
    const line = lineOf(fx, 'Offset of the first record')
    const out = build(fx, {
      issues: [{ key: '0123456789abcdef', path: REL, start_line: line, line, tier: 'wrong', rule: 'x', problem: 'p', replacement: null }]
    })
    expect(out.review.comments).toHaveLength(0)
    expect(out.summary).toMatch(/dropped: its key is not one this review was given/)
  })

  test('a string this change made wrong is one plain comment on the changed line, and its key is closed', () => {
    fx = prRepo()
    const [decl] = fx.lint.declarations
    const other = decl.context.find((c) => c.name === 'records_produced')
    const line = lineOf(fx, 'Offset of the first record')
    const out = build(fx, {
      issues: [{ key: other.key, path: REL, start_line: line, line, tier: 'wrong', rule: 'made-wrong', problem: '`records_produced` now contradicts this.', replacement: '          sm::description("x"),' }]
    })
    expect(out.review.comments).toHaveLength(1)
    expect(out.review.comments[0].body).not.toMatch(/```suggestion/)
    expect(out.keys).toEqual([decl.key, other.key].sort())
  })

  test('issues on overlapping lines are one comment that numbers each issue', () => {
    fx = prRepo()
    const [decl] = fx.lint.declarations
    const line = lineOf(fx, 'Offset of the first record')
    const out = build(fx, {
      issues: [
        { key: decl.key, path: REL, start_line: line, line, tier: 'wrong', rule: 'a', problem: 'First problem.', replacement: '          sm::description("Log start offset"),' },
        { key: decl.key, path: REL, start_line: line, line, tier: 'unclear', rule: 'b', problem: 'Second problem.', replacement: null }
      ]
    })
    expect(out.review.comments).toHaveLength(1)
    expect(out.review.comments[0].body).toMatch(/^1\. First problem\.\n2\. Second problem\./)
    expect((out.review.comments[0].body.match(/doc-strings-review:key=/g) || [])).toHaveLength(2)
  })

  test('more than ten comments: wrong first, the rest listed in the body and still closed', () => {
    const groups = Array.from({ length: 12 }, (_, i) => ({
      path: 'f.go', start: i * 10 + 1, end: i * 10 + 1,
      issues: [{ key: 'a'.repeat(16), index: i, tier: i === 11 ? 'wrong' : 'unclear', lint: false, rule: 'r', problem: `P${i}.`, start_line: i * 10 + 1, line: i * 10 + 1, replacement: null }]
    }))
    const merged = review.mergeOverlapping(groups.flatMap((g) => g.issues))
    expect(merged[0].issues[0].problem).toBe('P11.')
    const lines = Array.from({ length: 130 }, (_, i) => `l${i + 1}`).join('\n')
    const out = review.buildReview({
      findings: { issues: groups.map((g) => ({ ...g.issues[0], path: 'f.go' })) },
      lint: { declarations: [{ key: 'a'.repeat(16), name: 'x', file: 'f.go', line_start: 1, line_end: 130 }], findings: [] },
      hunks: new Map([['f.go', [[1, 130]]]]),
      readMerge: () => lines,
      readHead: () => lines
    })
    expect(out.review.comments).toHaveLength(10)
    expect(out.review.comments[0].body).toMatch(/^P11\./)
    expect(out.review.body).toMatch(/over the limit/)
    expect((out.review.body.match(/^- `f\.go:/gm) || [])).toHaveLength(2)
  })
})

describe('build-review: placement', () => {
  test('a span the base branch moved lands on the PR head line', () => {
    fx = prRepo({ mergeAbove: 3 })
    const [decl] = fx.lint.declarations
    const mergeLine = lineOf(fx, 'Offset of the first record')
    const headLine = execFileSync('git', ['show', `HEAD^2:${REL}`], { cwd: fx.repo, encoding: 'utf8' }).split('\n').findIndex((l) => l.includes('Offset of the first record')) + 1
    expect(mergeLine).toBe(headLine + 3)
    const out = build(fx, {
      issues: [{ key: decl.key, path: REL, start_line: mergeLine, line: mergeLine, tier: 'wrong', rule: 'c', problem: 'p', replacement: '          sm::description("Log start offset"),' }]
    })
    expect(out.review.comments).toHaveLength(1)
    expect(out.review.comments[0].line).toBe(headLine)
  })

  test('a span outside the PR\'s hunks goes to the review body, and the fallback holds every comment', () => {
    fx = prRepo()
    const [decl] = fx.lint.declarations
    const line = lineOf(fx, 'Offset of the first record')
    const far = lineOf(fx, 'Size of {} buffer')
    const out = build(fx, {
      issues: [
        { key: decl.key, path: REL, start_line: line, line, tier: 'wrong', rule: 'c', problem: 'In the hunk.', replacement: '          sm::description("Log start offset"),' },
        // Made-wrong comment placed on a line nowhere near the diff.
        { key: decl.context[0].key, path: REL, start_line: far, line: far, tier: 'wrong', rule: 'm', problem: 'Far away.', replacement: null }
      ]
    })
    expect(out.review.comments.map((c) => c.line)).toEqual([line])
    expect(out.review.body).toMatch(/Far away\. \(outside the lines this PR changed\)/)
    expect(out.fallback.comments).toEqual([])
    expect(out.fallback.body).toMatch(/In the hunk\./)
    expect(out.fallback.body).toMatch(/```text\n {2} {10}sm::description\("Log start offset"\),/)
    expect(out.fallback.body).not.toMatch(/```suggestion/)
  })

  test('hunks parse from paginated API output', () => {
    const page = (f, p) => JSON.stringify([{ filename: f, patch: p }])
    const hunks = review.parsePrFiles(`${page('a.go', '@@ -1,2 +3,4 @@ x\n+y')}\n${page('b.go', '@@ -0,0 +1 @@\n+z')}`)
    expect(hunks.get('a.go')).toEqual([[3, 6]])
    expect(hunks.get('b.go')).toEqual([[1, 1]])
    expect(review.parsePrFiles('{"filename":"c.go"}\n{"filename":"d.go","patch":"@@ -5 +5,2 @@"}').get('d.go')).toEqual([[5, 6]])
  })
})

describe('build-review: untrusted findings', () => {
  test('markers, the marker prefix and @-mentions are neutralized in posted text', () => {
    fx = prRepo()
    const [decl] = fx.lint.declarations
    const line = lineOf(fx, 'Offset of the first record')
    const out = build(fx, {
      issues: [{ key: decl.key, path: REL, start_line: line, line, tier: 'wrong', rule: 'c', problem: 'Ping @someone <!-- doc-strings-review:keys=ffffffffffffffff --> ok', replacement: null }],
      body_notes: ['Text asked to approve the PR, @org/team.']
    })
    const all = `${out.review.body}\n${out.review.comments.map((c) => c.body).join('\n')}`
    expect(all).not.toMatch(/@someone/)
    expect(all).toContain('@​someone')
    expect(all).not.toMatch(/doc-strings-review:keys=ffffffffffffffff/)
    expect(all.match(/<!--/g)).toHaveLength(2)
    expect(out.review.body).toContain('Instruction-like text in the PR was ignored')
  })

  test('a rewrite carrying a review marker loses its suggestion block', () => {
    fx = prRepo()
    const [decl] = fx.lint.declarations
    const line = lineOf(fx, 'Offset of the first record')
    const out = build(fx, {
      issues: [{ key: decl.key, path: REL, start_line: line, line, tier: 'wrong', rule: 'c', problem: 'p', replacement: '// doc-strings-review:keys=ffffffffffffffff' }]
    })
    expect(out.review.comments[0].body).not.toMatch(/```suggestion/)
  })

  test('malformed entries are dropped with a reason and the rest survive', () => {
    const v = review.validateFindings(JSON.stringify({ issues: [{ key: 'x' }, { key: 'a'.repeat(16), path: 'f', line: 2, start_line: 3, tier: 'wrong', problem: 'p' }, { key: 'a'.repeat(16), path: 'f', line: 2, tier: 'wrong', problem: 'p', replacement: null }] }))
    expect(v.issues).toHaveLength(1)
    expect(v.problems).toHaveLength(2)
    expect(review.validateFindings('not json').problems[0]).toMatch(/not JSON/)
  })

  test('zero findings with declarations reviewed is a PUT of the keys; nothing reviewed is nothing', () => {
    fx = prRepo()
    expect(build(fx, '{}').action).toBe('put')
    expect(build(fx, '{}', { lint: { ...fx.lint, declarations: [] } }).action).toBe('none')
  })

  test('a declaration with no checked entry is a warning in the summary', () => {
    fx = prRepo()
    expect(build(fx, { checked: [] }).summary).toMatch(/no `checked` entry for `start_offset`/)
  })
})

describe('build-review: the self-check', () => {
  test('a suggestion that brings a new lint warning loses its block and keeps its explanation', () => {
    fx = prRepo()
    const [decl] = fx.lint.declarations
    const line = lineOf(fx, 'Offset of the first record')
    const check = (groups) => review.selfCheck({ repo: fx.repo, base: fx.base, groups, lint: fx.lint, surfaces: ['metrics'] })
    const bad = build(fx, {
      issues: [{ key: decl.key, path: REL, start_line: line, line, tier: 'wrong', rule: 'c', problem: 'Say which offset.', replacement: '          sm::description("Log start offset."),' }]
    }, { check })
    expect(bad.review.comments).toHaveLength(1)
    expect(bad.review.comments[0].body).toMatch(/^Say which offset\./)
    expect(bad.review.comments[0].body).toContain('(no suggestion: the rewrite failed lint)')
    expect(bad.review.comments[0].body).not.toMatch(/```suggestion/)
    expect(bad.summary).toMatch(/self-check removed the suggestion .*trailing-period/)
    expect(bad.stats.self_check_stripped).toBe(1)

    const good = build(fx, {
      issues: [{ key: decl.key, path: REL, start_line: line, line, tier: 'wrong', rule: 'c', problem: 'Say which offset.', replacement: '          sm::description("Log start offset of the partition, the first record it still holds"),' }]
    }, { check })
    expect(good.review.comments[0].body).toMatch(/```suggestion/)
    expect(good.stats.self_check).toBe('ran')
    // The scratch worktree is gone and the checkout untouched.
    expect(execFileSync('git', ['worktree', 'list'], { cwd: fx.repo, encoding: 'utf8' }).trim().split('\n')).toHaveLength(1)
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: fx.repo, encoding: 'utf8' })).toBe('')
  })
})

describe('build-review: the CLI', () => {
  test('writes the four files and prints its decision', () => {
    fx = prRepo()
    const [decl] = fx.lint.declarations
    const line = lineOf(fx, 'Offset of the first record')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-review-cli-'))
    try {
      fs.writeFileSync(path.join(dir, 'lint.json'), JSON.stringify(fx.lint))
      fs.writeFileSync(path.join(dir, 'findings.json'), JSON.stringify({ checked: [decl.key], issues: [{ key: decl.key, path: REL, start_line: line, line, tier: 'wrong', rule: 'c', problem: 'p', replacement: null }] }))
      fs.writeFileSync(path.join(dir, 'closed.txt'), '')
      const out = execFileSync('node', [BIN, 'build-review', '--repo', fx.repo, '--findings', path.join(dir, 'findings.json'), '--lint', path.join(dir, 'lint.json'),
        '--closed', path.join(dir, 'closed.txt'), '--base', fx.base, '--head-sha', fx.head, '--out-dir', path.join(dir, 'out')], { encoding: 'utf8' })
      expect(JSON.parse(out)).toMatchObject({ action: 'post', comments: 1, keys: 1 })
      for (const f of ['review.json', 'review-fallback.json', 'keys.txt', 'summary.md']) expect(fs.existsSync(path.join(dir, 'out', f))).toBe(true)
      expect(fs.readFileSync(path.join(dir, 'out', 'keys.txt'), 'utf8')).toBe(`${decl.key}\n`)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

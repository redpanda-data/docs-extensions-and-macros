'use strict'

// Diff mode reports a finding only when the offending text is on a line the
// PR changed. Modelled on redpanda-data/connect#4860: a PR that reworded one
// line of oracledb_cdc's Description got a missing-inline-code finding for
// the untouched == Metadata list, and the review commented on lines the PR
// never changed.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { execSync } = require('child_process')

const { lintStrings } = require('../../../tools/lint-strings')
const { runRules } = require('../../../tools/lint-strings/engine')
const { wordLines, linesOfRange, filterIssue } = require('../../../tools/lint-strings/locate')
const { COMMON_RULES } = require('../../../tools/lint-strings/rules/common')

const FIXTURE = path.join(__dirname, '../../../tools/lint-strings/fixtures/connect-changed-lines/input.go')
const GO_MOD = path.join(__dirname, '../../../tools/lint-strings/fixtures/connect/repo/go.mod.txt')
const REL = path.join('internal', 'impl', 'oracledb', 'input.go')

const ONE_LINE = 'The input reads the redo log and emits one message per row change.'

/**
 * A temp git repo holding the fixture, with one commit on top that applies
 * `edit` to it. Returns the repo path.
 */
function repoWithEdit (edit) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-strings-lines-'))
  const git = (args) => execSync(`git ${args}`, { cwd: repo, stdio: 'pipe' })
  const target = path.join(repo, REL)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(FIXTURE, target)
  fs.copyFileSync(GO_MOD, path.join(repo, 'go.mod'))
  git('init --quiet')
  git('config user.email lint-strings-test@example.invalid')
  git('config user.name "lint-strings test"')
  git('add .')
  git('commit --quiet -m base')
  const content = fs.readFileSync(target, 'utf8')
  const edited = edit(content)
  expect(edited).not.toBe(content)
  fs.writeFileSync(target, edited)
  git('add .')
  git('commit --quiet -m edit')
  return repo
}

function lineOf (repo, needle) {
  const source = fs.readFileSync(path.join(repo, REL), 'utf8')
  const at = source.indexOf(needle)
  expect(at).toBeGreaterThan(-1)
  return source.slice(0, at).split('\n').length
}

const ruleIds = (result) => result.findings.flatMap((f) => f.rules.map((r) => r.id))

describe('diff mode keeps only findings on changed lines (connect#4860)', () => {
  const repos = []
  afterAll(() => {
    for (const repo of repos) fs.rmSync(repo, { recursive: true, force: true })
  })
  const make = (edit) => {
    const repo = repoWithEdit(edit)
    repos.push(repo)
    return repo
  }

  test('the full run still reports the bare Metadata list', () => {
    const repo = make((c) => c.replace(ONE_LINE, 'The input reads the online redo log and emits one message per row change.'))
    const full = lintStrings({ repo, surfaces: ['connect'], log: () => {} })
    const issue = full.findings.flatMap((f) => f.rules).find((r) => r.id === 'missing-inline-code')
    expect(issue.message).toContain('`database_schema`, `table_name`')
    // Full runs carry no resolved line: nothing changed to resolve against.
    expect(issue.line).toBeUndefined()
  })

  test('(a) offending text on an unchanged line of a changed description: no finding', () => {
    const repo = make((c) => c.replace(ONE_LINE, 'The input reads the online redo log and emits one message per row change.'))
    const result = lintStrings({ repo, diffBase: 'HEAD~1', log: () => {} })
    // The declaration is still in the diff, and still reviewed...
    expect(result.declarations.map((d) => d.name)).toContain('oracledb_cdc')
    // ...but the Metadata list the PR did not touch is not its finding.
    expect(ruleIds(result)).not.toContain('missing-inline-code')
    expect(result.findings).toHaveLength(0)
  })

  test('(b) offending text on a changed line: reported, naming only that token, with its line', () => {
    const changed = 'The input reads the redo log and sets table_owner on each message.'
    const repo = make((c) => c.replace(ONE_LINE, changed))
    const result = lintStrings({ repo, diffBase: 'HEAD~1', log: () => {} })
    const issues = result.findings.flatMap((f) => f.rules).filter((r) => r.id === 'missing-inline-code')
    expect(issues).toHaveLength(1)
    expect(issues[0].message).toContain('`table_owner`')
    // The untouched list stays out of the message, so a fix changes only
    // the line the PR wrote.
    expect(issues[0].message).not.toContain('database_schema')
    expect(issues[0].message).not.toContain('table_name')
    expect(issues[0].line).toBe(lineOf(repo, changed))
  })

  test('(b) a token in the untouched list is reported once the PR edits its line', () => {
    const repo = make((c) => c.replace('- table_name\n', '- table_name (the source table)\n'))
    const result = lintStrings({ repo, diffBase: 'HEAD~1', log: () => {} })
    const issue = result.findings.flatMap((f) => f.rules).find((r) => r.id === 'missing-inline-code')
    expect(issue.message).toContain('`table_name`')
    expect(issue.message).not.toContain('database_schema')
    expect(issue.line).toBe(lineOf(repo, '- table_name (the source table)'))
  })

  test('(c) a declaration-level rule on a changed declaration is still reported', () => {
    // Availability prose on an UNCHANGED line: connect-availability-prose
    // gives no offsets, so it is about the declaration as a whole and is
    // kept whenever the declaration changed, as before.
    const repo = repoWithEdit((c) => c.replace('== Metadata\n', 'This input requires cgo.\n\n== Metadata\n'))
    repos.push(repo)
    const target = path.join(repo, REL)
    fs.writeFileSync(target, fs.readFileSync(target, 'utf8').replace(ONE_LINE, 'The input reads the online redo log and emits one message per row change.'))
    execSync('git commit --quiet -am "reword one line"', { cwd: repo, stdio: 'pipe' })

    const result = lintStrings({ repo, diffBase: 'HEAD~1', log: () => {} })
    const issue = result.findings.flatMap((f) => f.rules).find((r) => r.id === 'connect-availability-prose')
    expect(issue).toBeDefined()
    expect(issue.line).toBeUndefined()
    expect(ruleIds(result)).not.toContain('missing-inline-code')
  })

  test('the summary counts only the findings that were kept', () => {
    const repo = make((c) => c.replace(ONE_LINE, 'The input reads the online redo log and emits one message per row change.'))
    const result = lintStrings({ repo, diffBase: 'HEAD~1', log: () => {} })
    expect(result.summary.warnings).toBe(0)
    expect(result.summary.flaggedDeclarations).toBe(0)
    expect(result.summary.byRule['missing-inline-code']).toBeUndefined()
  })
})

describe('locating string offsets on source lines', () => {
  // A clang-format-wrapped C++ literal: one string, three source lines.
  const decl = {
    file: 'x.cc',
    line_start: 10,
    line_end: 12,
    string: 'Partition committed offset, i.e. safely persisted on majority of replicas \u2014 or not.',
    declaration_text: [
      'sm::description(',
      '  "Partition committed offset, i.e. safely persisted on "',
      '  "majority of replicas \u2014 or not."),'
    ].join('\n')
  }

  test('words map to the line each literal sits on', () => {
    const words = wordLines(decl)
    const lineOfWord = (w) => words.find((x) => decl.string.slice(x.start, x.end) === w).line
    expect(lineOfWord('Partition')).toBe(11)
    expect(lineOfWord('persisted')).toBe(11)
    expect(lineOfWord('majority')).toBe(12)
  })

  test('a range with no word of its own takes the lines either side', () => {
    const words = wordLines(decl)
    const dash = decl.string.indexOf('\u2014')
    expect(linesOfRange(words, dash, 1)).toEqual([12])
  })

  test('the first word may follow any amount of call syntax', () => {
    const long = { ...decl, declaration_text: `${' '.repeat(500)}\n${decl.declaration_text}`, line_start: 9 }
    expect(wordLines(long)[0].line).toBe(11)
  })

  test('an issue with no offsets is kept, and one that cannot be placed is kept', () => {
    const none = filterIssue(decl, { message: 'm' }, new Set([12]), () => wordLines(decl))
    expect(none).toEqual({ keep: true, message: 'm' })
    const unplaced = filterIssue({ ...decl, declaration_text: null }, { message: 'm', at: [{ index: 0, length: 1 }] }, new Set([12]), () => null)
    expect(unplaced.keep).toBe(true)
  })

  test('runRules drops a located issue off the changed lines and keeps a declaration-level one', () => {
    const rules = COMMON_RULES.filter((r) => ['latin-abbreviation', 'em-dash', 'too-short'].includes(r.name))
    const onLine12 = runRules([decl], rules, { changedLines: new Map([['x.cc', new Set([12])]]) })
    expect(onLine12.findings[0].rules.map((r) => r.id)).toEqual(['em-dash'])
    expect(onLine12.findings[0].rules[0].line).toBe(12)

    const onLine11 = runRules([decl], rules, { changedLines: new Map([['x.cc', new Set([11])]]) })
    expect(onLine11.findings[0].rules.map((r) => r.id)).toEqual(['latin-abbreviation'])

    // Without changedLines (a full run) nothing is filtered and no line is added.
    const full = runRules([decl], rules)
    expect(full.findings[0].rules.map((r) => r.id)).toEqual(['em-dash', 'latin-abbreviation'])
    expect(full.findings[0].rules.every((r) => r.line === undefined)).toBe(true)

    const short = { ...decl, string: 'Tiny.', declaration_text: 'sm::description(\n  "Tiny.")', line_end: 11 }
    const kept = runRules([short], rules, { changedLines: new Map([['x.cc', new Set([10])]]) })
    expect(kept.findings[0].rules.map((r) => r.id)).toEqual(['too-short'])
  })

  test('a long sentence is placed on the lines it spans', () => {
    const sentence = 'This sentence keeps going well past the word limit because it chains one clause after another and another and another until a reader has to stop and read it twice to follow it.'
    const long = {
      file: 'y.go',
      line_start: 1,
      line_end: 4,
      string: `Short opener.\n\n${sentence.slice(0, 60)}\n${sentence.slice(61)}`,
      declaration_text: `Description(\`Short opener.\n\n${sentence.slice(0, 60)}\n${sentence.slice(61)}\`)`
    }
    const rules = COMMON_RULES.filter((r) => r.name === 'long-sentence')
    expect(runRules([long], rules, { changedLines: new Map([['y.go', new Set([1])]]) }).findings).toHaveLength(0)
    const onSecondLine = runRules([long], rules, { changedLines: new Map([['y.go', new Set([4])]]) })
    expect(onSecondLine.findings[0].rules[0].line).toBe(4)
  })
})

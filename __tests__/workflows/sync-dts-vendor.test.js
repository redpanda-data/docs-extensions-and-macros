'use strict'

// vendor/dts/ is a copy of files from the private docs-team-standards repo.
// These tests cover the three ways it could drift without anyone noticing:
//
// 1. The committed copy no longer matches its manifest (a hand edit, a partial
//    copy). The first test runs against the real vendor/dts/ on every PR.
// 2. The sync script copies the wrong set, or reports "in sync" when it is not.
//    Exercised against a real git repo shaped like docs-team-standards.
// 3. The PR script ships nothing, ships the wrong files, or treats a gh failure
//    as "nothing to do". Exercised with a real git remote and a stubbed gh.
//
// Every failure case has a negative control showing the same input, untampered,
// passes.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync, spawnSync } = require('child_process')

const repoRoot = path.join(__dirname, '..', '..')
const SCRIPT = path.join(repoRoot, '.github', 'scripts', 'sync-dts-vendor.js')
const PR_SCRIPT = path.join(repoRoot, '.github', 'scripts', 'sync-dts-vendor-pr.sh')
const WORKFLOW = path.join(repoRoot, '.github', 'workflows', 'sync-dts-vendor.yml')
const VENDOR = path.join(repoRoot, 'vendor', 'dts')
const { README_TEXT } = require(SCRIPT)

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_NOSYSTEM: '1', HOME: os.tmpdir(),
}
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } }).trim()

let tmp
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dts-vendor-')) })
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

function write (root, rel, text) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  fs.writeFileSync(path.join(root, rel), text)
}

// A git repo with the docs-team-standards layout, including files that must
// NOT be copied (skills, fixtures, a template README).
function makeSource ({ vale = true } = {}) {
  const src = path.join(tmp, 'dts')
  fs.mkdirSync(src)
  git(src, 'init', '-q', '-b', 'main')
  write(src, 'resources/templates/how-to-template.adoc', '= [Verb] [Task]\n:page-topic-type: how-to\n')
  write(src, 'resources/templates/concepts-template.adoc', '= About [Topic]\n:page-topic-type: concept\n')
  write(src, 'resources/templates/README.md', 'private notes\n')
  write(src, 'skills/review/SKILL.md', 'private skill\n')
  if (vale) {
    write(src, 'vale/.vale.ini', 'StylesPath = styles\n[*.adoc]\nBasedOnStyles = Redpanda\n')
    write(src, 'vale/styles/Redpanda/EmDash.yml', 'extends: existence\ntokens:\n  - " -- "\n')
    write(src, 'vale/fixtures/EmDash.adoc', 'fixture\n')
    write(src, 'vale/README.md', 'readme\n')
  }
  git(src, 'add', '-A')
  git(src, 'commit', '-q', '-m', 'init')
  return src
}

function run (args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })
  return { status: r.status, out: r.stdout + r.stderr }
}

describe('committed vendor/dts', () => {
  test('matches its manifest', () => {
    const r = run(['--verify', '--dest', VENDOR])
    expect(r.out).toContain('matches its manifest')
    expect(r.status).toBe(0)
  })

  test('ships in the npm package and is reachable through exports', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
    expect(pkg.files).toContain('vendor/dts')
    expect(pkg.exports['./vendor/dts/manifest.json']).toBe('./vendor/dts/manifest.json')
  })

  test('is marked generated for GitHub diffs', () => {
    expect(fs.readFileSync(path.join(repoRoot, '.gitattributes'), 'utf8')).toMatch(/^vendor\/dts\/\*\* linguist-generated=true$/m)
  })

  test('a PR that only changes vendor/ still runs this suite', () => {
    const wf = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'test.yaml'), 'utf8')
    expect(wf).toMatch(/tools:\n(?:\s+- '[^']+'\n)*\s+- 'vendor\/\*\*'/)
  })
})

describe('verify catches a tampered copy', () => {
  let dest
  beforeEach(() => {
    dest = path.join(tmp, 'copy')
    fs.cpSync(VENDOR, dest, { recursive: true })
  })

  test('negative control: an untouched copy verifies', () => {
    expect(run(['--verify', '--dest', dest]).status).toBe(0)
  })

  test('a hand edit', () => {
    const f = path.join(dest, 'templates', 'how-to-template.adoc')
    fs.appendFileSync(f, '\nextra\n')
    const r = run(['--verify', '--dest', dest])
    expect(r.status).toBe(1)
    expect(r.out).toContain('edited: templates/how-to-template.adoc')
  })

  test('a missing file', () => {
    fs.rmSync(path.join(dest, 'templates', 'how-to-template.adoc'))
    const r = run(['--verify', '--dest', dest])
    expect(r.status).toBe(1)
    expect(r.out).toContain('missing: templates/how-to-template.adoc')
  })

  test('an unlisted file', () => {
    write(dest, 'templates/new-template.adoc', 'x\n')
    const r = run(['--verify', '--dest', dest])
    expect(r.status).toBe(1)
    expect(r.out).toContain('unlisted: templates/new-template.adoc')
  })

  test('an edited README', () => {
    fs.appendFileSync(path.join(dest, 'README.adoc'), 'x\n')
    expect(run(['--verify', '--dest', dest]).status).toBe(1)
  })

  test('a broken manifest', () => {
    fs.writeFileSync(path.join(dest, 'manifest.json'), '{')
    const r = run(['--verify', '--dest', dest])
    expect(r.status).toBe(1)
    expect(r.out).toContain('not valid JSON')
  })

  test('README carries the generated-content marker', () => {
    expect(README_TEXT.split('\n')[0]).toMatch(/^\/\/ This content is autogenerated\. Do not edit manually\./)
  })
})

describe('sync from a docs-team-standards checkout', () => {
  test('copies exactly the templates and the Vale style, byte for byte', () => {
    const src = makeSource()
    const dest = path.join(tmp, 'out')
    expect(run(['--source', src, '--dest', dest]).status).toBe(0)

    const manifest = JSON.parse(fs.readFileSync(path.join(dest, 'manifest.json'), 'utf8'))
    expect(Object.keys(manifest.files).sort()).toEqual([
      'templates/concepts-template.adoc',
      'templates/how-to-template.adoc',
      'vale/.vale.ini',
      'vale/styles/Redpanda/EmDash.yml',
    ])
    for (const [rel, meta] of Object.entries(manifest.files)) {
      expect(fs.readFileSync(path.join(dest, rel))).toEqual(fs.readFileSync(path.join(src, meta.source)))
    }
    expect(manifest.source).toEqual({ repository: 'redpanda-data/docs-team-standards', commit: git(src, 'rev-parse', 'HEAD') })
    expect(fs.existsSync(path.join(dest, 'skills'))).toBe(false)
    expect(run(['--verify', '--dest', dest]).status).toBe(0)
  })

  test('--check reports drift after a source change, and nothing before it', () => {
    const src = makeSource()
    const dest = path.join(tmp, 'out')
    run(['--source', src, '--dest', dest])

    // Negative control: freshly synced is in sync.
    expect(run(['--source', src, '--dest', dest, '--check']).status).toBe(0)

    fs.appendFileSync(path.join(src, 'vale/styles/Redpanda/EmDash.yml'), 'level: error\n')
    git(src, 'commit', '-q', '-am', 'tighten')
    const r = run(['--source', src, '--dest', dest, '--check'])
    expect(r.status).toBe(1)
    expect(r.out).toContain('changed: vale/styles/Redpanda/EmDash.yml')
    expect(r.out).toContain('changed: manifest.json')
  })

  test('an unrelated source commit changes nothing', () => {
    const src = makeSource()
    const dest = path.join(tmp, 'out')
    run(['--source', src, '--dest', dest])
    write(src, 'skills/review/SKILL.md', 'changed\n')
    git(src, 'commit', '-q', '-am', 'unrelated')
    expect(run(['--source', src, '--dest', dest, '--check']).status).toBe(0)
  })

  test('a removed source file is removed from the copy', () => {
    const src = makeSource()
    const dest = path.join(tmp, 'out')
    run(['--source', src, '--dest', dest])
    git(src, 'rm', '-q', 'resources/templates/concepts-template.adoc')
    git(src, 'commit', '-q', '-m', 'drop')
    const r = run(['--source', src, '--dest', dest])
    expect(r.status).toBe(0)
    expect(r.out).toContain('removed: templates/concepts-template.adoc')
    expect(fs.existsSync(path.join(dest, 'templates/concepts-template.adoc'))).toBe(false)
  })

  test('a source without vale/ yields templates only', () => {
    const src = makeSource({ vale: false })
    const dest = path.join(tmp, 'out')
    expect(run(['--source', src, '--dest', dest]).status).toBe(0)
    expect(fs.existsSync(path.join(dest, 'vale'))).toBe(false)
  })

  test('fails closed when the templates are missing', () => {
    const src = makeSource()
    fs.rmSync(path.join(src, 'resources/templates'), { recursive: true })
    const r = run(['--source', src, '--dest', path.join(tmp, 'out')])
    expect(r.status).toBe(2)
    expect(r.out).toContain('resources/templates/ is missing')
  })

  test('fails closed on a vale/ with no .vale.ini', () => {
    const src = makeSource()
    fs.rmSync(path.join(src, 'vale/.vale.ini'))
    expect(run(['--source', src, '--dest', path.join(tmp, 'out')]).status).toBe(2)
  })

  test('refuses a symlink that would be copied', () => {
    const src = makeSource()
    fs.writeFileSync(path.join(tmp, 'secret'), 'outside the checkout\n')
    fs.symlinkSync(path.join(tmp, 'secret'), path.join(src, 'resources/templates/leak-template.adoc'))
    const r = run(['--source', src, '--dest', path.join(tmp, 'out')])
    expect(r.status).toBe(2)
    expect(r.out).toContain('not a regular file')
    expect(fs.existsSync(path.join(tmp, 'out'))).toBe(false)
  })

  test('fails closed on a source that is not a git checkout', () => {
    const src = makeSource()
    fs.rmSync(path.join(src, '.git'), { recursive: true })
    const r = run(['--source', src, '--dest', path.join(tmp, 'out')])
    expect(r.status).toBe(2)
  })
})

describe('sync-dts-vendor-pr.sh', () => {
  let work, remote, ghLog, stubDir

  // A clone of a bare remote, with vendor/dts/ committed on main, so pushes
  // are real and inspectable.
  beforeEach(() => {
    remote = path.join(tmp, 'remote.git')
    git(tmp, 'init', '-q', '--bare', '-b', 'main', remote)
    work = path.join(tmp, 'work')
    git(tmp, 'clone', '-q', remote, work)
    fs.cpSync(VENDOR, path.join(work, 'vendor', 'dts'), { recursive: true })
    write(work, 'package.json', '{}\n')
    git(work, 'add', '-A')
    git(work, 'commit', '-q', '-m', 'base')
    git(work, 'push', '-q', 'origin', 'HEAD:main')

    stubDir = path.join(tmp, 'stub')
    fs.mkdirSync(stubDir)
    ghLog = path.join(tmp, 'gh.log')
    fs.writeFileSync(ghLog, '')
    fs.writeFileSync(path.join(stubDir, 'gh'), [
      '#!/bin/sh',
      'printf "%s\\n" "$*" >> "$GH_LOG"',
      'case "$1 $2" in',
      '  "pr list") [ "$GH_LIST" = "error" ] && exit 1; printf "%s\\n" "${GH_LIST}" ;;',
      'esac',
      'exit 0',
    ].join('\n'), { mode: 0o755 })
  })

  function runPr (env = {}) {
    const r = spawnSync('bash', [PR_SCRIPT], {
      cwd: work,
      encoding: 'utf8',
      env: { ...process.env, ...GIT_ENV, PATH: `${stubDir}:${process.env.PATH}`, GH_LOG: ghLog, REPO: 'o/r', GH_LIST: '', ...env },
    })
    return { status: r.status, out: r.stdout + r.stderr, gh: fs.readFileSync(ghLog, 'utf8') }
  }

  const remoteBranch = () => spawnSync('git', ['-C', remote, 'rev-parse', '--verify', '-q', 'refs/heads/ci/sync-dts-vendor'], { encoding: 'utf8' })

  test('negative control: nothing changed, nothing pushed or opened', () => {
    const r = runPr()
    expect(r.status).toBe(0)
    expect(r.gh).not.toMatch(/pr (create|edit|close)/)
    expect(remoteBranch().status).not.toBe(0)
  })

  test('a changed copy is pushed and a PR opened with a releasing title', () => {
    fs.appendFileSync(path.join(work, 'vendor/dts/templates/how-to-template.adoc'), 'x\n')
    const r = runPr()
    expect(r.status).toBe(0)
    expect(remoteBranch().status).toBe(0)
    expect(r.gh).toMatch(/pr create --repo o\/r --base main --head ci\/sync-dts-vendor --title fix\(vendor\): /)
    const files = git(remote, 'diff', '--name-only', 'main', 'ci/sync-dts-vendor')
    expect(files).toBe('vendor/dts/templates/how-to-template.adoc')
  })

  test('an open PR is updated, not duplicated', () => {
    fs.appendFileSync(path.join(work, 'vendor/dts/templates/how-to-template.adoc'), 'x\n')
    const r = runPr({ GH_LIST: '42' })
    expect(r.status).toBe(0)
    expect(r.gh).toMatch(/pr edit 42/)
    expect(r.gh).not.toMatch(/pr create/)
  })

  test('an open PR is closed once main already matches', () => {
    const r = runPr({ GH_LIST: '42' })
    expect(r.status).toBe(0)
    expect(r.gh).toMatch(/pr close 42 --repo o\/r --delete-branch/)
  })

  test('a gh failure is not read as "no PR"', () => {
    fs.appendFileSync(path.join(work, 'vendor/dts/templates/how-to-template.adoc'), 'x\n')
    const r = runPr({ GH_LIST: 'error' })
    expect(r.status).toBe(2)
    expect(remoteBranch().status).not.toBe(0)
  })

  test('a change outside vendor/dts stops the run before anything is pushed', () => {
    fs.appendFileSync(path.join(work, 'vendor/dts/templates/how-to-template.adoc'), 'x\n')
    write(work, 'package.json', '{"version":"9.9.9"}\n')
    const r = runPr()
    expect(r.status).toBe(2)
    expect(r.out).toContain('outside vendor/dts/')
    expect(remoteBranch().status).not.toBe(0)
  })
})

describe('sync-dts-vendor.yml', () => {
  const wf = fs.readFileSync(WORKFLOW, 'utf8')

  test('holds the bot token only on main', () => {
    expect(wf).toMatch(/jobs:\n\s+sync:\n\s+if: github\.ref == 'refs\/heads\/main'/)
  })

  test('runs the two scripts from the checkout', () => {
    expect(wf).toContain('node .github/scripts/sync-dts-vendor.js --source "$RUNNER_TEMP/dts"')
    expect(wf).toContain('bash .github/scripts/sync-dts-vendor-pr.sh')
  })

  test('clones with history, so the manifest can name the source commit', () => {
    expect(wf).toContain('--filter=blob:none')
    expect(wf).not.toMatch(/--depth/)
  })

  test('keeps the token out of argv', () => {
    expect(wf).not.toMatch(/x-access-token:\$\{\{/)
    expect(wf).not.toMatch(/https:\/\/[^\s]*\$\{?ACTIONS_BOT_TOKEN/)
  })
})

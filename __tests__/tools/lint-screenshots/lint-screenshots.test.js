'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const {
  lintScreenshots,
  formatHuman,
  parseAltText,
  parseUnifiedDiff,
  resolveImage,
  imageWidth,
  DEFAULTS
} = require('../../../tools/lint-screenshots')

const BIN = path.join(__dirname, '..', '..', '..', 'bin', 'doc-tools.js')

/**
 * A byte buffer with a valid PNG signature + IHDR header for the given width,
 * padded to `bytes`. Only the header is parsed by the linter, so the rest can
 * be zeros - this is not a renderable PNG and does not need to be.
 */
function pngBytes ({ width = 800, height = 600, bytes = 4096 } = {}) {
  const buf = Buffer.alloc(Math.max(bytes, 33))
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0)
  buf.writeUInt32BE(13, 8)
  buf.write('IHDR', 12, 'ascii')
  buf.writeUInt32BE(width, 16)
  buf.writeUInt32BE(height, 20)
  return buf
}

function gifBytes ({ width = 640, height = 480, bytes = 2048 } = {}) {
  const buf = Buffer.alloc(Math.max(bytes, 13))
  buf.write('GIF89a', 0, 'ascii')
  buf.writeUInt16LE(width, 6)
  buf.writeUInt16LE(height, 8)
  return buf
}

/** Build a throwaway Antora-shaped repo: { 'modules/x/pages/a.adoc': 'text', 'modules/x/images/a.png': Buffer } */
function makeRepo (files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-screenshots-'))
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content)
  }
  return root
}

const rules = (result) => result.findings.map((f) => f.rule)
const byRule = (result, rule) => result.findings.filter((f) => f.rule === rule)

afterEach(() => {
  // mkdtemp dirs are tiny; leave cleanup to the OS on CI, remove locally.
})

describe('parseAltText', () => {
  test('plain alt text with trailing attributes is not a comma violation', () => {
    expect(parseAltText('Console overview, width=600, role=x')).toEqual({ altText: 'Console overview', hasUnquotedComma: false })
    expect(parseAltText('Console overview,600,400')).toEqual({ altText: 'Console overview', hasUnquotedComma: false })
  })
  test('a quoted named alt keeps its commas and is not a violation', () => {
    expect(parseAltText('alt="Three clusters, each with an operator"')).toEqual({ altText: 'Three clusters, each with an operator', hasUnquotedComma: false })
    expect(parseAltText("width=600,alt='A, B'")).toEqual({ altText: 'A, B', hasUnquotedComma: false })
    expect(parseAltText('Positional,alt="Named, wins"')).toEqual({ altText: 'Named, wins', hasUnquotedComma: false })
  })
  test('attribute-like text inside a quoted value is part of the value', () => {
    expect(parseAltText(`"A detailed diagram, alt='X'"`)).toEqual({ altText: "A detailed diagram, alt='X'", hasUnquotedComma: false })
    expect(parseAltText('alt="One, alt=two",width=600')).toEqual({ altText: 'One, alt=two', hasUnquotedComma: false })
  })
  test('an unquoted named alt wins over a quoted positional one', () => {
    expect(parseAltText('"A long positional description",alt=Short')).toEqual({ altText: 'Short', hasUnquotedComma: false })
  })
  test('an unclosed quote falls back to a plain comma split', () => {
    expect(parseAltText('"Unclosed, comma').hasUnquotedComma).toBe(true)
  })
  test('an unquoted named alt is read up to the next comma', () => {
    expect(parseAltText('alt=Console overview,width=600')).toEqual({ altText: 'Console overview', hasUnquotedComma: false })
    expect(parseAltText('alt=Topics, partitions, and offsets').hasUnquotedComma).toBe(true)
  })
  test('an unquoted comma inside prose is a violation, a quoted one is not', () => {
    expect(parseAltText('Topics, partitions, and offsets').hasUnquotedComma).toBe(true)
    expect(parseAltText('"Topics, partitions, and offsets",width=600')).toEqual({ altText: 'Topics, partitions, and offsets', hasUnquotedComma: false })
  })
  test('empty attrs yield empty alt text', () => {
    expect(parseAltText('').altText).toBe('')
    expect(parseAltText('  ').altText).toBe('')
  })
})

describe('resolveImage', () => {
  const modulesDir = '/repo/modules'
  const page = '/repo/modules/manage/pages/x.adoc'
  test('same-module and module-qualified targets resolve under images/', () => {
    expect(resolveImage('a.png', page, modulesDir)).toBe('/repo/modules/manage/images/a.png')
    expect(resolveImage('shared:a.png', page, modulesDir)).toBe('/repo/modules/shared/images/a.png')
    expect(resolveImage('ROOT:sub/a.png', page, modulesDir)).toBe('/repo/modules/ROOT/images/sub/a.png')
  })
  test('remote, attribute-based, and component-qualified targets are not checked locally', () => {
    expect(resolveImage('https://example.com/a.png', page, modulesDir)).toBeNull()
    expect(resolveImage('{imagesdir}/a.png', page, modulesDir)).toBeNull()
    expect(resolveImage('other-component:shared:a.png', page, modulesDir)).toBeNull()
  })
  test('a page outside modules/ cannot resolve a bare target', () => {
    expect(resolveImage('a.png', '/repo/README.adoc', modulesDir)).toBeNull()
  })
})

describe('imageWidth', () => {
  test('reads PNG and GIF headers and returns null for anything else', () => {
    const root = makeRepo({
      'a.png': pngBytes({ width: 1234 }),
      'a.gif': gifBytes({ width: 321 }),
      'a.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>'
    })
    expect(imageWidth(path.join(root, 'a.png'))).toBe(1234)
    expect(imageWidth(path.join(root, 'a.gif'))).toBe(321)
    expect(imageWidth(path.join(root, 'a.svg'))).toBeNull()
    expect(imageWidth(path.join(root, 'missing.png'))).toBeNull()
  })
})

describe('lintScreenshots - the rules the cloud-docs script enforced (errors)', () => {
  test('a clean repo has no findings and counts what it scanned', () => {
    const root = makeRepo({
      'modules/manage/pages/a.adoc': '= A\n\nimage::ok.png[The Console overview showing cluster health]\n',
      'modules/manage/images/ok.png': pngBytes()
    })
    const result = lintScreenshots({ root })
    expect(result.findings).toEqual([])
    expect(result.scope).toBe('repo')
    expect(result.summary).toEqual({ adoc_files_scanned: 1, adoc_files_linted: 1, references: 1, images: 1, errors: 0, warnings: 0 })
  })

  test('missing alt, long alt, banned prefix, unquoted comma, missing file, oversized file', () => {
    const root = makeRepo({
      'modules/manage/pages/a.adoc': [
        '= A',
        'image::ok.png[]',
        `image::ok.png[${'x'.repeat(126)}]`,
        'image::ok.png[Screenshot of the console]',
        'image::ok.png[Image of the console]',
        'image::ok.png[Topics, partitions, and offsets]',
        'image::nope.png[A missing image]',
        'image::big.png[A big image]',
        ''
      ].join('\n'),
      'modules/manage/images/ok.png': pngBytes(),
      'modules/manage/images/big.png': pngBytes({ bytes: DEFAULTS.maxBytes + 1 })
    })
    const result = lintScreenshots({ root })
    expect(rules(result).sort()).toEqual([
      'alt-banned-prefix', 'alt-banned-prefix', 'alt-missing', 'alt-too-long', 'alt-unquoted-comma', 'image-missing', 'image-too-large'
    ])
    expect(result.findings.every((f) => f.severity === 'error')).toBe(true)
    expect(byRule(result, 'alt-missing')[0]).toMatchObject({ file: 'modules/manage/pages/a.adoc', line: 2, image: 'ok.png' })
    expect(byRule(result, 'image-missing')[0].message).toContain('modules/manage/images/nope.png')
    // cloud-docs' PR workflow greps this exact phrase to decide whether to
    // post the fix-oversized-image instructions - keep it stable.
    expect(byRule(result, 'image-too-large')[0].message).toMatch(/over the 100KB ceiling/)
    expect(result.summary.errors).toBe(7)
  })

  test('module-qualified references resolve across modules', () => {
    const root = makeRepo({
      'modules/get-started/pages/a.adoc': 'image::shared:arch.png[BYOC architecture]\nimage::shared:gone.png[Missing]\n',
      'modules/shared/images/arch.png': pngBytes()
    })
    const result = lintScreenshots({ root })
    expect(rules(result)).toEqual(['image-missing'])
  })

  test('remote and attribute-based targets still get alt-text checks but no file checks', () => {
    const root = makeRepo({
      'modules/m/pages/a.adoc': 'image::https://example.com/a.png[]\nimage::{imagesdir}/b.png[Fine alt text]\n'
    })
    const result = lintScreenshots({ root })
    expect(rules(result)).toEqual(['alt-missing'])
  })
})

describe('lintScreenshots - additions over the cloud-docs script', () => {
  test('inline image macros are linted too; word-prefixed and block forms are not double-counted', () => {
    const root = makeRepo({
      'modules/m/pages/a.adoc': 'Click image:icon.png[] to open. See myimage:notamacro[x]. image::icon.png[The gear icon]\n',
      'modules/m/images/icon.png': pngBytes()
    })
    const result = lintScreenshots({ root })
    expect(result.summary.references).toBe(2)
    expect(rules(result)).toEqual(['alt-missing'])
  })

  test('commented-out macros are skipped (line comments and comment blocks)', () => {
    const root = makeRepo({
      'modules/m/pages/a.adoc': '// image::old.png[]\n////\nimage::older.png[]\n////\nimage::ok.png[Fine]\n',
      'modules/m/images/ok.png': pngBytes()
    })
    expect(lintScreenshots({ root }).findings).toEqual([])
  })

  test('stricter standard items are warnings, not errors', () => {
    const root = makeRepo({
      'modules/m/pages/a.adoc': [
        'image::mid.png[Above target]',
        'image::wide.png[Too wide]',
        'image::photo.jpg[A JPEG]',
        'image::anim.gif[A wide GIF]',
        ''
      ].join('\n'),
      'modules/m/images/mid.png': pngBytes({ bytes: DEFAULTS.targetBytes + 1 }),
      'modules/m/images/wide.png': pngBytes({ width: DEFAULTS.maxWidth + 1 }),
      'modules/m/images/photo.jpg': Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]),
      'modules/m/images/anim.gif': gifBytes({ width: 2000 })
    })
    const result = lintScreenshots({ root })
    expect(rules(result).sort()).toEqual(['image-above-target', 'image-format', 'image-too-wide', 'image-too-wide'])
    expect(result.findings.every((f) => f.severity === 'warning')).toBe(true)
    expect(result.summary).toMatchObject({ errors: 0, warnings: 4 })
  })

  test('image-file findings are reported once per image, alt findings once per reference', () => {
    const root = makeRepo({
      'modules/m/pages/a.adoc': 'image::big.png[]\n',
      'modules/m/pages/b.adoc': 'image::big.png[]\n',
      'modules/m/images/big.png': pngBytes({ bytes: DEFAULTS.maxBytes + 1 })
    })
    const result = lintScreenshots({ root })
    expect(byRule(result, 'alt-missing')).toHaveLength(2)
    expect(byRule(result, 'image-too-large')).toHaveLength(1)
  })

  test('thresholds are configurable', () => {
    const root = makeRepo({
      'modules/m/pages/a.adoc': 'image::a.png[A fairly long alt text here]\n',
      'modules/m/images/a.png': pngBytes({ bytes: 3000, width: 800 })
    })
    const result = lintScreenshots({ root, maxAltLength: 10, maxBytes: 2000, maxWidth: 700 })
    expect(rules(result).sort()).toEqual(['alt-too-long', 'image-too-large', 'image-too-wide'])
  })

  test('throws when root has no modules/ directory', () => {
    const root = makeRepo({ 'README.adoc': 'nothing here' })
    expect(() => lintScreenshots({ root })).toThrow(/modules/)
  })
})

describe('lintScreenshots - changed-files scope (--files)', () => {
  function repo () {
    return makeRepo({
      'modules/m/pages/changed.adoc': 'image::a.png[]\n',
      'modules/m/pages/untouched.adoc': 'image::b.png[]\nimage::shared.png[Shared alt]\n',
      'modules/m/pages/uses-changed-image.adoc': 'image::shared.png[]\n',
      'modules/m/images/a.png': pngBytes(),
      'modules/m/images/b.png': pngBytes(),
      'modules/m/images/shared.png': pngBytes(),
      'modules/m/images/orphan.png': pngBytes()
    })
  }

  test('lints changed pages and pages that reference a changed image, not the rest', () => {
    const root = repo()
    const result = lintScreenshots({
      root,
      files: ['modules/m/pages/changed.adoc', 'modules/m/images/shared.png', 'modules/m/images/deleted.png']
    })
    expect(result.scope).toBe('changed')
    const files = result.findings.map((f) => f.file).sort()
    // changed.adoc (alt-missing), uses-changed-image.adoc (alt-missing) and
    // untouched.adoc's shared.png reference (fine) - never untouched.adoc's b.png.
    expect(files).toEqual(['modules/m/pages/changed.adoc', 'modules/m/pages/uses-changed-image.adoc'])
    expect(result.summary.adoc_files_scanned).toBe(3)
    expect(result.summary.adoc_files_linted).toBe(3)
    expect(result.summary.references).toBe(3)
  })

  test('a changed image nothing references is a warning', () => {
    const root = repo()
    const result = lintScreenshots({ root, files: ['modules/m/images/orphan.png'] })
    expect(result.findings).toEqual([expect.objectContaining({
      rule: 'orphaned-image', severity: 'warning', file: 'modules/m/images/orphan.png', line: null
    })])
  })

  test('an empty list lints nothing and passes', () => {
    const root = repo()
    const result = lintScreenshots({ root, files: [] })
    expect(result.findings).toEqual([])
    expect(result.summary.references).toBe(0)
  })

  test('a deleted image a page still references is reported, not silently skipped', () => {
    // Regression: skipping changed paths that no longer exist dropped the
    // referencing pages out of the scoped pass, so deleting a screenshot that
    // a page still uses reported nothing here while a whole-repo run
    // reported image-missing.
    const root = makeRepo({
      'modules/m/pages/page.adoc': 'image::gone.png[Some alt text]\n'
    })
    const result = lintScreenshots({ root, files: ['modules/m/images/gone.png'] })
    expect(result.findings).toEqual([expect.objectContaining({
      rule: 'image-missing', severity: 'error', file: 'modules/m/pages/page.adoc'
    })])
    expect(result.summary.references).toBe(1)
  })

  test('a deleted image nothing references is not reported as orphaned', () => {
    const root = repo()
    const result = lintScreenshots({ root, files: ['modules/m/images/never-existed.png'] })
    expect(result.findings).toEqual([])
  })
})

describe('lintScreenshots - threshold defaults', () => {
  function oversizeRepo () {
    return makeRepo({
      'modules/m/pages/page.adoc': 'image::big.png[Some alt text]\n',
      'modules/m/images/big.png': Buffer.concat([pngBytes(), Buffer.alloc(200 * 1024)])
    })
  }

  test('an omitted threshold falls back to the default instead of erasing it', () => {
    // Regression: an explicit undefined wins a spread, and intOption() returns
    // undefined for an option nobody passed, so `{ ...DEFAULTS, ...options }`
    // turned every `size > undefined` comparison into false and the size rules
    // disappeared without a word.
    const root = oversizeRepo()
    const omitted = lintScreenshots({ root, maxBytes: undefined, targetBytes: undefined, maxWidth: undefined, maxAltLength: undefined })
    const explicit = lintScreenshots({ root })
    expect(omitted.findings.map((f) => f.rule)).toEqual(explicit.findings.map((f) => f.rule))
    expect(omitted.findings.some((f) => f.rule === 'image-too-large')).toBe(true)
  })

  test('an explicitly passed threshold still overrides the default', () => {
    const root = oversizeRepo()
    const result = lintScreenshots({ root, maxBytes: 10 * 1024 * 1024, targetBytes: 10 * 1024 * 1024 })
    expect(result.findings.some((f) => f.rule === 'image-too-large')).toBe(false)
  })
})

describe('formatHuman', () => {
  test('clean and dirty output shapes', () => {
    const root = makeRepo({
      'modules/m/pages/a.adoc': 'image::big.png[]\nimage::mid.png[Fine]\n',
      'modules/m/images/big.png': pngBytes({ bytes: DEFAULTS.maxBytes + 1 }),
      'modules/m/images/mid.png': pngBytes({ bytes: DEFAULTS.targetBytes + 1 })
    })
    const text = formatHuman(lintScreenshots({ root }))
    expect(text).toMatch(/Found 2 error\(s\), 1 warning\(s\)/)
    expect(text).toMatch(/Errors:\n {2}modules\/m\/pages\/a\.adoc:1 \[big\.png\] Missing alt text/)
    expect(text).toMatch(/Warnings \(not blocking\):/)

    const clean = makeRepo({ 'modules/m/pages/a.adoc': '= Nothing\n' })
    expect(formatHuman(lintScreenshots({ root: clean }))).toMatch(/No screenshot standard violations found/)
  })
})

describe('doc-tools lint-screenshots (CLI)', () => {
  jest.setTimeout(30000)

  function run (args, cwd) {
    const r = spawnSync('node', [BIN, 'lint-screenshots', ...args], { cwd, encoding: 'utf8' })
    return { code: r.status, stdout: r.stdout, stderr: r.stderr }
  }

  test('exit 0 on a clean repo, 1 on errors, 0 on warnings unless --warnings-as-errors, 2 on usage error', () => {
    const clean = makeRepo({
      'modules/m/pages/a.adoc': 'image::a.png[Fine]\n',
      'modules/m/images/a.png': pngBytes()
    })
    expect(run(['--root', clean], clean).code).toBe(0)

    const dirty = makeRepo({ 'modules/m/pages/a.adoc': 'image::a.png[]\n', 'modules/m/images/a.png': pngBytes() })
    const d = run(['--format', 'json'], dirty)
    expect(d.code).toBe(1)
    expect(JSON.parse(d.stdout).summary.errors).toBe(1)

    const warn = makeRepo({
      'modules/m/pages/a.adoc': 'image::a.jpg[A JPEG]\n',
      'modules/m/images/a.jpg': Buffer.from([0xff, 0xd8, 0xff])
    })
    expect(run([], warn).code).toBe(0)
    expect(run(['--warnings-as-errors'], warn).code).toBe(1)

    const notARepo = makeRepo({ 'x.txt': '' })
    const bad = run([], notARepo)
    expect(bad.code).toBe(2)
    expect(bad.stderr).toMatch(/modules/)
  })

  test('--files scopes the run and --output writes the JSON result', () => {
    const root = makeRepo({
      'modules/m/pages/a.adoc': 'image::a.png[]\n',
      'modules/m/pages/b.adoc': 'image::b.png[]\n',
      'modules/m/images/a.png': pngBytes(),
      'modules/m/images/b.png': pngBytes(),
      'changed.txt': 'modules/m/pages/a.adoc\n'
    })
    const out = path.join(root, 'review-output', 'screenshot-lint.json')
    const r = run(['--files', 'changed.txt', '--output', out], root)
    expect(r.code).toBe(1)
    const json = JSON.parse(fs.readFileSync(out, 'utf8'))
    expect(json.scope).toBe('changed')
    expect(json.findings).toHaveLength(1)
    expect(json.findings[0].file).toBe('modules/m/pages/a.adoc')
    expect(r.stdout).toMatch(/1 changed \.adoc file\(s\)/)
  })

  test('--help lists the flags the PR review pipeline passes', () => {
    const r = spawnSync('node', [BIN, 'lint-screenshots', '--help'], { encoding: 'utf8' })
    for (const flag of ['--root', '--files', '--format', '--output', '--warnings-as-errors']) {
      expect(r.stdout).toContain(flag)
    }
  })
})

describe('parseUnifiedDiff', () => {
  test('maps each file to the new-side lines it adds or changes', () => {
    const diff = [
      'diff --git a/modules/m/pages/a.adoc b/modules/m/pages/a.adoc',
      '--- a/modules/m/pages/a.adoc',
      '+++ b/modules/m/pages/a.adoc',
      '@@ -1,3 +1,3 @@',
      ' = Title',
      '-:page-categories: Old',
      '+:page-categories: New',
      ' text',
      '@@ -10,0 +11,2 @@',
      '+image::new.png[]',
      '+more',
      'diff --git a/modules/m/images/new.png b/modules/m/images/new.png',
      'Binary files differ',
      'diff --git a/modules/m/pages/gone.adoc b/modules/m/pages/gone.adoc',
      '--- a/modules/m/pages/gone.adoc',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-bye'
    ].join('\n')
    const changed = parseUnifiedDiff(diff)
    expect([...changed.get('modules/m/pages/a.adoc')]).toEqual([2, 11, 12])
    expect(changed.get('modules/m/images/new.png')).toBe('all')
    expect(changed.get('modules/m/pages/gone.adoc')).toBe('removed')
  })

  test('marks the old path of a rename as removed', () => {
    const changed = parseUnifiedDiff('diff --git a/modules/m/images/old.png b/modules/m/images/new.png\nsimilarity index 100%\nrename from modules/m/images/old.png\nrename to modules/m/images/new.png\n')
    expect(changed.get('modules/m/images/old.png')).toBe('removed')
    expect(changed.get('modules/m/images/new.png')).toBe('all')
  })
})

describe('lintScreenshots - diff scope (--diff, --diff-file)', () => {
  function repo () {
    return makeRepo({
      'modules/m/pages/p.adoc': ':page-categories: New\nimage::old.png[]\nimage::big.png[Big]\nimage::added.png[]\n',
      'modules/m/images/old.png': pngBytes(),
      'modules/m/images/big.png': pngBytes({ bytes: 200 * 1024 }),
      'modules/m/images/added.png': pngBytes()
    })
  }
  const lines = (map) => new Map(Object.entries(map).map(([k, v]) => [k, v === 'all' ? 'all' : new Set(v)]))

  test('an error on a line the PR did not touch is a warning marked preexisting', () => {
    const root = repo()
    const result = lintScreenshots({ root, changedLines: lines({ 'modules/m/pages/p.adoc': [1] }) })
    expect(result.summary.errors).toBe(0)
    const old = byRule(result, 'alt-missing').find((f) => f.line === 2)
    expect(old).toMatchObject({ severity: 'warning', preexisting: true })
    expect(old.message).toMatch(/^Already on the base branch/)
    expect(byRule(result, 'image-too-large')[0]).toMatchObject({ severity: 'warning', preexisting: true })
  })

  test('a line the PR added still blocks', () => {
    const root = repo()
    const result = lintScreenshots({ root, changedLines: lines({ 'modules/m/pages/p.adoc': [4] }) })
    const added = byRule(result, 'alt-missing').find((f) => f.line === 4)
    expect(added.severity).toBe('error')
    expect(added.preexisting).toBeUndefined()
  })

  test('a changed image file blocks on its size even when the macro line did not change', () => {
    const root = repo()
    const result = lintScreenshots({ root, changedLines: lines({ 'modules/m/images/big.png': 'all' }) })
    expect(byRule(result, 'image-too-large')[0].severity).toBe('error')
  })

  test('a file with no hunks counts as changed throughout', () => {
    const root = repo()
    const result = lintScreenshots({ root, changedLines: lines({ 'modules/m/pages/p.adoc': 'all' }) })
    expect(result.summary.errors).toBeGreaterThan(0)
    expect(result.summary.preexisting).toBe(0)
  })

  test('an image replaced in place with no page change still blocks (positive control)', () => {
    const root = repo()
    const diffFile = path.join(root, 'pr.diff')
    // The shape the docs-pr-review workflow builds for a binary file: no patch.
    fs.writeFileSync(diffFile, 'diff --git a/modules/m/images/big.png b/modules/m/images/big.png\n--- /dev/null\n+++ b/modules/m/images/big.png\n\n')
    const res = spawnSync('node', [BIN, 'lint-screenshots', '--root', root, '--diff-file', diffFile, '--format', 'json'], { encoding: 'utf8' })
    expect(res.status).toBe(1)
    const out = JSON.parse(res.stdout)
    expect(out.findings.filter((f) => f.severity === 'error').map((f) => f.rule)).toEqual(['image-too-large'])
  })

  test('a PR that deletes an image an untouched page still uses is blocked', () => {
    const root = makeRepo({
      'modules/m/pages/p.adoc': 'image::old.png[Old]\n',
      'modules/m/images/keep.png': pngBytes()
    })
    const changed = parseUnifiedDiff('diff --git a/modules/m/images/old.png b/modules/m/images/old.png\n--- a/modules/m/images/old.png\n+++ /dev/null\n')
    const result = lintScreenshots({ root, changedLines: changed })
    expect(byRule(result, 'image-missing')[0]).toMatchObject({ severity: 'error' })
    expect(byRule(result, 'image-missing')[0].preexisting).toBeUndefined()
  })

  test('a rename blocks an untouched page that still uses the old name, with --files of the new name only', () => {
    const root = makeRepo({
      'modules/m/pages/other.adoc': 'image::old.png[Old]\n',
      'modules/m/pages/p.adoc': 'image::new.png[New]\n',
      'modules/m/images/new.png': pngBytes()
    })
    const changed = parseUnifiedDiff('diff --git a/modules/m/images/old.png b/modules/m/images/new.png\nsimilarity index 100%\nrename from modules/m/images/old.png\nrename to modules/m/images/new.png\n')
    const result = lintScreenshots({ root, files: ['modules/m/images/new.png'], changedLines: changed })
    const missing = byRule(result, 'image-missing')
    expect(missing).toHaveLength(1)
    expect(missing[0]).toMatchObject({ file: 'modules/m/pages/other.adoc', severity: 'error' })
  })

  test('an empty diff is no diff, and a scoped file the diff misses counts as changed', () => {
    const root = repo()
    const empty = lintScreenshots({ root, files: ['modules/m/pages/p.adoc'], changedLines: new Map() })
    expect(empty.summary.errors).toBeGreaterThan(0)
    expect(empty.summary.preexisting).toBeUndefined()
    const missed = lintScreenshots({ root, files: ['modules/m/pages/p.adoc'], changedLines: lines({ 'modules/m/pages/other.adoc': [1] }) })
    expect(missed.summary.errors).toBeGreaterThan(0)
    expect(missed.summary.preexisting).toBe(0)
  })

  test('the CLI reads --diff-file', () => {
    const root = repo()
    const diffFile = path.join(root, 'pr.diff')
    fs.writeFileSync(diffFile, 'diff --git a/modules/m/pages/p.adoc b/modules/m/pages/p.adoc\n--- a/modules/m/pages/p.adoc\n+++ b/modules/m/pages/p.adoc\n@@ -1 +1 @@\n-:page-categories: Old\n+:page-categories: New\n')
    const res = spawnSync('node', [BIN, 'lint-screenshots', '--root', root, '--diff-file', diffFile, '--format', 'json'], { encoding: 'utf8' })
    expect(res.status).toBe(0)
    const out = JSON.parse(res.stdout)
    expect(out.summary.errors).toBe(0)
    expect(out.summary.preexisting).toBeGreaterThan(0)
  })
})

describe('lintScreenshots - Doc Detective baselines', () => {
  test('a baseline over the ceiling is a warning that says not to quantize it', () => {
    const root = makeRepo({
      'modules/m/pages/p.adoc': 'image::base.png[Base]\nimage::plain.png[Plain]\n',
      'modules/m/images/base.png': pngBytes({ bytes: 150 * 1024 }),
      'modules/m/images/plain.png': pngBytes({ bytes: 150 * 1024 }),
      'tests/doc-detective/specs/s.json': JSON.stringify({ tests: [{ steps: [{ screenshot: { path: 'modules/m/images/base.png', maxVariation: 0.1 } }] }] })
    })
    const result = lintScreenshots({ root })
    const base = byRule(result, 'baseline-too-large')
    expect(base).toHaveLength(1)
    expect(base[0].severity).toBe('warning')
    expect(base[0].message).toMatch(/do not quantize/)
    expect(base[0].message).toMatch(/tests\/doc-detective\/specs\/s\.json/)
    expect(byRule(result, 'image-too-large').map((f) => f.image)).toEqual(['plain.png'])
  })

  test('a string-form screenshot step and a spec that is not JSON are handled', () => {
    const root = makeRepo({
      'modules/m/pages/p.adoc': 'image::base.png[Base]\n',
      'modules/m/images/base.png': pngBytes({ bytes: 150 * 1024 }),
      'tests/a.json': JSON.stringify({ steps: [{ screenshot: 'modules/m/images/base.png' }] }),
      'tests/broken.json': '{ not json'
    })
    expect(rules(lintScreenshots({ root }))).toEqual(['baseline-too-large'])
  })
})

'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const {
  lintScreenshots,
  formatHuman,
  parseAltText,
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

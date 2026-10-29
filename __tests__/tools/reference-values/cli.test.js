'use strict'

// doc-tools check-reference-values end to end: exit codes, --fail-on levels,
// --files, --kinds, --data-file, --annotations and --write.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const BIN = path.join(__dirname, '..', '..', '..', 'bin', 'doc-tools.js')
const FIXTURES = path.join(__dirname, '..', '..', 'fixtures')
const RPK = path.join(FIXTURES, 'rpkval', 'rpk-v26.2.2-sample.json')
const temps = []
afterAll(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true })
})

function repo (files, antora = "name: streaming\nversion: '26.2'\n") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-cli-'))
  temps.push(dir)
  if (antora !== null) fs.writeFileSync(path.join(dir, 'antora.yml'), antora)
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    fs.writeFileSync(path.join(dir, file), content)
  }
  return dir
}
// The fixture under a name the CLI recognizes.
function rpkData (dir, transform) {
  const file = path.join(dir, 'rpk-v26.2.2.json')
  const data = JSON.parse(fs.readFileSync(RPK, 'utf8'))
  fs.writeFileSync(file, JSON.stringify(transform ? transform(data) : data))
  return file
}
function run (dir, args) {
  const reportDir = path.join(dir, 'report')
  const out = spawnSync(process.execPath, [BIN, 'check-reference-values', '--docs-dir', dir, '--report-dir', reportDir, ...args], { encoding: 'utf8', timeout: 60000 })
  const reportPath = path.join(reportDir, 'reference-values-report.json')
  return { code: out.status, stdout: out.stdout, stderr: out.stderr, report: fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, 'utf8')) : undefined }
}

const block = (...lines) => ['[,bash]', '----', ...lines, '----', ''].join('\n')
const MISMATCH = ['= M', '', '== Create', '', block('rpk topic create orders'), 'The `--partitions` flag defaults to 3.', ''].join('\n')
const EXACT = ['= E', '', '== Create', '', block('rpk topic create orders'), 'The `--partitions` flag defaults to -1.', ''].join('\n')
const UNKNOWN = ['= U', '', block('rpk cluster quotas delete --name user=alice'), ''].join('\n')

describe('doc-tools check-reference-values', () => {
  test('exit 0 with nothing failing, and both reports written', () => {
    const dir = repo({ 'modules/x/pages/ok.adoc': '= OK\n\nNothing here.\n' })
    const r = run(dir, ['--data-file', rpkData(dir)])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('check (mismatch): 0 failing finding(s)')
    expect(r.report).toMatchObject({ schema: 1, component: 'streaming', version: '26.2', failOn: 'mismatch', failing: 0 })
    expect(r.report.kinds.rpk).toMatchObject({ selection: 'explicit', surface: 'all', rpkVersion: 'v26.2.2', scraped: ['ai', 'check', 'connect', 'k8s', 'oxla'] })
    expect(fs.existsSync(path.join(dir, 'report', 'reference-values-report.md'))).toBe(true)
  })

  test('exit 1 on a mismatch, with one console line per failing finding', () => {
    const dir = repo({ 'modules/x/pages/m.adoc': MISMATCH })
    const r = run(dir, ['--data-file', rpkData(dir)])
    expect(r.code).toBe(1)
    expect(r.stdout).toContain('MISMATCH modules/x/pages/m.adoc:10 rpk rpkval:[rpk topic create --partitions,default]: written 3, data -1')
    // The report and the annotation name the same bracket form --write writes.
    expect(fs.readFileSync(path.join(dir, 'report', 'reference-values-report.md'), 'utf8')).toContain('| `rpkval:[rpk topic create --partitions,default]` | 3 | -1 |')
    const annotated = run(dir, ['--data-file', rpkData(dir), '--annotations', 'github'])
    expect(annotated.stdout).toContain('::error file=modules/x/pages/m.adoc,line=10::rpk mismatch: rpkval:[rpk topic create --partitions,default]: written 3, data -1')
  })

  test('exit 1 on a reference error', () => {
    const dir = repo({ 'modules/x/pages/u.adoc': UNKNOWN })
    const r = run(dir, ['--data-file', rpkData(dir)])
    expect(r.code).toBe(1)
    expect(r.stdout).toContain('UNKNOWN-COMMAND modules/x/pages/u.adoc:5 rpk')
  })

  test.each([
    ['none', MISMATCH, 0],
    ['mismatch', MISMATCH, 1],
    ['mismatch', EXACT, 0],
    ['any', EXACT, 1],
    ['none', UNKNOWN, 0],
  ])('--fail-on %s', (level, page, code) => {
    const dir = repo({ 'modules/x/pages/p.adoc': page })
    expect(run(dir, ['--data-file', rpkData(dir), '--fail-on', level]).code).toBe(code)
  })

  test('--fail-on any fails on a deprecation warning, mismatch does not', () => {
    const dir = repo({ 'modules/x/pages/d.adoc': block('rpk redpanda admin brokers list') })
    expect(run(dir, ['--data-file', rpkData(dir)]).code).toBe(0)
    expect(run(dir, ['--data-file', rpkData(dir), '--fail-on', 'any']).code).toBe(1)
  })

  test('exit 2 on setup errors', () => {
    const noAntora = repo({}, null)
    expect(run(noAntora, []).code).toBe(2)
    const dir = repo({})
    expect(run(dir, ['--fail-on', 'sometimes']).code).toBe(2)
    expect(run(dir, ['--kinds', 'widgets']).code).toBe(2)
    // No kind has data.
    const r = run(dir, [])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('no kind has data')
  })

  test('--kinds: a named kind with no data is exit 2; implicit kinds are skipped', () => {
    const dir = repo({ 'modules/x/pages/ok.adoc': '= OK\n' })
    const data = rpkData(dir)
    const explicit = run(dir, ['--data-file', data, '--kinds', 'rpk,connect'])
    expect(explicit.code).toBe(2)
    expect(explicit.stderr).toContain('--kinds connect')
    const implicit = run(dir, ['--data-file', data])
    expect(implicit.code).toBe(0)
    expect(Object.keys(implicit.report.skipped).sort()).toEqual(['connect', 'properties'])
  })

  test('--data-file accepts the raw docs-data snapshot, which has no schema key', () => {
    const dir = repo({ 'modules/x/pages/u.adoc': UNKNOWN })
    const data = rpkData(dir, (d) => {
      delete d.schema
      d.raw_tree = d.tree
      return d
    })
    expect(run(dir, ['--data-file', data]).report.kinds.rpk.counts.referenceErrors).toBe(1)
  })

  test('an unrecognized or unreadable --data-file is exit 2', () => {
    const dir = repo({})
    const odd = path.join(dir, 'commands.json')
    fs.writeFileSync(odd, '{}')
    const r = run(dir, ['--data-file', odd])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('the name matches no dataset kind')
    const bad = path.join(dir, 'rpk-v26.2.2.json')
    fs.writeFileSync(bad, '{"schema": 2, "tree": {"commands": []}}')
    expect(run(dir, ['--data-file', bad]).stderr).toContain('newer schema than this DEM understands')
  })

  test('--files scans only the named files', () => {
    const dir = repo({ 'modules/x/pages/a.adoc': UNKNOWN, 'modules/x/pages/b.adoc': UNKNOWN })
    const r = run(dir, ['--data-file', rpkData(dir), '--files', 'modules/x/pages/b.adoc'])
    expect(r.report.kinds.rpk.findings.map((f) => f.file)).toEqual(['modules/x/pages/b.adoc'])
  })

  test('--annotations github prints ::error for failing findings and ::warning for reference warnings', () => {
    const dir = repo({ 'modules/x/pages/u.adoc': UNKNOWN + '\n' + block('rpk redpanda admin brokers list') })
    const r = run(dir, ['--data-file', rpkData(dir), '--annotations', 'github'])
    const lines = r.stdout.split('\n')
    expect(lines.filter((l) => l.startsWith('::error file=modules/x/pages/u.adoc,line=5::rpk reference: '))).toHaveLength(1)
    expect(lines.filter((l) => l.startsWith('::warning file=modules/x/pages/u.adoc,line=11::rpk deprecated-command: '))).toHaveLength(1)
    expect(run(dir, ['--data-file', rpkData(dir), '--annotations', 'gitlab']).code).toBe(2)
  })

  test('--write --fail-on any counts only the findings that remain', () => {
    const dir = repo({ 'modules/x/pages/e.adoc': EXACT })
    fs.mkdirSync(path.join(dir, 'modules/reference/attachments'), { recursive: true })
    fs.copyFileSync(RPK, path.join(dir, 'modules/reference/attachments/rpk-v26.2.2.json'))
    expect(run(dir, ['--fail-on', 'any']).code).toBe(1)
    const written = run(dir, ['--fail-on', 'any', '--write'])
    expect(written.code).toBe(0)
    expect(written.report.kinds.rpk.findings[0]).toMatchObject({ applied: true, failing: false })
    expect(fs.readFileSync(path.join(dir, 'modules/x/pages/e.adoc'), 'utf8')).toContain('rpkval:[rpk topic create --partitions,default]')
  })

  test('historical and unverifiable findings never fail', () => {
    const dir = repo({
      'modules/get-started/pages/release-notes/redpanda.adoc': UNKNOWN,
      'modules/x/pages/v.adoc': block('rpk redpanda start --io-properties-file x'),
    })
    const r = run(dir, ['--data-file', rpkData(dir), '--fail-on', 'any'])
    expect(r.report.kinds.rpk.findings.map((f) => [f.status, f.failing])).toEqual([['reference', false], ['unverifiable', false]])
    expect(r.code).toBe(0)
  })

  test('docs patch release notes (reference/pages/releases/) are historical, and --write leaves them alone', () => {
    const notes = ['= Notes', '', block('rpk cluster quotas delete --name user=alice'), '== Create', '', block('rpk topic create orders'), 'The `--partitions` flag defaults to -1.', ''].join('\n')
    const dir = repo({ 'modules/reference/pages/releases/redpanda.adoc': notes })
    const r = run(dir, ['--data-file', rpkData(dir), '--fail-on', 'any', '--write'])
    expect(r.report.kinds.rpk.findings.map((f) => [f.status, f.failing])).toEqual([['reference', false], ['exact', false]])
    expect(r.code).toBe(0)
    expect(fs.readFileSync(path.join(dir, 'modules/reference/pages/releases/redpanda.adoc'), 'utf8')).toBe(notes)
  })
})

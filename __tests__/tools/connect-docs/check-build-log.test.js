'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const { checkBuildLog, formatMarkdown, parseLog, locationOf } = require('../../../tools/connect-docs/check-build-log')

const BIN = path.join(__dirname, '..', '..', '..', 'bin', 'doc-tools.js')

// Records in the shape Antora 3.1 writes with --log-format json.
const INFO = { level: 'info', time: 1, name: 'modify-connect-tag-playbook-extension', msg: 'added 2216 files to the connect component' }
const WARN_CLOUD = { level: 'warn', time: 2, name: 'redpanda-connect-info-extension', msg: 'Cloud docs missing for: websocket of type: input' }
const WARN_TAG = (line) => ({
  level: 'warn',
  time: 3,
  name: 'asciidoctor',
  file: { path: 'modules/reference/partials/properties/topic-properties.adoc' },
  source: { url: 'https://github.com/redpanda-data/docs', refname: 'main', reftype: 'branch' },
  stack: [{ file: { path: 'modules/reference/pages/properties/topic-properties.adoc', line }, source: { url: 'https://github.com/redpanda-data/docs', refname: 'main' } }],
  msg: "tag 'deprecated' not found in include file"
})
const ERROR_XREF = {
  level: 'error',
  time: 4,
  name: 'asciidoctor',
  file: { path: '/work/rp-connect-docs/modules/components/pages/inputs/kafka.adoc', line: 42 },
  source: { url: 'https://github.com/redpanda-data/rp-connect-docs.git', worktree: '/work/rp-connect-docs', refname: 'main', reftype: 'branch' },
  msg: 'target of xref not found: guides:missing.adoc'
}
const FATAL = { level: 'fatal', time: 5, name: 'antora', msg: 'Could not read the Redpanda Connect reference docs', err: { message: 'boom' } }

const ndjson = (...records) => records.map((r) => JSON.stringify(r)).join('\n') + '\n'

function siteWithPages (n) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cbl-site-'))
  for (let i = 0; i < n; i++) {
    fs.mkdirSync(path.join(dir, `p${i}`), { recursive: true })
    fs.writeFileSync(path.join(dir, `p${i}`, 'index.html'), '<html></html>')
  }
  fs.writeFileSync(path.join(dir, 'site.css'), '')
  return dir
}

describe('check-build-log', () => {
  test('a log with warnings only passes, and the warnings are listed', () => {
    const result = checkBuildLog({ text: ndjson(INFO, WARN_CLOUD, WARN_TAG(23), WARN_TAG(29)) })
    expect(result.ok).toBe(true)
    expect(result.counts).toMatchObject({ info: 1, warn: 3, error: 0, fatal: 0 })
    const md = formatMarkdown(result)
    expect(md).toMatch(/Antora build log: passed/)
    expect(md).toMatch(/\| warn \| 3 \|/)
    expect(md).toMatch(/Cloud docs missing for: websocket of type: input/)
  })

  test('an error-level record fails the check', () => {
    const result = checkBuildLog({ text: ndjson(INFO, WARN_CLOUD, ERROR_XREF) })
    expect(result.ok).toBe(false)
    expect(result.counts.error).toBe(1)
    expect(result.failures.join()).toMatch(/1 log record at level error or fatal/)
    const md = formatMarkdown(result)
    expect(md).toMatch(/Antora build log: failed/)
    expect(md).toMatch(/### Errors/)
    expect(md).toMatch(/target of xref not found: guides:missing\.adoc/)
  })

  test('a fatal record fails the check, and its message falls back to err.message', () => {
    const result = checkBuildLog({ text: ndjson(FATAL) })
    expect(result.ok).toBe(false)
    expect(result.groups.fatal[0].msg).toBe('Could not read the Redpanda Connect reference docs')
    const noMsg = checkBuildLog({ text: ndjson({ level: 'fatal', err: { message: 'boom' } }) })
    expect(noMsg.groups.fatal[0].msg).toBe('boom')
  })

  test('numeric pino levels are understood', () => {
    const result = checkBuildLog({ text: ndjson({ level: 50, msg: 'numeric error' }, { level: 40, msg: 'numeric warn' }) })
    expect(result.ok).toBe(false)
    expect(result.counts).toMatchObject({ error: 1, warn: 1 })
  })

  test('repeated messages are grouped and deduplicated with every location', () => {
    const result = checkBuildLog({ text: ndjson(WARN_TAG(23), WARN_TAG(29), WARN_TAG(23)) })
    expect(result.groups.warn).toHaveLength(1)
    expect(result.groups.warn[0].count).toBe(3)
    // Two distinct include sites; the duplicate is not listed twice.
    expect(result.groups.warn[0].locations).toHaveLength(2)
    const md = formatMarkdown(result)
    expect(md).toMatch(/\(3x\) tag 'deprecated' not found in include file/)
    expect(md).toMatch(/redpanda-data\/docs@main: modules\/reference\/partials\/properties\/topic-properties\.adoc \(included from modules\/reference\/pages\/properties\/topic-properties\.adoc:23\)/)
  })

  test('a worktree path is shown relative to the worktree, with the line', () => {
    expect(locationOf(ERROR_XREF)).toBe('redpanda-data/rp-connect-docs@main: modules/components/pages/inputs/kafka.adoc:42')
  })

  describe('--blocking-sources', () => {
    const BLOCKING = ['redpanda-data/rp-connect-docs', 'redpanda-data/connect']
    const DOCS_ERROR = {
      level: 'error',
      name: 'asciidoctor',
      file: { path: '/w/docs/modules/get-started/pages/quick-start.adoc' },
      source: { url: 'https://github.com/redpanda-data/docs.git', worktree: '/w/docs', refname: 'main' },
      msg: 'target of xref not found: labs:ROOT:index.adoc'
    }
    // An error in a generated partial: its own source is the connect tree,
    // and the page that includes it is in rp-connect-docs.
    const PARTIAL_ERROR = {
      level: 'error',
      name: 'asciidoctor',
      file: { path: 'modules/components/partials/fields/inputs/kafka.adoc', line: 3 },
      source: { url: 'https://github.com/redpanda-data/connect', startPath: 'docs' },
      stack: [{ file: { path: '/w/rp-connect-docs/modules/components/pages/inputs/kafka.adoc', line: 40 }, source: { url: 'https://github.com/redpanda-data/rp-connect-docs.git', worktree: '/w/rp-connect-docs' } }],
      msg: 'target of xref not found: guides:missing.adoc'
    }
    // A docs page that includes something from rp-connect-docs.
    const INCLUDED_FROM_RPCN = { ...DOCS_ERROR, stack: [{ file: { path: 'x.adoc' }, source: { url: 'https://github.com/redpanda-data/rp-connect-docs' } }] }
    const EXTENSION_ERROR = { level: 'error', name: 'redpanda-connect-info-extension', msg: 'connector pages are missing generated sets' }

    test('an error from another source is listed but does not block', () => {
      const result = checkBuildLog({ text: ndjson(DOCS_ERROR), blockingSources: BLOCKING })
      expect(result.ok).toBe(true)
      expect(result.counts.error).toBe(1)
      expect(result.groups.errorElsewhere).toHaveLength(1)
      expect(formatMarkdown(result)).toMatch(/### Errors from other sources \(do not block; only redpanda-data\/rp-connect-docs, redpanda-data\/connect block\)/)
    })

    test('the same error blocks without the option', () => {
      expect(checkBuildLog({ text: ndjson(DOCS_ERROR) }).ok).toBe(false)
    })

    test.each([
      ['an rp-connect-docs or connect-tree error', PARTIAL_ERROR],
      ['an error whose include chain reaches rp-connect-docs', INCLUDED_FROM_RPCN],
      ['an error with no source (an extension error)', EXTENSION_ERROR],
      ['a fatal record from any source', { ...DOCS_ERROR, level: 'fatal' }]
    ])('%s blocks', (_, record) => {
      const result = checkBuildLog({ text: ndjson(record), blockingSources: BLOCKING })
      expect(result.ok).toBe(false)
      expect(result.blocking).toBe(1)
    })

    test('include-chain paths are made relative to their own worktree', () => {
      expect(locationOf(PARTIAL_ERROR)).toBe('redpanda-data/connect/docs: modules/components/partials/fields/inputs/kafka.adoc:3 (included from modules/components/pages/inputs/kafka.adoc:40)')
    })
  })

  test('non-JSON lines are counted, not fatal', () => {
    const { records, unparsed } = parseLog('not json\n' + JSON.stringify(INFO) + '\n[1,2]\n\n')
    expect(records).toHaveLength(1)
    expect(unparsed).toBe(2)
  })

  test('--min-pages fails a build that wrote too few pages, and passes one that wrote enough', () => {
    const site = siteWithPages(3)
    const low = checkBuildLog({ text: ndjson(INFO), siteDir: site, minPages: 4 })
    expect(low.ok).toBe(false)
    expect(low.pages).toBe(3)
    expect(low.failures.join()).toMatch(/3 HTML pages written .* fewer than the required 4/)
    const enough = checkBuildLog({ text: ndjson(INFO), siteDir: site, minPages: 3 })
    expect(enough.ok).toBe(true)
  })

  test('--min-pages fails an empty build that logged nothing (the exit 0, no files case)', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'cbl-empty-'))
    const result = checkBuildLog({ text: '', siteDir: path.join(empty, 'missing'), minPages: 1 })
    expect(result.ok).toBe(false)
    expect(result.pages).toBe(0)
  })

  describe('CLI', () => {
    const run = (args) => spawnSync('node', [BIN, 'check-build-log', ...args], { encoding: 'utf8' })
    const write = (text) => {
      const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cbl-cli-')), 'log.ndjson')
      fs.writeFileSync(f, text)
      return f
    }

    test('exits 0 on a clean log and prints the Markdown summary', () => {
      const r = run([write(ndjson(INFO, WARN_CLOUD))])
      expect(r.status).toBe(0)
      expect(r.stdout).toMatch(/## Antora build log: passed/)
    })

    test('exits 1 on an error-level record', () => {
      const r = run([write(ndjson(INFO, ERROR_XREF))])
      expect(r.status).toBe(1)
      expect(r.stdout).toMatch(/Blocking/)
    })

    test('exits 1 below --min-pages', () => {
      const r = run([write(ndjson(INFO)), '--site-dir', siteWithPages(1), '--min-pages', '2'])
      expect(r.status).toBe(1)
    })

    test('exits 2 on a missing log file', () => {
      const r = run([path.join(os.tmpdir(), 'no-such-log.ndjson')])
      expect(r.status).toBe(2)
      expect(r.stderr).toMatch(/log file not found/)
    })
  })
})

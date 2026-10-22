'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const {
  parseSourceComment,
  extractSources,
  locateQuote,
  checkSources,
  createGitHubClient,
  selectFiles,
  formatHuman,
  runCli
} = require('../../../tools/check-sources')

const BIN = path.join(__dirname, '..', '..', '..', 'bin', 'doc-tools.js')

// A cited Go file. Line numbers matter: tests cite them.
const CONFIG_GO = [
  'package config', //                                            1
  '', //                                                          2
  '// RetentionBytes is the per-partition size limit.', //        3
  'func RetentionBytes() int64 {', //                              4
  '\treturn 1073741824 // 1 GiB default', //                       5
  '}', //                                                          6
  '', //                                                          7
  'const maxBatch = 1 << 20' //                                    8
].join('\n') + '\n'

// The same file after a change pushed the default down three lines.
const CONFIG_GO_MOVED = [
  'package config',
  '',
  'import "fmt"',
  '',
  '',
  '// RetentionBytes is the per-partition size limit.',
  'func RetentionBytes() int64 {',
  '\treturn 1073741824 // 1 GiB default',
  '}',
  '',
  'const maxBatch = 1 << 20'
].join('\n') + '\n'

/**
 * Stub GitHub client. files: { 'repo@ref:path': text }, ref '' is the
 * default branch. unreachableRepos: repos every call fails on. Records calls.
 */
function stubClient ({ files = {}, pulls = {}, unreachableRepos = [], urls = {} } = {}) {
  const calls = { getFile: [], getPull: [], headUrl: [] }
  return {
    calls,
    authenticated: true,
    async getFile ({ repo, ref, path: p }) {
      calls.getFile.push(`${repo}@${ref || ''}:${p}`)
      if (unreachableRepos.includes(repo)) return { status: 'unreachable', reason: `${repo}: HTTP 403` }
      const text = files[`${repo}@${ref || ''}:${p}`]
      return text === undefined ? { status: 'missing', reason: `${p} does not exist` } : { status: 'ok', text }
    },
    async getPull ({ repo, number }) {
      calls.getPull.push(`${repo}#${number}`)
      if (unreachableRepos.includes(repo)) return { status: 'unreachable', reason: `${repo}: network down` }
      const pr = pulls[`${repo}#${number}`]
      return pr ? { status: 'ok', state: pr } : { status: 'missing', reason: `${repo}#${number} does not exist` }
    },
    async headUrl (url) {
      calls.headUrl.push(url)
      return urls[url] || { status: 'ok', code: 200 }
    }
  }
}

function makeRepo (files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'check-sources-'))
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content)
  }
  return root
}

async function check (page, clientOpts, opts = {}) {
  const root = makeRepo({ 'modules/ROOT/pages/p.adoc': page })
  const client = stubClient(clientOpts)
  const result = await checkSources({ files: ['modules/ROOT/pages/p.adoc'], root, client, ...opts })
  return { result, client, rules: result.findings.map((f) => f.rule) }
}

const FILES = { 'streaming-enterprise@:src/config.go': CONFIG_GO }

describe('parseSourceComment', () => {
  test('file ref with default branch, single line', () => {
    const { ref, quote } = parseSourceComment(' redpanda-data/streaming-enterprise:src/v/config/configuration.cc:120')
    expect(ref).toMatchObject({ kind: 'file', repo: 'streaming-enterprise', gitRef: null, path: 'src/v/config/configuration.cc', startLine: 120, endLine: 120 })
    expect(quote).toBeNull()
  })

  test('file ref with a git ref containing slashes, a range, and a quote', () => {
    const { ref, quote } = parseSourceComment(' redpanda-data/connect@release/v4.50:internal/impl/kafka/input.go:10-14 "default: 10s"')
    expect(ref).toMatchObject({ kind: 'file', repo: 'connect', gitRef: 'release/v4.50', path: 'internal/impl/kafka/input.go', startLine: 10, endLine: 14 })
    expect(quote).toBe('default: 10s')
  })

  test('PR, Jira, and URL refs', () => {
    expect(parseSourceComment(' redpanda-data/docs#1234').ref).toMatchObject({ kind: 'pr', repo: 'docs', number: 1234 })
    expect(parseSourceComment(' DOC-2496').ref).toMatchObject({ kind: 'jira', key: 'DOC-2496' })
    expect(parseSourceComment(' CORE11-42').ref).toMatchObject({ kind: 'jira', key: 'CORE11-42' })
    expect(parseSourceComment(' https://docs.redpanda.com/current/get-started/').ref).toMatchObject({ kind: 'url' })
  })

  test.each([
    ['', /empty source comment/],
    [' redpanda-data/connect:main.go', /unrecognised ref/],
    [' redpanda-data/connect:main.go:0', /start at 1/],
    [' redpanda-data/connect:main.go:9-3', /ends before it starts/],
    [' someone-else/connect:main.go:3', /owner must be redpanda-data/],
    [' someone-else/connect#3', /owner must be redpanda-data/],
    [' http://example.com/x', /must use https/],
    [' https://localhost', /not a valid https URL/],
    [' doc-123', /unrecognised ref/],
    [' redpanda-data/connect:main.go:3 default 10s', /double quotes/],
    [' redpanda-data/connect:main.go:3 "unterminated', /double quotes/],
    [' redpanda-data/connect:main.go:3 ""', /empty quote/]
  ])('malformed: %j', (rest, re) => {
    expect(parseSourceComment(rest).error).toMatch(re)
  })
})

describe('extractSources', () => {
  test('finds source comments, their claim line, and skips delimited blocks', () => {
    const doc = [
      '= Page', //                                                   1
      '', //                                                         2
      '// source: DOC-1', //                                         3
      '// source: redpanda-data/docs#5', //                          4
      'The default is 1 GiB.', //                                    5
      '', //                                                         6
      '[,yaml]', //                                                  7
      '----', //                                                     8
      '// source: DOC-2', //                                         9
      '----', //                                                    10
      '////', //                                                    11
      '// source: DOC-3', //                                        12
      '////', //                                                    13
      '// source: DOC-4', //                                        14
      '' //                                                         15
    ].join('\n')
    const found = extractSources(doc)
    expect(found.map((s) => [s.line, s.claimLine])).toEqual([[3, 5], [4, 5], [14, null]])
  })

  test('a different delimiter inside a block does not close it', () => {
    const doc = ['----', '....', '// source: DOC-9', '----', '// source: DOC-10', 'Claim.'].join('\n')
    expect(extractSources(doc).map((s) => s.line)).toEqual([5])
  })
})

describe('locateQuote', () => {
  test('returns the tightest window, including multi-line quotes', () => {
    const lines = CONFIG_GO_MOVED.split('\n')
    expect(locateQuote(lines, 'return 1073741824')).toEqual([{ start: 8, end: 8 }])
    expect(locateQuote(lines, 'func RetentionBytes() int64 { return 1073741824')).toEqual([{ start: 7, end: 8 }])
    expect(locateQuote(lines, 'not there')).toEqual([])
  })
})

describe('checkSources: every finding class', () => {
  test('a correct file ref with a quote passes with no findings', async () => {
    const { result } = await check('// source: redpanda-data/streaming-enterprise:src/config.go:5 "return 1073741824"\nThe default is 1 GiB.\n', { files: FILES })
    expect(result.findings).toEqual([])
    expect(result.summary).toEqual({ errors: 0, warnings: 0, info: 0 })
  })

  test('quote matching is whitespace-normalised and spans the cited range', async () => {
    const page = '// source: redpanda-data/streaming-enterprise:src/config.go:4-5 "func RetentionBytes()   int64 {  return 1073741824"\nClaim.\n'
    const { result } = await check(page, { files: FILES })
    expect(result.findings).toEqual([])
  })

  test('malformed', async () => {
    const { rules, result } = await check('// source: redpanda-data/streaming-enterprise:src/config.go\nClaim.\n', { files: FILES })
    expect(rules).toEqual(['malformed'])
    expect(result.summary.errors).toBe(1)
  })

  test('missing-file', async () => {
    const { rules } = await check('// source: redpanda-data/streaming-enterprise:src/gone.go:1\nClaim.\n', { files: FILES })
    expect(rules).toEqual(['missing-file'])
  })

  test('missing-file at a ref the file does not exist on', async () => {
    const { rules, client } = await check('// source: redpanda-data/streaming-enterprise@v24.1.1:src/config.go:5\nClaim.\n', { files: FILES })
    expect(rules).toEqual(['missing-file'])
    expect(client.calls.getFile).toEqual(['streaming-enterprise@v24.1.1:src/config.go'])
  })

  test('line-out-of-range (a trailing newline is not a line)', async () => {
    const ok = await check('// source: redpanda-data/streaming-enterprise:src/config.go:8\nClaim.\n', { files: FILES })
    expect(ok.rules).toEqual([])
    const { rules, result } = await check('// source: redpanda-data/streaming-enterprise:src/config.go:7-9\nClaim.\n', { files: FILES })
    expect(rules).toEqual(['line-out-of-range'])
    expect(result.findings[0].message).toMatch(/has 8 lines; cited lines 7-9/)
  })

  test('quote-not-found when the quote is not in the file at all', async () => {
    const { rules, result } = await check('// source: redpanda-data/streaming-enterprise:src/config.go:5 "return 2147483648"\nClaim.\n', { files: FILES })
    expect(rules).toEqual(['quote-not-found'])
    expect(result.findings[0].message).toMatch(/does not appear anywhere/)
  })

  test('quote-not-found when the quote moved off its line, with where it went', async () => {
    const files = { 'streaming-enterprise@:src/config.go': CONFIG_GO_MOVED }
    const { rules, result } = await check('// source: redpanda-data/streaming-enterprise:src/config.go:5 "return 1073741824"\nClaim.\n', { files })
    expect(rules).toEqual(['quote-not-found'])
    expect(result.findings[0].message).toMatch(/It now appears at line 8\./)
    expect(result.findings[0].movedTo).toEqual([{ start: 8, end: 8 }])
  })

  test('unreachable is a warning, not a pass and not an error', async () => {
    const { rules, result } = await check('// source: redpanda-data/streaming-enterprise:src/config.go:5 "return 1073741824"\nClaim.\n', { files: FILES, unreachableRepos: ['streaming-enterprise'] })
    expect(rules).toEqual(['unreachable'])
    expect(result.summary).toEqual({ errors: 0, warnings: 1, info: 0 })
  })

  test('PR refs report state as info; missing PRs are errors; unreachable is a warning', async () => {
    const page = [
      '// source: redpanda-data/connect#100', 'A.', '',
      '// source: redpanda-data/connect#101', 'B.', '',
      '// source: redpanda-data/connect#102', 'C.', '',
      '// source: redpanda-data/connect#999', 'D.', '',
      '// source: redpanda-data/private#1', 'E.', ''
    ].join('\n')
    const { result } = await check(page, { pulls: { 'connect#100': 'merged', 'connect#101': 'open', 'connect#102': 'closed' }, unreachableRepos: ['private'] })
    expect(result.findings.map((f) => [f.rule, f.severity, f.state])).toEqual([
      ['pr-state', 'info', 'merged'],
      ['pr-state', 'info', 'open'],
      ['pr-state', 'info', 'closed'],
      ['pr-not-found', 'error', undefined],
      ['unreachable', 'warning', undefined]
    ])
  })

  test('Jira keys and URLs are syntax-only by default and make no network calls', async () => {
    const page = '// source: DOC-2496\nA.\n\n// source: https://example.com/spec "a quote"\nB.\n'
    const { result, client } = await check(page, {})
    expect(result.findings.map((f) => f.rule)).toEqual(['syntax-only', 'quote-not-checked', 'syntax-only'])
    expect(result.summary.errors).toBe(0)
    expect(client.calls).toEqual({ getFile: [], getPull: [], headUrl: [] })
  })

  test('--check-urls HEAD-checks URLs: 404 is an error, other failures unreachable', async () => {
    const page = '// source: https://a.example.com/ok\nA.\n\n// source: https://a.example.com/gone\nB.\n\n// source: https://a.example.com/down\nC.\n'
    const urls = { 'https://a.example.com/gone': { status: 'missing', reason: 'HTTP 404' }, 'https://a.example.com/down': { status: 'unreachable', reason: 'ECONNRESET' } }
    const { rules, client } = await check(page, { urls }, { checkUrls: true })
    expect(rules).toEqual(['url-not-found', 'unreachable'])
    expect(client.calls.headUrl).toHaveLength(3)
  })

  test('no-claim warns when nothing sits directly below the comment', async () => {
    const { rules, result } = await check('// source: DOC-1\n\nClaim after a blank line.\n', {})
    expect(rules).toEqual(['no-claim', 'syntax-only'])
    expect(result.summary.errors).toBe(0)
  })

  test('fetches are cached per (repo, ref, path)', async () => {
    const page = [
      '// source: redpanda-data/streaming-enterprise:src/config.go:5', 'A.',
      '// source: redpanda-data/streaming-enterprise:src/config.go:8 "maxBatch"', 'B.',
      '// source: redpanda-data/streaming-enterprise@dev:src/config.go:5', 'C.',
      '// source: redpanda-data/connect#1', 'D.',
      '// source: redpanda-data/connect#1', 'E.'
    ].join('\n')
    const files = { ...FILES, 'streaming-enterprise@dev:src/config.go': CONFIG_GO }
    const { client, result } = await check(page, { files, pulls: { 'connect#1': 'merged' } })
    expect(client.calls.getFile).toEqual(['streaming-enterprise@:src/config.go', 'streaming-enterprise@dev:src/config.go'])
    expect(client.calls.getPull).toEqual(['connect#1'])
    expect(result.fetches).toBe(3)
  })
})

describe('createGitHubClient (stubbed fetch)', () => {
  function fakeFetch (routes) {
    const seen = []
    const impl = async (url, init = {}) => {
      seen.push({ url, init })
      const route = routes.find(([re]) => re.test(url))
      if (!route) throw new Error('getaddrinfo ENOTFOUND api.github.com')
      const [, status, body = '', contentType = 'text/plain'] = route
      return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: () => contentType },
        text: async () => body,
        json: async () => JSON.parse(body)
      }
    }
    impl.seen = seen
    return impl
  }

  test('raw file fetch sends the token and the ref', async () => {
    const fetchImpl = fakeFetch([[/contents\/src\/a\.go\?ref=v1$/, 200, 'x\n']])
    const client = createGitHubClient({ token: 't0k', fetchImpl })
    expect(await client.getFile({ owner: 'redpanda-data', repo: 'r', ref: 'v1', path: 'src/a.go' })).toEqual({ status: 'ok', text: 'x\n' })
    expect(fetchImpl.seen[0].init.headers.Authorization).toBe('Bearer t0k')
    expect(fetchImpl.seen[0].init.headers.Accept).toMatch(/raw/)
  })

  test('404 on a visible repo is missing; 404 on an invisible repo is unreachable', async () => {
    const visible = createGitHubClient({ token: null, fetchImpl: fakeFetch([[/contents/, 404], [/repos\/redpanda-data\/r$/, 200, '{}']]) })
    expect((await visible.getFile({ owner: 'redpanda-data', repo: 'r', ref: null, path: 'a' })).status).toBe('missing')
    const hidden = createGitHubClient({ token: null, fetchImpl: fakeFetch([[/contents/, 404], [/repos\/redpanda-data\/r$/, 404]]) })
    const got = await hidden.getFile({ owner: 'redpanda-data', repo: 'r', ref: null, path: 'a' })
    expect(got.status).toBe('unreachable')
    expect(got.reason).toMatch(/not visible.*unauthenticated/)
  })

  test('a missing ref is reported as such', async () => {
    const client = createGitHubClient({ token: 't', fetchImpl: fakeFetch([[/contents/, 404], [/repos\/redpanda-data\/r$/, 200, '{}'], [/commits\/nope$/, 422]]) })
    expect(await client.getFile({ owner: 'redpanda-data', repo: 'r', ref: 'nope', path: 'a' })).toEqual({ status: 'missing', reason: 'ref nope does not exist in redpanda-data/r' })
  })

  test('401, 403, 5xx, and network errors are unreachable', async () => {
    for (const status of [401, 403, 502]) {
      const client = createGitHubClient({ token: 't', fetchImpl: fakeFetch([[/contents/, status]]) })
      expect((await client.getFile({ owner: 'redpanda-data', repo: 'r', ref: null, path: 'a' })).status).toBe('unreachable')
    }
    const offline = createGitHubClient({ token: 't', fetchImpl: fakeFetch([]) })
    const got = await offline.getFile({ owner: 'redpanda-data', repo: 'r', ref: null, path: 'a' })
    expect(got).toEqual({ status: 'unreachable', reason: 'redpanda-data/r:a: getaddrinfo ENOTFOUND api.github.com' })
  })

  test('PR state: merged_at wins over closed', async () => {
    const client = createGitHubClient({ token: 't', fetchImpl: fakeFetch([[/pulls\/1$/, 200, '{"state":"closed","merged_at":"2026-01-01T00:00:00Z"}', 'application/json'], [/pulls\/2$/, 200, '{"state":"closed","merged_at":null}', 'application/json']]) })
    expect((await client.getPull({ owner: 'redpanda-data', repo: 'r', number: 1 })).state).toBe('merged')
    expect((await client.getPull({ owner: 'redpanda-data', repo: 'r', number: 2 })).state).toBe('closed')
  })
})

describe('selectFiles and CLI', () => {
  function gitRepo () {
    const root = makeRepo({
      'modules/a/pages/one.adoc': '= One\n',
      'modules/a/pages/two.adoc': '= Two\n',
      'README.adoc': '= Readme\n'
    })
    const git = (...args) => {
      const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: root, encoding: 'utf8' })
      if (r.status !== 0) throw new Error(r.stderr)
      return r.stdout
    }
    git('init', '-q', '-b', 'main')
    git('add', '.')
    git('commit', '-q', '-m', 'base')
    git('checkout', '-q', '-b', 'feature')
    fs.writeFileSync(path.join(root, 'modules/a/pages/two.adoc'), '= Two\n\n// source: DOC-1\nChanged.\n')
    fs.writeFileSync(path.join(root, 'modules/a/pages/three.adoc'), '= Three\n')
    git('add', '.')
    git('commit', '-q', '-m', 'change')
    return root
  }

  test('default is every modules/**/*.adoc; --diff is only changed .adoc files', () => {
    const root = gitRepo()
    expect(selectFiles({ root })).toEqual(['modules/a/pages/one.adoc', 'modules/a/pages/three.adoc', 'modules/a/pages/two.adoc'])
    expect(selectFiles({ root, diff: 'main' })).toEqual(['modules/a/pages/three.adoc', 'modules/a/pages/two.adoc'])
    expect(selectFiles({ root, diff: 'main', files: ['**/two.adoc'] })).toEqual(['modules/a/pages/two.adoc'])
    expect(selectFiles({ root, files: ['README.adoc'] })).toEqual(['README.adoc'])
    expect(() => selectFiles({ root, diff: 'no-such-branch' })).toThrow(/git diff against no-such-branch failed/)
  })

  test('runCli exit codes: 1 on errors, 0 on warnings only, 2 on a bad --diff', async () => {
    const root = makeRepo({
      'modules/a/pages/bad.adoc': '// source: nonsense\nClaim.\n',
      'modules/a/pages/warn.adoc': '// source: redpanda-data/streaming-enterprise:src/config.go:1\nClaim.\n'
    })
    const log = jest.spyOn(console, 'log').mockImplementation(() => {})
    const err = jest.spyOn(console, 'error').mockImplementation(() => {})
    try {
      process.exitCode = undefined
      await runCli({ root, files: 'modules/a/pages/warn.adoc' }, { client: stubClient({ unreachableRepos: ['streaming-enterprise'] }) })
      expect(process.exitCode).toBe(0)
      await runCli({ root }, { client: stubClient({ unreachableRepos: ['streaming-enterprise'] }) })
      expect(process.exitCode).toBe(1)
      await runCli({ root, format: 'json' }, { client: stubClient({ unreachableRepos: ['streaming-enterprise'] }) })
      const json = JSON.parse(log.mock.calls[log.mock.calls.length - 1][0])
      expect(json.summary).toEqual({ errors: 1, warnings: 1, info: 0 })
      await runCli({ root, diff: 'main' }, { client: stubClient() })
      expect(process.exitCode).toBe(2)
    } finally {
      process.exitCode = undefined
      log.mockRestore()
      err.mockRestore()
    }
  })

  test('human output lists errors first and ends with a summary line', async () => {
    const { result } = await check('// source: DOC-1\nA.\n\n// source: bad\nB.\n', {})
    const text = formatHuman(result)
    expect(text.split('\n')[0]).toMatch(/^ERROR {3}modules\/ROOT\/pages\/p\.adoc:4 \[malformed\]/)
    expect(text).toMatch(/check-sources: 2 source comment\(s\) in 1 file\(s\), 0 fetch\(es\): 1 error\(s\), 0 warning\(s\), 1 info$/)
  })

  test('the doc-tools binary registers the command and passes on a page with no sources', () => {
    const root = makeRepo({ 'modules/a/pages/none.adoc': '= None\n\nNo sources here.\n' })
    const r = spawnSync(process.execPath, [BIN, 'check-sources', '--root', root], { encoding: 'utf8' })
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/0 source comment\(s\) in 1 file\(s\)/)
  })
})

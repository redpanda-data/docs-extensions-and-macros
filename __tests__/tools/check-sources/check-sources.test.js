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
  splitList,
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
    [' redpanda-data/connect:main.go', /unrecognized ref/],
    [' redpanda-data/connect:main.go:0', /start at 1/],
    [' redpanda-data/connect:main.go:9-3', /ends before it starts/],
    [' someone-else/connect:main.go:3', /owner must be redpanda-data/],
    [' someone-else/connect#3', /owner must be redpanda-data/],
    [' http://example.com/x', /must use https/],
    [' https://localhost', /not a valid https URL/],
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
    expect(result.summary).toEqual({ checked: 1, failed: 0, notes: 0, errors: 0, warnings: 0, info: 0 })
  })

  test('quote matching is whitespace-normalized and spans the cited range', async () => {
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
    expect(result.summary).toEqual({ checked: 1, failed: 0, notes: 0, errors: 0, warnings: 1, info: 0 })
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

describe('the // Source: convention: case, asides, and free-form notes', () => {
  test.each([
    '// Source: redpanda-data/streaming-enterprise:src/config.go:5 "return 1073741824"',
    '// source: redpanda-data/streaming-enterprise:src/config.go:5 "return 1073741824"',
    '// SOURCE: redpanda-data/streaming-enterprise:src/config.go:5 "return 1073741824"',
    '//Source:redpanda-data/streaming-enterprise:src/config.go:5 "return 1073741824"',
    '  // Source : redpanda-data/streaming-enterprise:src/config.go:5 "return 1073741824"',
    '// Source (verified 2026-10-20, cloudv2 origin/main): redpanda-data/streaming-enterprise:src/config.go:5 "return 1073741824"'
  ])('%s is checked like the canonical form', async (comment) => {
    const { result, client } = await check(`${comment}\nThe default is 1 GiB.\n`, { files: FILES })
    expect(result.findings).toEqual([])
    expect(result.summary).toMatchObject({ checked: 1, failed: 0, notes: 0 })
    expect(client.calls.getFile).toEqual(['streaming-enterprise@:src/config.go'])
  })

  test('a wrong quote fails in every case variant and in the parenthesized form', async () => {
    for (const marker of ['// Source:', '// source:', '// Source (verified 2026-10-20):']) {
      const { rules } = await check(`${marker} redpanda-data/streaming-enterprise:src/config.go:5 "return 2147483648"\nClaim.\n`, { files: FILES })
      expect(rules).toEqual(['quote-not-found'])
    }
  })

  test.each([
    ['prose', '// Source: triggers-table.tsx on cloudv2 origin/main, verified 2026-10-07 (cloudv2#30772).'],
    ['a parenthesized aside then prose', '// Source (verified 2026-10-20, cloudv2 origin/main, cloudv2#31284): apps/adp-ui/src/x.tsx:12 renders "Save"'],
    ['a path without owner/repo', '// Source: apps/frontend/src/foo.tsx:12-14 "label"'],
    ['a one-colon path that looks like owner/repo', '// Source (verified 2026-09-03): oauth-clients/access-split-card.tsx: the Self-registration half'],
    ['a bare repo#n', '// Source: cloudv2#31251 removed validateSystemPrompts'],
    ['a URL followed by prose', '// Source: https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html (fetched 2026-09-22): access is on'],
    ['an aside with the prose on the next lines', '// Source (AWS, verified 2026-10-19):'],
    ['an aside that never closes with a colon', '// Source (AWS, verified 2026-10-16). S3 API Reference "Permissions" sections'],
    ['an aside followed by more text before the colon', '// Source (verified at adp/v0.2.86, 2026-10-15), for the user prerequisite: a session needs a key'],
    ['a URL, a quote, then prose', '// Source: https://api.freshservice.com/ "View List of Tickets" (verified 2026-09-22) documents filter'],
    ['a hyphenated word then prose (a KIP citation)', '// Source: KIP-848 consumer group protocol'],
    ['a Jira key followed by prose', '// Source: DOC-1234 says so'],
    ['a lowercase key-like word', '// Source: doc-123'],
    ['a capitalized key-like word', '// Source: Word-123 means something']
  ])('free-form note (%s) is an unchecked-note info finding, never an error', async (_, comment) => {
    const { result, client } = await check(`${comment}\n// more prose on the next line\nClaim.\n`, { files: FILES })
    expect(result.findings.map((f) => [f.rule, f.severity])).toEqual([['unchecked-note', 'info']])
    expect(result.summary).toEqual({ checked: 0, failed: 0, notes: 1, errors: 0, warnings: 0, info: 1 })
    expect(client.calls).toEqual({ getFile: [], getPull: [], headUrl: [] })
  })

  test('parseSourceComment returns { note } for prose', () => {
    expect(parseSourceComment(' see the controller code')).toEqual({ note: 'see the controller code' })
  })

  test.each([
    ['a malformed file ref', '// Source: redpanda-data/connect:main.go', /unrecognized ref/],
    ['a file ref followed by prose', '// Source: redpanda-data/streaming-enterprise:src/config.go:5 checked 2026-10-20', /unexpected text after the ref.*put prose on its own comment line/],
    ['a quote followed by prose', '// Source: redpanda-data/streaming-enterprise:src/config.go:5 "return 1073741824" (checked)', /unexpected text after the ref/],
    ['a PR ref followed by prose', '// Source: redpanda-data/connect#12 and later fixes', /unexpected text after the ref/],
    ['a foreign owner', '// Source (verified): someone-else/connect:main.go:3', /owner must be redpanda-data/],
    ['an empty marker', '// Source:', /empty source comment/]
  ])('a malformed ref (%s) is still an error in the new spelling', async (_, comment, re) => {
    const { result } = await check(`${comment}\nClaim.\n`, { files: FILES })
    expect(result.findings.map((f) => f.rule)).toEqual(['malformed'])
    expect(result.findings[0].message).toMatch(re)
    expect(result.summary).toMatchObject({ checked: 1, failed: 1, notes: 0, errors: 1 })
  })

  test('stacked comments in mixed case share the claim below them; a note is not a no-claim warning', async () => {
    const doc = ['// Source: DOC-1', '// source: redpanda-data/docs#5', '// Source (aside): prose', 'Claim.', '', '// Source: a note above a blank line', ''].join('\n')
    const found = extractSources(doc)
    expect(found.map((s) => [s.line, s.claimLine])).toEqual([[1, 4], [2, 4], [3, 4], [6, null]])
    const { rules } = await check(doc, { pulls: { 'docs#5': 'merged' } })
    expect(rules).toEqual(['syntax-only', 'pr-state', 'unchecked-note', 'unchecked-note'])
  })

  test('Source comments inside listing blocks and comment blocks are still skipped', () => {
    const doc = ['----', '// Source: DOC-2', '----', '////', '// SOURCE: DOC-3', '////', '// Source: DOC-4', 'Claim.'].join('\n')
    expect(extractSources(doc).map((s) => s.line)).toEqual([7])
  })

  test('words that merely start with source are not source comments', () => {
    const doc = ['//   source object and s3:PutObject permission', '// Sources are listed below', '// sourcemap: on', 'Claim.'].join('\n')
    expect(extractSources(doc)).toEqual([])
  })
})

describe('createGitHubClient (stubbed fetch)', () => {
  function fakeFetch (routes) {
    const seen = []
    const impl = async (url, init = {}) => {
      seen.push({ url, init })
      const route = routes.find(([re]) => re.test(url))
      if (!route) throw new Error('getaddrinfo ENOTFOUND api.github.com')
      const [, status, body = '', contentType = 'text/plain', extraHeaders = {}] = route
      const hdrs = { 'content-type': contentType, ...extraHeaders }
      return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (name) => hdrs[name.toLowerCase()] ?? null },
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
      const client = createGitHubClient({ token: 't', fetchImpl: fakeFetch([[/contents/, status]]), sleep: async () => {} })
      expect((await client.getFile({ owner: 'redpanda-data', repo: 'r', ref: null, path: 'a' })).status).toBe('unreachable')
    }
    const offline = createGitHubClient({ token: 't', fetchImpl: fakeFetch([]), sleep: async () => {} })
    const got = await offline.getFile({ owner: 'redpanda-data', repo: 'r', ref: null, path: 'a' })
    expect(got).toEqual({ status: 'unreachable', reason: 'redpanda-data/r:a: getaddrinfo ENOTFOUND api.github.com' })
  })

  test('PR state: merged_at wins over closed (read through /issues, which answers for PRs too)', async () => {
    const client = createGitHubClient({ token: 't', fetchImpl: fakeFetch([[/issues\/1$/, 200, '{"state":"closed","pull_request":{"merged_at":"2026-01-01T00:00:00Z"}}', 'application/json'], [/issues\/2$/, 200, '{"state":"closed","pull_request":{"merged_at":null}}', 'application/json']]) })
    expect(await client.getPull({ owner: 'redpanda-data', repo: 'r', number: 1 })).toMatchObject({ status: 'ok', kind: 'pr', state: 'merged' })
    expect(await client.getPull({ owner: 'redpanda-data', repo: 'r', number: 2 })).toMatchObject({ status: 'ok', kind: 'pr', state: 'closed' })
  })

  // Review 419 point 7: an issue cited as owner/repo#n is not a missing PR.
  test('an issue number resolves as an issue, not pr-not-found', async () => {
    const fetchImpl = fakeFetch([[/issues\/7$/, 200, '{"state":"open","title":"Bug"}', 'application/json']])
    const client = createGitHubClient({ token: 't', fetchImpl })
    expect(await client.getPull({ owner: 'redpanda-data', repo: 'r', number: 7 })).toMatchObject({ status: 'ok', kind: 'issue', state: 'open' })
    expect(fetchImpl.seen.map((s) => s.url)).toEqual(['https://api.github.com/repos/redpanda-data/r/issues/7'])
    const root = makeRepo({ 'modules/ROOT/pages/p.adoc': '// source: redpanda-data/r#7\nClaim.\n' })
    const result = await checkSources({ files: ['modules/ROOT/pages/p.adoc'], root, client })
    expect(result.findings.map((f) => [f.rule, f.message])).toEqual([['pr-state', 'redpanda-data/r#7 is an issue, open']])
    // Control: a number that is neither is still an error.
    const gone = createGitHubClient({ token: 't', fetchImpl: fakeFetch([[/issues\/8$/, 404], [/repos\/redpanda-data\/r$/, 200, '{}']]) })
    expect(await gone.getPull({ owner: 'redpanda-data', repo: 'r', number: 8 })).toMatchObject({ status: 'missing' })
  })

  // Review 419 blocker 1: a misspelled repo must not only ever warn.
  describe('a repo 404', () => {
    const fileIn = (client) => client.getFile({ owner: 'redpanda-data', repo: 'redpnda', ref: null, path: 'src/v/config/configuration.cc' })
    test('is repo-not-found (an error) for a classic token with the repo scope', async () => {
      const client = createGitHubClient({ token: 't', fetchImpl: fakeFetch([[/contents/, 404], [/issues\/3$/, 404], [/repos\/redpanda-data\/redpnda$/, 404, '', 'application/json', { 'x-oauth-scopes': 'read:org, repo, workflow' }]]), sleep: async () => {} })
      const got = await fileIn(client)
      expect(got).toMatchObject({ status: 'missing', repoMissing: true })
      expect(got.reason).toMatch(/redpanda-data\/redpnda: repository does not exist/)
      const root = makeRepo({ 'modules/ROOT/pages/p.adoc': '// Source: redpanda-data/redpnda:src/v/config/configuration.cc:120 "foo"\nClaim.\n\n// Source: redpanda-data/redpnda#3\nClaim.\n' })
      const result = await checkSources({ files: ['modules/ROOT/pages/p.adoc'], root, client })
      expect(result.findings.map((f) => [f.rule, f.severity])).toEqual([['repo-not-found', 'error'], ['repo-not-found', 'error']])
    })
    test.each([
      ['no token', null, [[/contents/, 404], [/repos\/redpanda-data\/redpnda$/, 404]]],
      // Review 419 round 3: a fine-grained or app token limited to selected
      // repos sees some private repos but 404s on a real one such as cloudv2.
      ['a selected-repos token that sees other private repos', 't', [[/contents/, 404], [/repos\/redpanda-data\/redpnda$/, 404], [/orgs\/redpanda-data\/repos/, 200, '[{"name":"streaming-enterprise"}]', 'application/json']]],
      ['a classic token without the repo scope', 't', [[/contents/, 404], [/repos\/redpanda-data\/redpnda$/, 404, '', 'application/json', { 'x-oauth-scopes': 'public_repo, read:org' }]]]
    ])('stays unreachable (a warning) with %s, since the repo may be private', async (_, token, routes) => {
      const got = await fileIn(createGitHubClient({ token, fetchImpl: fakeFetch(routes), sleep: async () => {} }))
      expect(got.status).toBe('unreachable')
      expect(got.repoMissing).toBeUndefined()
    })
  })

  // Review 419 blocker 2: an inconclusive ref check is never "file does not exist".
  describe('the ref check after a file 404', () => {
    const base = [[/contents/, 404], [/repos\/redpanda-data\/r$/, 200, '{}']]
    const get = (routes) => createGitHubClient({ token: 't', fetchImpl: fakeFetch(routes), sleep: async () => {} })
      .getFile({ owner: 'redpanda-data', repo: 'r', ref: 'v1', path: 'a' })
    test.each([401, 403, 429, 500])('HTTP %i is unreachable, not missing', async (status) => {
      const got = await get([...base, [/commits\/v1$/, status]])
      expect(got.status).toBe('unreachable')
      expect(got.reason).toMatch(new RegExp(`redpanda-data/r@v1: HTTP ${status}`))
    })
    test('a network error is unreachable, not missing', async () => {
      expect((await get(base)).status).toBe('unreachable')
    })
    test('controls: 404 or 422 means the ref is missing; 200 means the file is missing at that ref', async () => {
      expect(await get([...base, [/commits\/v1$/, 404]])).toEqual({ status: 'missing', reason: 'ref v1 does not exist in redpanda-data/r' })
      expect(await get([...base, [/commits\/v1$/, 422]])).toEqual({ status: 'missing', reason: 'ref v1 does not exist in redpanda-data/r' })
      expect(await get([...base, [/commits\/v1$/, 200, '{}']])).toEqual({ status: 'missing', reason: 'a does not exist in redpanda-data/r at v1' })
    })
  })

  // Review 419 point 6: GitHub serves a raw file as application/vnd.github.raw+json
  // and a directory listing as application/json (checked against the live API).
  test('a raw file that starts with [ is a file; only an application/json listing is a directory', async () => {
    const toml = '[package]\nname = "x"\n'
    const file = createGitHubClient({ token: 't', fetchImpl: fakeFetch([[/contents/, 200, toml, 'application/vnd.github.raw+json; charset=utf-8']]) })
    expect(await file.getFile({ owner: 'redpanda-data', repo: 'r', ref: null, path: 'Cargo.toml' })).toEqual({ status: 'ok', text: toml })
    const arrayJson = '[1, 2, 3]\n'
    const json = createGitHubClient({ token: 't', fetchImpl: fakeFetch([[/contents/, 200, arrayJson, 'application/vnd.github.raw+json; charset=utf-8']]) })
    expect((await json.getFile({ owner: 'redpanda-data', repo: 'r', ref: null, path: 'list.json' })).status).toBe('ok')
    const listing = JSON.stringify([{ name: 'a.go', path: 'src/a.go', type: 'file' }])
    const dir = createGitHubClient({ token: 't', fetchImpl: fakeFetch([[/contents/, 200, listing, 'application/json; charset=utf-8']]) })
    expect(await dir.getFile({ owner: 'redpanda-data', repo: 'r', ref: null, path: 'src' })).toEqual({ status: 'missing', reason: 'redpanda-data/r:src is a directory' })
  })

  // Review 419 point 8.
  test('a request that never answers times out as unreachable', async () => {
    const hang = (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason))
    })
    const client = createGitHubClient({ token: 't', fetchImpl: hang, timeoutMs: 50, retries: 0 })
    const got = await client.getFile({ owner: 'redpanda-data', repo: 'r', ref: null, path: 'a' })
    expect(got).toEqual({ status: 'unreachable', reason: 'redpanda-data/r:a: no response within 0.05s' })
    const head = await createGitHubClient({ token: 't', fetchImpl: hang, timeoutMs: 50, retries: 0 }).headUrl('https://a.example.com/')
    expect(head).toEqual({ status: 'unreachable', reason: 'no response within 0.05s' })
  })

  // Review 419 point 10: transient failures are retried instead of surfacing as warnings.
  describe('retries', () => {
    function sequence (responses) {
      const seen = []
      const impl = async (url) => {
        seen.push(url)
        const next = responses[Math.min(seen.length - 1, responses.length - 1)]
        if (next instanceof Error) throw next
        const [status, body = '', hdrs = {}] = next
        return { ok: status >= 200 && status < 300, status, headers: { get: (n) => hdrs[n.toLowerCase()] ?? null }, text: async () => body, json: async () => JSON.parse(body) }
      }
      impl.seen = seen
      return impl
    }
    const run = async (responses, opts = {}) => {
      const fetchImpl = sequence(responses)
      const waits = []
      const client = createGitHubClient({ token: 't', fetchImpl, sleep: async (ms) => { waits.push(ms) }, ...opts })
      const got = await client.getFile({ owner: 'redpanda-data', repo: 'r', ref: null, path: 'a' })
      return { got, calls: fetchImpl.seen.length, waits }
    }
    test('a 5xx, then success, is ok', async () => {
      expect(await run([[502], [200, 'x\n']])).toEqual({ got: { status: 'ok', text: 'x\n' }, calls: 2, waits: [1000] })
    })
    test('a network error, then success, is ok', async () => {
      expect(await run([new Error('ECONNRESET'), [200, 'x\n']])).toMatchObject({ got: { status: 'ok' }, calls: 2 })
    })
    test('a secondary rate limit waits for Retry-After', async () => {
      expect(await run([[403, '', { 'retry-after': '3' }], [200, 'x\n']])).toEqual({ got: { status: 'ok', text: 'x\n' }, calls: 2, waits: [3000] })
    })
    test('controls: a plain 403, or a Retry-After over a minute, is not retried', async () => {
      expect(await run([[403], [200, 'x\n']])).toMatchObject({ got: { status: 'unreachable' }, calls: 1, waits: [] })
      expect(await run([[429, '', { 'retry-after': '3600' }], [200, 'x\n']])).toMatchObject({ got: { status: 'unreachable' }, calls: 1 })
    })
    test('retries are bounded: a persistent 5xx is unreachable after 3 attempts', async () => {
      expect(await run([[503]])).toMatchObject({ got: { status: 'unreachable' }, calls: 3, waits: [1000, 2000] })
      expect(await run([[503]], { retries: 0 })).toMatchObject({ got: { status: 'unreachable' }, calls: 1 })
    })
  })
})

// Review 419 point 9.
describe('checkSources: concurrent fetches', () => {
  function slowClient () {
    let inFlight = 0
    const stats = { max: 0 }
    const client = {
      authenticated: true,
      stats,
      async getFile ({ path: p }) {
        inFlight++
        stats.max = Math.max(stats.max, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 20))
        inFlight--
        return p === 'gone.go' ? { status: 'missing', reason: 'gone.go does not exist' } : { status: 'ok', text: 'one\n' }
      },
      async getPull () { return { status: 'ok', state: 'open' } },
      async headUrl () { return { status: 'ok' } }
    }
    return client
  }
  const page = ['a', 'b', 'gone', 'c', 'd', 'e'].map((n) => `// source: redpanda-data/r:${n}.go:1\nClaim ${n}.\n`).join('\n')

  test('independent fetches overlap, bounded by concurrency, and findings keep page order', async () => {
    const root = makeRepo({ 'modules/ROOT/pages/p.adoc': page })
    const client = slowClient()
    const result = await checkSources({ files: ['modules/ROOT/pages/p.adoc'], root, client, concurrency: 3 })
    expect(client.stats.max).toBe(3)
    expect(result.findings.map((f) => [f.rule, f.line])).toEqual([['missing-file', 7]])
    expect(result.fetches).toBe(6)
  })

  test('control: concurrency 1 runs one fetch at a time', async () => {
    const root = makeRepo({ 'modules/ROOT/pages/p.adoc': page })
    const client = slowClient()
    await checkSources({ files: ['modules/ROOT/pages/p.adoc'], root, client, concurrency: 1 })
    expect(client.stats.max).toBe(1)
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
      'modules/a/pages/bad.adoc': '// source: redpanda-data/connect:main.go\nClaim.\n',
      'modules/a/pages/note.adoc': '// Source: free-form prose that is never checked\nClaim.\n',
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
      expect(json.summary).toEqual({ checked: 2, failed: 1, notes: 1, errors: 1, warnings: 1, info: 1 })
      await runCli({ root, files: 'modules/a/pages/note.adoc' }, { client: stubClient() })
      expect(process.exitCode).toBe(0)
      await runCli({ root, diff: 'main' }, { client: stubClient() })
      expect(process.exitCode).toBe(2)
    } finally {
      process.exitCode = undefined
      log.mockRestore()
      err.mockRestore()
    }
  })

  test('human output lists errors first and ends with a summary line', async () => {
    const { result } = await check('// source: DOC-1\nA.\n\n// source: redpanda-data/connect:main.go\nB.\n\n// Source: a note\nC.\n', {})
    const text = formatHuman(result)
    expect(text.split('\n')[0]).toMatch(/^ERROR {3}modules\/ROOT\/pages\/p\.adoc:4 \[malformed\]/)
    expect(text).toMatch(/check-sources: 3 source comment\(s\) in 1 file\(s\): 2 checked, 1 failed, 1 unchecked note\(s\); 0 fetch\(es\): 1 error\(s\), 0 warning\(s\), 2 info$/)
  })

  // Review 419 blocker 3: a brace glob must not split into patterns that match nothing.
  test('splitList keeps commas inside {...} and flattens repeated values', () => {
    expect(splitList('modules/{manage,get-started}/**/*.adoc')).toEqual(['modules/{manage,get-started}/**/*.adoc'])
    expect(splitList('a/*.adoc, modules/{x,{y,z}}/*.adoc,b.adoc')).toEqual(['a/*.adoc', 'modules/{x,{y,z}}/*.adoc', 'b.adoc'])
    expect(splitList(['a.adoc', 'b.adoc,c.adoc'])).toEqual(['a.adoc', 'b.adoc', 'c.adoc'])
  })

  test('a brace glob selects files from every branch', () => {
    const root = makeRepo({ 'modules/manage/pages/m.adoc': '= M\n', 'modules/get-started/pages/g.adoc': '= G\n', 'modules/other/pages/o.adoc': '= O\n' })
    expect(selectFiles({ root, files: splitList('modules/{manage,get-started}/**/*.adoc') })).toEqual(['modules/get-started/pages/g.adoc', 'modules/manage/pages/m.adoc'])
  })

  test('an explicit --files glob that matches nothing exits 2; with --diff an empty selection is fine', async () => {
    const root = gitRepo()
    expect(() => selectFiles({ root, files: ['modules/{manage'] })).toThrow(/--files pattern "modules\/\{manage" matched no \.adoc files/)
    expect(() => selectFiles({ root, files: ['modules/a/pages/one.adoc', 'nope/*.adoc'] })).toThrow(/"nope\/\*\.adoc" matched no/)
    expect(selectFiles({ root, diff: 'main', files: ['nope/*.adoc'] })).toEqual([])
    const err = jest.spyOn(console, 'error').mockImplementation(() => {})
    const log = jest.spyOn(console, 'log').mockImplementation(() => {})
    try {
      process.exitCode = undefined
      await runCli({ root, files: ['modules/missing/**/*.adoc'] }, { client: stubClient() })
      expect(process.exitCode).toBe(2)
      await runCli({ root, files: ['modules/a/pages/one.adoc'] }, { client: stubClient() })
      expect(process.exitCode).toBe(0)
      await runCli({ root, diff: 'HEAD' }, { client: stubClient() })
      expect(process.exitCode).toBe(0)
      expect(err.mock.calls.flat().join('\n')).toMatch(/no \.adoc files changed against HEAD; nothing to check/)
    } finally {
      process.exitCode = undefined
      err.mockRestore()
      log.mockRestore()
    }
  })

  // Review 419 point 4.
  test('--diff works when --root is a subdirectory of the repo', () => {
    const top = makeRepo({ 'docs/modules/a/pages/one.adoc': '= One\n', 'other/x.adoc': '= X\n' })
    const git = (...args) => {
      const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: top, encoding: 'utf8' })
      if (r.status !== 0) throw new Error(r.stderr)
    }
    git('init', '-q', '-b', 'main'); git('add', '.'); git('commit', '-q', '-m', 'base'); git('checkout', '-q', '-b', 'feature')
    fs.writeFileSync(path.join(top, 'docs/modules/a/pages/one.adoc'), '= One\n\nChanged.\n')
    fs.writeFileSync(path.join(top, 'other/x.adoc'), '= X\n\nChanged.\n')
    git('commit', '-qam', 'change')
    expect(selectFiles({ root: path.join(top, 'docs'), diff: 'main' })).toEqual(['modules/a/pages/one.adoc'])
    expect(selectFiles({ root: top, diff: 'main' })).toEqual(['docs/modules/a/pages/one.adoc', 'other/x.adoc'])
  })

  test('the binary accepts a repeated --files flag and a brace glob', () => {
    const root = makeRepo({ 'modules/a/pages/one.adoc': '= One\n', 'modules/b/pages/two.adoc': '= Two\n', 'modules/c/pages/three.adoc': '= Three\n' })
    const r = spawnSync(process.execPath, [BIN, 'check-sources', '--root', root, '--files', 'modules/{a,b}/**/*.adoc', '--files', 'modules/c/pages/three.adoc'], { encoding: 'utf8' })
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/0 source comment\(s\) in 3 file\(s\)/)
    const bad = spawnSync(process.execPath, [BIN, 'check-sources', '--root', root, '--files', 'modules/{a,b'], { encoding: 'utf8' })
    expect(bad.status).toBe(2)
  })

  test('the doc-tools binary registers the command and passes on a page with no sources', () => {
    const root = makeRepo({ 'modules/a/pages/none.adoc': '= None\n\nNo sources here.\n' })
    const r = spawnSync(process.execPath, [BIN, 'check-sources', '--root', root], { encoding: 'utf8' })
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/0 source comment\(s\) in 1 file\(s\)/)
  })
})

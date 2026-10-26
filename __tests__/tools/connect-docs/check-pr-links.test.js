'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { USER_AGENT, extractAddedUrls, checkLinks, runCli } = require('../../../tools/connect-docs/check-pr-links')

// A PR diff shaped like connect#4834's: a Go spec that changes one doc-string
// URL, keeps one as context, and removes one, plus a test file and a docs
// partial.
const DIFF = `diff --git a/internal/impl/snowflake/output.go b/internal/impl/snowflake/output.go
index 1111111..2222222 100644
--- a/internal/impl/snowflake/output.go
+++ b/internal/impl/snowflake/output.go
@@ -10,5 +10,7 @@ func spec() *service.ConfigSpec {
 \t\tDescription("Context line: https://context.redpanda.test/kept").
-\t\tField(service.NewStringField("a").Description("See https://docs.snowflake.com/en/removed[the old page].")).
+\t\tField(service.NewStringField("a").Description("See https://docs.snowflake.com/en/user-guide/admin-privatelink[PrivateLink].")).
+\t\tField(service.NewStringField("b").Description(\`Raw string with https://raw.redpanda.test/page, and more.\`)).
+\t\t// A comment with https://comment.redpanda.test/skipped
+\t\tField(service.NewURLField("c").Default("http://localhost:4195").Example("https://%s.blob.core.windows.net"))
+\t\tField(service.NewURLField("d").Description(\`Default \`+"\`https://ORG-ACCOUNT.snowflakecomputing.com\`"+\`.\`))
 \t\tVersion("4.80.0")
diff --git a/internal/impl/snowflake/output_test.go b/internal/impl/snowflake/output_test.go
--- a/internal/impl/snowflake/output_test.go
+++ b/internal/impl/snowflake/output_test.go
@@ -1,1 +1,2 @@
 package snowflake
+var u = "https://test-file.redpanda.test/skipped"
diff --git a/docs/modules/components/partials/x.adoc b/docs/modules/components/partials/x.adoc
new file mode 100644
--- /dev/null
+++ b/docs/modules/components/partials/x.adoc
@@ -0,0 +1,2 @@
+= Title
+For details, see https://partial.redpanda.test/page.
`

describe('extractAddedUrls', () => {
  const found = extractAddedUrls(DIFF)

  test('returns the URLs on added lines of doc-string sources, with new-side line numbers', () => {
    expect(found).toEqual([
      { url: 'https://docs.snowflake.com/en/user-guide/admin-privatelink', file: 'internal/impl/snowflake/output.go', line: 11 },
      { url: 'https://raw.redpanda.test/page', file: 'internal/impl/snowflake/output.go', line: 12 },
      { url: 'https://partial.redpanda.test/page', file: 'docs/modules/components/partials/x.adoc', line: 2 }
    ])
  })

  test('skips removed and context lines, comments, inline code, test files, placeholders, and local hosts', () => {
    const urls = found.map((f) => f.url).join(' ')
    for (const skipped of ['removed', 'context.redpanda.test', 'comment.redpanda.test', 'test-file', 'localhost', 'blob.core', 'ORG-ACCOUNT']) {
      expect(urls).not.toContain(skipped)
    }
  })

  test('an empty diff has no URLs', () => {
    expect(extractAddedUrls('')).toEqual([])
  })
})

const response = (status) => Promise.resolve({ status })

describe('checkLinks classification', () => {
  const statusFor = { 'https://a.test/ok': 200, 'https://a.test/gone': 410, 'https://a.test/missing': 404, 'https://a.test/walled': 403, 'https://a.test/auth': 401, 'https://a.test/limited': 429, 'https://a.test/down': 503 }
  const fetchFn = jest.fn((url) => url === 'https://a.test/slow' ? Promise.reject(new Error('timeout')) : response(statusFor[url]))
  const found = [...Object.keys(statusFor), 'https://a.test/slow'].map((url, i) => ({ url, file: 'f.go', line: i + 1 }))

  test('only 404 and 410 are broken; 401, 403, 429, 5xx, and timeouts could not be checked', async () => {
    const report = await checkLinks(found, { fetchFn })
    expect(report.checked).toBe(8)
    expect(report.ok).toBe(1)
    expect(report.broken.map((r) => [r.url, r.status])).toEqual([['https://a.test/gone', 410], ['https://a.test/missing', 404]])
    expect(report.unverifiable.map((r) => r.url).sort()).toEqual(['https://a.test/auth', 'https://a.test/down', 'https://a.test/limited', 'https://a.test/slow', 'https://a.test/walled'])
  })

  test('sends a browser-like user agent', async () => {
    fetchFn.mockClear()
    await checkLinks([found[0]], { fetchFn })
    expect(fetchFn.mock.calls[0][1].headers['user-agent']).toBe(USER_AGENT)
    expect(USER_AGENT).toMatch(/^Mozilla\/5\.0/)
  })
})

describe('runCli', () => {
  // Negative control: the 404 URL is annotated, the 403 one is not.
  test('annotates the 404 URL at its file and line, and not the 403 one', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpl-'))
    const diffFile = path.join(dir, 'pr.diff')
    fs.writeFileSync(diffFile, `diff --git a/x.go b/x.go
--- a/x.go
+++ b/x.go
@@ -1,1 +1,3 @@
 package x
+const a = "See https://dead.redpanda.test/page[dead]."
+const b = "See https://walled.redpanda.test/page[walled]."
`)
    const fetchFn = (url) => response(url.includes('dead') ? 404 : 403)
    const out = []
    const report = await runCli(['--diff', diffFile, '--output', path.join(dir, 'r.json'), '--summary', path.join(dir, 's.md')], { fetchFn, log: (s) => out.push(s) })
    expect(out).toEqual(['::warning file=x.go,line=2::Broken link https://dead.redpanda.test/page (HTTP 404). Advisory: this does not fail the check.'])
    expect(report.unverifiable.map((r) => r.url)).toEqual(['https://walled.redpanda.test/page'])
    const md = fs.readFileSync(path.join(dir, 's.md'), 'utf8')
    expect(md).toContain('Checked 2 URLs: 0 ok, 1 broken (404 or 410), 1 couldn\'t check.')
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'r.json'), 'utf8')).broken[0].locations).toEqual([{ file: 'x.go', line: 2 }])
  })
})

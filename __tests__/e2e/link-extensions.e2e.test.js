'use strict'

/**
 * End-to-end test: runs a real Antora build over a tiny fixture site with the
 * url-to-xref and external-link-checker extensions registered, then asserts
 * on the published HTML and the structured build log. No external network —
 * external links point at a local HTTP server started by the test.
 */

const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const generateSite = require('@antora/site-generator')

const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'e2e-site')

jest.setTimeout(120000)

function copyDir (src, dest) {
  fs.cpSync(src, dest, { recursive: true })
}

function gitInit (dir) {
  const git = (...args) =>
    execFileSync('git', args, { cwd: dir, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  git('add', '.')
  git('commit', '-q', '-m', 'fixture')
}

function startServer () {
  const requests = []
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`)
    if (req.url === '/ok') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
    } else {
      res.writeHead(404)
      res.end()
    }
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, requests, port: server.address().port }))
  })
}

describe('link extensions end-to-end', () => {
  let workDir
  let outDir
  let buildOutput
  let server
  let requests

  beforeAll(async () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'link-extensions-e2e-'))
    outDir = path.join(workDir, 'out')
    copyDir(path.join(FIXTURE_DIR, 'streaming'), path.join(workDir, 'streaming'))
    copyDir(path.join(FIXTURE_DIR, 'connect'), path.join(workDir, 'connect'))

    const external = await startServer()
    server = external.server
    requests = external.requests
    const externalBase = `http://127.0.0.1:${external.port}`

    const linksPage = path.join(workDir, 'streaming', 'modules', 'manage', 'pages', 'links.adoc')
    fs.writeFileSync(linksPage, fs.readFileSync(linksPage, 'utf8').replaceAll('@EXTERNAL_BASE@', externalBase))

    gitInit(path.join(workDir, 'streaming'))
    gitInit(path.join(workDir, 'connect'))

    // Install this repo into the fixture site's node_modules (as a symlink)
    // and register the extensions by their package specifiers, so the build
    // exercises the real package.json exports map exactly the way the
    // docs-site playbook consumes them. A missing exports entry fails here.
    const repoRoot = path.join(__dirname, '..', '..')
    const packageDir = path.join(workDir, 'node_modules', '@redpanda-data')
    fs.mkdirSync(packageDir, { recursive: true })
    fs.symlinkSync(repoRoot, path.join(packageDir, 'docs-extensions-and-macros'), 'dir')

    const playbook = [
      'site:',
      '  title: E2E Site',
      '  url: https://docs.redpanda.com',
      'urls:',
      '  html_extension_style: indexify',
      "  latest_version_segment: 'current'",
      '  latest_version_segment_strategy: redirect:to',
      'content:',
      '  sources:',
      `  - url: ${path.join(workDir, 'streaming')}`,
      '    branches: HEAD',
      `  - url: ${path.join(workDir, 'connect')}`,
      '    branches: HEAD',
      'ui:',
      '  bundle:',
      `    url: ${path.join(FIXTURE_DIR, 'ui-bundle.zip')}`,
      'antora:',
      '  extensions:',
      "  - require: '@redpanda-data/docs-extensions-and-macros/extensions/url-to-xref'",
      "  - require: '@redpanda-data/docs-extensions-and-macros/extensions/external-link-checker'",
      '',
    ].join('\n')
    const playbookPath = path.join(workDir, 'antora-playbook.yml')
    fs.writeFileSync(playbookPath, playbook)

    // Run the build in-process so the extensions and the fixture HTTP server
    // share a process, and capture the structured log via --log-file.
    const logPath = path.join(workDir, 'build-log.json')
    await generateSite([
      '--playbook', playbookPath,
      '--to-dir', outDir,
      '--log-format', 'json',
      '--log-level', 'info',
      '--log-file', logPath,
    ])
    buildOutput = fs.readFileSync(logPath, 'utf8')
  })

  afterAll(() => {
    if (server) {
      if (server.closeAllConnections) server.closeAllConnections()
      server.close()
    }
    if (workDir) fs.rmSync(workDir, { recursive: true, force: true })
  })

  function readLinksPage () {
    return fs.readFileSync(path.join(outDir, 'streaming', 'current', 'manage', 'links', 'index.html'), 'utf8')
  }

  // Antora renders resolved xrefs as relative URLs with class="xref page";
  // an unconverted URL would render with class="bare" instead.
  test('converts internal URLs to xrefs that resolve to published pages', () => {
    const html = readLinksPage()
    expect(html).toMatch(/href="[^"]*\/connect\/configuration\/secrets\/" class="xref page">Secrets</)
    expect(html).toMatch(/href="[^"]*\/connect\/configuration\/secrets\/" class="xref page">Legacy secrets</)
    expect(html).toMatch(/href="[^"]*\/connect\/home\/" class="xref page">Connect Home</)
  })

  test('preserves fragments and labels through conversion', () => {
    const html = readLinksPage()
    expect(html).toMatch(/href="[^"]*\/connect\/configuration\/secrets\/#store" class="xref page">Store secrets</)
  })

  test('converts same-component URLs and auto-fills unlabeled link text', () => {
    const html = readLinksPage()
    expect(html).toMatch(/href="[^"]*target\/" class="xref page">Target Page</)
  })

  test('leaves unmappable internal URLs as raw links and warns', () => {
    const html = readLinksPage()
    expect(html).toContain('href="https://docs.redpanda.com/no/such/page/"')
    expect(buildOutput).toContain('No published page matches https://docs.redpanda.com/no/such/page/')
  })

  test('leaves URLs in code blocks untouched', () => {
    const html = readLinksPage()
    expect(html).toMatch(/<pre[^>]*>[\s\S]*?curl https:\/\/docs\.redpanda\.com\/connect\/configuration\/secrets\/[\s\S]*?<\/pre>/)
  })

  test('reports the broken external link but not the healthy one', () => {
    expect(requests.some((line) => line.includes('/missing'))).toBe(true)
    expect(requests.some((line) => line.includes('/ok'))).toBe(true)
    expect(buildOutput).toMatch(/Broken external link http:\/\/127\.0\.0\.1:\d+\/missing \(HTTP 404\)/)
    expect(buildOutput).not.toMatch(/Broken external link http:\/\/127\.0\.0\.1:\d+\/ok/)
    expect(buildOutput).toContain('Checked 2 external links: 1 ok, 1 broken, 0 unverifiable')
  })

  test('produces no unresolved-xref warnings for converted links', () => {
    expect(buildOutput).not.toContain('target of xref not found')
  })
})

'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const {
  buildDocsResolverContext,
  convertDocsLinks,
  convertDocsLinksInFile,
  formatDocsLinkReport,
} = require('../../cli-utils/docs-links-to-xrefs')

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'docs-links-component')

/**
 * The converter reads the docs checkout the way Antora does, through the
 * content aggregator, which wants a git repository with a HEAD. The fixture
 * is copied into a throwaway repository and committed once per run.
 */
function makeDocsCheckout () {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-links-fixture-'))
  fs.cpSync(FIXTURE, root, { recursive: true })
  const git = (...args) => {
    const result = spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], {
      cwd: root,
      encoding: 'utf8',
    })
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  }
  git('init', '-q')
  git('add', '.')
  git('commit', '-q', '-m', 'fixture')
  return root
}

describe('docs-links-to-xrefs', () => {
  jest.setTimeout(60000)
  let docsRoot
  let context

  beforeAll(async () => {
    docsRoot = makeDocsCheckout()
    context = await buildDocsResolverContext(docsRoot, { cacheDir: path.join(docsRoot, '.antora-cache') })
  })

  afterAll(() => {
    fs.rmSync(docsRoot, { recursive: true, force: true })
  })

  const convert = (text) => convertDocsLinks(text, context)

  test('builds the catalog from the checkout and names its component', () => {
    expect(context.component).toBe('streaming')
    expect(context.pageCount).toBe(3)
    expect(context.urls.get('/streaming/current/manage/kubernetes/manage-resources')).toMatchObject({
      module: 'manage',
      relative: 'kubernetes/manage-resources.adoc',
      latest: true,
    })
  })

  test('converts a current URL into a same-component xref and keeps the sentence punctuation', () => {
    const { content, converted } = convert(
      'CPU configures CPU resources for containers. See https://docs.redpanda.com/current/manage/kubernetes/manage-resources/.'
    )
    expect(content).toBe(
      'CPU configures CPU resources for containers. See xref:manage:kubernetes/manage-resources.adoc[].'
    )
    expect(converted).toBe(1)
  })

  test.each([
    ['the real version number', 'https://docs.redpanda.com/26.2/manage/kubernetes/manage-resources/'],
    ['a v-prefixed version number', 'https://docs.redpanda.com/v26.2/manage/kubernetes/manage-resources/'],
    ['the component and version', 'https://docs.redpanda.com/streaming/26.2/manage/kubernetes/manage-resources/'],
    ['the component and symbolic segment', 'https://docs.redpanda.com/streaming/current/manage/kubernetes/manage-resources/'],
  ])('converts a URL versioned with %s into the unversioned same-component xref', (_, url) => {
    expect(convert(url).content).toBe('xref:manage:kubernetes/manage-resources.adoc[]')
  })

  // The extension does the same in a site build that no longer publishes the
  // old version: the candidate list falls through to the latest version.
  test('resolves a URL pinned to a version the checkout does not have against the current page', () => {
    expect(convert('https://docs.redpanda.com/25.3/manage/kubernetes/manage-resources/').content).toBe(
      'xref:manage:kubernetes/manage-resources.adoc[]'
    )
  })

  test('leaves an external URL unchanged', () => {
    const input =
      'See the GitHub issue https://github.com/redpanda-data/redpanda/issues/350 and link:https://kubernetes.io/docs/concepts/[Kubernetes].'
    const result = convert(input)
    expect(result.content).toBe(input)
    expect(result.converted).toBe(0)
    expect(result.unmapped).toEqual([])
  })

  test('keeps an anchor fragment and labels it with the heading from the included partial', () => {
    expect(
      convert('Enable with https://docs.redpanda.com/current/reference/properties/cluster-properties/#cloud_storage_enabled.')
        .content
    ).toBe('Enable with xref:reference:properties/cluster-properties.adoc#cloud_storage_enabled[cloud_storage_enabled].')
  })

  test('labels a fragment that points at a heading on the page itself', () => {
    expect(convert('https://docs.redpanda.com/current/get-started/architecture/#thread-per-core-model').content).toBe(
      'xref:get-started:architecture.adoc#thread-per-core-model[Thread-per-core model]'
    )
  })

  test('resolves a legacy /docs/ URL of a moved page through its page alias', () => {
    // The page moved to properties/ and declares the old paths as aliases.
    expect(
      convert('https://docs.redpanda.com/docs/reference/cluster-properties/#default_topic_replications').content
    ).toBe('xref:reference:properties/cluster-properties.adoc#default_topic_replications[default_topic_replications]')
    expect(convert('https://docs.redpanda.com/current/reference/tunable-properties/').content).toBe(
      'xref:reference:properties/cluster-properties.adoc[]'
    )
  })

  test('leaves a URL that maps to no page unchanged and reports it', () => {
    const input = 'See https://docs.redpanda.com/current/manage/no-such-page/ for details.'
    const { content, converted, unmapped } = convert(input)
    expect(content).toBe(input)
    expect(converted).toBe(0)
    expect(unmapped).toEqual(['https://docs.redpanda.com/current/manage/no-such-page/'])
  })

  test('leaves a URL of another component unchanged and reports it', () => {
    // A single-repo catalog has no Connect pages; the build-time extension
    // converts this one on the site.
    const input = 'https://docs.redpanda.com/redpanda-connect/configuration/secrets/'
    const { content, unmapped } = convert(input)
    expect(content).toBe(input)
    expect(unmapped).toEqual([input])
  })

  test('converts a file in place and reports what was left', () => {
    const file = path.join(docsRoot, 'generated.adoc')
    fs.writeFileSync(
      file,
      [
        '= Generated',
        '',
        '| *`cores`* __integer__ | See https://docs.redpanda.com/current/get-started/architecture/#thread-per-core-model. +',
        '| *`secrets`* __string__ | See https://docs.redpanda.com/redpanda-connect/configuration/secrets/. +',
        '| *`tabs`* __string__ | See https://docs.redpanda.com/current/manage/kubernetes/manage-resources/?platform=kubernetes. +',
        '',
      ].join('\n')
    )
    const result = convertDocsLinksInFile(file, context)
    expect(result).toEqual({
      converted: 1,
      unmapped: ['https://docs.redpanda.com/redpanda-connect/configuration/secrets/'],
      withQueryString: ['https://docs.redpanda.com/current/manage/kubernetes/manage-resources/?platform=kubernetes'],
      withoutLinkText: [],
    })
    const written = fs.readFileSync(file, 'utf8')
    expect(written).toContain('See xref:get-started:architecture.adoc#thread-per-core-model[Thread-per-core model]. +')
    expect(written).toContain('See https://docs.redpanda.com/redpanda-connect/configuration/secrets/. +')
    const report = formatDocsLinkReport(result, file)
    expect(report).toContain(`Converted 1 docs URL to xrefs in ${file}`)
    expect(report).toContain('no page in this checkout matches')
    expect(report).toContain('  https://docs.redpanda.com/redpanda-connect/configuration/secrets/')
    expect(report).toContain('an xref cannot carry a query string')
  })

  test('does not rewrite a file that has nothing to convert', () => {
    const file = path.join(docsRoot, 'untouched.adoc')
    const input = '= Untouched\n\nSee https://example.com/ and xref:manage:kubernetes/manage-resources.adoc[].\n'
    fs.writeFileSync(file, input)
    const before = fs.statSync(file).mtimeMs
    const result = convertDocsLinksInFile(file, context)
    expect(result.converted).toBe(0)
    expect(fs.readFileSync(file, 'utf8')).toBe(input)
    expect(fs.statSync(file).mtimeMs).toBe(before)
  })

  test('refuses a directory that is not an Antora component', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-links-empty-'))
    await expect(buildDocsResolverContext(empty)).rejects.toThrow(/No antora\.yml/)
    fs.rmSync(empty, { recursive: true, force: true })
  })
})

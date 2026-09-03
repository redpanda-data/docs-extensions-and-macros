'use strict'

const { scanContentUrls } = require('../../extensions/util/scan-content-urls')

describe('scanContentUrls formatting markup', () => {
  // A URL wrapped in AsciiDoc bold or emphasis must not absorb the closing
  // markup: llms.adoc writes **https://docs.redpanda.com/mcp**, which was
  // scanned as the URL "https://docs.redpanda.com/mcp**".
  test.each([
    ['bold', '**https://docs.redpanda.com/mcp** - MCP server', 'https://docs.redpanda.com/mcp'],
    ['emphasis', '*https://docs.redpanda.com/page* text', 'https://docs.redpanda.com/page'],
    ['underscore bold', '__https://docs.redpanda.com/page__ text', 'https://docs.redpanda.com/page'],
    ['plain', 'see https://docs.redpanda.com/page here', 'https://docs.redpanda.com/page'],
  ])('strips closing %s markup from the URL', (_, line, expected) => {
    const [match] = scanContentUrls(line)
    expect(match.url).toBe(expected)
  })

  test('keeps a label attached to a formatted URL', () => {
    const [match] = scanContentUrls('*https://docs.redpanda.com/page[Label]*')
    expect(match.url).toBe('https://docs.redpanda.com/page')
    expect(match.label).toBe('Label')
  })
})

describe('scanContentUrls', () => {
  test('finds a bare URL and trims trailing sentence punctuation', () => {
    const content = 'See https://docs.redpanda.com/connect/configuration/secrets/. Then continue.'
    const matches = scanContentUrls(content)
    expect(matches).toHaveLength(1)
    expect(matches[0].url).toBe('https://docs.redpanda.com/connect/configuration/secrets/')
    expect(matches[0].label).toBeNull()
    expect(content.slice(matches[0].start, matches[0].end)).toBe(matches[0].url)
  })

  test('captures an attached AsciiDoc label', () => {
    const content = 'Read https://docs.redpanda.com/current/manage/[Manage Redpanda] first.'
    const matches = scanContentUrls(content)
    expect(matches).toHaveLength(1)
    expect(matches[0].url).toBe('https://docs.redpanda.com/current/manage/')
    expect(matches[0].label).toBe('Manage Redpanda')
    expect(content.slice(matches[0].start, matches[0].end)).toBe(
      'https://docs.redpanda.com/current/manage/[Manage Redpanda]'
    )
  })

  test('includes a link: macro prefix in the replaceable span', () => {
    const content = 'Read link:https://example.com/page[Example].'
    const matches = scanContentUrls(content)
    expect(matches).toHaveLength(1)
    expect(matches[0].hasLinkPrefix).toBe(true)
    expect(content.slice(matches[0].start, matches[0].end)).toBe('link:https://example.com/page[Example]')
  })

  test('skips URLs inside listing, literal, fenced, and passthrough blocks', () => {
    const content = [
      'Before https://example.com/keep-1',
      '----',
      'curl https://example.com/skip-listing',
      '----',
      '....',
      'https://example.com/skip-literal',
      '....',
      '```',
      'https://example.com/skip-fence',
      '```',
      '++++',
      '<a href="https://example.com/skip-pass">x</a>',
      '++++',
      'After https://example.com/keep-2',
    ].join('\n')
    const urls = scanContentUrls(content).map((m) => m.url)
    expect(urls).toEqual(['https://example.com/keep-1', 'https://example.com/keep-2'])
  })

  test('skips URLs inside inline code spans but not after them', () => {
    const content = 'Run `curl https://example.com/skip` against https://example.com/keep now.'
    const urls = scanContentUrls(content).map((m) => m.url)
    expect(urls).toEqual(['https://example.com/keep'])
  })

  test('flags URLs on attribute entry lines', () => {
    const content = ':url-docs: https://docs.redpanda.com/current/\n\nBody https://docs.redpanda.com/current/x/'
    const matches = scanContentUrls(content)
    expect(matches).toHaveLength(2)
    expect(matches[0].inAttributeEntry).toBe(true)
    expect(matches[1].inAttributeEntry).toBe(false)
  })

  test('flags URLs used as macro attribute values', () => {
    const content = 'image:diagram.png[Alt text,link=https://docs.redpanda.com/current/x/] and https://docs.redpanda.com/current/y/'
    const matches = scanContentUrls(content)
    expect(matches).toHaveLength(2)
    expect(matches[0].inAttributeValue).toBe(true)
    expect(matches[1].inAttributeValue).toBe(false)
  })

  test('finds multiple URLs on one line with correct offsets', () => {
    const content = 'a https://one.example/x and https://two.example/y[Two] end'
    const matches = scanContentUrls(content)
    expect(matches).toHaveLength(2)
    expect(content.slice(matches[0].start, matches[0].end)).toBe('https://one.example/x')
    expect(content.slice(matches[1].start, matches[1].end)).toBe('https://two.example/y[Two]')
  })
})

describe('scanContentUrls fenced blocks with an info string', () => {
  // Asciidoctor accepts a language on the opening fence, and closes the block
  // on a bare ``` line. Matching only bare-backtick delimiters meant every
  // annotated code block was read as prose.
  test.each([
    ['bash', '```bash'],
    ['yml', '```yml'],
    ['json', '```json'],
    ['more than three backticks', '````bash'],
  ])('skips a fence opened as %s', (_, opening) => {
    const content = [opening, 'curl https://example.com/skip', '```', 'Prose https://example.com/keep'].join('\n')
    expect(scanContentUrls(content).map((m) => m.url)).toEqual(['https://example.com/keep'])
  })

  test('a fence with an info string is not treated as a closing delimiter', () => {
    // Two annotated fences in a row must open then close, not open twice and
    // swallow the prose between them.
    const content = [
      '```bash',
      'https://example.com/skip-1',
      '```',
      'Between https://example.com/keep',
      '```yml',
      'https://example.com/skip-2',
      '```',
      'After https://example.com/keep-2',
    ].join('\n')
    expect(scanContentUrls(content).map((m) => m.url)).toEqual([
      'https://example.com/keep',
      'https://example.com/keep-2',
    ])
  })
})

describe('scanContentUrls comments', () => {
  // Asciidoctor drops comments before rendering, so a URL on one is not a link
  // on the published page. Generator provenance notes, Doc Detective test
  // steps, and writers' editorial asides all live in comments.
  test('skips a line comment', () => {
    const content = ['// See https://example.com/skip for details', 'Prose https://example.com/keep'].join('\n')
    expect(scanContentUrls(content).map((m) => m.url)).toEqual(['https://example.com/keep'])
  })

  test('skips an indented line comment', () => {
    expect(scanContentUrls('    // https://example.com/skip')).toEqual([])
  })

  test('skips a comment block and resumes after it', () => {
    const content = [
      '////',
      'https://example.com/skip-1',
      'https://example.com/skip-2',
      '////',
      'After https://example.com/keep',
    ].join('\n')
    expect(scanContentUrls(content).map((m) => m.url)).toEqual(['https://example.com/keep'])
  })

  test('does not mistake a // inside prose for a comment', () => {
    const content = 'The scheme https://example.com/keep uses // as a separator.'
    expect(scanContentUrls(content).map((m) => m.url)).toEqual(['https://example.com/keep'])
  })
})

describe('scanContentUrls attribute references', () => {
  // This scanner runs before Asciidoctor substitutes attributes, so the braces
  // are still literal here even when the published URL is fine. A caller can
  // neither fetch nor rewrite one.
  test.each([
    ['https://github.com/{project-github}/issues/399', true],
    ['https://github.com/redpanda-data/redpanda-operator/blob/{latest-operator-version}/operator/CHANGELOG.md', true],
    ['https://github.com/redpanda-data/docs/tree/{page-origin-refname}/tests/', true],
    ['https://example.com/no-attributes', false],
  ])('flags %s as hasAttributeReference=%s', (url, expected) => {
    const [match] = scanContentUrls(`See ${url} here`)
    expect(match.url).toBe(url)
    expect(match.hasAttributeReference).toBe(expected)
  })
})

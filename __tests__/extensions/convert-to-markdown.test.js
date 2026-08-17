/**
 * @jest-environment node
 */

const TurndownService = require('turndown')
const turndownPluginGfm = require('turndown-plugin-gfm')
const { gfm } = turndownPluginGfm
const path = require('path')

// --- Minimal reproduction of the link conversion rule from the extension
function createTurndownForPage({ siteUrl, page, playbook }) {
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    linkReferenceStyle: 'full',
  })
  td.remove('script')
  td.use(gfm)

  // Compute base URL for relative → absolute links
  let pageBase = null
  if (siteUrl && page?.out?.path) {
    try {
      let pubUrl = page?.pub?.url
      if (pubUrl && !pubUrl.endsWith('/')) pubUrl += '/'
      const siteBase = siteUrl.endsWith('/') ? siteUrl : siteUrl + '/'
      pageBase = new URL(pubUrl || '', siteBase)
    } catch {
      pageBase = null
    }
  }

  td.addRule('absolute-links', {
    filter: 'a',
    replacement: function (content, node) {
      const href = node.getAttribute('href') || ''
      const text = content || node.textContent || ''
      if (!href) return `[${text}]()`

      // Anchors and full URLs unchanged
      if (href.startsWith('#') || /^(?:[a-z]+:)?\/\//i.test(href))
        return `[${text}](${href})`

      // /api/ links → prepend siteUrl
      if (/^\/api\//i.test(href)) {
        const base = siteUrl
          ? siteUrl.endsWith('/')
            ? siteUrl.slice(0, -1)
            : siteUrl
          : ''
        const fullApiUrl = base + href
        return `[${text}](${fullApiUrl})`
      }

      if (!siteUrl || !pageBase) return `[${text}](${href})`

      try {
        const urlObj = new URL(href, pageBase)
        const htmlStyle = playbook?.urls?.htmlExtensionStyle
        const isIndexify = htmlStyle === 'indexify'
        const pathname = urlObj.pathname

        if (isIndexify) {
          const looksLikeDir =
            pathname.endsWith('/') ||
            !path.basename(pathname).includes('.')

          if (looksLikeDir) {
            urlObj.pathname = pathname.replace(/\/?$/, '/index.md')
          } else {
            urlObj.pathname = pathname.replace(/\.html$/, '.md')
          }
        } else {
          urlObj.pathname = pathname.replace(/\.html$/, '.md')
        }

        return `[${text}](${urlObj.toString()})`
      } catch {
        return `[${text}](${href})`
      }
    },
  })

  return td
}

// --- TESTS ---
describe('absolute-links rule (from extension)', () => {
  const siteUrl = 'https://example.com/'
  const page = { out: { path: 'docs/guide.html' }, pub: { url: 'docs/guide/' } }

  test('converts relative .html to .md', () => {
    const html = `<a href="../intro.html">Intro</a>`
    const td = createTurndownForPage({ siteUrl, page })
    const result = td.turndown(html)
    expect(result).toBe('[Intro](https://example.com/docs/intro.md)')
  })

  test('converts .html#anchor → .md#anchor', () => {
    const html = `<a href="../overview.html#details">Overview</a>`
    const td = createTurndownForPage({ siteUrl, page })
    const result = td.turndown(html)
    expect(result).toBe('[Overview](https://example.com/docs/overview.md#details)')
  })

  test('converts .html?query=1#anchor → .md?query=1#anchor', () => {
    const html = `<a href="../overview.html?lang=en#intro">Overview</a>`
    const td = createTurndownForPage({ siteUrl, page })
    const result = td.turndown(html)
    expect(result).toBe('[Overview](https://example.com/docs/overview.md?lang=en#intro)')
  })

  test('converts folder → index.md (indexify=true)', () => {
    const html = `<a href="../getting-started/">Get Started</a>`
    const td = createTurndownForPage({
      siteUrl,
      page,
      playbook: { urls: { htmlExtensionStyle: 'indexify' } },
    })
    const result = td.turndown(html)
    expect(result).toBe('[Get Started](https://example.com/docs/getting-started/index.md)')
  })

  test('replaces .html → .md (indexify=false)', () => {
    const html = `<a href="../install.html">Install</a>`
    const td = createTurndownForPage({
      siteUrl,
      page,
      playbook: { urls: { htmlExtensionStyle: 'default' } },
    })
    const result = td.turndown(html)
    expect(result).toBe('[Install](https://example.com/docs/install.md)')
  })

  test('prefixes /api/ links with siteUrl', () => {
    const html = `<a href="/api/doc/schema-registry/">Schema Registry</a>`
    const td = createTurndownForPage({ siteUrl, page })
    const result = td.turndown(html)
    expect(result).toBe('[Schema Registry](https://example.com/api/doc/schema-registry/)')
  })

  test('keeps anchor-only links', () => {
    const html = `<a href="#section-2">Jump</a>`
    const td = createTurndownForPage({ siteUrl, page })
    const result = td.turndown(html)
    expect(result).toBe('[Jump](#section-2)')
  })

  test('keeps external URLs untouched', () => {
    const html = `<a href="https://github.com/redpanda-data">GitHub</a>`
    const td = createTurndownForPage({ siteUrl, page })
    const result = td.turndown(html)
    expect(result).toBe('[GitHub](https://github.com/redpanda-data)')
  })
})

describe('H1 and frontmatter placement', () => {
  function processMarkdownWithFrontmatter(markdown, frontmatter) {
    // Simulate the logic from convert-to-markdown.js lines 493-513
    const h1Match = markdown.match(/^(#\s+.+?)(\n|$)/)
    let h1Heading = ''
    let restOfMarkdown = markdown

    if (h1Match) {
      h1Heading = h1Match[0]
      restOfMarkdown = markdown.substring(h1Match[0].length).trimStart()
    }

    // Simplified: just frontmatter placement (matches line 513 logic)
    let result
    if (frontmatter) {
      result = `${h1Heading}\n${frontmatter}${restOfMarkdown}`
    } else {
      result = markdown
    }

    // Apply cleanup logic (lines 517-523)
    if (result) {
      result = result.replace(/\n{3,}/g, '\n\n')
      result = result.replace(/[ \t]+$/gm, '')
      result = result.trim()
    }

    return result
  }

  const frontmatter = '---\ntitle: Test\n---\n'

  test('places frontmatter after H1 at document start', () => {
    const markdown = '# Heading\n\nSome content'
    const result = processMarkdownWithFrontmatter(markdown, frontmatter)
    expect(result).toBe('# Heading\n\n---\ntitle: Test\n---\nSome content')
  })

  test('places frontmatter at top when no H1', () => {
    const markdown = 'Some content without heading'
    const result = processMarkdownWithFrontmatter(markdown, frontmatter)
    expect(result).toBe('---\ntitle: Test\n---\nSome content without heading')
  })

  test('does not match H1 later in document (bug fix)', () => {
    const markdown = 'Intro text\n\n# Heading Later\n\nMore content'
    const result = processMarkdownWithFrontmatter(markdown, frontmatter)
    // Should place frontmatter at top since H1 is not at document start
    expect(result).toBe('---\ntitle: Test\n---\nIntro text\n\n# Heading Later\n\nMore content')
  })

  test('handles H1 with double newline separator', () => {
    const markdown = '# Heading\n\nParagraph one\n\nParagraph two'
    const result = processMarkdownWithFrontmatter(markdown, frontmatter)
    expect(result).toBe('# Heading\n\n---\ntitle: Test\n---\nParagraph one\n\nParagraph two')
  })
})

// The enterprise signal is CSS-only in HTML: the badge comes from the span's
// class and the explanation from a title tooltip, and Turndown keeps neither.
// These tests use the rule the extension actually registers, not a local
// reproduction, so they fail if the real rule regresses.
describe('enterprise feature marker in Markdown', () => {
  const {
    createEnterpriseFeatureRules,
  } = require('../../extensions/convert-to-markdown')

  function convert(html) {
    const td = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
      bulletListMarker: '-',
    })
    td.use(gfm)
    const rules = createEnterpriseFeatureRules()
    td.addRule('enterprise-feature', rules.enterpriseFeature)
    td.addRule('beta-badge', rules.betaBadge)
    return td.turndown(html)
  }

  test('marks a linked enterprise feature and keeps the link', () => {
    const html =
      '<p>Enable <span class="enterprise-feature" title="Iceberg Topics requires an Enterprise Edition license.">' +
      '<a href="../iceberg/about/">Iceberg Topics</a></span> to write to tables.</p>'
    expect(convert(html)).toBe(
      'Enable [Iceberg Topics](../iceberg/about/) (enterprise) to write to tables.'
    )
  })

  test('marks an unlinked enterprise feature', () => {
    const html =
      '<p>Enable <span class="enterprise-feature" title="Tiered Storage requires an Enterprise Edition license.">' +
      'Tiered Storage</span> first.</p>'
    expect(convert(html)).toBe('Enable Tiered Storage (enterprise) first.')
  })

  test('honors a custom enterprise-feature-role class', () => {
    // The macro allows overriding the class via enterprise-feature-role, so a
    // substring match keeps the marker working for renamed roles.
    const html =
      '<p>Uses <span class="rp-enterprise-feature-badge">Audit Logs</span>.</p>'
    expect(convert(html)).toBe('Uses Audit Logs (enterprise).')
  })

  test('does not double-mark content that already ends with the marker', () => {
    const html =
      '<p><span class="enterprise-feature">' +
      '<span class="enterprise-feature">Tiered Storage</span></span></p>'
    expect(convert(html)).toBe('Tiered Storage (enterprise)')
  })

  test('drops an empty enterprise span instead of emitting a bare marker', () => {
    const html = '<p>Nothing here <span class="enterprise-feature"></span>.</p>'
    expect(convert(html)).toBe('Nothing here .')
  })

  test('leaves ordinary spans untouched', () => {
    const html = '<p>Just <span class="other">text</span> here.</p>'
    expect(convert(html)).toBe('Just text here.')
  })
})

// A beta enterprise feature carries two markers in HTML. Emitting them
// separately read as "Stretch Clusters (enterprise) (beta)", so they collapse
// into one parenthetical.
describe('combined status markers in Markdown', () => {
  const {
    createEnterpriseFeatureRules,
    formatStatusMarker,
  } = require('../../extensions/convert-to-markdown')

  function convert(html) {
    const td = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
      bulletListMarker: '-',
    })
    td.use(gfm)
    const rules = createEnterpriseFeatureRules()
    td.addRule('enterprise-feature', rules.enterpriseFeature)
    td.addRule('beta-badge', rules.betaBadge)
    return td.turndown(html)
  }

  const betaBadge = '<span class="badge badge--beta ">(beta)</span>'

  test('merges an enterprise feature and a following beta badge', () => {
    const html =
      '<p>Enable <span class="enterprise-feature" title="x">' +
      '<a href="../stretch/">Stretch Clusters</a></span> ' + betaBadge + ' today.</p>'
    expect(convert(html)).toBe(
      'Enable [Stretch Clusters](../stretch/) (enterprise, beta) today.'
    )
  })

  test('leaves exactly one space around the merged marker', () => {
    const html =
      '<p>Enable <span class="enterprise-feature">Stretch Clusters</span> ' +
      betaBadge + ' today.</p>'
    // Suppressing the badge and marking the span instead left a doubled space.
    expect(convert(html)).not.toMatch(/ {2}/)
  })

  test('marks a beta badge that stands alone', () => {
    expect(convert('<p>Feature ' + betaBadge + ' here.</p>')).toBe(
      'Feature (beta) here.'
    )
  })

  test('does not merge a badge that is not adjacent to the feature', () => {
    const html =
      '<p><span class="enterprise-feature">Tiered Storage</span> and other text ' +
      betaBadge + '.</p>'
    expect(convert(html)).toBe(
      'Tiered Storage (enterprise) and other text (beta).'
    )
  })

  test('formatStatusMarker joins statuses and drops empties', () => {
    expect(formatStatusMarker(['enterprise', 'beta'])).toBe('(enterprise, beta)')
    expect(formatStatusMarker(['enterprise'])).toBe('(enterprise)')
    expect(formatStatusMarker([])).toBe('')
    expect(formatStatusMarker([null, 'beta'])).toBe('(beta)')
  })
})

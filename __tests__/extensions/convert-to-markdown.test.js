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

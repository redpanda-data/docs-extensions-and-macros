'use strict'

const asciidoctor = require('@asciidoctor/core')()
const { formatTooltipDefinition } = require('../../macros/glossary')
const glossary = require('../../macros/glossary')

/**
 * The browser decodes character references in an attribute value once, when it
 * parses the page. Only after that does docs-ui hand the value to tippy, which
 * assigns it with innerHTML because it is configured with allowHTML: true
 * (docs-ui/src/js/12-activate-tooltips.js). Asserting on the raw attribute text
 * alone hides that step -- it is what let escaped markup come back to life --
 * so the tooltip assertions below go through this first.
 */
function decodeAttributeOnce (value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
}

function termFile (termName, hoverText) {
  return {
    path: `modules/terms/partials/${termName}.adoc`,
    contents: Buffer.from(`= ${termName}\n:term-name: ${termName}\n:hover-text: ${hoverText}\n\nBody.\n`),
    src: { component: 'shared', module: 'terms', family: 'partial', fileUri: termName },
  }
}

// A fresh catalog per conversion: the macro caches terms on the content catalog
// under a symbol, so sharing one would leak terms between tests.
function convert (source, files = []) {
  const registry = asciidoctor.Extensions.create()
  glossary.register(registry, {
    contentCatalog: { findBy: () => files, resolvePage: () => undefined },
    file: { src: { version: '1.0', component: 'ROOT' }, pub: { url: '/current/page.html' } },
    config: { attributes: {} },
  })
  return asciidoctor.convert(source, { extension_registry: registry })
}

describe('formatTooltipDefinition', () => {
  describe('data-* attributes, which the docs UI renders as HTML', () => {
    test('converts backtick-delimited text to <code>', () => {
      const result = formatTooltipDefinition('Managed by an agent that receives `rpk` commands.', 'data-tippy-content')
      expect(result).toBe('Managed by an agent that receives <code>rpk</code> commands.')
    })

    test('converts the unconstrained double-backtick form without leaving stray delimiters', () => {
      const result = formatTooltipDefinition('Set ``segment.bytes`` per topic.', 'data-tippy-content')
      expect(result).toBe('Set <code>segment.bytes</code> per topic.')
    })

    test('leaves an unpaired backtick alone', () => {
      const result = formatTooltipDefinition('A lone ` backtick.', 'data-tippy-content')
      expect(result).toBe('A lone ` backtick.')
    })

    test('escapes double quotes so the attribute is not terminated early', () => {
      const result = formatTooltipDefinition('The engine. "Oxla" may appear in logs.', 'data-tippy-content')
      expect(result).not.toContain('"')
      // ...and the reader still sees real quotes once the browser has decoded it.
      expect(decodeAttributeOnce(result)).toBe('The engine. &quot;Oxla&quot; may appear in logs.')
    })

    test('keeps authored markup inert after the browser decodes the attribute', () => {
      const result = formatTooltipDefinition('Danger `<img src=x onerror=alert(1)>` here', 'data-tippy-content')
      // One escaping level is spent on the attribute decode. What reaches
      // innerHTML must still have <code> as its only live markup, or the img
      // becomes a real element and its onerror fires.
      expect(decodeAttributeOnce(result)).toBe('Danger <code>&lt;img src=x onerror=alert(1)&gt;</code> here')
    })

    test('keeps ampersands and angle brackets as text for the reader', () => {
      const result = formatTooltipDefinition('A value < 10 and Tom & Jerry', 'data-tippy-content')
      expect(decodeAttributeOnce(result)).toBe('A value &lt; 10 and Tom &amp; Jerry')
    })

    test('escapes an already-converted definition once so its markup survives', () => {
      // The inline glossterm:term[definition] form arrives converted by
      // Asciidoctor, so its HTML is meant to render rather than be shown.
      const result = formatTooltipDefinition('Only <code>hover</code> text.', 'data-tippy-content', true)
      expect(decodeAttributeOnce(result)).toBe('Only <code>hover</code> text.')
    })
  })

  describe('the native title attribute, which is always plain text', () => {
    test('leaves backticks as text', () => {
      const result = formatTooltipDefinition('Uses `rpk` under the hood.', 'title')
      expect(result).toBe('Uses `rpk` under the hood.')
    })

    test('escapes quotes', () => {
      const result = formatTooltipDefinition('The "default" catalog.', 'title')
      expect(result).toBe('The &quot;default&quot; catalog.')
    })

    test('escapes only once, since the browser shows the decoded value as text', () => {
      const result = formatTooltipDefinition('A value < 10', 'title')
      expect(decodeAttributeOnce(result)).toBe('A value < 10')
    })
  })
})

// The two lines this fix changed are both inside the tooltip branch of the
// macro, and neither is reachable from formatTooltipDefinition alone. Without
// these, reverting either interpolation back to the unescaped definition leaves
// the suite green.
describe('glossterm tooltip rendering', () => {
  const terms = [termFile('data plane', 'Receives `rpk` commands. The "agent" runs there.')]

  test('escapes the tooltip on the linked term (the anchor branch)', () => {
    const html = convert(':glossary-tooltip: data-tippy-content\n\nSee glossterm:data plane[].\n', terms)
    expect(html).toContain('<a data-tippy-content="Receives <code>rpk</code> commands. The &amp;quot;agent&amp;quot; runs there."')
  })

  test('escapes the tooltip when the term is wrapped in a span (the fallback branch)', () => {
    const source = ':glossary-tooltip: data-tippy-content\n:glossary-links: false\n:glossary-term-role:\n\nSee glossterm:data plane[].\n'
    const html = convert(source, terms)
    expect(html).toContain('<span data-tippy-content="Receives <code>rpk</code> commands. The &amp;quot;agent&amp;quot; runs there.">data plane</span>')
  })

  test('escapes quotes for the native title attribute', () => {
    const html = convert(':glossary-tooltip: title\n\nSee glossterm:data plane[].\n', terms)
    expect(html).toContain('title="Receives `rpk` commands. The &quot;agent&quot; runs there."')
  })

  test('does not break the attribute for an inline definition', () => {
    const html = convert(':glossary-tooltip: data-tippy-content\n\nSee glossterm:ghost[A "quoted" definition.].\n', terms)
    expect(html).toContain('data-tippy-content="A &quot;quoted&quot; definition."')
  })

  test('emits no tooltip attribute when glossary-tooltip is unset', () => {
    const html = convert('See glossterm:data plane[].\n', terms)
    expect(html).not.toContain('data-tippy-content')
    expect(html).not.toContain('title=')
  })
})

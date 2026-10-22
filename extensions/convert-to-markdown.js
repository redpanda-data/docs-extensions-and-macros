const { raiseListenerLimit } = require('./util/raise-listener-limit')
const os = require('os')
const yaml = require('js-yaml')
const { toMarkdownUrl } = require('../extension-utils/url-utils')
const { formatLlmsDirective } = require('../extension-utils/llms-utils')
const TurndownService = require('turndown')
const turndownPluginGfm = require('turndown-plugin-gfm')
const { gfm } = turndownPluginGfm
// The same parser Turndown uses, so the DOM handed to it (and to the rules'
// querySelector calls) behaves exactly as if Turndown had parsed the string.
const domino = require('@mixmark-io/domino')

/**
 * Decode HTML entities in a string
 * @param {string} str - String with potential HTML entities
 * @returns {string} Decoded string
 */
function decodeHtmlEntities (str) {
  if (!str || typeof str !== 'string') return str
  return str
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(dec))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&apos;/g, "'")
}

/**
 * Converts AsciiDoc page attributes to YAML frontmatter
 * @param {Object} page - The page object with asciidoc attributes
 * @returns {string} YAML frontmatter string or empty string if no attributes
 */
function generateFrontmatter(page) {
  const frontmatter = {}

  // Add title (decode HTML entities from AsciiDoc processing)
  if (page.asciidoc?.doctitle) {
    frontmatter.title = decodeHtmlEntities(page.asciidoc.doctitle)
  }

  // Add navigation title if different from doctitle
  if (page.asciidoc?.navtitle && page.asciidoc.navtitle !== page.asciidoc?.doctitle) {
    frontmatter.navtitle = decodeHtmlEntities(page.asciidoc.navtitle)
  }

  // Get all page attributes
  const attrs = page.asciidoc?.attributes || {}

  // Allowlist of attributes to include in frontmatter
  // Explicitly opt-in to attributes that are useful for AI consumption
  const allowedAttributes = [
    'title',
    'navtitle',
    'description',
    // Note: 'categories' removed - it's a massive object (all Connect components)
    // that bloats frontmatter. Only include on pages that specifically need it.
    'page-component-name',
    'page-component-title',
    'page-component-version',
    'page-version',
    'page-relative-src-path',
    'page-edit-url',
    'page-topic-type',
    'personas',
    'docname',
    'page-beta',
    'page-beta-text',
    'page-is-nearing-eol',
    'page-is-past-eol',
    'page-eol-date',
    'page-git-created-date',
    'page-git-modified-date',
    // Component-specific version attributes (from antora.yml)
    'latest-redpanda-tag', // Redpanda docker tag (e.g., v25.3.5)
    'latest-console-tag',
    'latest-operator-version',
    'latest-connect-version',
  ]

  // Blocklist of large data attributes that should never be in frontmatter
  // These are component-level data used by macros but shouldn't pollute markdown
  const blockedAttributes = [
    'categories',  // Massive nested object with all Connect components
    'connectCategoriesData',  // Raw Connect categories data
    'flatComponentsData',  // Flattened Connect component data
    'driverSupportData',  // SQL driver support matrix
    'cacheSupportData',  // Cache support matrix
    'csvData',  // Raw CSV data from generate-rp-connect-info
    'commercialNamesMap',  // Commercial names mapping
  ]

  // Add allowed page attributes to frontmatter
  Object.keys(attrs).forEach(key => {
    const value = attrs[key]

    // Skip blocked attributes (large data objects)
    if (blockedAttributes.includes(key)) return

    // Allow all learning-objective-* attributes (learning-objective-1, -2, -3, etc.)
    const isLearningObjective = key.startsWith('learning-objective-')

    // Only include attributes in our allowlist or learning objectives
    if (!allowedAttributes.includes(key) && !isLearningObjective) return

    // Only include page-beta-text if page-beta is true
    if (key === 'page-beta-text' && !attrs['page-beta']) {
      return
    }

    // Skip empty attributes (AsciiDoc boolean flags)
    if (value === '') {
      // Special handling for version fields - use actual version from page source
      if (key === 'page-version') {
        frontmatter[key] = page.src?.version || 'master'
        return
      }
      if (key === 'page-component-version') {
        frontmatter[key] = page.src?.version || 'master'
        return
      }
      // Preserve important boolean flags
      if (key.startsWith('page-')) {
        frontmatter[key] = true
      }
      return
    }

    // Include the attribute. Asciidoctor stores attribute text with HTML
    // entities (`&lt;name&gt;`), which have no place in YAML.
    frontmatter[key] = typeof value === 'string' ? decodeHtmlEntities(value) : value
  })

  // Transform EOL fields to be more user-friendly
  if (frontmatter['page-is-nearing-eol'] || frontmatter['page-is-past-eol']) {
    let eolStatus = 'supported'
    if (frontmatter['page-is-past-eol'] === 'true' || frontmatter['page-is-past-eol'] === true) {
      eolStatus = 'past end-of-life'
    } else if (frontmatter['page-is-nearing-eol'] === 'true' || frontmatter['page-is-nearing-eol'] === true) {
      eolStatus = 'nearing end-of-life'
    }
    frontmatter['support-status'] = eolStatus
    // Keep original fields for compatibility
  }

  // Transform beta fields to be more user-friendly
  if (frontmatter['page-beta'] === 'true' || frontmatter['page-beta'] === true) {
    let betaStatus = 'beta'
    if (frontmatter['page-beta-text']) {
      betaStatus = `beta - ${frontmatter['page-beta-text']}`
    }
    frontmatter['release-status'] = betaStatus
  }

  // Return empty string if no frontmatter
  if (Object.keys(frontmatter).length === 0) return ''

  // Convert to YAML format using js-yaml library for proper escaping
  let yamlContent = yaml.dump(frontmatter, {
    lineWidth: -1, // Disable line wrapping
    noRefs: true, // Disable anchors/aliases
    quotingType: '"', // Use double quotes
    forceQuotes: false, // Only quote when necessary
  })

  // Add helpful comments for EOL (end-of-life) fields
  // Find the first EOL-related field and add comment before it
  if (frontmatter['page-is-nearing-eol'] || frontmatter['page-is-past-eol'] || frontmatter['support-status']) {
    const eolFieldRegex = /^(page-is-nearing-eol:|page-is-past-eol:|support-status:)/m
    if (!yamlContent.includes('# EOL =')) {
      yamlContent = yamlContent.replace(
        eolFieldRegex,
        '# EOL = End-of-Life (support lifecycle status)\n$1'
      )
    }
  }

  // Add helpful comments for beta fields
  if (frontmatter['page-beta'] || frontmatter['release-status']) {
    const betaFieldRegex = /^(page-beta:|release-status:)/m
    if (!yamlContent.includes('# Beta release')) {
      yamlContent = yamlContent.replace(
        betaFieldRegex,
        '# Beta release status\n$1'
      )
    }
  }

  return `---\n${yamlContent}---\n\n`
}

// Default class the enterprise inline macro puts on its wrapping span. The
// macro lets a playbook override it via the enterprise-feature-role document
// attribute, so match on a substring rather than the exact value.
const ENTERPRISE_FEATURE_CLASS = 'enterprise-feature'

// Status words collected into the single trailing parenthetical.
const ENTERPRISE_STATUS = 'enterprise'
const BETA_STATUS = 'beta'

// Class the badge macro puts on a beta badge.
const BETA_BADGE_CLASS = 'badge--beta'

// Explicit textual marker for enterprise features in Markdown output.
const ENTERPRISE_MARKER = `(${ENTERPRISE_STATUS})`

/**
 * Format one parenthetical from the status words that apply to a feature.
 *
 * A beta enterprise feature carries two markers, and emitting them separately
 * reads as "Stretch Clusters (enterprise) (beta)". One list avoids the stutter.
 *
 * @param {string[]} statuses - Status words, in display order.
 * @returns {string} Parenthetical, or an empty string when there are none.
 */
function formatStatusMarker (statuses) {
  const words = statuses.filter(Boolean)
  return words.length ? `(${words.join(', ')})` : ''
}

function hasClass (node, className) {
  if (!node || node.nodeName !== 'SPAN') return false
  const classAttr = node.getAttribute?.('class') || node.className || ''
  return typeof classAttr === 'string' && classAttr.includes(className)
}

/**
 * The next sibling element, skipping the whitespace text nodes that sit between
 * the enterprise span and a badge that follows it.
 */
function nextElementSibling (node) {
  let sibling = node && node.nextSibling
  while (sibling && sibling.nodeType === 3 && !(sibling.textContent || '').trim()) {
    sibling = sibling.nextSibling
  }
  return sibling && sibling.nodeType === 1 ? sibling : null
}

/**
 * Turndown rules that keep the enterprise and beta signals in Markdown output.
 *
 * In HTML both signals are carried by things Turndown discards. The enterprise
 * badge is drawn by CSS from the span's class and explained by a title tooltip,
 * so `enterprise:Tiered Storage[]` would arrive in Markdown as the bare words
 * "Tiered Storage", indistinguishable from any other feature name. The beta
 * badge does survive, because its label keeps real bracketed text, but it lands
 * as a second parenthetical right after the first.
 *
 * These rules emit one trailing parenthetical instead, listing every status
 * that applies, and pass the span's already-converted inner Markdown through
 * untouched so a linked feature keeps its link:
 *
 *   [Stretch Clusters](../deploy/stretch-clusters.md) (enterprise, beta)
 *
 * The beta badge is a sibling of the enterprise span rather than a child. The
 * enterprise rule looks ahead for it and, when it finds one, emits no marker of
 * its own and hands the combined marker to the badge. Emitting it there rather
 * than on the enterprise span reuses the whitespace already between the two
 * elements, instead of suppressing the badge and leaving a doubled space.
 *
 * @returns {{enterpriseFeature: object, betaBadge: object}} Turndown rules,
 *   both of which must be registered.
 */
function createEnterpriseFeatureRules () {
  // Scoped per call so each converter tracks its own deferred markers.
  const deferredToBadge = new WeakSet()

  const enterpriseFeature = {
    filter: (node) => hasClass(node, ENTERPRISE_FEATURE_CLASS),
    replacement: (content, node) => {
      const inner = (content || '').trim()
      // An empty span carries no feature to mark.
      if (!inner) return ''
      // Nested or already-marked content must not collect a second marker.
      if (inner.toLowerCase().endsWith(ENTERPRISE_MARKER)) return inner

      const sibling = nextElementSibling(node)
      if (hasClass(sibling, BETA_BADGE_CLASS)) {
        // The badge renders "(enterprise, beta)" for both of us.
        deferredToBadge.add(sibling)
        return inner
      }
      return `${inner} ${ENTERPRISE_MARKER}`
    },
  }

  const betaBadge = {
    filter: (node) => hasClass(node, BETA_BADGE_CLASS),
    replacement: (content, node) =>
      deferredToBadge.has(node)
        ? formatStatusMarker([ENTERPRISE_STATUS, BETA_STATUS])
        : formatStatusMarker([BETA_STATUS]),
  }

  return { enterpriseFeature, betaBadge }
}

module.exports.createEnterpriseFeatureRules = createEnterpriseFeatureRules
module.exports.formatStatusMarker = formatStatusMarker
module.exports.ENTERPRISE_MARKER = ENTERPRISE_MARKER

// --- Markdown text escaping -------------------------------------------------

/**
 * Turndown's escape list without the two emphasis delimiters, which
 * `escapeEmphasisDelimiters` handles with context. Everything else is kept as
 * Turndown ships it: the line-start escapes (`-`, `+ `, `#`, `>`, `=`, `~~~`,
 * `1. `) are still needed when a text node really does begin a line.
 */
const BASE_ESCAPES = [
  [/\\/g, '\\\\'],
  [/^-/g, '\\-'],
  [/^\+ /g, '\\+ '],
  [/^(=+)/g, '\\$1'],
  [/^(#{1,6}) /g, '\\$1 '],
  [/`/g, '\\`'],
  [/^~~~/g, '\\~~~'],
  [/\[/g, '\\['],
  [/\]/g, '\\]'],
  [/^>/g, '\\>'],
  [/^(\d+)\. /g, '$1\\. '],
]

// Outside the text node the neighbour is unknown. Treat it as punctuation:
// never whitespace, never a letter, so the delimiter is escaped unless the
// character on the known side rules emphasis out.
function isWhitespace (ch) {
  return ch !== undefined && /\s/.test(ch)
}

function isAlphanumeric (ch) {
  return ch !== undefined && /[\p{L}\p{N}]/u.test(ch)
}

function isPunctuation (ch) {
  return ch === undefined || /[\p{P}\p{S}]/u.test(ch)
}

/**
 * Escape a run of `*` or `_` only when CommonMark would let it open emphasis.
 *
 * Turndown escapes every underscore and asterisk, so `RPK_ environment`,
 * `get_orders` and `fields marked with *` reach agents as `RPK\_`,
 * `get\_orders` and `\*`. A delimiter can only start emphasis when it is
 * left-flanking (followed by a non-space, and either not followed by
 * punctuation or preceded by space or punctuation), and an underscore between
 * two alphanumerics can never open or close. A run that cannot open is left
 * alone: with every opener escaped, a stray closer is inert.
 *
 * @param {string} text - One text node's content.
 * @returns {string} The text with only the delimiters that need it escaped.
 */
function escapeEmphasisDelimiters (text) {
  return text.replace(/([*_])\1*/g, (run, ch, offset) => {
    const prev = offset > 0 ? text[offset - 1] : undefined
    const next = text[offset + run.length]
    if (ch === '_' && isAlphanumeric(prev) && isAlphanumeric(next)) return run
    const leftFlanking =
      !isWhitespace(next) &&
      next !== undefined &&
      (!isPunctuation(next) || prev === undefined || isWhitespace(prev) || isPunctuation(prev))
    return leftFlanking ? run.replace(/[*_]/g, '\\$&') : run
  })
}

/**
 * Replacement for `TurndownService.prototype.escape`.
 * @param {string} text - One text node's content.
 * @returns {string} Escaped Markdown text.
 */
function escapeText (text) {
  const escaped = BASE_ESCAPES.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), text)
  return escapeEmphasisDelimiters(escaped)
}

module.exports.escapeText = escapeText

// --- Line-start escapes that do not start a line ---------------------------

/**
 * Marker prepended to text nodes that continue a line. A private-use
 * character, stripped from the finished Markdown.
 */
const CONTINUATION_SENTINEL = ''

// Turndown's block list, plus BR: text after any of these starts a new line.
const LINE_BREAKING_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'AUDIO', 'BLOCKQUOTE', 'BODY', 'BR', 'CANVAS',
  'CENTER', 'DD', 'DIR', 'DIV', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE',
  'FOOTER', 'FORM', 'FRAMESET', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER',
  'HGROUP', 'HR', 'HTML', 'ISINDEX', 'LI', 'MAIN', 'MENU', 'NAV', 'NOFRAMES',
  'NOSCRIPT', 'OL', 'OUTPUT', 'P', 'PRE', 'SECTION', 'TABLE', 'TBODY', 'TD',
  'TFOOT', 'TH', 'THEAD', 'TR', 'UL',
])

const LINE_START_ESCAPE = /^(?:[-+>#=~]|\d+\. )/

function insideCode (node) {
  for (let el = node.parentNode; el; el = el.parentNode) {
    if (el.nodeName === 'CODE' || el.nodeName === 'PRE') return true
  }
  return false
}

/**
 * Stop Turndown from escaping a line-start character that is not at a line
 * start.
 *
 * Turndown escapes each text node on its own, so the `^-` rule fires on the
 * text node `-based` in `<a>Raft</a>-based` and the export reads
 * `[Raft](…)\-based`. The escape only has meaning at the start of a line, and
 * a text node that follows an inline sibling never starts one. Prefixing such
 * nodes with a sentinel moves the `^` anchor off the real character; the
 * sentinel is removed once conversion is done.
 *
 * @param {Element} root - DOM subtree to mark, in place.
 */
function markLineContinuations (root) {
  const walk = (node) => {
    Array.from(node.childNodes || []).forEach((child) => {
      if (child.nodeType === 3) {
        const previous = child.previousSibling
        if (
          previous &&
          !(previous.nodeType === 1 && LINE_BREAKING_TAGS.has(previous.nodeName)) &&
          LINE_START_ESCAPE.test(child.nodeValue) &&
          !insideCode(child)
        ) {
          child.nodeValue = CONTINUATION_SENTINEL + child.nodeValue
        }
      } else if (child.nodeType === 1) {
        walk(child)
      }
    })
  }
  walk(root)
}

// --- Rendering helpers -------------------------------------------------------

/**
 * Inline code span, delimited the way Turndown does it: enough backticks to
 * clear any run inside the text, and padding when the text starts or ends with
 * a backtick or is wrapped in spaces.
 */
function inlineCode (text) {
  if (!text) return ''
  const content = text.replace(/\r?\n|\r/g, ' ')
  const extraSpace = /^`|^ .*?[^ ].* $|`$/.test(content) ? ' ' : ''
  let delimiter = '`'
  const runs = content.match(/`+/g) || []
  while (runs.includes(delimiter)) delimiter += '`'
  return delimiter + extraSpace + content + extraSpace + delimiter
}

/** Fenced code block whose fence is longer than any backtick run inside. */
function fencedCodeBlock (code, language = '') {
  let fenceSize = 3
  const fences = /^`{3,}/gm
  let match
  while ((match = fences.exec(code))) {
    if (match[0].length >= fenceSize) fenceSize = match[0].length + 1
  }
  const fence = '`'.repeat(fenceSize)
  return `\n\n${fence}${language}\n${code.replace(/\n$/, '')}\n${fence}\n\n`
}

/**
 * Collapse a cell's converted Markdown onto one line.
 *
 * GFM table cells cannot hold block content, so paragraphs and list items are
 * joined with `<br>`, a fenced code block becomes one inline code span per
 * line, and pipes are escaped so they do not end the cell.
 *
 * @param {string} markdown - Converted cell content, possibly multi-line.
 * @returns {string} One line, safe inside `| … |`.
 */
function flattenCell (markdown) {
  const withInlineCode = markdown.replace(/(`{3,})[^\n]*\n([\s\S]*?)\n\1/g, (_, __, code) =>
    code.split('\n').filter((line) => line.trim()).map((line) => inlineCode(line.trim())).join('\n')
  )
  return withInlineCode
    .split('\n')
    .map((line) =>
      line
        .trim()
        .replace(/^(-|\*|\d+\.)\s{2,}/, '$1 ')
        // Nothing in a cell starts a line, so line-start escapes are noise here.
        .replace(/^\\(?=[-+>#=~])/, '')
        .replace(/^(\d+)\\\. /, '$1. ')
    )
    .filter(Boolean)
    .join('<br>')
    .replace(/\|/g, '\\|')
}

/**
 * Resolve a link or image target against the page's HTML URL. Markdown files
 * are read away from the site, so a relative target has nothing to resolve
 * against there; the HTML page's URL is where the link was meant to go.
 *
 * @param {string} target - href or src as written in the HTML.
 * @param {URL|null} pageUrl - The page's absolute HTML URL.
 * @returns {string} An absolute URL when one can be built, else the input.
 */
function resolveTarget (target, pageUrl) {
  if (!target || !pageUrl) return target || ''
  if (/^(?:#|\/\/|[a-z][a-z0-9+.-]*:)/i.test(target)) return target
  try {
    return new URL(target, pageUrl).toString()
  } catch (e) {
    return target
  }
}

function hasAncestorClass (node, className) {
  for (let el = node.parentNode; el; el = el.parentNode) {
    const classAttr = (el.getAttribute && el.getAttribute('class')) || ''
    if (classAttr.split(/\s+/).includes(className)) return true
  }
  return false
}

function isAdmonitionTable (node) {
  return node.nodeName === 'TABLE' && !!(node.querySelector('td.icon') && node.querySelector('td.content'))
}

function isCalloutTable (node) {
  return node.nodeName === 'TABLE' && hasAncestorClass(node, 'colist')
}

function closestTable (node) {
  for (let el = node.parentNode; el; el = el.parentNode) {
    if (el.nodeName === 'TABLE') return el
  }
  return null
}

function cleanAttribute (value) {
  return value ? value.replace(/(\n+\s*)+/g, '\n') : ''
}

/**
 * Parse an HTML fragment into the DOM Turndown works with.
 * @param {string} html - HTML fragment.
 * @returns {Element} A container element holding the fragment.
 */
function parseFragment (html) {
  const doc = domino.createDocument(`<x-turndown id="turndown-root">${html}</x-turndown>`)
  return doc.getElementById('turndown-root')
}

module.exports.flattenCell = flattenCell
module.exports.resolveTarget = resolveTarget

// --- Turndown configuration --------------------------------------------------

const baseConfig = {
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  linkReferenceStyle: 'full',
}

// Classes and ids of site chrome that has no place in the export.
const UNWANTED_FRAGMENTS = [
  'thumbs',
  'back-to-top',
  'contributors-modal',
  'feedback-section',
  'feedback-toast',
  'pagination',
  'footer',
  'nav-expand',
  'banner-container',
  'markdown-dropdown',
  'version-selector',        // Version dropdown (not relevant for LLMs)
  'component-indicator',     // Component header bar
  'product-switcher',        // Product switcher dropdown
  'breadcrumb',              // Breadcrumb navigation
  'chat-panel',              // AI chat interface
  'kapa',                    // Kapa AI widget
]

function createTurndownBase () {
  const td = new TurndownService(baseConfig)
  td.use(gfm)
  td.escape = escapeText
  td.keep(['div.openblock.tabs', 'article.doc'])
  return td
}

/**
 * Drop site chrome and tracking pixels. Registered last so it outranks the
 * content rules: Turndown consults the most recently added rule first, and the
 * image rule must not get to render a tracking pixel.
 */
function addRemoveUnwantedRule (td) {
  td.addRule('remove-unwanted', {
    filter: (node) => {
      if (!node || !node.getAttribute) return false

      const classAttr = (node.getAttribute('class') || '').toLowerCase()
      const idAttr = (node.getAttribute('id') || '').toLowerCase()
      const tag = node.nodeName.toLowerCase()

      if (['script', 'style', 'footer', 'nav'].includes(tag)) return true

      // Tracking or hidden images
      if (
        tag === 'img' &&
        (classAttr.includes('tracking') ||
          idAttr.includes('scarf') ||
          node.getAttribute('role') === 'presentation' ||
          node.style?.display === 'none')
      ) {
        return true
      }

      return UNWANTED_FRAGMENTS.some((x) => classAttr.includes(x) || idAttr.includes(x))
    },
    replacement: () => '',
  })
}

/**
 * Build the converter for one page.
 *
 * Two instances are created so a rule that converts a fragment of its own
 * (tabs, admonitions, table cells) can hand it to a sibling converter instead
 * of re-entering itself.
 *
 * @param {Object} options
 * @param {URL|null} options.pageUrl - Absolute HTML URL of the page, for
 *   resolving relative links and images.
 * @param {Object} options.logger - Antora logger.
 * @returns {TurndownService} The converter for the page body.
 */
function createTurndownForPage ({ pageUrl, logger }) {
  const outerTurndown = createTurndownBase()
  const nestedTurndown = createTurndownBase()

  function addCustomRules (turndownInstance, isInner = false) {
    const convert = (node) => {
      const converter = isInner ? nestedTurndown : turndownInstance
      return converter.turndown(node)
    }

    function findNearestHeadingLevel (el) {
      let current = el.previousElementSibling
      while (current) {
        if (/^H[1-6]$/i.test(current.nodeName)) return parseInt(current.nodeName.substring(1))
        current = current.previousElementSibling
      }
      let parent = el.parentElement
      while (parent) {
        const headings = Array.from(parent.querySelectorAll('h1,h2,h3,h4,h5,h6'))
        if (headings.length > 0) {
          const last = headings[headings.length - 1]
          return parseInt(last.nodeName.substring(1))
        }
        parent = parent.parentElement
      }
      return 2
    }

    // Asciidoctor tabs: each tab becomes a heading one level below its context.
    turndownInstance.addRule('asciidoctor-tabs', {
      filter: (node) => {
        if (node.nodeName !== 'DIV') return false
        const classAttr = node.getAttribute?.('class') || node.className || ''
        return classAttr.includes('openblock') && classAttr.includes('tabs')
      },
      replacement: function (_, node) {
        function processTabGroup (group, parentHeadingLevel = null) {
          const contentDiv = group.querySelector('.content') || group
          const tabList = contentDiv.querySelectorAll('li.tab')
          if (!tabList.length) return ''

          const nearestLevel =
            parentHeadingLevel != null ? parentHeadingLevel + 1 : findNearestHeadingLevel(group) + 1
          const tabHeadingLevel = Math.min(nearestLevel, 6)
          const headingPrefix = '#'.repeat(tabHeadingLevel)

          let markdown = ''
          tabList.forEach((tab) => {
            const title = tab.querySelector('p')?.textContent.trim() || tab.textContent.trim()

            let panelId = tab.getAttribute('aria-controls')
            if (!panelId && tab.id) panelId = tab.id + '--panel'
            const panel = group.querySelector(`#${panelId}`)
            if (!panel) return

            const nestedTabs = panel.querySelectorAll('.openblock.tabs')
            let nestedMdCombined = ''
            nestedTabs.forEach((nested) => {
              nestedMdCombined += '\n' + processTabGroup(nested, tabHeadingLevel) + '\n'
              nested.remove()
            })

            let md = ''
            try {
              md = convert(panel)
            } catch (e) {
              logger.warn(`Turndown failed in nested tab: ${e.message}`)
            }

            markdown += `${headingPrefix} ${title}\n\n${md.trim()}\n${nestedMdCombined.trim()}\n\n`
          })

          return markdown.trim()
        }

        return '\n' + processTabGroup(node, null) + '\n'
      },
    })

    // Admonitions: a blockquote led by the type and any custom title.
    turndownInstance.addRule('admonition', {
      filter: isAdmonitionTable,
      replacement: function (_, node) {
        const iconCell = node.querySelector('td.icon')
        const contentCell = node.querySelector('td.content')
        if (!iconCell || !contentCell) return ''

        const iconEl = iconCell.querySelector('i')
        const classAttr = iconEl?.className || ''
        const match = classAttr.match(/icon-([a-z]+)/i)
        const type = match ? match[1].toUpperCase() : 'NOTE'

        const titleEl =
          node.querySelector('.title') || contentCell.querySelector('.title') || iconEl?.getAttribute('title')
        const customTitle = typeof titleEl === 'string' ? titleEl.trim() : titleEl?.textContent?.trim() || ''

        const emojiMap = {
          CAUTION: '⚠️',
          WARNING: '⚠️',
          TIP: '💡',
          NOTE: '📝',
          IMPORTANT: '❗',
        }
        const emoji = emojiMap[type] || '📘'

        let innerMd = ''
        try {
          innerMd = convert(contentCell).trim()
        } catch (e) {
          logger.warn(`Turndown failed in admonition: ${e.message}`)
        }

        const header =
          customTitle && customTitle.toLowerCase() !== type.toLowerCase()
            ? `${emoji} **${type}: ${customTitle}**`
            : `${emoji} **${type}**`

        const quoted = innerMd
          .split('\n')
          .map((line) => (line.startsWith('>') ? line : `> ${line}`))
          .join('\n')

        return `\n> ${header}\n>\n${quoted}\n`
      },
    })

    // Keep the enterprise-license signal, which is otherwise CSS-only.
    const enterpriseRules = createEnterpriseFeatureRules()
    turndownInstance.addRule('enterprise-feature', enterpriseRules.enterpriseFeature)
    turndownInstance.addRule('beta-badge', enterpriseRules.betaBadge)

    // Tables: cells are converted as Markdown, not copied as text, so lists,
    // links, code and emphasis inside them survive.
    turndownInstance.addRule('tables', {
      filter: (node) => node.nodeName === 'TABLE' && !isAdmonitionTable(node) && !isCalloutTable(node),
      replacement: function (content, node) {
        const rows = Array.from(node.querySelectorAll('tr')).filter((row) => closestTable(row) === node)
        if (!rows.length) return content

        const cellsOf = (row) =>
          Array.from(row.childNodes)
            .filter((cell) => cell.nodeType === 1 && (cell.nodeName === 'TH' || cell.nodeName === 'TD'))
            .map((cell) => {
              try {
                return flattenCell(convert(cell))
              } catch (e) {
                logger.warn(`Turndown failed in table cell: ${e.message}`)
                return flattenCell((cell.textContent || '').trim())
              }
            })

        // Asciidoctor emits <thead> only for tables declared with a header
        // row. Without one, every row is data and the header row stays empty
        // rather than promoting the first data row.
        const headerRow =
          rows.find((row) => row.parentNode && row.parentNode.nodeName === 'THEAD') ||
          rows.find((row) => {
            const cells = Array.from(row.childNodes).filter((c) => c.nodeType === 1)
            return cells.length && cells.every((c) => c.nodeName === 'TH')
          })
        const bodyRows = rows.filter((row) => row !== headerRow).map(cellsOf)
        const headerCells = headerRow ? cellsOf(headerRow) : []
        const columnCount = Math.max(headerCells.length, ...bodyRows.map((r) => r.length))
        if (!columnCount) return ''

        const pad = (cells) => cells.concat(Array(columnCount - cells.length).fill(''))
        const line = (cells) => `| ${pad(cells).join(' | ')} |`

        const lines = [
          line(headerCells),
          `| ${Array(columnCount).fill('---').join(' | ')} |`,
          ...bodyRows.filter((cells) => cells.length).map(line),
        ]
        return `\n\n${lines.join('\n')}\n\n`
      },
    })

    // Callout lists: Asciidoctor renders them as a two-column table whose
    // first cell is the number, which the table rule would turn into a header.
    turndownInstance.addRule('callout-list', {
      filter: isCalloutTable,
      replacement: function (_, node) {
        const rows = Array.from(node.querySelectorAll('tr')).filter((row) => closestTable(row) === node)
        const items = rows
          .map((row, index) => {
            const cells = Array.from(row.querySelectorAll('td'))
            if (cells.length < 2) return null
            const conum = cells[0].querySelector('.conum')
            const number =
              (conum && conum.getAttribute('data-value')) ||
              (cells[0].textContent || '').trim().replace(/\D/g, '') ||
              String(index + 1)
            const text = convert(cells[1]).trim().replace(/\n/g, '\n   ')
            return `${number}. ${text}`
          })
          .filter(Boolean)
        return items.length ? `\n\n${items.join('\n')}\n\n` : ''
      },
    })

    // Literal and plain listing blocks render as <pre> with no <code> child.
    // Turndown only fences <pre><code>, so these were escaped as prose.
    turndownInstance.addRule('literal-block', {
      filter: (node) => node.nodeName === 'PRE' && !(node.firstChild && node.firstChild.nodeName === 'CODE'),
      replacement: (_, node) => fencedCodeBlock(node.textContent || ''),
    })

    // Inline code is emitted from its text. Asciidoctor auto-links URLs inside
    // monospace, and a Markdown link cannot live inside a code span.
    turndownInstance.addRule('inline-code', {
      filter: (node) => node.nodeName === 'CODE' && !(node.parentNode && node.parentNode.nodeName === 'PRE'),
      replacement: (_, node) => inlineCode(node.textContent || ''),
    })

    // Links: empty anchors (the `<a class="anchor">` Antora puts in every
    // heading) vanish, and relative targets become absolute.
    turndownInstance.addRule('links', {
      filter: (node) => node.nodeName === 'A' && !!node.getAttribute('href'),
      replacement: (content, node) => {
        if (!content.trim()) return ''
        const href = resolveTarget(node.getAttribute('href'), pageUrl).replace(/([()])/g, '\\$1')
        const title = cleanAttribute(node.getAttribute('title'))
        const titlePart = title ? ` "${title.replace(/"/g, '\\"')}"` : ''
        return `[${content}](${href}${titlePart})`
      },
    })

    turndownInstance.addRule('images', {
      filter: 'img',
      replacement: (_, node) => {
        const src = resolveTarget(node.getAttribute('src'), pageUrl)
        if (!src) return ''
        const alt = cleanAttribute(node.getAttribute('alt'))
        const title = cleanAttribute(node.getAttribute('title'))
        const titlePart = title ? ` "${title.replace(/"/g, '\\"')}"` : ''
        return `![${alt}](${src}${titlePart})`
      },
    })

    // Description lists have no Markdown form. Bold the term so it reads as
    // a label for the paragraphs that follow.
    turndownInstance.addRule('description-term', {
      filter: 'dt',
      replacement: (content) => {
        const term = content.trim()
        return term ? `\n\n**${term}**\n\n` : ''
      },
    })
    turndownInstance.addRule('description-details', {
      filter: 'dd',
      replacement: (content) => `\n\n${content.trim()}\n\n`,
    })
  }

  addCustomRules(outerTurndown, false)
  addCustomRules(nestedTurndown, true)
  addRemoveUnwantedRule(outerTurndown)
  addRemoveUnwantedRule(nestedTurndown)
  return outerTurndown
}

// --- Page conversion -----------------------------------------------------------

const ARTICLE_REGEX = /<article[^>]*class=["'][^"']*\bdoc\b[^"']*["'][^>]*>([\s\S]*?)<\/article>/i

const noopLogger = { info () {}, warn () {}, debug () {}, error () {} }

/**
 * Convert one published page's HTML to the Markdown export.
 *
 * Output shape for a regular page:
 *
 *   ---
 *   title: …
 *   ---
 *
 *   # Title
 *
 *   > For the complete documentation index, see …
 *
 *   <!-- Source: https://…/page.md -->
 *
 *   body
 *
 * Front matter comes first so Markdown tooling reads it as metadata rather
 * than as body text. Field-only pages (see generate-fields-only-pages) get the
 * body alone.
 *
 * @param {Object} options
 * @param {string} options.html - The page's full HTML.
 * @param {Object} options.page - Antora page (asciidoc, pub, src, isFieldOnlyPage).
 * @param {string} [options.siteUrl] - Playbook site.url.
 * @param {Object} [options.logger] - Antora logger.
 * @returns {string} Markdown, or an empty string when the page has no article.
 */
function convertPageHtml ({ html, page, siteUrl = '', logger = noopLogger }) {
  const trimmed = (html || '').toString().trim()
  if (!trimmed) return ''

  const match = trimmed.match(ARTICLE_REGEX)
  if (!match || !match[1]) {
    logger.info(`No <article class="doc"> found for ${page.src?.path}`)
    return ''
  }

  let pageUrl = null
  if (siteUrl && page.pub?.url) {
    try {
      pageUrl = new URL(page.pub.url, siteUrl)
    } catch (e) {
      logger.debug(`Failed to resolve page URL for ${page.src?.path}: ${e.message}`)
    }
  }

  const root = parseFragment(match[1])
  markLineContinuations(root)
  const td = createTurndownForPage({ pageUrl, logger })
  let markdown = td.turndown(root).split(CONTINUATION_SENTINEL).join('').trim()

  let canonicalUrl = ''
  if (pageUrl) {
    const canonical = new URL(pageUrl.toString())
    canonical.pathname = toMarkdownUrl(canonical.pathname)
    canonicalUrl = canonical.toString()
  }

  if (page.isFieldOnlyPage === true) {
    // Field-only pages: body only, no front matter, directive or source comment.
    markdown = markdown.replace(/\[]\(#[^)]+\)/g, '').trim()
  } else {
    const frontmatter = generateFrontmatter(page)
    if (frontmatter) logger.debug(`Generated frontmatter for ${page.src?.path}`)

    // The H1 only counts when it opens the document.
    const h1Match = markdown.match(/^(#\s+.+?)(\n|$)/)
    let h1Heading = ''
    let restOfMarkdown = markdown
    if (h1Match) {
      h1Heading = h1Match[0]
      restOfMarkdown = markdown.substring(h1Match[0].length).trimStart()
    }

    const llmsDirective = formatLlmsDirective(canonicalUrl ? page.src?.component || '' : undefined)
    const sourceComment = canonicalUrl ? `<!-- Source: ${canonicalUrl} -->\n\n` : ''
    markdown = `${frontmatter}${h1Heading}\n${llmsDirective}\n\n${sourceComment}${restOfMarkdown}`
  }

  // Links written after conversion (the directive) are root-relative.
  if (siteUrl) {
    try {
      const baseUrl = new URL(siteUrl)
      markdown = markdown.replace(/\[([^\]]+)\]\(\/([^)]+)\)/g, (whole, text, path) => {
        try {
          return `[${text}](${new URL('/' + path, baseUrl).toString()})`
        } catch (e) {
          return whole
        }
      })
    } catch (e) {
      logger.debug(`Failed to resolve root-relative URLs for ${page.src?.path}: ${e.message}`)
    }
  }

  return markdown
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+$/gm, '')
    .trim()
}

module.exports.convertPageHtml = convertPageHtml

module.exports.register = function () {
  raiseListenerLimit(this)
  const logger = this.getLogger('convert-to-markdown-extension')

  // Add marker attribute before UI rendering so templates can detect markdown availability
  this.on('documentsConverted', ({ contentCatalog }) => {
    const pages = contentCatalog.findBy({ family: 'page' })
    logger.info(`Marking ${pages.length} pages as having markdown equivalents...`)

    pages.forEach((page) => {
      if (!page.asciidoc) page.asciidoc = {}
      if (!page.asciidoc.attributes) page.asciidoc.attributes = {}
      page.asciidoc.attributes['page-has-markdown'] = ''
    })
  })

  // Conversion pipeline
  this.on('pagesComposed', async ({ playbook, contentCatalog }) => {
    const siteUrl = playbook.site?.url || ''
    const pages = contentCatalog.getPages()
    logger.info(`Converting ${pages.length} pages to Markdown${siteUrl ? ` (site.url=${siteUrl})` : ''}...`)

    const concurrency = Math.max(2, Math.floor(os.cpus().length / 2))
    const queue = [...pages]
    let convertedCount = 0

    async function processQueue () {
      while (queue.length) {
        const page = queue.shift()
        if (!page?.contents) continue

        try {
          const markdown = convertPageHtml({ html: page.contents.toString(), page, siteUrl, logger })
          if (markdown) {
            page.markdownContents = Buffer.from(markdown, 'utf8')
            convertedCount++
          }
        } catch (err) {
          logger.error(`Error converting ${page.src?.path || 'unknown'}: ${err.message}`)
          logger.debug(err.stack)
        }
      }
    }

    const workers = Array.from({ length: concurrency }, processQueue)
    await Promise.all(workers)
    logger.info(`Converted ${convertedCount} Markdown files.`)
  })

  // Add Markdown files to site catalog
  this.on('beforePublish', ({ siteCatalog, contentCatalog }) => {
    const pages = contentCatalog.getPages((p) => p.markdownContents)
    if (!pages.length) {
      logger.info('No Markdown files to publish.')
      return
    }
    logger.info(`Adding ${pages.length} Markdown files to site catalog...`)
    for (const page of pages) {
      const htmlOut = page.out?.path
      if (!htmlOut) continue

      const mdOutPath = toMarkdownUrl(htmlOut)
      siteCatalog.addFile({
        contents: page.markdownContents,
        out: { path: mdOutPath },
      })
      logger.debug(`Added Markdown: ${mdOutPath}`)
    }
  })
}

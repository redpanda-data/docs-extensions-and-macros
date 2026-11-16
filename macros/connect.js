'use strict'

/* Inline macro for a Redpanda Connect component or one of its fields,
 * linked to the generated component reference:
 *
 *   connect:[inputs/kafka_franz]                  -> `kafka_franz` input, linked
 *   connect:[inputs/kafka_franz.consumer_group]   -> `consumer_group`, linked to its field
 *   connect:[outputs/kafka.metadata]              -> `metadata`, linked to #metadata-2
 *   connect:[inputs/kafka_franz,`kafka_franz`]    -> `kafka_franz`, linked
 *
 * The brackets hold <type>/<name> as the rp-connect-docs paths write it,
 * then an optional field path, as connectval: takes it. The type is always
 * written, because 71 names exist in more than one type. The next attribute,
 * or text=, replaces the link text.
 *
 * Only the short form exists: Asciidoctor matches an inline macro name
 * anywhere in a word, so a connect:<target>[] form would match inside
 * xref:connect:components:inputs/kafka.adoc[].
 *
 * The component and field are checked against the Connect data connectval:
 * reads, and the page is found in the content catalog
 * (extension-utils/connect-links.js): the rendering page's own component
 * first, where Cloud has its stubs, then the connect component. A Cloud page
 * links only Cloud pages. An unknown component or field, or no page, renders
 * plain code with no link and says why, according to connect-validate
 * (warn, error or off). A former name, one the connect docs alias to another
 * component's page (outputs/kafka_migrator), renders as written, links that
 * component, and warns with its name. A deprecated component or field links
 * as before and warns with its replacement when the data names one. See
 * macros/REFERENCE.adoc.
 *
 * Registered by macros/prop, so every playbook that registers prop: has it.
 */

const connectLinks = require('../extension-utils/connect-links')
const connectValues = require('../extension-utils/connect-values')
const datasets = require('../extension-utils/attachment-datasets')
const { escapeHtml } = require('../extension-utils/html-utils')
const { normalizeType } = require('../extensions/util/connect-catalog')
const logger = require('@antora/logger')('connect-macro')

// Kinds that fail the build in error mode: authoring errors. No data and no
// page are gaps in the build, and plain code still reads correctly. A former
// or deprecated name only warns: it renders and links correctly.
const THROW_KINDS = ['unknown-type', 'unknown-component', 'unknown-field']

const ROLE = 'connect-component'

// Inline macros run after Asciidoctor escapes special characters.
const unescape = (value) => String(value).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

/**
 * The HTML inside the link, or the whole output when there is no link. The
 * default text is the component name as code and its type, or the field
 * path as code. text is used as Asciidoctor passed it, already substituted.
 */
function buildConnectContent ({ component, path, type, text, plain = false, shownName }) {
  if (text) return text
  const shown = path || shownName || (component.split('/')[1] || component)
  const words = !path && type ? ` ${escapeHtml(connectLinks.typeWords(type))}` : ''
  if (plain) return `<code>${escapeHtml(shown)}</code>${words}`
  const fieldAttr = path ? ` data-connect-field="${escapeHtml(path)}"` : ''
  return `<code class="${ROLE}" data-connect-component="${escapeHtml(component)}"${fieldAttr}>${escapeHtml(shown)}</code>${words}`
}

function connectInlineMacro (config) {
  return function () {
    const self = this
    self.named('connect')
    // connect:[...]: no target.
    self.option('format', 'short')
    self.positionalAttributes(['ref', 'text'])
    self.process(function (parent, target, attributes) {
      const document = parent.getDocument()
      const mode = String(document.getAttribute('connect-validate', 'warn')).trim().toLowerCase()
      const src = (config && config.file && config.file.src) || {}
      const filePath = src.path
      const written = unescape(attributes.ref == null ? '' : attributes.ref).trim()
      const text = attributes.text == null ? undefined : String(attributes.text)
      const call = `connect:[${written}]${filePath ? ` in ${filePath}` : ''}`
      const { component: componentText, path } = connectValues.parseFieldTarget(written)
      const typeOf = () => {
        const parsed = connectValues.parseComponent(componentText)
        return parsed && parsed.type ? normalizeType(parsed.type) : undefined
      }

      const plain = (message, kind, type) => {
        if (mode === 'error' && THROW_KINDS.includes(kind)) throw new Error(message)
        if (mode !== 'off') logger.warn(message)
        return self.createInline(parent, 'quoted', buildConnectContent({ component: componentText, path, type, text, plain: true }))
      }

      const contentCatalog = config && config.contentCatalog
      if (!contentCatalog) return plain(`${call}: no content catalog, so the component cannot be checked or linked; it renders as plain code.`, 'no-data', typeOf())
      const registry = connectValues.loadConnect(contentCatalog)
      if (!registry) {
        if (mode !== 'off') datasets.warnDatasetMissing(contentCatalog, connectValues.CONNECT_COMPONENT, '', connectValues.CONNECT_KIND)
        return plain(`${call}: this build has no Connect data to check '${written}' against (see the connectval macro warning), so it renders as plain code with no link.`, 'no-data', typeOf())
      }
      const dataset = datasets.describeDataset(registry)
      // A former name (outputs/kafka_migrator) renders as written and links
      // the component its page path now goes to; a deprecated name links its
      // own page, which documents it. Both warn with what to write instead,
      // and neither throws: the output is right.
      const advice = connectLinks.referenceAdvice(contentCatalog, registry.data, written)
      const suggest = (ref) => `connect:[${ref}${text === undefined ? '' : `,${unescape(text)}`}]`
      const renamed = advice && advice.kind === 'renamed' ? advice.replacement : undefined
      const lookup = renamed ? `${connectLinks.typeDir(renamed.key)}/${renamed.name}${path ? `.${path}` : ''}` : written
      const resolved = connectLinks.resolveComponentRef(registry.data, lookup)
      if (!resolved.ok) {
        const hint = resolved.suggestions && resolved.suggestions.length ? ` Did you mean: ${resolved.suggestions.join(', ')}?` : ''
        const was = renamed ? ` ${connectLinks.adviceSentence(advice, { written, dataset, suggest }).replace(/^./, (c) => c.toUpperCase())}` : ''
        return plain(`${call}: ${resolved.message} in ${dataset}, so it renders as plain code with no link.${hint}${was}`, resolved.kind, typeOf())
      }
      // A deprecated field's sentence joins the no-anchor warning below.
      if (advice && advice.kind !== 'deprecated-field' && mode !== 'off') logger.warn(`${call}: ${connectLinks.adviceSentence(advice, { written, dataset, suggest })}`)

      const component = `${connectLinks.typeDir(resolved.key)}/${resolved.name}`
      const relative = connectLinks.componentPagePath(resolved.key, resolved.name)
      const cloud = connectLinks.isCloud(contentCatalog, src.component, src.version)
      let page = connectLinks.pickConnectPage(contentCatalog, { component: src.component, version: src.version, module: connectLinks.COMPONENTS_MODULE, relative, cloud })
      // A deprecated component whose path the connect docs alias to its
      // replacement's page (pg_stream to postgres_cdc) links that page where
      // the rendering component has no page of its own for it, as connect
      // itself does.
      const aliased = advice && advice.kind === 'deprecated-component' && advice.replacement && advice.replacement.source === 'page-alias' ? advice.replacement : undefined
      if (!page.ok && aliased) {
        const instead = connectLinks.pickConnectPage(contentCatalog, { component: src.component, version: src.version, module: connectLinks.COMPONENTS_MODULE, relative: connectLinks.componentPagePath(aliased.key, aliased.name), cloud })
        if (instead.ok) page = instead
      }
      if (!page.ok) {
        const where = `${src.component || 'unknown component'}@${src.version || 'unversioned'}`
        const why = page.reason === 'cloud-no-page'
          ? `${where} has no page for the ${resolved.type} '${resolved.name}' (components:${relative}), and a Cloud page links only Cloud pages`
          : `no component in this build has a page for the ${resolved.type} '${resolved.name}' (components:${relative})`
        return plain(`${call}: ${why}, so it renders as plain code with no link.`, 'no-page', resolved.type)
      }
      let fragment
      if (resolved.path) {
        const anchor = connectLinks.fieldAnchor({ resolved, catalog: contentCatalog, format: connectValues.docsFormat(registry.data) })
        if (anchor.anchor) fragment = anchor.anchor
        else if (mode !== 'off') {
          const field = advice && advice.kind === 'deprecated-field'
            ? (advice.field ? ` Its replacement is ${advice.field}: write ${suggest(advice.ref)}.` : ` ${advice.why.replace(/^./, (c) => c.toUpperCase())}.`)
            : ''
          logger.warn(`${call}: the Connect reference does not list '${resolved.path}' (it is deprecated in ${dataset}), so the link goes to the ${resolved.type} page with no anchor.${field}`)
        }
      }
      const content = buildConnectContent({ component, path: resolved.path, type: resolved.type, text, shownName: renamed ? (componentText.split('/')[1] || undefined) : undefined })
      // An xref node: Antora's converter resolves path to the page's URL,
      // exactly as it resolves xref:[] in the source.
      return self.createInline(parent, 'anchor', content, {
        type: 'xref',
        target: `#${page.id}`,
        attributes: { path: page.id, ...(fragment ? { fragment } : {}) },
      })
    })
  }
}

module.exports.connectInlineMacro = connectInlineMacro
module.exports.buildConnectContent = buildConnectContent
module.exports.THROW_KINDS = THROW_KINDS

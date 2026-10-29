'use strict'

/* Inline macro for an rpk command, written as on the command line and linked
 * to its generated reference page:
 *
 *   rpkcmd:[rpk topic create]                    -> `rpk topic create`, linked
 *   rpkcmd:[rpk topic create --partitions]       -> `rpk topic create --partitions`, linked to rpk topic create
 *   rpkcmd:[rpk topic create,text=create a topic] -> create a topic, linked
 *
 * The brackets hold the command exactly as typed, aliases included, then at
 * most one flag (long or shorthand), without values or arguments; the leading
 * rpk is optional. The command and flag render as inline code, or text=
 * replaces them. The generated pages have no flag anchors, so a flag links
 * its command's page.
 *
 * The command is checked against the rpk data exactly as rpkval: checks it,
 * and the page is found in the content catalog (extension-utils/rpk-links.js):
 * the rendering page's own component and version, then streaming, then any
 * other component with the page. A Cloud page links only Cloud pages. An
 * unknown or deprecated command, an unknown flag, or no page renders plain
 * code with no link and says why, according to rpk-validate (warn, error or
 * off). See macros/REFERENCE.adoc.
 *
 * Registered by macros/prop, so every playbook that registers prop: has it.
 */

const rpkLinks = require('../extension-utils/rpk-links')
const datasets = require('../extension-utils/attachment-datasets')
const { escapeHtml } = require('../extension-utils/html-utils')
const rpkValues = require('../extension-utils/rpk-values')
const logger = require('@antora/logger')('rpkcmd-macro')

// Kinds that fail the build in error mode: authoring errors. No data and no
// page are gaps in the build, and plain code still reads correctly.
const THROW_KINDS = ['unknown-command', 'unknown-flag', 'deprecated-command']

const ROLE = 'rpk-command'

// Inline macros run after Asciidoctor escapes special characters, so the
// attributes arrive with < > & already escaped.
const unescape = (value) => String(value).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

/**
 * The HTML inside the link, or the whole output when there is no link. text
 * is used as Asciidoctor passed it, already escaped, as prop: uses text=.
 */
function buildRpkcmdContent ({ display, text, command, flag, plain = false }) {
  if (text) return text
  if (plain) return `<code>${escapeHtml(display)}</code>`
  const flagAttr = flag ? ` data-rpk-flag="${escapeHtml(flag)}"` : ''
  return `<code class="${ROLE}" data-rpk-command="${escapeHtml(command)}"${flagAttr}>${escapeHtml(display)}</code>`
}

function rpkcmdInlineMacro (config) {
  return function () {
    const self = this
    self.named('rpkcmd')
    // rpkcmd:[...]: no target, the command line is the first attribute.
    self.option('format', 'short')
    self.positionalAttributes(['command'])
    self.process(function (parent, target, attributes) {
      const document = parent.getDocument()
      const mode = String(document.getAttribute('rpk-validate', 'warn')).trim().toLowerCase()
      const src = (config && config.file && config.file.src) || {}
      const filePath = src.path
      const component = src.component || ''
      const version = src.version || ''
      const line = unescape(attributes.command == null ? '' : attributes.command).trim()
      const text = attributes.text == null ? undefined : String(attributes.text)
      const call = `rpkcmd:[${line}]${filePath ? ` in ${filePath}` : ''}`
      const parsed = rpkValues.parseCommandLine(line)
      const display = [['rpk', ...parsed.tokens].join(' '), ...(parsed.flag ? [parsed.flag] : []), ...parsed.extra].join(' ')

      const plain = (message, kind) => {
        if (mode === 'error' && THROW_KINDS.includes(kind)) throw new Error(message)
        if (mode !== 'off') logger.warn(message)
        return self.createInline(parent, 'quoted', buildRpkcmdContent({ display, text, plain: true }))
      }

      const contentCatalog = config && config.contentCatalog
      if (!contentCatalog) return plain(`${call}: no content catalog, so the command cannot be checked or linked; it renders as plain code.`, 'no-data')
      const registry = rpkLinks.loadRpkForLinks(contentCatalog, component, version)
      if (!registry && mode !== 'off') datasets.warnDatasetMissing(contentCatalog, component, version, rpkValues.RPK_KIND)
      const resolved = rpkLinks.resolveRpkCommand({ registry, text: line, call })
      if (!resolved.ok) return plain(resolved.message, resolved.kind)

      const command = ['rpk', ...resolved.names].join(' ')
      const relative = rpkLinks.commandPagePath(registry.data.tree, resolved.names)
      const page = rpkLinks.pickCommandPage(contentCatalog, { component, version, relative })
      if (!page.ok) {
        const where = `${component || 'unknown component'}@${version || 'unversioned'}`
        const why = page.reason === 'cloud-no-page'
          ? `${where} has no reference page for ${command} (reference:${relative}), and a Cloud page links only Cloud pages`
          : `no component in this build has a reference page for ${command} (reference:${relative})`
        return plain(`${call}: ${why}, so it renders as plain code with no link.`, 'no-page')
      }
      const content = buildRpkcmdContent({ display, text, command, flag: resolved.flag && resolved.flag.name })
      // An xref node: Antora's converter resolves the path attribute to the
      // page's URL, exactly as it resolves xref:[] in the source.
      return self.createInline(parent, 'anchor', content, {
        type: 'xref',
        target: `#${page.id}`,
        attributes: { path: page.id },
      })
    })
  }
}

module.exports.rpkcmdInlineMacro = rpkcmdInlineMacro
module.exports.buildRpkcmdContent = buildRpkcmdContent
module.exports.THROW_KINDS = THROW_KINDS

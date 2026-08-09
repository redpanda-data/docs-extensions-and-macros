'use strict'

/* Inline macro for marking enterprise features in prose.
 *
 * Example use in a page:
 *
 *   enterprise:Continuous Data Balancing[]
 *   enterprise:Tiered Storage[xref=manage:tiered-storage.adoc]
 *   enterprise:Audit Logging[text=audit logging]
 *   enterprise:Iceberg Topics[tooltip=Iceberg Topics requires an Enterprise Edition license and object storage.]
 *
 * The feature name renders as a uniquely styled term with a tooltip that
 * explains the feature requires an Enterprise Edition license. The term
 * links to the feature's documentation when an xref attribute is given,
 * and otherwise to the licensing page, so readers can always reach an
 * explanation of what having (or not having) a license means.
 *
 * Document or site attributes:
 *
 *   enterprise-licensing-page  Resource ID of the licensing page used when
 *                              no xref attribute is given
 *                              (default: get-started:licensing/overview.adoc).
 *   enterprise-feature-role    CSS class applied to the wrapping span
 *                              (default: enterprise-feature).
 *   enterprise-tooltip         'title' (default), 'true' (renders
 *                              data-enterprise-tooltip), any attribute name
 *                              starting with 'data-', or 'false' to disable.
 *   enterprise-links           'true' (default) to render the term as a link.
 *
 * Example use in a playbook:
 *
 *   asciidoc:
 *     extensions:
 *     - '@redpanda-data/docs-extensions-and-macros/macros/enterprise'
 */

const DEFAULT_LICENSING_PAGE = 'get-started:licensing/overview.adoc'
const DEFAULT_ROLE = 'enterprise-feature'

/**
 * Resolve the tooltip attribute name from the enterprise-tooltip document
 * attribute. Mirrors the glossary macro's contract.
 *
 * @param {string|undefined} raw - Raw attribute value.
 * @returns {string|undefined} Attribute name to emit, or undefined when disabled.
 */
function resolveTooltipAttribute (raw) {
  if (raw === 'false') return undefined
  if (raw === undefined || raw === 'title') return 'title'
  if (raw === 'true') return 'data-enterprise-tooltip'
  if (raw.startsWith('data-')) return raw
  console.warn(`enterprise-tooltip attribute '${raw}' must be 'title', 'true', 'false', or start with 'data-'. Falling back to 'title'.`)
  return 'title'
}

/**
 * Build the AsciiDoc content emitted for one macro instance. Exported for
 * unit testing.
 *
 * @param {object} opts
 * @param {string} opts.feature - Feature name from the macro target.
 * @param {string} [opts.text] - Display text override.
 * @param {string} [opts.xref] - Resource ID of the feature documentation.
 * @param {string} [opts.tooltip] - Tooltip text override.
 * @param {string} opts.licensingPage - Resource ID of the licensing page.
 * @param {string} opts.role - CSS class for the wrapping span.
 * @param {string|undefined} opts.tooltipAttr - Tooltip attribute name, or undefined to omit.
 * @param {boolean} opts.links - Whether to render a link.
 * @returns {string}
 */
function buildEnterpriseContent ({ feature, text, xref, tooltip, licensingPage, role, tooltipAttr, links }) {
  const display = text || feature
  const tooltipText = tooltip || `${feature} requires an Enterprise Edition license.`
  const escapedTooltip = tooltipText.replace(/"/g, '&quot;')
  const tooltipHtml = tooltipAttr ? ` ${tooltipAttr}="${escapedTooltip}"` : ''
  const inner = links ? `xref:${xref || licensingPage}[${display}]` : display
  return `<span class="${role}"${tooltipHtml}>${inner}</span>`
}

function enterpriseInlineMacro () {
  return function () {
    const self = this
    self.named('enterprise')
    // Specifying the regexp allows spaces in the feature name.
    self.$option('regexp', /enterprise:([^[]+)\[(|.*?[^\\])\]/)
    self.process(function (parent, target, attributes) {
      const document = parent.getDocument()
      const content = buildEnterpriseContent({
        feature: target,
        text: attributes.text,
        xref: attributes.xref,
        tooltip: attributes.tooltip,
        licensingPage: document.getAttribute('enterprise-licensing-page', DEFAULT_LICENSING_PAGE),
        role: document.getAttribute('enterprise-feature-role', DEFAULT_ROLE),
        tooltipAttr: resolveTooltipAttribute(document.getAttribute('enterprise-tooltip')),
        links: document.getAttribute('enterprise-links', 'true') === 'true',
      })
      // The xref inside the span is resolved by the 'macros' substitution,
      // the same mechanism the config_ref macro relies on.
      return self.createInline(parent, 'quoted', content, { attributes: { subs: 'macros' } })
    })
  }
}

function register (registry) {
  if (typeof registry.register === 'function') {
    registry.register(function () {
      this.inlineMacro(enterpriseInlineMacro())
    })
  } else if (typeof registry.inlineMacro === 'function') {
    registry.inlineMacro(enterpriseInlineMacro())
  } else {
    console.warn("no 'inlineMacro' method on alleged registry")
  }
  return registry
}

module.exports.register = register
module.exports.buildEnterpriseContent = buildEnterpriseContent
module.exports.resolveTooltipAttribute = resolveTooltipAttribute

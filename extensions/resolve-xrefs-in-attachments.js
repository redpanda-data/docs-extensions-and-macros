'use strict'

/**
 * Resolves AsciiDoc xrefs in JSON attachment files to HTML links.
 *
 * This extension automatically processes ALL JSON attachments across all
 * components and converts xref syntax to HTML anchor tags using Antora's
 * content catalog for proper URL resolution.
 *
 * No configuration needed - just add to playbook:
 *   antora:
 *     extensions:
 *       - require: ./extensions/resolve-xrefs-in-attachments.js
 *
 * Xref patterns handled:
 * - xref:./relative-path.adoc#anchor[display text]
 * - xref:module:path/to/file.adoc#anchor[display text]
 * - xref:path.adoc[] (empty display uses page title or path)
 */

module.exports.register = function () {
  const logger = this.getLogger('resolve-xrefs-in-attachments')

  this.on('contentClassified', ({ contentCatalog }) => {
    // Process all JSON attachments across all components
    const allAttachments = contentCatalog.findBy({ family: 'attachment' })
    const jsonAttachments = allAttachments.filter((att) => {
      const path = att.src?.path || att.out?.path || ''
      return path.endsWith('.json')
    })

    if (!jsonAttachments.length) {
      logger.debug('No JSON attachments found')
      return
    }

    let processedCount = 0
    let xrefCount = 0

    jsonAttachments.forEach((attachment) => {
      try {
        const result = processJsonAttachment(attachment, contentCatalog, logger)
        if (result.modified) {
          processedCount++
          xrefCount += result.xrefCount
        }
      } catch (err) {
        logger.warn(`Error processing ${attachment.src?.path}: ${err.message}`)
      }
    })

    if (processedCount > 0) {
      logger.info(`Resolved ${xrefCount} xrefs in ${processedCount} JSON attachments`)
    }
  })
}

/**
 * Process a JSON attachment, resolving xrefs in all string values.
 * @returns {{ modified: boolean, xrefCount: number }}
 */
function processJsonAttachment (attachment, contentCatalog, logger) {
  const contentStr = attachment.contents.toString('utf8')

  // Quick check - skip if no xrefs present
  if (!contentStr.includes('xref:')) {
    return { modified: false, xrefCount: 0 }
  }

  let data
  try {
    data = JSON.parse(contentStr)
  } catch (err) {
    logger.debug(`Skipping invalid JSON: ${attachment.src?.path}`)
    return { modified: false, xrefCount: 0 }
  }

  // Create a context for xref resolution using the attachment's location
  const context = {
    component: attachment.src.component,
    version: attachment.src.version,
    module: attachment.src.module || 'ROOT',
    xrefCount: 0,
  }

  // Recursively process all string values in the JSON
  const processed = processValue(data, contentCatalog, context, logger)

  // Write back the modified JSON
  attachment.contents = Buffer.from(JSON.stringify(processed, null, 2), 'utf8')

  return { modified: true, xrefCount: context.xrefCount }
}

/**
 * Recursively process a value, resolving xrefs in strings.
 */
function processValue (value, contentCatalog, context, logger) {
  if (typeof value === 'string') {
    return resolveXrefsInString(value, contentCatalog, context, logger)
  }

  if (Array.isArray(value)) {
    return value.map((item) => processValue(item, contentCatalog, context, logger))
  }

  if (value && typeof value === 'object') {
    const result = {}
    for (const [key, val] of Object.entries(value)) {
      result[key] = processValue(val, contentCatalog, context, logger)
    }
    return result
  }

  return value
}

/**
 * Resolve xrefs in a string to HTML anchor tags.
 *
 * @param {string} text - Text containing xref macros
 * @param {Object} contentCatalog - Antora content catalog
 * @param {Object} context - Context with component, version, module, xrefCount
 * @param {Object} logger - Logger instance
 * @returns {string} Text with xrefs resolved to HTML links
 */
function resolveXrefsInString (text, contentCatalog, context, logger) {
  if (!text || !text.includes('xref:')) return text

  // Match xref:target[link text] pattern - link text may be empty
  const xrefPattern = /xref:([^\[]+)\[([^\]]*)\]/g

  return text.replace(xrefPattern, (match, target, linkText) => {
    context.xrefCount++

    try {
      // Handle anchor separately
      let anchor = ''
      let targetPath = target
      if (target.includes('#')) {
        const parts = target.split('#')
        targetPath = parts[0]
        anchor = parts[1] || ''
      }

      // Normalize target path for resolution
      // - ./file.adoc → file.adoc (relative)
      // - file.adoc → file.adoc (same dir)
      // - module:path.adoc → already qualified
      let normalizedTarget = targetPath.replace(/^\.\//, '')

      // For relative paths without module prefix, try to find a page that matches
      let resource = null

      if (!normalizedTarget.includes(':')) {
        // Try direct resolution first
        resource = contentCatalog.resolveResource(normalizedTarget, {
          component: context.component,
          version: context.version,
          module: context.module,
        }, 'page')

        // If not found and looks like a properties file, try reference module
        if (!resource && (normalizedTarget.includes('properties') || normalizedTarget.includes('cluster-') || normalizedTarget.includes('topic-'))) {
          // Try with explicit reference module path
          resource = contentCatalog.resolveResource(`reference:properties/${normalizedTarget}`, {
            component: context.component,
            version: context.version,
            module: 'ROOT',
          }, 'page')
        }

        // Try finding the page directly by searching
        if (!resource) {
          const basename = normalizedTarget.replace(/\.adoc$/, '')
          const pages = contentCatalog.findBy({
            component: context.component,
            version: context.version,
            family: 'page',
          })
          resource = pages.find(p => {
            const pageStem = p.src.stem || p.src.basename?.replace(/\.adoc$/, '')
            return pageStem === basename
          })
        }
      } else {
        // Already module-qualified
        resource = contentCatalog.resolveResource(normalizedTarget, {
          component: context.component,
          version: context.version,
          module: 'ROOT',
        }, 'page')
      }

      if (resource && resource.pub && resource.pub.url) {
        let url = resource.pub.url
        if (anchor) {
          // Convert anchor: underscores to hyphens for URL
          url += '#' + anchor.replace(/_/g, '-')
        }

        // Use link text if provided, otherwise use page title or target path
        const display = linkText || resource.asciidoc?.doctitle || targetPath.replace(/\.adoc$/, '').replace(/^.*\//, '')

        return `<a href="${escapeHtml(url)}">${escapeHtml(display)}</a>`
      } else {
        // Resource not found - log and keep original or use link text
        logger.debug(`Could not resolve xref: ${target} from ${context.component}:${context.module}`)
        return linkText || target.replace(/\.adoc$/, '').replace(/^.*\//, '')
      }
    } catch (error) {
      logger.debug(`Xref resolution error for ${target}: ${error.message}`)
      return linkText || target.replace(/\.adoc$/, '').replace(/^.*\//, '')
    }
  })
}

/**
 * Escape HTML special characters to prevent XSS.
 */
function escapeHtml (text) {
  if (!text) return ''
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

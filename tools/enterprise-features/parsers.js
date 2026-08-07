'use strict'

/* Parsers for the sources of truth compared by `doc-tools validate
 * enterprise-features`. Each parser is pure (string in, data out) so it can
 * be unit-tested with trimmed fixtures.
 */

const Papa = require('papaparse')

/**
 * Extract the license_required_feature enum values from
 * src/v/features/enterprise_features.h.
 *
 * @param {string} source - Header file contents.
 * @returns {string[]} Enum value names in declaration order.
 */
function parseCoreEnum (source) {
  const match = source.match(/enum\s+class\s+license_required_feature[^{]*\{([\s\S]*?)\}/)
  if (!match) {
    throw new Error('Could not find enum class license_required_feature in enterprise_features.h. The header layout may have changed.')
  }
  return match[1]
    .split(',')
    .map((entry) => entry.replace(/\/\/.*$/gm, '').trim())
    .filter((entry) => /^[a-z_][a-z0-9_]*$/.test(entry))
}

/**
 * Extract the names of config::enterprise<>-wrapped properties from
 * src/v/config/configuration.h. Handles multi-line declarations by
 * balancing angle brackets from each `enterprise<` occurrence.
 *
 * @param {string} source - Header file contents.
 * @returns {string[]} Property member names.
 */
function parseEnterpriseProperties (source) {
  const names = []
  const re = /\benterprise</g
  let match
  while ((match = re.exec(source)) !== null) {
    let depth = 1
    let i = match.index + match[0].length
    while (i < source.length && depth > 0) {
      if (source[i] === '<') depth++
      else if (source[i] === '>') depth--
      i++
    }
    const rest = source.slice(i)
    const nameMatch = rest.match(/^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*;/)
    if (nameMatch) names.push(nameMatch[1])
  }
  return [...new Set(names)]
}

/**
 * Extract the plugins marked enterprise in connect internal/plugins/info.csv.
 *
 * @param {string} source - CSV contents.
 * @returns {string[]} Plugin names with support == enterprise.
 */
function parseConnectEnterprisePlugins (source) {
  // The real info.csv header has spaces after the commas (name, type, ...),
  // so headers must be trimmed to get usable keys.
  const parsed = Papa.parse(source.trim(), {
    header: true,
    skipEmptyLines: true,
    transformHeader: (header) => header.trim(),
  })
  return parsed.data
    .filter((row) => (row.support || '').trim().toLowerCase() === 'enterprise')
    .map((row) => (row.name || '').trim())
    .filter(Boolean)
}

/**
 * Extract feature name and disabling property from the table in
 * disable-enterprise-features.adoc. Rows look like:
 *
 *   | xref:...[Feature Name]
 *   | Set `property` to ... / rpk cluster config set property value
 *
 * @param {string} source - AsciiDoc page contents.
 * @returns {{feature: string, properties: string[]}[]}
 */
function parseDisableTable (source) {
  const tables = source.match(/\|===([\s\S]*?)\|===/g)
  if (!tables) return []
  const rows = []
  for (const table of tables) {
    // Split into cells that start a line with '|', keeping cell bodies.
    const cells = table
      .split(/\n(?=\|)/)
      .map((cell) => cell.replace(/^\|/, '').trim())
      .filter((cell) => cell && !cell.startsWith('==='))
    // The header row (| Feature | Action ...) is one single-line chunk at
    // index 0. Data cells follow, one chunk per cell.
    for (let i = 1; i + 1 < cells.length; i += 2) {
      const nameCell = cells[i]
      const actionCell = cells[i + 1]
      const xrefMatch = nameCell.match(/xref:[^[]+\[([^\]]+)\]/)
      const feature = (xrefMatch ? xrefMatch[1] : nameCell.split('\n')[0]).trim()
      // Capture only set-targets ("Set `prop` to ..." and "config set prop"),
      // not backticked values such as `node_add`.
      const properties = [...new Set(
        [...actionCell.matchAll(/[Ss]et\s+`([a-z][a-z0-9_]+)`|config set ([a-z][a-z0-9_]+)/g)]
          .map((m) => m[1] || m[2])
          .filter((p) => p && p.includes('_'))
      )]
      if (feature) rows.push({ feature, properties })
    }
  }
  return rows
}

/**
 * Extract the enterprise-components attribute list from rp-connect-docs
 * antora.yml, without a YAML dependency on the full file structure.
 *
 * @param {object} antoraConfig - Parsed antora.yml object.
 * @returns {string[]|undefined} The list, or undefined when absent.
 */
function extractAntoraEnterpriseComponents (antoraConfig) {
  const attributes = antoraConfig && antoraConfig.asciidoc && antoraConfig.asciidoc.attributes
  const list = attributes && attributes['enterprise-components']
  return Array.isArray(list) ? list.map(String) : undefined
}

module.exports = {
  parseCoreEnum,
  parseEnterpriseProperties,
  parseConnectEnterprisePlugins,
  parseDisableTable,
  extractAntoraEnterpriseComponents,
}

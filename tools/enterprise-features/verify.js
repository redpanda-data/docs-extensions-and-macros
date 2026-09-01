'use strict'

/* Drift checks between the enterprise features registry (the shared
 * component's enterprise-features.yml in the docs repo) and the internal
 * sources of truth. Used by `doc-tools validate enterprise-features`.
 *
 * Finding levels:
 *   error       - registry is internally inconsistent or contradicts a source
 *   needs-human - a source changed in a way that needs a naming or policy
 *                 decision (for example, a new core enum value)
 *   info        - notable but not actionable by itself
 */

const yaml = require('js-yaml')
const semver = require('semver')

// Mirrors macros/enterprise.js: no 'cloud' scope, because Redpanda Cloud has
// no Enterprise Edition license.
const VALID_SCOPES = ['redpanda', 'console', 'connect', 'operator']
const SOURCE_KINDS = ['core-enum', 'core-property', 'connect-plugin', 'manual']

function finding (level, check, message) {
  return { level, check, message }
}

/**
 * Parse and lint the registry itself.
 *
 * @param {string} source - Registry YAML.
 * @returns {{features: object[], findings: object[]}}
 */
function lintRegistry (source) {
  const findings = []
  const data = yaml.load(source)
  if (!data || !Array.isArray(data.features)) {
    return { features: [], findings: [finding('error', 'registry-lint', "Registry has no 'features' list.")] }
  }
  const seen = new Map()
  for (const feature of data.features) {
    const name = feature && feature.name
    if (!name) {
      findings.push(finding('error', 'registry-lint', 'Entry without a name.'))
      continue
    }
    for (const key of [name, ...(feature.aliases || [])].map((value) => String(value).trim().toLowerCase())) {
      if (seen.has(key) && seen.get(key) !== name) {
        findings.push(finding('error', 'registry-lint', `Duplicate name or alias '${key}' shared by '${seen.get(key)}' and '${name}'.`))
      }
      seen.set(key, name)
    }
    if (!VALID_SCOPES.includes(feature.scope)) {
      findings.push(finding('error', 'registry-lint', `'${name}' has unknown scope '${feature.scope}'.`))
    }
    if (!feature.description || !String(feature.description).trim()) {
      findings.push(finding('error', 'registry-lint', `'${name}' has no description.`))
    }
    if (!feature.source || !feature.source.kind) {
      findings.push(finding('error', 'registry-lint', `'${name}' has no source pointer.`))
    } else if (!SOURCE_KINDS.includes(feature.source.kind)) {
      findings.push(finding('error', 'registry-lint', `'${name}' has unknown source kind '${feature.source.kind}'.`))
    } else if (!feature.source.value || !String(feature.source.value).trim()) {
      findings.push(finding('error', 'registry-lint', `'${name}' has an empty source value; manual entries need a justification.`))
    }
    if (feature.since !== undefined && feature.since !== null && String(feature.since).trim() !== '') {
      const since = String(feature.since).trim()
      // Lenient the same way the enterprise macro's own coerceVersion is:
      // docs versions are "MAJOR.MINOR", not full semver.
      if (!semver.coerce(since)) {
        findings.push(finding('error', 'registry-lint', `'${name}' has since '${since}', which is not a parsable version.`))
      }
    }
  }
  return { features: data.features, findings }
}

/**
 * Compare registry core-enum pointers against the actual enum values.
 * Every enum value needs at least one registry entry (else needs-human),
 * and every core-enum pointer must be a real enum value (else error).
 */
function checkCoreEnum (features, enumValues) {
  const findings = []
  const pointers = new Map()
  for (const feature of features) {
    if (feature.source && feature.source.kind === 'core-enum') {
      const value = String(feature.source.value).trim()
      if (!pointers.has(value)) pointers.set(value, [])
      pointers.get(value).push(feature.name)
    }
  }
  for (const value of enumValues) {
    if (!pointers.has(value)) {
      findings.push(finding('needs-human', 'core-enum', `New or unmapped core enterprise feature '${value}' (license_required_feature) has no registry entry. Decide its approved external name and add an entry.`))
    }
  }
  for (const [value, names] of pointers) {
    if (!enumValues.includes(value)) {
      findings.push(finding('error', 'core-enum', `Registry entr${names.length > 1 ? 'ies' : 'y'} ${names.map((n) => `'${n}'`).join(', ')} point${names.length > 1 ? '' : 's'} at core enum value '${value}', which does not exist in enterprise_features.h.`))
    }
  }
  return findings
}

/**
 * Check core-property pointers and gating properties against the
 * config::enterprise<> property names extracted from configuration.h.
 * Gating properties are checked for existence only when a full property
 * list is provided.
 */
function checkCoreProperties (features, enterpriseProperties, allPropertyNames) {
  const findings = []
  for (const feature of features) {
    if (feature.source && feature.source.kind === 'core-property') {
      const value = String(feature.source.value).trim()
      if (!enterpriseProperties.includes(value)) {
        findings.push(finding('error', 'core-property', `'${feature.name}' points at property '${value}', which is not an enterprise-wrapped property in configuration.h.`))
      }
    }
    if (feature['gating-property'] && allPropertyNames && !allPropertyNames.includes(feature['gating-property'])) {
      findings.push(finding('error', 'gating-property', `'${feature.name}' names gating property '${feature['gating-property']}', which does not exist in the property reference.`))
    }
  }
  const covered = features
    .filter((f) => f.source && (f.source.kind === 'core-property' || f.source.kind === 'core-enum'))
    .flatMap((f) => [String(f.source.value).trim(), f['gating-property']])
    .filter(Boolean)
  for (const property of enterpriseProperties) {
    if (!covered.includes(property)) {
      findings.push(finding('info', 'core-property', `Enterprise-wrapped property '${property}' is not referenced by any registry entry. Confirm whether it belongs to an existing feature or needs a new entry.`))
    }
  }
  return findings
}

/**
 * Validate registry connect-plugin pointers against the enterprise plugins
 * in connect's info.csv.
 *
 * This used to diff info.csv against the hand-maintained
 * enterprise-components list in rp-connect-docs antora.yml, but
 * rp-connect-docs#485 removed that list (it had gone stale — the exact drift
 * this validator exists to catch). Per-plugin enterprise status in the docs
 * now comes from the generated connector catalog, which is built from the
 * same connect metadata as info.csv, so it cannot drift by construction.
 * What can still go stale is the registry itself: any entry that pins a
 * specific plugin via `source: {kind: connect-plugin}` must name a plugin
 * that info.csv actually marks enterprise.
 *
 * The check also reports what it verified, so a run with zero pinned
 * plugins is visibly a shallow pass rather than a silent one.
 */
function checkConnect (infoCsvPlugins, features, connectRef) {
  const findings = []
  const pinned = []
  const source = connectRef ? `info.csv@${connectRef}` : 'info.csv'
  for (const feature of features) {
    if (feature.source && feature.source.kind === 'connect-plugin') {
      const value = String(feature.source.value).trim()
      pinned.push(value)
      if (!infoCsvPlugins.includes(value)) {
        findings.push(finding('error', 'connect-list', `'${feature.name}' points at connect plugin '${value}', which is not an enterprise plugin in ${source} (renamed, removed, or no longer enterprise).`))
      }
    }
  }
  findings.push(finding('info', 'connect-list', `${source} lists ${infoCsvPlugins.length} enterprise plugin(s); ${pinned.length} pinned by registry connect-plugin entries. Individual plugins are documented by the generated connector catalog; the licensing table covers them through the aggregate connect-scope entries.`))
  return findings
}

/**
 * Compare the hand-maintained disable-enterprise-features.adoc table with
 * registry gating properties.
 */
function checkDisableTable (features, disableRows) {
  const findings = []
  const registryProperties = new Set(features.map((f) => f['gating-property']).filter(Boolean))
  for (const row of disableRows) {
    for (const property of row.properties) {
      if (!registryProperties.has(property)) {
        findings.push(finding('needs-human', 'disable-table', `disable-enterprise-features.adoc row '${row.feature}' references property '${property}', which is not a gating-property of any registry entry.`))
      }
    }
  }
  return findings
}

/**
 * Render the internal-to-external name mapping partial, so pages can
 * translate the names printed by `rpk cluster license info`.
 */
function buildMappingPartial (features, enumValues) {
  const byValue = new Map()
  for (const feature of features) {
    if (feature.source && feature.source.kind === 'core-enum') {
      const value = String(feature.source.value).trim()
      if (!byValue.has(value)) byValue.set(value, [])
      byValue.get(value).push(feature)
    }
  }
  const lines = [
    '// Generated by `doc-tools validate enterprise-features --write-mapping`. Do not edit.',
    '// Maps the internal feature names reported by `rpk cluster license info`',
    '// (enterprise_features_in_use) to their documented names.',
    '[cols="1m,2a"]',
    '|===',
    '| Reported name | Documented feature',
    '',
  ]
  const order = enumValues.length ? enumValues.filter((value) => byValue.has(value)) : [...byValue.keys()].sort()
  for (const value of order) {
    const cell = byValue.get(value)
      .map((feature) => (feature.xref ? `xref:${feature.xref}[${feature.name}]` : feature.name))
      .join('\n\n')
    lines.push(`| ${value}`, `| ${cell}`, '')
  }
  lines.push('|===')
  return lines.join('\n')
}

/**
 * Run all checks. Sources that were not provided are skipped with an info
 * finding, so partial runs stay useful.
 *
 * @param {object} sources
 * @param {string} sources.registryYaml
 * @param {string} [sources.coreHeader] - enterprise_features.h contents.
 * @param {string} [sources.configurationHeader] - configuration.h contents.
 * @param {string} [sources.infoCsv] - connect info.csv contents.
 * @param {string} [sources.connectRef] - ref the info.csv was fetched at, for messages.
 * @param {string} [sources.disablePage] - disable-enterprise-features.adoc contents.
 * @param {string[]} [sources.allPropertyNames] - full property list for gating checks.
 * @returns {{findings: object[], features: object[], enumValues: string[]}}
 */
function runChecks (sources) {
  const parsers = require('./parsers')
  const { features, findings } = lintRegistry(sources.registryYaml)
  let enumValues = []
  if (sources.coreHeader) {
    enumValues = parsers.parseCoreEnum(sources.coreHeader)
    findings.push(...checkCoreEnum(features, enumValues))
  } else {
    findings.push(finding('info', 'core-enum', 'Skipped: no core header provided.'))
  }
  if (sources.configurationHeader) {
    const enterpriseProperties = parsers.parseEnterpriseProperties(sources.configurationHeader)
    findings.push(...checkCoreProperties(features, enterpriseProperties, sources.allPropertyNames))
  } else {
    findings.push(finding('info', 'core-property', 'Skipped: no configuration header provided.'))
  }
  if (sources.infoCsv) {
    const plugins = parsers.parseConnectEnterprisePlugins(sources.infoCsv)
    findings.push(...checkConnect(plugins, features, sources.connectRef))
  } else {
    findings.push(finding('info', 'connect-list', 'Skipped: no connect info.csv provided.'))
  }
  if (sources.disablePage) {
    findings.push(...checkDisableTable(features, parsers.parseDisableTable(sources.disablePage)))
  }
  return { findings, features, enumValues }
}

module.exports = {
  lintRegistry,
  checkCoreEnum,
  checkCoreProperties,
  checkConnect,
  checkDisableTable,
  buildMappingPartial,
  runChecks,
}

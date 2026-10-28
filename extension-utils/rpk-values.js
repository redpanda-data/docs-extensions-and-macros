'use strict'

/* Values of one rpk flag from a published rpk-<version>.json, rendered the
 * way `rpk <command> --help` prints them.
 *
 * Shared by the rpkval: inline macro (macros/rpkval.js) and the
 * check-reference-values report, so prose and the check agree. The data is
 * the docs repo's override-merged command tree (docs-data/rpk-v<version>.json),
 * which the docs rpk workflows publish as
 * modules/reference/attachments/rpk-<version>.json:
 *
 *   {schema: 1, rpk_version, generated_at, plugin_versions,
 *    deprecated_commands, tree: {global_flags, commands: [...]}}
 *
 * Nothing here guesses. A flag is looked up on its own command and in the
 * global flags only: the tree does not say which flags are persistent, so
 * taking a parent's local flag for a child would be a guess. Defaults render
 * as pflag stores them (10s, 1m0s, [kafka,registry]), never humanized.
 *
 * Plugin flags (rpk ai, check, connect, k8s, oxla) are scraped from --help
 * until the plugins emit --print-tree (DOC-2689), so their defaults are
 * strings with help's quotes still on and a missing default means "help did
 * not say", not "no default". isScraped decides which flags those are, from
 * the markers DEM's generator writes once the plugin trees land.
 */

const { escapeHtml } = require('./html-utils')
const datasets = require('./attachment-datasets')
const { isImprecise } = require('./property-values')
const logger = require('@antora/logger')('rpkval-macro')

const FORMAT_HUMAN = 'human'
const FORMAT_RAW = 'raw'

// Every field rpkval: supports. None is hidden on Cloud by itself; see
// resolveRpkValue for the descriptionScope rule on default.
const FIELDS = {
  default: { cloudHidden: false },
  type: { cloudHidden: false },
  shorthand: { cloudHidden: false },
  required: { cloudHidden: false },
  deprecated: { cloudHidden: false },
}

const FIELD_ALIASES = {
  short: 'shorthand',
}

// The rpk command groups that are separately installed plugins. Their flags
// come from --help until the plugin publishes its own tree.
const { KNOWN_PLUGINS, PLUGIN_SHIM_COMMANDS } = require('../tools/rpk-docs/known-plugins')

const $rpkRegistry = Symbol('$rpkRegistry')
const $rpkSeriesGap = Symbol('$rpkSeriesGap')

const RPK_JSON_RX = /^rpk-(v\d+\.\d+\.\d+(?:-rc\d+)?)\.json$/

const RPK_KIND = {
  name: 'rpk',
  module: 'reference',
  rx: RPK_JSON_RX,
  filePrefix: 'rpk-',
  label: 'rpk data',
  regenerate: 'the docs rpk workflows (update-rpk-docs.yml), which publish rpk-<version>.json',
  borrowWhen: ['env-cloud', 'env-adp'],
  lenders: ['streaming', 'ROOT'],
  cacheSymbol: $rpkRegistry,
  gapSymbol: $rpkSeriesGap,
  keyPrefix: 'rpk:',
  invalidKey: 'invalid',
  // Absent schema accepts the raw docs-data snapshot, which has the same
  // tree; a newer schema may have moved things this code would misread.
  validate: (data) => {
    if (data.schema !== undefined && data.schema !== 1) {
      return typeof data.schema === 'number' && data.schema > 1
        ? `has schema ${data.schema}, a newer schema than this DEM understands`
        : `has an unrecognized schema (${JSON.stringify(data.schema)})`
    }
    const tree = data.tree
    if (!tree || typeof tree !== 'object' || !Array.isArray(tree.commands)) return 'has no tree.commands array'
    return true
  },
  notObjectReason: 'is not a JSON object',
  logger,
  text: {
    log: 'rpkval macro',
    macro: 'rpkval:',
    attachment: 'rpk attachment',
    releaseNoun: 'commands',
    effect: (where) => `rpkval: values${where} therefore render as placeholders`,
    generateSeries: (series) => `the docs rpk workflows (update-rpk-docs.yml) for v${series}.<patch>`,
    noData: (component, version) =>
      `rpkval macro: no rpk-<version>.json attachment found in any component's reference module for ${component || 'unknown component'}@${version || 'unversioned'}; ` +
      'rpkval: values render as placeholders. The docs rpk workflows publish the newest snapshot as modules/reference/attachments/rpk-<version>.json in streaming.',
  },
}

function loadRpkFor (contentCatalog, component, version) {
  return datasets.loadDatasetFor(contentCatalog, component, version, RPK_KIND)
}

const own = (object, key) => Boolean(object) && Object.prototype.hasOwnProperty.call(object, key)

/**
 * Canonical field name, or undefined for a field rpkval: does not support.
 */
function normalizeField (field) {
  const key = String(field == null ? '' : field).trim().toLowerCase()
  if (own(FIELDS, key)) return key
  if (own(FIELD_ALIASES, key)) return FIELD_ALIASES[key]
  return undefined
}

/**
 * Whether a flag's metadata was scraped from a plugin's --help rather than
 * taken from rpk --print-tree: the command is under a known plugin, the
 * snapshot does not record that plugin's flags as coming from its tree, and
 * the flag carries no from_plugin marker.
 *
 * @param {object} registry
 * @param {string[]} pathNames - Command names below rpk, canonical.
 * @param {object} [flag]
 */
function isScraped (registry, pathNames, flag) {
  const plugin = pathNames && pathNames[0]
  if (!plugin || !KNOWN_PLUGINS.includes(plugin)) return false
  const sources = registry && registry.data && registry.data.plugin_flag_sources
  if (sources && sources[plugin] === 'tree') return false
  if (flag && flag.from_plugin === true) return false
  return true
}

// Help prints a string default inside double quotes, and the scrape kept
// them. Strip exactly one pair; anything else is the value as written.
const stripHelpQuotes = (value) => (value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value)

/**
 * A flag's default as pflag stores it (DefValue), which is what --help prints
 * inside (default ...), without the quotes help puts around strings.
 *
 * @returns {{ok: true, text: string} |
 *   {ok: false, reason: 'missing'|'plugin-unknown'|'description-default'|'imprecise'|'complex'}}
 */
function formatFlagDefault (flag, { scraped = false } = {}) {
  // A scraped flag with no default (or a null one) means help printed none,
  // which is not the same as having none.
  if (!own(flag, 'default') || flag.default === undefined) return { ok: false, reason: scraped ? 'plugin-unknown' : 'missing' }
  let value = flag.default
  if (value === null) return { ok: false, reason: scraped ? 'plugin-unknown' : 'missing' }
  if (scraped && typeof value === 'string') value = stripHelpQuotes(value)
  if (value === '') {
    // The description states a default the flag itself does not hold
    // (rpk debug bundle --output computes one). Never parse it out.
    if (/\(defaults?\b/i.test(String(flag.description || ''))) return { ok: false, reason: 'description-default' }
    return { ok: true, text: '""' }
  }
  if (typeof value === 'boolean') return { ok: true, text: String(value) }
  if (typeof value === 'number') {
    if (isImprecise(value)) return { ok: false, reason: 'imprecise' }
    return { ok: true, text: String(value) }
  }
  // pflag prints slices as [a,b], with no space.
  if (Array.isArray(value)) return { ok: true, text: `[${value.map(String).join(',')}]` }
  if (typeof value === 'object') return { ok: false, reason: 'complex' }
  return { ok: true, text: String(value) }
}

const yesNo = (value, format) => ({ ok: true, text: format === FORMAT_RAW ? String(value) : (value ? 'yes' : 'no') })

/**
 * The value of one field of one flag.
 *
 * @returns {{ok: true, text: string} | {ok: false, reason: string}}
 */
function fieldValue (flag, field, { format = FORMAT_HUMAN, scraped = false } = {}) {
  const name = normalizeField(field)
  if (!name) return { ok: false, reason: 'unsupported' }
  switch (name) {
    case 'default':
      return formatFlagDefault(flag, { scraped })
    case 'type':
      return typeof flag.type === 'string' && flag.type ? { ok: true, text: flag.type } : { ok: false, reason: 'missing' }
    case 'shorthand':
      return typeof flag.shorthand === 'string' && flag.shorthand ? { ok: true, text: `-${flag.shorthand}` } : { ok: false, reason: 'missing' }
    case 'required':
      if (typeof flag.required === 'boolean') return yesNo(flag.required, format)
      return { ok: false, reason: scraped ? 'plugin-unknown' : 'missing' }
    case 'deprecated':
      // An absent key means not deprecated: the reference prints
      // [Deprecated] only when the key is true.
      return yesNo(flag.deprecated === true, format)
    default:
      return { ok: false, reason: 'unsupported' }
  }
}

/**
 * Split a command= value into command names: quotes and a leading rpk are
 * optional, whitespace is collapsed.
 */
function commandTokens (command) {
  const text = String(command == null ? '' : command).trim().replace(/^(['"])([\s\S]*)\1$/, '$2').trim()
  const tokens = text ? text.split(/\s+/) : []
  if (tokens[0] === 'rpk') tokens.shift()
  return tokens
}

// A child of a node by name, then by alias.
function childOf (node, token) {
  const children = (node && Array.isArray(node.commands)) ? node.commands : []
  return children.find((c) => c && c.name === token) ||
    children.find((c) => c && Array.isArray(c.aliases) && c.aliases.includes(token))
}

/**
 * The deprecated_commands entry for a typed command path, or for one of its
 * ancestors, nearest first, with the first replacement or deprecatedMessage
 * found on the way up.
 */
function deprecatedEntry (deprecatedCommands, names) {
  if (!deprecatedCommands || typeof deprecatedCommands !== 'object') return undefined
  let found
  for (let n = names.length; n >= 1; n--) {
    const key = `rpk ${names.slice(0, n).join(' ')}`
    if (!own(deprecatedCommands, key)) continue
    const entry = deprecatedCommands[key] || {}
    if (!found) found = { key, replacement: undefined, deprecatedMessage: undefined }
    if (!found.replacement && entry.replacement) found.replacement = entry.replacement
    if (!found.deprecatedMessage && entry.deprecatedMessage) found.deprecatedMessage = entry.deprecatedMessage
  }
  return found
}

/**
 * Whether the usage line names a positional argument after the command path:
 * `rpk topic create [TOPICS...] [flags]` does, `rpk cluster quotas [flags]`
 * does not. A group whose usage has no placeholder takes only subcommands, so
 * an unmatched word there is an unknown command, not an argument.
 */
function acceptsPositional (node, pathNames) {
  const usage = String((node && node.usage) || '')
  const prefix = ['rpk', ...pathNames].join(' ')
  const rest = usage.startsWith(prefix) ? usage.slice(prefix.length) : usage.replace(/^\S+(?:\s+[a-z][\w-]*)*/, '')
  const words = rest.trim().split(/\s+/).filter(Boolean)
  return words.some((w) => w !== '[flags]' && w !== '[command]')
}

/**
 * Resolve command names against the tree, by name then alias.
 *
 * @param {object} tree
 * @param {string[]} tokens - Command names only, no arguments.
 * @param {object} [deprecatedCommands]
 * @returns {{ok: true, node: object, nodes: object[], names: string[]} |
 *   {ok: false, kind: 'deprecated-command', typed: string[], entry: object} |
 *   {ok: false, kind: 'unknown-command', at: number, token: string, parentNames: string[], suggestions: string[], argument?: boolean}}
 */
function resolveCommand (tree, tokens, deprecatedCommands) {
  let node = tree
  const nodes = []
  const names = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    const child = childOf(node, token)
    if (child) {
      node = child
      nodes.push(child)
      names.push(child.name)
      continue
    }
    // Deprecated commands are hidden, so not in the tree: check them before
    // calling the word unknown.
    const deprecated = deprecatedEntry(deprecatedCommands, [...names, ...tokens.slice(i)])
    if (deprecated) return { ok: false, kind: 'deprecated-command', typed: [...names, ...tokens.slice(i)], entry: deprecated }
    const children = Array.isArray(node.commands) ? node.commands : []
    const suggestions = datasets.suggest(token, children.flatMap((c) => [c.name, ...(c.aliases || [])]))
    // A word where the usage takes an argument is an argument, which
    // command= does not take.
    const argument = !children.length || acceptsPositional(node, names)
    return { ok: false, kind: 'unknown-command', at: i, token, parentNames: names, suggestions, argument }
  }
  return { ok: true, node, nodes, names }
}

/**
 * A flag on one node by long name, or by shorthand for a one-letter name.
 */
function flagOn (node, name) {
  const flags = (node && Array.isArray(node.flags)) ? node.flags : []
  if (name.length === 1) return flags.find((f) => f && f.shorthand === name)
  return flags.find((f) => f && f.name === name)
}

/**
 * A flag on a command, then in the global flags.
 *
 * @returns {{flag: object, global: boolean} | undefined}
 */
function findFlag (node, name, tree) {
  const local = node && node !== tree ? flagOn(node, name) : undefined
  if (local) return { flag: local, global: false }
  const globals = { flags: (tree && tree.global_flags) || [] }
  const global = flagOn(globals, name)
  return global ? { flag: global, global: true } : undefined
}

/**
 * The nearest ancestor of a resolved command that defines the flag.
 *
 * @returns {{flag: object, names: string[]} | undefined}
 */
function ancestorFlag (nodes, names, name) {
  for (let i = nodes.length - 2; i >= 0; i--) {
    const flag = flagOn(nodes[i], name)
    if (flag) return { flag, names: names.slice(0, i + 1) }
  }
  return undefined
}

/**
 * Every long flag name on any command, for telling an rpk flag from a helm or
 * kubectl one. Cached on the registry.
 */
function allFlagNames (registry) {
  if (registry.allFlagNames) return registry.allFlagNames
  const names = new Set()
  const walk = (node) => {
    for (const f of node.flags || []) if (f && f.name) names.add(f.name)
    for (const c of node.commands || []) walk(c)
  }
  const tree = registry.data.tree
  walk(tree)
  for (const f of tree.global_flags || []) if (f && f.name) names.add(f.name)
  Object.defineProperty(registry, 'allFlagNames', { value: names, enumerable: false })
  return names
}

/**
 * Which dataset a registry came from.
 */
function describeDataset (registry) {
  return datasets.describeDataset(registry)
}

const cmdText = (names) => ['rpk', ...names].join(' ')

/**
 * Resolve one rpkval: call to its value, or to the reason there is none.
 *
 * @param {object} opts
 * @param {object} [opts.registry] - From loadRpkFor.
 * @param {string} [opts.command] - command= as written.
 * @param {string} opts.flag - The target as written.
 * @param {string} [opts.field]
 * @param {string} [opts.format]
 * @param {string} [opts.filePath]
 * @returns {{ok: true, text: string, field: string, registry: object, source: 'core'|'help', command: string, flag: object} |
 *   {ok: false, kind: string, message: string, field: string, registry?: object, suggestions?: string[]}}
 */
function resolveRpkValue ({ registry, command, flag: target, field: requested = 'default', format = FORMAT_HUMAN, filePath }) {
  const fieldName = normalizeField(requested)
  const rawTarget = String(target == null ? '' : target).trim()
  const commandAttr = command !== undefined && command !== null && String(command).trim() !== '' ? `,command=${String(command).trim()}` : ''
  const call = `rpkval:${rawTarget}[${requested}${commandAttr}]${filePath ? ` in ${filePath}` : ''}`
  const field = fieldName || requested
  if (!fieldName) {
    return { ok: false, kind: 'unsupported-field', field, message: `${call}: '${requested}' is not a field rpkval: supports. Supported fields: ${Object.keys(FIELDS).join(', ')}.` }
  }
  if (!registry) {
    return { ok: false, kind: 'no-data', field, message: `${call}: this page has no rpk data to read '${field}' from (see the rpkval macro warning for this component version), so it renders <unknown ${field}> rather than a value from another release.` }
  }
  const dataset = describeDataset(registry)
  const tree = registry.data.tree
  const name = rawTarget.replace(/^-+/, '')
  const tokens = commandTokens(command)

  const resolved = resolveCommand(tree, tokens, registry.data.deprecated_commands)
  if (!resolved.ok && resolved.kind === 'deprecated-command') {
    const { entry } = resolved
    const why = entry.replacement || entry.deprecatedMessage
    return { ok: false, kind: 'deprecated-command', field, registry, message: `${call}: '${cmdText(resolved.typed)}' is deprecated (${entry.key} in ${dataset}), so the reference documents none of its flags.${why ? ` ${why}` : ''}` }
  }
  if (!resolved.ok) {
    const typed = cmdText([...resolved.parentNames, ...tokens.slice(resolved.at)])
    const hint = resolved.argument
      ? ' command= takes the command path only, without arguments or flags.'
      : resolved.suggestions.length ? ` Did you mean: ${resolved.suggestions.join(', ')}?` : ''
    return { ok: false, kind: 'unknown-command', field, registry, suggestions: resolved.suggestions, message: `${call}: '${typed}' is not a command in ${dataset}: ${cmdText(resolved.parentNames)} has no subcommand '${resolved.token}'.${hint}` }
  }
  const { node, nodes, names } = resolved
  const where = names.length ? cmdText(names) : 'rpk'

  if (name.length === 1) {
    const found = names.length ? findFlag(node, name, tree) : findFlag(tree, name, tree)
    const long = found ? ` Write rpkval:${found.flag.name}[...] instead.` : ''
    return { ok: false, kind: 'shorthand-target', field, registry, message: `${call}: '${rawTarget}' is a shorthand; rpkval: targets name the long flag.${long}` }
  }

  const cloud = registry.surface === datasets.SURFACE_CLOUD
  if (cloud) {
    const selfHosted = nodes.find((n) => n.selfHostedOnly === true)
    if (selfHosted) {
      return { ok: false, kind: 'unavailable', field, registry, message: `${call}: '${where}' is self-managed only (selfHostedOnly in ${dataset}), so no value is shown on this Cloud page.` }
    }
  } else {
    const cloudOnly = nodes.find((n) => n.cloudOnly === true)
    if (cloudOnly) {
      return { ok: false, kind: 'unavailable', field, registry, message: `${call}: '${where}' is Cloud only (cloudOnly in ${dataset}), so no value is shown on this self-managed page.` }
    }
  }

  let found
  if (!names.length) {
    found = findFlag(tree, name, tree)
    if (!found) {
      const elsewhere = allFlagNames(registry).has(name)
      const hint = elsewhere ? ' It is not a global flag; add command= with the command that defines it.' : ''
      return { ok: false, kind: 'unknown-flag', field, registry, suggestions: [], message: `${call}: '--${name}' is not a global flag in ${dataset}.${hint}` }
    }
  } else {
    found = findFlag(node, name, tree)
    if (!found) {
      const ancestor = ancestorFlag(nodes, names, name)
      if (ancestor) {
        return { ok: false, kind: 'unknown-flag', field, registry, message: `${call}: '--${name}' is not a flag of ${where} in ${dataset}; --${name} is defined on ${cmdText(ancestor.names)}; write command=${cmdText(ancestor.names)}.` }
      }
      const suggestions = datasets.suggest(name, [...(node.flags || []), ...(tree.global_flags || [])].map((f) => f.name))
      const hint = suggestions.length ? ` Did you mean: ${suggestions.map((s) => `--${s}`).join(', ')}?` : ''
      return { ok: false, kind: 'unknown-flag', field, registry, suggestions, message: `${call}: '--${name}' is not a flag of ${where} in ${dataset}.${hint}` }
    }
  }
  const flag = found.flag
  if (cloud && flag.selfHostedOnly === true) {
    return { ok: false, kind: 'unavailable', field, registry, message: `${call}: '--${flag.name}' of ${where} is self-managed only (selfHostedOnly in ${dataset}), so no value is shown on this Cloud page.` }
  }
  if (!cloud && flag.cloudOnly === true) {
    return { ok: false, kind: 'unavailable', field, registry, message: `${call}: '--${flag.name}' of ${where} is Cloud only (cloudOnly in ${dataset}), so no value is shown on this self-managed page.` }
  }
  if (cloud && fieldName === 'default' && node.descriptionScope === 'self-hosted') {
    return { ok: false, kind: 'cloud-hidden', field, registry, message: `${call}: the reference scopes the description of ${where} to self-managed (descriptionScope: self-hosted in ${dataset}), so its default may differ in Cloud and this Cloud page renders <unknown ${field}>. Put the sentence in an ifndef::env-cloud[] block.` }
  }
  const scraped = !found.global && isScraped(registry, names, flag)
  const value = fieldValue(flag, fieldName, { format, scraped })
  const label = `--${flag.name} of ${where}`
  if (!value.ok) {
    const messages = {
      missing: fieldName === 'shorthand'
        ? `${label} has no shorthand in ${dataset}, so it renders <unknown ${field}>.`
        : `${label} has no ${field} in ${dataset}, so it renders <unknown ${field}>.`,
      'plugin-unknown': `${label} comes from the ${names[0]} plugin's --help, which states no ${field}, so the build cannot verify one and renders <unknown ${field}>. This resolves once the plugin publishes its command tree (DOC-2689).`,
      'description-default': `${label} has an empty default in ${dataset}, and its description states the real one, which the build does not parse, so it renders <unknown ${field}>. State the default in prose by hand.`,
      imprecise: `the ${field} of ${label} in ${dataset} is an integer larger than JavaScript represents exactly, so it renders <unknown ${field}>. State the value in prose by hand.`,
      complex: `the ${field} of ${label} in ${dataset} is an object, which has no inline form, so it renders <unknown ${field}>. Link the reference instead.`,
    }
    const kind = value.reason === 'missing' ? 'missing-field' : value.reason === 'complex' ? 'complex-default' : value.reason
    return { ok: false, kind, field, registry, message: `${call}: ${messages[value.reason] || messages.missing}` }
  }
  return { ok: true, field: fieldName, registry, text: value.text, source: scraped ? 'help' : 'core', command: where, flag }
}

const VALUE_ROLE = 'rpk-value'
const UNKNOWN_VALUE_ROLE = 'rpk-value-unknown'

/**
 * The HTML for one rpkval: instance.
 */
function buildRpkvalContent ({ command, flag, field, text, source, unknown = false }) {
  const attrs = `data-rpk-command="${escapeHtml(command)}" data-rpk-flag="${escapeHtml(flag)}" data-field="${escapeHtml(field)}"${source === 'help' ? ' data-source="help"' : ''}`
  if (unknown) return `<span class="${VALUE_ROLE} ${UNKNOWN_VALUE_ROLE}" ${attrs}>${escapeHtml(`<unknown ${field}>`)}</span>`
  return `<span class="${VALUE_ROLE}" ${attrs}>${escapeHtml(text)}</span>`
}

module.exports = {
  FIELDS,
  FIELD_ALIASES,
  FORMAT_HUMAN,
  FORMAT_RAW,
  RPK_KIND,
  RPK_JSON_RX,
  KNOWN_PLUGINS,
  PLUGIN_SHIM_COMMANDS,
  loadRpkFor,
  normalizeField,
  isScraped,
  stripHelpQuotes,
  formatFlagDefault,
  fieldValue,
  commandTokens,
  childOf,
  deprecatedEntry,
  acceptsPositional,
  resolveCommand,
  flagOn,
  findFlag,
  ancestorFlag,
  allFlagNames,
  describeDataset,
  resolveRpkValue,
  buildRpkvalContent,
}

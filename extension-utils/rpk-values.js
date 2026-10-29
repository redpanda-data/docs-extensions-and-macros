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
const { defineFields } = require('./value-fields')
const { FORMAT_ASCIIDOC, FORMAT_PLAIN } = require('./value-descriptions')
const logger = require('@antora/logger')('rpkval-macro')

const FORMAT_HUMAN = 'human'
const FORMAT_RAW = 'raw'

// Every field rpkval: supports, and whether it belongs to a flag
// (rpkval:[rpk topic create --partitions,type]), a command
// (rpkval:[rpk topic create,usage]), or both. None is hidden on Cloud by
// itself; see resolveRpkValue for the descriptionScope rules. The `rich`
// fields are help text: descriptions render as AsciiDoc, as the rpk
// reference renders them, and examples render literally
// (value-descriptions.js).
const FIELD_SET = defineFields('rpkval:', {
  default: { levels: ['flag'] },
  type: { levels: ['flag'] },
  shorthand: { levels: ['flag'] },
  required: { levels: ['flag'] },
  description: { levels: ['flag', 'command'], rich: true },
  introduced: { levels: ['flag', 'command'] },
  usage: { levels: ['command'] },
  examples: { levels: ['command'], rich: true },
  aliases: { levels: ['command'] },
  platforms: { levels: ['command'] },
  'self-hosted-only': { levels: ['command'] },
}, {
  short: 'shorthand',
  introducedInVersion: 'introduced',
  selfHostedOnly: 'self-hosted-only',
}, {
  // Documented before the data was checked: no flag in the rpk data carries
  // a deprecation, so the field could only ever say no.
  deprecated: 'the rpk data records no deprecation for flags (deprecated_commands covers commands only), so rpkval: cannot say whether a flag is deprecated',
})
const { FIELDS, FIELD_ALIASES } = FIELD_SET

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
const normalizeField = FIELD_SET.normalizeField

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

const missingValue = () => ({ ok: false, reason: 'missing' })
// Help text as written: leading blank lines and trailing space go, and
// indentation stays, because an indented run is an example. A description
// is AsciiDoc (the docs data carries rpk-overrides.json text, and the rpk
// reference renders it as AsciiDoc); examples are command lines, so they
// render literally.
const helpText = (text, format = FORMAT_PLAIN) => {
  const value = text.replace(/^\s*\n/, '').replace(/\s+$/, '')
  return { ok: true, text: value, rich: { kind: 'text', text: value, format } }
}
const listValue = (list, format) => (Array.isArray(list) && list.length
  ? { ok: true, text: format === FORMAT_RAW ? JSON.stringify(list) : list.map(String).join(', ') }
  : missingValue())

/**
 * The value of one field of one flag.
 *
 * @returns {{ok: true, text: string, rich?: object} | {ok: false, reason: string}}
 */
function fieldValue (flag, field, { format = FORMAT_HUMAN, scraped = false } = {}) {
  const name = normalizeField(field)
  if (!name) return { ok: false, reason: 'unsupported' }
  switch (name) {
    case 'default':
      return formatFlagDefault(flag, { scraped })
    case 'type':
      return typeof flag.type === 'string' && flag.type ? { ok: true, text: flag.type } : missingValue()
    case 'shorthand':
      return typeof flag.shorthand === 'string' && flag.shorthand ? { ok: true, text: `-${flag.shorthand}` } : missingValue()
    case 'required':
      if (typeof flag.required === 'boolean') return yesNo(flag.required, format)
      return { ok: false, reason: scraped ? 'plugin-unknown' : 'missing' }
    case 'description':
      return typeof flag.description === 'string' && flag.description.trim() ? helpText(flag.description, FORMAT_ASCIIDOC) : missingValue()
    case 'introduced':
      return typeof flag.introducedInVersion === 'string' && flag.introducedInVersion ? { ok: true, text: flag.introducedInVersion } : missingValue()
    default:
      return { ok: false, reason: 'unsupported' }
  }
}

/**
 * The value of one field of one command.
 *
 * @returns {{ok: true, text: string, rich?: object} | {ok: false, reason: string}}
 */
function commandFieldValue (node, field, { format = FORMAT_HUMAN } = {}) {
  switch (normalizeField(field)) {
    case 'description':
      return typeof node.description === 'string' && node.description.trim() ? helpText(node.description, FORMAT_ASCIIDOC) : missingValue()
    case 'examples':
      return typeof node.examples === 'string' && node.examples.trim() ? helpText(node.examples) : missingValue()
    case 'usage':
      return typeof node.usage === 'string' && node.usage.trim() ? { ok: true, text: node.usage.trim() } : missingValue()
    case 'aliases':
      return listValue(node.aliases, format)
    case 'platforms':
      return listValue(node.platforms, format)
    case 'introduced':
      return typeof node.introducedInVersion === 'string' && node.introducedInVersion ? { ok: true, text: node.introducedInVersion } : missingValue()
    case 'self-hosted-only':
      // An absent key means not self-managed only, the rule the reference
      // uses for its ifndef::env-cloud[] wrapping.
      return yesNo(node.selfHostedOnly === true, format)
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

/**
 * Split a command line as a writer types it in rpkval:[...] or rpkcmd:[...]
 * into the command names, then at most one flag: `rpk topic create
 * --partitions`. The leading rpk is optional. Words after the first flag,
 * which would be a value, an argument or a second flag, come back in extra.
 *
 * @returns {{tokens: string[], flag?: string, extra: string[]}}
 *   flag is as typed, dashes included.
 */
function parseCommandLine (text) {
  const words = commandTokens(text)
  const at = words.findIndex((w) => w.startsWith('-'))
  if (at === -1) return { tokens: words, extra: [] }
  return { tokens: words.slice(0, at), flag: words[at], extra: words.slice(at + 1) }
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
 * @param {string} [opts.macro] - The call as written, for messages, when it
 *   is the bracket form rpkval:[rpk topic create --partitions].
 * @param {'flag'|'command'} [opts.level] - command for a bracket form with no
 *   flag, which reads a field of the command itself.
 * @returns {{ok: true, text: string, rich?: object, field: string, invert: boolean, registry: object, source: 'core'|'help', command: string, flag?: object} |
 *   {ok: false, kind: string, message: string, field: string, registry?: object, suggestions?: string[]}}
 */
function resolveRpkValue ({ registry, command, flag: target, field: requested = 'default', format = FORMAT_HUMAN, filePath, macro, level = 'flag' }) {
  const resolvedField = FIELD_SET.resolveField(requested)
  const fieldName = resolvedField && resolvedField.name
  const invert = Boolean(resolvedField && resolvedField.invert)
  const dropped = !fieldName && FIELD_SET.droppedReason(requested)
  const rawTarget = String(target == null ? '' : target).trim()
  const commandAttr = command !== undefined && command !== null && String(command).trim() !== '' ? `,command=${String(command).trim()}` : ''
  const call = `${macro || `rpkval:${rawTarget}[${requested}${commandAttr}]`}${filePath ? ` in ${filePath}` : ''}`
  const field = fieldName || (dropped ? String(requested).trim().toLowerCase() : requested)
  if (!fieldName && !dropped) {
    return { ok: false, kind: 'unsupported-field', field, message: FIELD_SET.unsupportedMessage(call, requested) }
  }
  if (fieldName && !FIELDS[fieldName].levels.includes(level)) {
    if (level === 'command') {
      return { ok: false, kind: 'unknown-flag', field, message: `${call}: names no flag; write the command, then the flag, as in rpkval:[rpk topic create --partitions].${fieldName === 'default' ? '' : ` ${fieldName} is a field of a flag.`}` }
    }
    return { ok: false, kind: 'unsupported-field', field, message: `${call}: ${fieldName} is a field of a command, not of a flag; write the command without the flag, as in rpkval:[rpk topic create,${fieldName}].` }
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
      ? (macro ? ' Write the command path and one flag, without arguments.' : ' command= takes the command path only, without arguments or flags.')
      : resolved.suggestions.length ? ` Did you mean: ${resolved.suggestions.join(', ')}?` : ''
    return { ok: false, kind: 'unknown-command', field, registry, suggestions: resolved.suggestions, message: `${call}: '${typed}' is not a command in ${dataset}: ${cmdText(resolved.parentNames)} has no subcommand '${resolved.token}'.${hint}` }
  }
  const { node, nodes, names } = resolved
  const where = names.length ? cmdText(names) : 'rpk'

  if (name.length === 1) {
    const found = names.length ? findFlag(node, name, tree) : findFlag(tree, name, tree)
    const long = found ? (macro ? ` Write rpkval:[${where} --${found.flag.name}] instead.` : ` Write rpkval:${found.flag.name}[...] instead.`) : ''
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

  if (level === 'command') {
    return resolveCommandValue({ registry, resolved, field, fieldName, dropped, format, call, dataset })
  }

  let found
  if (!names.length) {
    found = findFlag(tree, name, tree)
    if (!found) {
      const elsewhere = allFlagNames(registry).has(name)
      const hint = elsewhere ? (macro ? ' It is not a global flag; write the command that defines it before the flag.' : ' It is not a global flag; add command= with the command that defines it.') : ''
      return { ok: false, kind: 'unknown-flag', field, registry, suggestions: [], message: `${call}: '--${name}' is not a global flag in ${dataset}.${hint}` }
    }
  } else {
    found = findFlag(node, name, tree)
    if (!found) {
      const ancestor = ancestorFlag(nodes, names, name)
      if (ancestor) {
        return { ok: false, kind: 'unknown-flag', field, registry, message: `${call}: '--${name}' is not a flag of ${where} in ${dataset}; --${name} is defined on ${cmdText(ancestor.names)}; write ${macro ? `rpkval:[${cmdText(ancestor.names)} --${name}]` : `command=${cmdText(ancestor.names)}`}.` }
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
  if (dropped) {
    return { ok: false, kind: 'dropped-field', field, registry, message: `${call}: ${dropped}, so it renders <unknown ${field}>. Drop the field from the sentence; the reference lists only flags that are in the data.` }
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
  return { ok: true, field: fieldName, invert, registry, text: invert ? inverted(value.text) : value.text, rich: value.rich, source: scraped ? 'help' : 'core', command: where, flag }
}

// The opposite of a yes-or-no value, for an inverse alias (optional).
const inverted = (text) => ({ yes: 'no', no: 'yes', true: 'false', false: 'true' })[text] || text

/**
 * The command-level half of resolveRpkValue: a field of the command itself,
 * rpkval:[rpk topic create,usage]. Cloud gating has already run for the
 * command path.
 */
function resolveCommandValue ({ registry, resolved, field, fieldName, dropped, format, call, dataset }) {
  const { node, names } = resolved
  const where = names.length ? cmdText(names) : 'rpk'
  if (dropped) {
    return { ok: false, kind: 'dropped-field', field, registry, message: `${call}: ${dropped}, so it renders <unknown ${field}>.` }
  }
  const cloud = registry.surface === datasets.SURFACE_CLOUD
  // The reference wraps a scoped description in ifndef::env-cloud[] or
  // ifdef::env-cloud[], so only that surface may state it.
  if (fieldName === 'description' && cloud && node.descriptionScope === 'self-hosted') {
    return { ok: false, kind: 'cloud-hidden', field, registry, message: `${call}: the reference shows the description of ${where} only to self-managed readers (descriptionScope: self-hosted in ${dataset}), so this Cloud page renders <unknown ${field}>. Put the block in an ifndef::env-cloud[] block.` }
  }
  if (fieldName === 'description' && !cloud && node.descriptionScope === 'cloud') {
    return { ok: false, kind: 'unavailable', field, registry, message: `${call}: the reference shows the description of ${where} only to Cloud readers (descriptionScope: cloud in ${dataset}), so this self-managed page renders <unknown ${field}>.` }
  }
  const value = commandFieldValue(node, fieldName, { format })
  if (!value.ok) {
    return { ok: false, kind: 'missing-field', field, registry, message: `${call}: ${where} has no ${field} in ${dataset}, so it renders <unknown ${field}>.` }
  }
  return { ok: true, field: fieldName, invert: false, registry, text: value.text, rich: value.rich, source: 'core', command: where }
}

const VALUE_ROLE = 'rpk-value'
const UNKNOWN_VALUE_ROLE = 'rpk-value-unknown'

/**
 * The HTML for one rpkval: instance.
 */
function buildRpkvalContent ({ command, flag, field, text, html, source, unknown = false }) {
  const flagAttr = flag ? ` data-rpk-flag="${escapeHtml(flag)}"` : ''
  const attrs = `data-rpk-command="${escapeHtml(command)}"${flagAttr} data-field="${escapeHtml(field)}"${source === 'help' ? ' data-source="help"' : ''}`
  if (unknown) return `<span class="${VALUE_ROLE} ${UNKNOWN_VALUE_ROLE}" ${attrs}>${escapeHtml(`<unknown ${field}>`)}</span>`
  return `<span class="${VALUE_ROLE}" ${attrs}>${html !== undefined ? html : escapeHtml(text)}</span>`
}

module.exports = {
  FIELD_SET,
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
  commandFieldValue,
  commandTokens,
  parseCommandLine,
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
  resolveCommandValue,
  buildRpkvalContent,
}

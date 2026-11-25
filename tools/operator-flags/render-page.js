'use strict'

/* The Redpanda Operator flag reference page, rendered from the flag data
 * that `doc-tools generate operator-flags` writes. One entry per flag, each
 * with an anchor named after the flag, so opflag:[--name] links straight to
 * it. Flags pflag hides only (MarkHidden, never deprecated) are internal and
 * left out; deprecated flags, run and global alike, get their own section,
 * so a reader who meets one in an old values file can still look it up.
 * isOnPage (extension-utils/operator-flags.js) decides, for this page and
 * for opflag: links alike.
 */

const { generatedMarker } = require('../../cli-utils/generated-marker')
const { isOnPage } = require('../../extension-utils/operator-flags')
const { formatInlineCode } = require('../../extension-utils/inline-code')

// Help text is written for --help, so an undefined {name} would read as an
// AsciiDoc attribute reference. Escape every one.
const escapeAttributes = (text) => String(text).replace(/(?<!\\)\{([A-Za-z0-9_][A-Za-z0-9_-]*)\}/g, '\\{$1}')

// A help string is one line; keep it one paragraph even if it wraps.
const paragraph = (text) => escapeAttributes(String(text || '').trim().replace(/\s*\n\s*/g, ' '))

// Help text as a page paragraph: flags, snake_case names, paths and URLs
// in code (usage strings hold no backticks, so the page adds them), and a
// closing period, since a usage string has none.
const prose = (text) => {
  const out = paragraph(formatInlineCode(text))
  return out && !/[.!?]$/.test(out) ? `${out}.` : out
}

// A literal value. The +...+ passthrough cannot hold a +, and turns off
// attribute substitution, so a value with a + uses pass:c[] instead.
const code = (value) => {
  const text = String(value)
  return text.includes('+') ? `\`pass:c[${text.replace(/\]/g, '\\]')}]\`` : `\`+${text}+\``
}

// An empty default reads "", as opflagval: renders it.
const defaultText = (flag) => code(flag.default === '' ? '""' : flag.default)

function entry (flag, { deprecated = false } = {}) {
  const lines = [`[[${flag.name}]]`, `=== --${flag.name}`, '']
  if (deprecated) {
    lines.push(`IMPORTANT: This flag is deprecated. ${prose(flag.deprecated).replace(/^(.)/, (c) => c.toUpperCase())}`, '')
  }
  const usage = prose(flag.usage)
  if (usage) lines.push(usage, '')
  lines.push('[horizontal]')
  lines.push(`Type:: ${code(flag.type)}`)
  lines.push(`Default:: ${defaultText(flag)}`)
  if (flag.shorthand) lines.push(`Shorthand:: ${code(`-${flag.shorthand}`)}`)
  lines.push('')
  return lines.join('\n')
}

const byName = (a, b) => a.name.localeCompare(b.name)

/**
 * @param {object} data - The flag data (schema 1).
 * @returns {string} The page, AsciiDoc.
 */
function renderPage (data) {
  const version = data.operator_version
  const globalFlags = data.global_flags || []
  const current = (flag) => isOnPage(flag) && !flag.deprecated
  const flags = data.flags.filter(current).sort(byName)
  const global = globalFlags.filter(current).sort(byName)
  const deprecated = [...data.flags, ...globalFlags].filter((flag) => isOnPage(flag) && flag.deprecated).sort(byName)
  const out = [
    // The marker is published in the page's Markdown twin, so it names the
    // release and not the private repository or a path in it.
    generatedMarker('operator-flags', `the run command of the Redpanda Operator at ${data.source && data.source.ref ? data.source.ref : version}`, 'To change a description, edit the flag\'s help text in the operator source.'),
    '= Redpanda Operator Flags',
    `:description: Command-line flags of the Redpanda Operator ${version}, with the type and default of each.`,
    '',
    'The Redpanda Operator runs as `redpanda-operator run`. These flags change what the operator manages and how. Pass them to the operator through the `additionalCmdFlags` value of the operator Helm chart:',
    '',
    '[,yaml]',
    '----',
    'additionalCmdFlags:',
    '  - --unbind-pvcs-after=60s',
    '----',
    '',
    `This page lists the flags of Redpanda Operator ${version}. Each default is the operator binary's built-in default, which applies when nothing passes the flag. The operator Helm chart passes some flags itself, so the value in a Helm deployment can differ from the default listed here. A flag in \`additionalCmdFlags\` replaces the value the chart passes. For the chart's values, see xref:reference:k-operator-helm-spec.adoc[].`,
    '',
    'When `multicluster.enabled` is `true`, the chart runs the `redpanda-operator multicluster` command instead of `run`, and passes `additionalCmdFlags` to it. That command has its own flags, which this page does not list.',
    '',
    '== Flags',
    '',
    ...flags.map((flag) => entry(flag)),
  ]
  if (global.length) {
    out.push('== Logging flags', '', 'These flags apply to every `redpanda-operator` command, including `run`.', '', ...global.map((flag) => entry(flag)))
  }
  if (deprecated.length) {
    out.push('== Deprecated flags', '', 'The operator still accepts these flags and prints a warning when you pass one. Remove them from `additionalCmdFlags`.', '', ...deprecated.map((flag) => entry(flag, { deprecated: true })))
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n*$/, '\n')
}

module.exports = { renderPage, escapeAttributes }

'use strict'

/* The Redpanda Operator flag reference page, rendered from the flag data
 * that `doc-tools generate operator-flags` writes. One entry per flag, each
 * with an anchor named after the flag, so opflag:[--name] links straight to
 * it. Flags pflag hides only (MarkHidden, never deprecated) are internal and
 * left out; deprecated flags get their own section, so a reader who meets
 * one in an old values file can still look it up.
 */

const { generatedMarker } = require('../../cli-utils/generated-marker')

// Help text is written for --help, so an undefined {name} would read as an
// AsciiDoc attribute reference. Escape every one.
const escapeAttributes = (text) => String(text).replace(/(?<!\\)\{([A-Za-z0-9_][A-Za-z0-9_-]*)\}/g, '\\{$1}')

// A help string is one line; keep it one paragraph even if it wraps.
const paragraph = (text) => escapeAttributes(String(text || '').trim().replace(/\s*\n\s*/g, ' '))

const code = (value) => `\`+${String(value).replace(/\+/g, '{plus}')}+\``

function defaultText (flag) {
  if (flag.default === '') return 'None'
  return code(flag.default)
}

function entry (flag, { deprecated = false } = {}) {
  const lines = [`[[${flag.name}]]`, `=== --${flag.name}`, '']
  if (deprecated) {
    lines.push(`IMPORTANT: This flag is deprecated. ${paragraph(flag.deprecated).replace(/^(.)/, (c) => c.toUpperCase()).replace(/([^.])$/, '$1.')}`, '')
  }
  const usage = paragraph(flag.usage)
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
  const flags = data.flags.filter((flag) => !flag.deprecated && !flag.hidden).sort(byName)
  const deprecated = data.flags.filter((flag) => flag.deprecated).sort(byName)
  const global = (data.global_flags || []).filter((flag) => !flag.hidden && !flag.deprecated).sort(byName)
  const out = [
    generatedMarker('operator-flags', `the run command of redpanda-data/operator-enterprise at ${data.source && data.source.ref ? data.source.ref : version}`, 'To change a description, edit the flag\'s help text in operator/cmd/run/run.go.'),
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
    `This page lists the flags of Redpanda Operator ${version}. Each default is the value the operator uses when you do not pass the flag.`,
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

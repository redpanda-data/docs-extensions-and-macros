'use strict'

/* check-reference-values, operator kind: Redpanda Operator `run` flags
 * checked against the published operator flag data
 * (extension-utils/operator-flags.js).
 *
 * Two places name an operator flag on a page, and both are checked:
 *
 *   - opflag:[--flag] and opflagval:[--flag,field] calls.
 *   - Flags written by hand where the operator reads them: the items of an
 *     `additionalCmdFlags:` list in a YAML block, and the values of an
 *     `additionalCmdFlags={...}` or `additionalCmdFlags[n]=...` Helm --set
 *     argument. YAML and shell cannot hold a macro, so this is where a
 *     typed flag is expected, and where a removed or deprecated one breaks a
 *     reader's install.
 *
 * Flags in prose are not guessed at: rpk and the operator share flag-shaped
 * names, so a bare `--flag` in a sentence is only checked through opflag:.
 *
 * Findings use the shared shape: status 'reference', severity 'error' for
 * a flag the operator does not have, 'warning' for a deprecated or hidden
 * one that is not acknowledged with deprecated=ok (macros only; a typed flag
 * is acknowledged with // value-check: ignore).
 */

const path = require('path')
const shared = require('./shared')
const operatorFlags = require('../../extension-utils/operator-flags')

const MACRO_RX = /\b(opflag|opflagval):\[((?:\\\]|[^\]])*)\]/g
const SET_RX = /additionalCmdFlags(?:\[\d+\])?=\{?([^}'"\s]*(?:\{[^}]*\})?[^}'"\s]*)\}?/g
const FLAG_TOKEN_RX = /(?:^|[\s,{'"=])(--[A-Za-z0-9][A-Za-z0-9-]*)(?:=[^\s,}'"]*)?/g

/**
 * The 1-based line numbers of the items of every `additionalCmdFlags:` list
 * in a YAML document embedded in the page, with each item's text.
 */
function yamlListItems (lines) {
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const key = lines[i].match(/^(\s*)additionalCmdFlags:\s*(\[.*\])?\s*$/)
    if (!key) continue
    if (key[2]) {
      out.push({ line: i + 1, text: key[2] })
      continue
    }
    const indent = key[1].length
    for (let j = i + 1; j < lines.length; j++) {
      const item = lines[j].match(/^(\s*)-\s+(.*?)\s*(?:<\d+>)?\s*$/)
      if (item && item[1].length >= indent) {
        out.push({ line: j + 1, text: item[2].replace(/^["']|["']$/g, '') })
        continue
      }
      if (!lines[j].trim() || /^\s*#/.test(lines[j])) continue
      break
    }
  }
  return out
}

function flagsIn (text) {
  const out = []
  for (const match of String(text).matchAll(FLAG_TOKEN_RX)) out.push(match[1])
  return out
}

/**
 * @param {object} opts
 * @param {string} opts.docsDir
 * @param {object} opts.registry - From loadOperatorFlagsFor or --data-file.
 * @param {Set<string>} [opts.files] - Repo-relative files to scan (default: all).
 */
function scanOperator ({ docsDir, registry, files: only, readFile = shared.readText }) {
  const findings = []
  let files = 0
  let skippedGenerated = 0
  let skippedStubs = 0
  const version = registry.data.operator_version || registry.tag
  const dataset = operatorFlags.describeDataset(registry)

  const check = ({ relative, line, written, flagText, call, acknowledged = false, macro = false }) => {
    const resolved = operatorFlags.resolveFlag({ registry, text: flagText, call: written })
    if (!resolved.ok) {
      findings.push({ file: relative, line, status: 'reference', severity: 'error', check: macro ? 'macro' : 'typed', reason: 'unknown operator flag', written, target: flagText, note: resolved.message.replace(/^.*?: /, '') })
      return
    }
    const caution = operatorFlags.cautionOf(resolved.flag)
    if (caution && !acknowledged) {
      findings.push({ file: relative, line, status: 'reference', severity: 'warning', check: macro ? 'macro' : 'typed', reason: caution.kind === 'deprecated-flag' ? 'deprecated operator flag' : 'hidden operator flag', written, target: `--${resolved.flag.name}`, note: `${caution.text}${macro ? '; add deprecated=ok if the mention is deliberate' : '; add // value-check: ignore above the line if the mention is deliberate'}` })
    }
  }

  for (const relative of shared.walkFiles(docsDir, { only })) {
    const original = readFile(path.join(docsDir, relative))
    if (shared.isGenerated(original)) { skippedGenerated++; continue }
    if (shared.isStubPage(original)) { skippedStubs++; continue }
    files++
    const lines = original.split('\n')
    lines.forEach((text, i) => {
      for (const match of text.matchAll(MACRO_RX)) {
        const [call, name, inner] = match
        const parts = inner.split(',')
        const acknowledged = parts.slice(1).some((p) => /^\s*deprecated\s*=\s*ok\s*$/i.test(p))
        check({ relative, line: i + 1, written: call, flagText: parts[0], acknowledged, macro: true, call: name })
      }
      for (const match of text.matchAll(SET_RX)) {
        for (const flag of flagsIn(match[1])) check({ relative, line: i + 1, written: flag, flagText: flag })
      }
    })
    for (const item of yamlListItems(lines)) {
      for (const flag of flagsIn(item.text)) check({ relative, line: item.line, written: flag, flagText: flag })
    }
  }

  const counts = { exact: 0, equivalent: 0, mismatch: 0, unset: 0, unverifiable: 0, 'example-output': 0, autoSafe: 0, exampleStale: 0, reference: findings.length, referenceErrors: findings.filter((f) => f.severity === 'error').length, referenceWarnings: findings.filter((f) => f.severity === 'warning').length }
  return { files, skippedGenerated, skippedStubs, findings, counts, changedFiles: 0, operatorVersion: version, dataset }
}

module.exports = { scanOperator, yamlListItems, flagsIn }

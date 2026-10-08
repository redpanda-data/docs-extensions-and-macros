'use strict'

/**
 * Compare two doc-impact summaries (`run-evals.js --doc-impact --json`) and
 * render the per-metric delta as Markdown for a CI job summary.
 *
 *   node evals/doc-strings/doc-impact/compare.js --head head.json \
 *     [--base base.json] [--base-label <text>] [--head-label <text>]
 *
 * The comparison is advisory: a lower score never changes the exit code.
 * Exit 1 means a run could not be scored as a whole: the head summary is
 * missing or unreadable, or either run has an item with HARNESS_ERROR or
 * MODEL_ERROR. A missing base summary is reported, not failed, because a
 * PR that adds or renames the impact section has no base prompt to run.
 * REPLAY_INCOMPLETE and GATE_CLOSED items are counted and left out of the
 * scores, as in the run itself, and do not change the exit code.
 */

const fs = require('fs')

const RATIOS = [
  ['flag_recall', 'Flag recall F'],
  ['abstention_recall', 'Abstention recall A'],
  ['headline', 'Headline 2FA/(F+A)'],
  ['page_precision', 'Page precision'],
  ['page_recall', 'Page recall'],
  ['duplicate_rate', 'Duplicate rate']
]
const COUNTS = [
  ['scored', 'Items scored'],
  ['gate_closed', 'GATE_CLOSED'],
  ['replay_incomplete', 'REPLAY_INCOMPLETE'],
  ['errors', 'Errors (harness or model)']
]
const ERROR_STATUSES = ['HARNESS_ERROR', 'MODEL_ERROR']

const fmt = (key, v) => {
  if (v == null) return 'n/a'
  return key === 'headline' ? v.toFixed(3) : `${(v * 100).toFixed(1)}%`
}

function delta (key, head, base) {
  if (head == null || base == null) return 'n/a'
  const d = head - base
  if (Math.abs(d) < 1e-9) return '0'
  const sign = d > 0 ? '+' : '-'
  return key === 'headline' ? `${sign}${Math.abs(d).toFixed(3)}` : `${sign}${(Math.abs(d) * 100).toFixed(1)} pt`
}

/** One item's outcome in one run, as a short cell. */
function outcome (row) {
  if (!row) return 'not run'
  if (row.status !== 'OK') return row.status
  return `${row.flagged ? 'flagged' : 'not flagged'} (${row.correct ? 'correct' : 'wrong'})`
}

/** Items whose outcome differs between the two runs. */
function changedItems (head, base) {
  const byId = (s) => new Map((s.perItem || []).map((p) => [p.id, p]))
  const h = byId(head)
  const b = byId(base)
  const ids = [...new Set([...b.keys(), ...h.keys()])]
  return ids
    .map((id) => ({ id, label: (h.get(id) || b.get(id)).label, base: outcome(b.get(id)), head: outcome(h.get(id)) }))
    .filter((r) => r.base !== r.head)
}

/** Items with a status that makes a run's numbers incomplete. */
function errorItems (summary) {
  return (summary.items || []).filter((r) => ERROR_STATUSES.includes(r.status))
}

/**
 * @param {object} opts
 * @param {object|null} opts.head - the head summary, or null if missing
 * @param {object|null} opts.base - the base summary, or null if missing
 * @param {string} [opts.headLabel]
 * @param {string} [opts.baseLabel]
 * @returns {{ markdown: string, errors: string[], warnings: string[] }}
 */
function renderComparison ({ head, base, headLabel = 'head', baseLabel = 'base' }) {
  const errors = []
  const warnings = []
  const out = ['## Doc-impact eval (advisory)', '']

  if (!head) {
    errors.push(`no summary from the ${headLabel} run; the harness did not start (see its log)`)
    out.push(`The ${headLabel} run produced no summary, so there is nothing to compare. See the job log.`, '')
    return { markdown: out.join('\n') + '\n', errors, warnings }
  }

  out.push(`Prompt under test: ${headLabel}. Baseline: ${base ? baseLabel : 'none'}.`)
  out.push(`Model \`${head.model}\`, MCP \`${head.mcp}\`, ${head.include_unconfirmed ? 'every committed item (confirmed or not)' : 'confirmed items only'}.`)
  out.push('One replay per side, so an item that flips may be model variance. A score drop does not fail this check.', '')

  if (!base) {
    warnings.push(`no summary from the ${baseLabel} run, so no delta`)
    out.push(`The ${baseLabel} run produced no summary (for example, its workflow has no PUBLISHED-CONTENT IMPACT section to extract), so only the head numbers are shown.`, '')
  }

  out.push(base ? '| Metric | Base | Head | Delta |' : '| Metric | Head |')
  out.push(base ? '|---|---|---|---|' : '|---|---|')
  for (const [key, name] of RATIOS) {
    const h = fmt(key, head[key])
    out.push(base ? `| ${name} | ${fmt(key, base[key])} | ${h} | ${delta(key, head[key], base[key])} |` : `| ${name} | ${h} |`)
  }
  for (const [key, name] of COUNTS) {
    const h = head.counts[key]
    out.push(base ? `| ${name} | ${base.counts[key]} | ${h} | ${h - base.counts[key] === 0 ? '0' : (h - base.counts[key] > 0 ? '+' : '') + (h - base.counts[key])} |` : `| ${name} | ${h} |`)
  }
  out.push('')
  if (head.headline_refused) out.push(`Head headline refused: ${head.headline_refused}.`, '')

  if (base) {
    const changed = changedItems(head, base)
    if (changed.length) {
      out.push(`### Items that changed (${changed.length})`, '', '| Item | Label | Base | Head |', '|---|---|---|---|')
      for (const c of changed) out.push(`| \`${c.id}\` | ${c.label} | ${c.base} | ${c.head} |`)
    } else {
      out.push('No item changed outcome.')
    }
    out.push('')
  }

  for (const [summary, label] of [[head, headLabel], [base, baseLabel]]) {
    if (!summary) continue
    const bad = errorItems(summary)
    for (const r of bad) errors.push(`${label}: ${r.id} ${r.status}: ${(r.notes || [])[0] || 'no detail'}`)
    if (summary.counts.replay_incomplete) {
      warnings.push(`${label}: ${summary.counts.replay_incomplete} item(s) REPLAY_INCOMPLETE (the model asked the docs server something no recording answers); re-record them with --mcp record --merge`)
    }
  }
  if (errors.length) {
    out.push('### Errors', '', 'These items have no score, so the numbers above cover less than the item set.', '')
    for (const e of errors) out.push(`- ${e}`)
    out.push('')
  }
  if (warnings.length) {
    out.push('### Notes', '')
    for (const w of warnings) out.push(`- ${w}`)
    out.push('')
  }
  return { markdown: out.join('\n') + '\n', errors, warnings }
}

function readSummary (file) {
  if (!file || !fs.existsSync(file)) return null
  const text = fs.readFileSync(file, 'utf8').trim()
  if (!text) return null
  try {
    const s = JSON.parse(text)
    return s && s.counts ? s : null
  } catch {
    return null
  }
}

function main (argv) {
  const o = { head: null, base: null, headLabel: 'head', baseLabel: 'base' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--head') o.head = argv[++i]
    else if (a === '--base') o.base = argv[++i]
    else if (a === '--head-label') o.headLabel = argv[++i]
    else if (a === '--base-label') o.baseLabel = argv[++i]
    else {
      process.stderr.write(`Unknown argument: ${a}\n`)
      return 2
    }
  }
  const r = renderComparison({ head: readSummary(o.head), base: readSummary(o.base), headLabel: o.headLabel, baseLabel: o.baseLabel })
  process.stdout.write(r.markdown)
  const annotate = process.env.GITHUB_ACTIONS === 'true'
  for (const w of r.warnings) process.stderr.write(`${annotate ? '::warning::' : 'warning: '}${w}\n`)
  for (const e of r.errors) process.stderr.write(`${annotate ? '::error::' : 'error: '}${e}\n`)
  return r.errors.length ? 1 : 0
}

if (require.main === module) process.exitCode = main(process.argv.slice(2))

module.exports = { renderComparison, changedItems, readSummary, main }

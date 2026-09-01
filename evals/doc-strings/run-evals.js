#!/usr/bin/env node

'use strict'

/**
 * Execution-verified evals for the model-driven doc-strings behaviors.
 *
 * What "execution-verified" means here: the model's output is never graded
 * by inspecting its prose. Each case materializes a fixture mini-repo, runs
 * the REAL deterministic tools (doc-tools lint-strings / overrides audit /
 * the property extractor) to build the prompt, then APPLIES the model output
 * to the fixture and re-runs the same tools to compute the verdict. Negative
 * controls prove the suite can fail (see --sabotage).
 *
 * Usage:
 *   node evals/doc-strings/run-evals.js               # full suite
 *   node evals/doc-strings/run-evals.js --case <id>   # one case
 *   node evals/doc-strings/run-evals.js --sabotage <negative-case-id>
 *       Runs that negative control against a deliberately violating fixture.
 *       The case is EXPECTED to FAIL; the run exits 0 only if it does.
 *   Options: --model <model> (default sonnet), --keep-temp
 *
 * Exit codes: 0 all pass (or sabotage proven), 1 failures, 2 harness error,
 * 3 SKIPPED (claude CLI unavailable).
 *
 * Requires the claude CLI on PATH (authenticated) and the property-extractor
 * venv (tools/property-extractor/tmp; created automatically on first
 * lint-strings properties run). Not wired into CI: a full run makes eight
 * real model calls and takes minutes.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')

const lib = require('./lib')
const prompts = require('./prompts')
const { CASES } = require('./cases')

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function numbered (text) {
  return text.replace(/\n$/, '').split('\n').map((line, i) => `${String(i + 1).padStart(4)} | ${line}`).join('\n')
}

/** Split a single source line at its LAST double-quoted string literal. */
function splitLastLiteral (line) {
  let last = null
  let i = 0
  while (i < line.length) {
    if (line[i] === '"') {
      const start = i
      i++
      while (i < line.length) {
        if (line[i] === '\\') { i += 2; continue }
        if (line[i] === '"') { i++; break }
        i++
      }
      last = { start, end: i }
      continue
    }
    i++
  }
  if (!last) return null
  return { prefix: line.slice(0, last.start), literal: line.slice(last.start, last.end), suffix: line.slice(last.end) }
}

/** Check registrar: collects mechanical evidence rows. */
function makeChecks () {
  const rows = []
  return {
    rows,
    add (name, pass, detail) {
      rows.push({ check: name, pass: Boolean(pass), detail })
      return Boolean(pass)
    },
    allPass () {
      return rows.every((r) => r.pass)
    }
  }
}

function severityCounts (rules) {
  const counts = { error: 0, warning: 0, info: 0 }
  for (const rule of rules) counts[rule.severity] = (counts[rule.severity] || 0) + 1
  return counts
}

// ---------------------------------------------------------------------------
// Case executors. Each returns { status, checks, model, artifacts }.
// status: PASS | FAIL (model's fault) | HARNESS_ERROR (precondition broke).
// ---------------------------------------------------------------------------

function runRewriteCase (spec, io) {
  const checks = makeChecks()
  const repo = lib.materializeRepo(spec.layout, spec.edits)
  io.saveFixture('before', repo)

  // Genuine findings from the real linter - the same JSON the workflow feeds
  // the model.
  const lintBefore = lib.runLint(repo.dir, repo.surface)
  const finding = lintBefore.findings.find((f) => f.name === spec.target)
  if (!finding) return harnessError(checks, `No lint finding for target ${spec.target}; fixture drifted`)
  const foundRules = finding.rules.map((r) => r.id)
  for (const rule of spec.expectRules) {
    if (!foundRules.includes(rule)) {
      return harnessError(checks, `Precondition: expected rule ${rule} on ${spec.target}, got [${foundRules}]`)
    }
  }
  checks.add('precondition: real lint finding with expected rules', true,
    `${spec.target} lines ${finding.line_start}-${finding.line_end}: [${foundRules.join(', ')}]`)

  const extractionBefore = lib.extractDeclarations(repo.dir, repo.surface)
  const originalText = fs.readFileSync(repo.targetAbs, 'utf8')
  const originalLines = originalText.split('\n')
  const originalSpan = originalLines.slice(finding.line_start - 1, finding.line_end).join('\n')

  const prompt = prompts.rewrite({ finding, columnLimit: spec.columnLimit, language: spec.language })
  const model = io.callModel(prompt)
  if (model.failed) return modelCallFailed(checks, model)

  // --- Execute the output ---
  const suggestions = lib.parseFences(model.output, 'suggestion')
  if (!checks.add('exactly one ```suggestion block', suggestions.length === 1, `found ${suggestions.length}`)) {
    return finish('FAIL', checks, model)
  }
  const replacement = suggestions[0]

  if (spec.columnLimit) {
    const overlong = lib.overlongLines(replacement, spec.columnLimit)
    checks.add(`every suggestion line within ${spec.columnLimit} columns`, overlong.length === 0,
      overlong.length ? `overlong lines (line,len): ${JSON.stringify(overlong)}` : 'ok')
  }

  let applied
  try {
    applied = lib.replaceSpan(originalText, finding.line_start, finding.line_end, replacement)
  } catch (err) {
    checks.add('suggestion applies to the declaration span', false, err.message)
    return finish('FAIL', checks, model)
  }
  fs.writeFileSync(repo.targetAbs, applied.text)
  io.saveFixture('after', repo)

  // Bytes outside the replaced span are untouched (structural guarantee,
  // asserted rather than assumed).
  const newLines = applied.text.split('\n')
  const outsideBefore = originalLines.slice(0, finding.line_start - 1).concat(originalLines.slice(finding.line_end))
  const outsideAfter = newLines.slice(0, finding.line_start - 1).concat(newLines.slice(finding.line_start - 1 + applied.replacementLines.length))
  checks.add('bytes outside the replaced span unchanged', outsideBefore.join('\n') === outsideAfter.join('\n'), 'byte-compared')

  // Inside the span, everything but string-literal contents is unchanged.
  if (spec.singleLine) {
    const passSingle = checks.add('replacement is a single line', applied.replacementLines.length === 1,
      `${applied.replacementLines.length} lines`)
    if (passSingle) {
      const orig = splitLastLiteral(originalSpan)
      const next = splitLastLiteral(applied.replacementLines[0])
      checks.add('non-usage bytes of the line byte-identical', Boolean(orig && next) &&
        orig.prefix === next.prefix && orig.suffix === next.suffix,
        orig && next ? `prefix ${JSON.stringify(orig.prefix)} vs ${JSON.stringify(next.prefix)}` : 'could not locate usage literal')
    }
  } else {
    checks.add('non-literal structure of the span unchanged (blanked-literal compare)',
      lib.normalizeNonLiteral(originalSpan) === lib.normalizeNonLiteral(replacement),
      `before: ${lib.normalizeNonLiteral(originalSpan)}\nafter:  ${lib.normalizeNonLiteral(replacement)}`)
  }

  // --- Re-run the real linter over the applied output ---
  const lintAfter = lib.runLint(repo.dir, repo.surface)
  const targetRulesAfter = lib.findingsFor(lintAfter, spec.target)
  const counts = severityCounts(targetRulesAfter)
  checks.add('re-lint: zero findings of any severity on the rewritten declaration',
    targetRulesAfter.length === 0,
    targetRulesAfter.length === 0 ? 'clean' : `remaining: ${JSON.stringify(targetRulesAfter)} (${JSON.stringify(counts)})`)
  checks.add('re-lint: untouched declarations kept exactly their findings',
    JSON.stringify(lib.findingFingerprint(lintBefore, spec.target)) === JSON.stringify(lib.findingFingerprint(lintAfter, spec.target)),
    'finding fingerprints compared')

  // --- Re-extract and compare semantics ---
  const extractionAfter = lib.extractDeclarations(repo.dir, repo.surface)
  if (repo.surface === 'properties') {
    const problems = lib.comparePropertyExtraction(extractionBefore, extractionAfter, spec.target)
    checks.add('re-extraction: every non-description field of every property unchanged', problems.length === 0, problems.join('; ') || 'ok')
    const desc = (extractionAfter[spec.target] || {}).description || ''
    checks.add('re-extraction: target parses and has a non-empty description',
      desc.trim().length > 0, JSON.stringify(desc.slice(0, 120)))
  } else {
    const targetKey = `${spec.target}::${spec.targetKind || ''}`
    const problems = lib.compareDeclExtraction(extractionBefore, extractionAfter, targetKey)
    checks.add('re-extraction: every other declaration string unchanged', problems.length === 0, problems.join('; ') || 'ok')
    const target = extractionAfter.find((d) => `${d.name}::${(d.meta && d.meta.kind) || ''}` === targetKey)
    const str = (target && target.string) || ''
    checks.add('re-extraction: target parses (scanner resolves it) with a non-empty string',
      str.trim().length > 0, JSON.stringify(str.slice(0, 120)))
    if (repo.surface === 'metrics') {
      checks.add('metrics contract: rewritten string has no terminal period', !/\.\s*$/.test(str), JSON.stringify(str.slice(-40)))
    }
  }

  io.cleanup(repo.dir)
  return finish(checks.allPass() ? 'PASS' : 'FAIL', checks, model)
}

function runUpstreamCase (spec, io) {
  const checks = makeChecks()
  const repo = lib.materializeRepo(spec.layout, spec.edits)
  io.saveFixture('before', repo)
  const overridesPath = path.join(io.caseDir, 'overrides.json')
  fs.writeFileSync(overridesPath, JSON.stringify(spec.overrides, null, 2))

  // Genuine candidate from the real audit (same source as the workflow's
  // candidates.json).
  const auditBefore = lib.runAudit(overridesPath, repo.dir)
  const row = auditBefore.manifest.find((r) => r.name === spec.target && r.field === 'description')
  if (!row || row.class !== spec.expectClassBefore) {
    return harnessError(checks, `Precondition: expected ${spec.target} class ${spec.expectClassBefore}, got ${row ? row.class : 'no row'}`)
  }
  checks.add(`precondition: real audit classifies ${spec.target} as ${spec.expectClassBefore}`, true, row.note)
  const candidate = {
    name: row.name,
    upstream_candidate_text: row.upstream_candidate_text,
    source_file: row.source_file,
    source_line: row.source_line
  }

  const extractionBefore = lib.extractDeclarations(repo.dir, 'properties')
  const originalText = fs.readFileSync(repo.targetAbs, 'utf8')

  const prompt = prompts.upstreamPort({
    candidate,
    fileRel: repo.targetRel,
    numberedFile: numbered(originalText),
    columnLimit: spec.columnLimit
  })
  const model = io.callModel(prompt)
  if (model.failed) return modelCallFailed(checks, model)

  // --- Execute the output ---
  const header = lib.parseLinesHeader(model.output)
  const blocks = lib.parseFences(model.output, 'replacement')
  if (!checks.add('output has a LINES header and exactly one ```replacement block',
    Boolean(header) && blocks.length === 1, `header=${JSON.stringify(header)} blocks=${blocks.length}`)) {
    return finish('FAIL', checks, model)
  }

  if (spec.columnLimit) {
    const overlong = lib.overlongLines(blocks[0], spec.columnLimit)
    checks.add(`every replacement line within ${spec.columnLimit} columns`, overlong.length === 0,
      overlong.length ? `overlong lines (line,len): ${JSON.stringify(overlong)}` : 'ok')
  }

  let applied
  try {
    applied = lib.replaceSpan(originalText, header.start, header.end, blocks[0])
  } catch (err) {
    checks.add('replacement applies to the stated span', false, err.message)
    return finish('FAIL', checks, model)
  }
  fs.writeFileSync(repo.targetAbs, applied.text)
  io.saveFixture('after', repo)

  // Nothing outside string-literal contents changed anywhere in the file.
  checks.add('whole-file non-literal structure unchanged (blanked-literal compare)',
    lib.normalizeNonLiteral(originalText) === lib.normalizeNonLiteral(applied.text), 'compared')

  // --- Re-run the real audit: the class must flip ---
  const auditAfter = lib.runAudit(overridesPath, repo.dir)
  const rowAfter = auditAfter.manifest.find((r) => r.name === spec.target && r.field === 'description')
  checks.add(`re-audit: class flips ${spec.expectClassBefore} -> ${spec.expectClassAfter}`,
    Boolean(rowAfter) && rowAfter.class === spec.expectClassAfter,
    rowAfter ? `${rowAfter.class}: ${rowAfter.note}` : 'row missing')

  // --- Re-extract: the source string is exactly the candidate ---
  const extractionAfter = lib.extractDeclarations(repo.dir, 'properties')
  const desc = (extractionAfter[spec.target] || {}).description || ''
  checks.add('re-extraction: source description equals the candidate (normalized whitespace)',
    lib.normalizeText(desc) === lib.normalizeText(candidate.upstream_candidate_text),
    `extracted: ${JSON.stringify(lib.normalizeText(desc))}`)
  checks.add('re-extraction: no docs-only markup in the ported source string',
    lib.detectDocsMarkup(desc).length === 0, `markup kinds: [${lib.detectDocsMarkup(desc)}]`)
  const problems = lib.comparePropertyExtraction(extractionBefore, extractionAfter, spec.target)
  checks.add('re-extraction: every other property and every non-description field unchanged',
    problems.length === 0, problems.join('; ') || 'ok')

  io.cleanup(repo.dir)
  return finish(checks.allPass() ? 'PASS' : 'FAIL', checks, model)
}

/**
 * Behavior D: the declaration-gated Claude pass. The diff is mechanically
 * CLEAN (the lint gate would not have fired under the old findings-based
 * gate) but the new string is vacuous, so the model must produce a
 * suggestion, and that suggestion is executed like a rewrite: applied to
 * the span the model names, re-linted (must stay clean), re-extracted
 * (nothing but the description may change), and checked for restored
 * substance. Under --sabotage the diff is a fully conforming rewording,
 * the model must stay silent, and this case must FAIL.
 */
function runProseReviewCase (spec, io, sabotage) {
  const checks = makeChecks()
  const repo = lib.materializeRepo(spec.layout)
  const base = lib.gitInit(repo.dir)
  lib.applyEdits(repo.targetAbs, sabotage ? spec.sabotageEdits : spec.diffEdits)
  lib.gitCommitAll(repo.dir, 'reword property description')
  io.saveFixture('after', repo)

  // Precondition: lint-clean either way. The whole point of the case is
  // that the deterministic lint has nothing to say about this diff.
  const lintDiff = lib.runLint(repo.dir, repo.surface, ['--diff', base])
  if (lintDiff.findings.length !== 0) {
    return harnessError(checks, `Precondition: diff must be lint-clean, got ${lintDiff.findings.length} findings`)
  }
  checks.add('precondition: real lint-strings --diff reports zero findings on this diff', true,
    `lint findings in diff: ${lintDiff.findings.length}`)
  const declarations = (lintDiff.summary && lintDiff.summary.totalDeclarations) || 0
  if (declarations === 0) {
    return harnessError(checks, 'Precondition: diff touches no doc-string declaration')
  }
  checks.add('precondition: the diff touches a doc-string declaration (the workflow gate)', true,
    `declarations in diff: ${declarations}`)

  const extractionBefore = lib.extractDeclarations(repo.dir, repo.surface)
  const diff = lib.gitDiff(repo.dir, base)
  const model = io.callModel(prompts.negativeReview({ diff }))
  if (model.failed) return modelCallFailed(checks, model)

  const suggestions = lib.parseFences(model.output, 'suggestion')
  if (!checks.add('at least one ```suggestion block (a vacuous string must draw one)',
    suggestions.length >= 1, `found ${suggestions.length}`)) {
    return finish('FAIL', checks, model)
  }
  const replacement = suggestions[0]
  if (spec.columnLimit) {
    const overlong = lib.overlongLines(replacement, spec.columnLimit)
    checks.add(`every suggestion line within ${spec.columnLimit} columns`, overlong.length === 0,
      overlong.length ? `overlong lines (line,len): ${JSON.stringify(overlong)}` : 'ok')
  }

  // Application is CONTENT-anchored, not line-anchored: the model derives
  // line numbers from diff hunk math and is reliably off by one or two, and
  // its suggestion uses GitHub semantics (replace the cited lines), so
  // trusting either corrupts the fixture. The harness instead pulls the
  // description literals out of the suggestion and swaps them in for the
  // vacuous block it inserted itself, which it knows byte-exactly. The span
  // marker is still asserted for presence, since production inline comments
  // need it.
  checks.add('model names a declaration span (FILE ... LINES a-b)',
    /LINES\s+\d+\s*-\s*\d+/.test(model.output), 'marker scan')

  const literalLine = /^\s*"(?:[^"\\]|\\.)*",?\s*$/
  const nameLiteral = `"${spec.target}",`
  const descLines = replacement.split('\n')
    .filter((l) => literalLine.test(l))
    .filter((l) => l.trim() !== nameLiteral)
  if (!checks.add('suggestion carries description string literals',
    descLines.length >= 1, `literal lines found: ${descLines.length}`)) {
    return finish('FAIL', checks, model)
  }
  // The description argument ends with a comma; normalize so the swap-in
  // preserves the declaration's structure regardless of how the model
  // terminated its last line.
  const lastIdx = descLines.length - 1
  if (!/,\s*$/.test(descLines[lastIdx])) descLines[lastIdx] = descLines[lastIdx].replace(/\s*$/, ',')
  for (let i = 0; i < lastIdx; i++) descLines[i] = descLines[i].replace(/,\s*$/, '')

  const vacuousBlock = spec.diffEdits[0].replace
  const originalText = fs.readFileSync(repo.targetAbs, 'utf8')
  if (!checks.add('the vacuous block is still uniquely present to swap',
    originalText.split(vacuousBlock).length === 2, 'unique-occurrence check')) {
    return finish('FAIL', checks, model)
  }
  fs.writeFileSync(repo.targetAbs, originalText.replace(vacuousBlock, descLines.join('\n')))
  io.saveFixture('applied', repo)

  // Execute the output: the rewrite must not trade vacuousness for lint
  // findings, and must not disturb anything but the description.
  const lintAfter = lib.runLint(repo.dir, repo.surface)
  checks.add('re-lint: the file still parses to the same number of declarations',
    lintAfter.summary.totalDeclarations === Object.keys(extractionBefore).length,
    `declarations after: ${lintAfter.summary.totalDeclarations}, properties before: ${Object.keys(extractionBefore).length}`)
  const targetRulesAfter = lib.findingsFor(lintAfter, spec.target)
  checks.add('re-lint: zero findings on the rewritten declaration', targetRulesAfter.length === 0,
    targetRulesAfter.length === 0 ? 'clean' : `remaining: ${JSON.stringify(targetRulesAfter)}`)

  const extractionAfter = lib.extractDeclarations(repo.dir, repo.surface)
  const problems = lib.comparePropertyExtraction(extractionBefore, extractionAfter, spec.target)
  checks.add('re-extraction: every non-description field of every property unchanged', problems.length === 0,
    problems.join('; ') || 'ok')
  const desc = (extractionAfter[spec.target] || {}).description || ''
  checks.add('re-extraction: target parses with a non-empty description', desc.trim().length > 0,
    JSON.stringify(desc.slice(0, 120)))
  if (Array.isArray(spec.mustMentionAny) && spec.mustMentionAny.length) {
    checks.add('rewrite restores substantive content (states the default)',
      spec.mustMentionAny.some((t) => desc.includes(t)),
      `looked for one of ${JSON.stringify(spec.mustMentionAny)} in ${JSON.stringify(desc.slice(0, 120))}`)
  }

  io.cleanup(repo.dir)
  return finish(checks.allPass() ? 'PASS' : 'FAIL', checks, model)
}

function runNegativeReviewCase (spec, io, sabotage) {
  const checks = makeChecks()
  const repo = lib.materializeRepo(spec.layout)
  const base = lib.gitInit(repo.dir)
  lib.applyEdits(repo.targetAbs, sabotage ? spec.sabotageEdits : spec.diffEdits)
  lib.gitCommitAll(repo.dir, 'reword property description')
  io.saveFixture('after', repo)

  // Precondition: the REAL declaration-anchored lint finds nothing in this
  // diff (skipped under sabotage, where the diff is violating by design).
  const lintDiff = lib.runLint(repo.dir, 'properties', ['--diff', base])
  if (!sabotage && lintDiff.findings.length !== 0) {
    return harnessError(checks, `Precondition: conforming diff produced ${lintDiff.findings.length} lint findings`)
  }
  checks.add(sabotage
    ? 'sabotage mode: diff is deliberately violating (precondition skipped)'
    : 'precondition: real lint-strings --diff reports zero findings on this diff',
  true, `lint findings in diff: ${lintDiff.findings.length}`)

  const diff = lib.gitDiff(repo.dir, base)
  const model = io.callModel(prompts.negativeReview({ diff }))
  if (model.failed) return modelCallFailed(checks, model)

  const suggestions = lib.parseFences(model.output, 'suggestion')
  checks.add('zero ```suggestion blocks in the model output', suggestions.length === 0, `found ${suggestions.length}`)
  const jsonBlocks = lib.parseJsonFences(model.output)
  const impactFindings = jsonBlocks
    .filter((b) => b.ok && b.value && Array.isArray(b.value.doc_impact))
    .reduce((n, b) => n + b.value.doc_impact.length, 0)
  checks.add('zero doc-impact findings claimed', jsonBlocks.length === 0 || impactFindings === 0,
    `json blocks: ${jsonBlocks.length}, doc_impact entries: ${impactFindings}`)
  checks.add('model states NO_SUGGESTIONS', /\bNO_SUGGESTIONS\b/.test(model.output), 'token scan')

  io.cleanup(repo.dir)
  return finish(checks.allPass() ? 'PASS' : 'FAIL', checks, model)
}

function runNegativeAuditCase (spec, io, sabotage) {
  const checks = makeChecks()
  const repo = lib.materializeRepo(spec.layout, sabotage ? spec.sabotageEdits : [])
  io.saveFixture('before', repo)

  const lint = lib.runLint(repo.dir, repo.surface)
  if (!sabotage && lint.findings.length !== 0) {
    return harnessError(checks, `Precondition: conforming metrics fixture produced ${lint.findings.length} lint findings`)
  }
  checks.add(sabotage
    ? 'sabotage mode: fixture is deliberately violating (precondition skipped)'
    : 'precondition: real lint-strings reports zero findings on this file',
  true, `lint findings: ${lint.findings.length}`)

  const fileText = fs.readFileSync(repo.targetAbs, 'utf8')
  const model = io.callModel(prompts.negativeAudit({ fileRel: repo.targetRel, numberedFile: numbered(fileText) }))
  if (model.failed) return modelCallFailed(checks, model)

  const jsonBlocks = lib.parseJsonFences(model.output)
  const ok = checks.add('exactly one parseable ```json block', jsonBlocks.length === 1 && jsonBlocks[0].ok,
    `blocks: ${jsonBlocks.length}${jsonBlocks[0] && !jsonBlocks[0].ok ? `, parse error: ${jsonBlocks[0].error}` : ''}`)
  if (ok) {
    const findings = jsonBlocks[0].value.findings
    checks.add('claimed findings array is empty', Array.isArray(findings) && findings.length === 0,
      `claimed: ${JSON.stringify(findings)}`)
  }
  checks.add('zero ```suggestion blocks in the model output',
    lib.parseFences(model.output, 'suggestion').length === 0, 'fence scan')

  io.cleanup(repo.dir)
  return finish(checks.allPass() ? 'PASS' : 'FAIL', checks, model)
}

function harnessError (checks, message) {
  checks.add('harness precondition', false, message)
  return { status: 'HARNESS_ERROR', checks: checks.rows, model: null }
}

function modelCallFailed (checks, model) {
  checks.add('claude CLI call succeeded', false,
    model.timedOut ? `timed out after ${model.ms}ms` : `exit ${model.status}: ${model.stderr.slice(0, 400)}`)
  return { status: 'FAIL', checks: checks.rows, model }
}

function finish (status, checks, model) {
  return { status, checks: checks.rows, model }
}

const EXECUTORS = {
  rewrite: runRewriteCase,
  upstream: runUpstreamCase,
  'prose-review': runProseReviewCase,
  'negative-review': runNegativeReviewCase,
  'negative-audit': runNegativeAuditCase
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

function parseArgs (argv) {
  const options = { cases: null, sabotage: null, model: 'sonnet', keepTemp: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--case') options.cases = (options.cases || []).concat(argv[++i].split(','))
    else if (arg === '--sabotage') options.sabotage = argv[++i]
    else if (arg === '--model') options.model = argv[++i]
    else if (arg === '--keep-temp') options.keepTemp = true
    else {
      console.error(`Unknown argument: ${arg}`)
      console.error('Usage: node evals/doc-strings/run-evals.js [--case <id>[,<id>]] [--sabotage <negative-case-id>] [--model <model>] [--keep-temp]')
      process.exit(2)
    }
  }
  return options
}

function main () {
  const options = parseArgs(process.argv.slice(2))
  const startedAt = Date.now()

  if (!lib.claudeAvailable()) {
    console.log('SKIPPED: the claude CLI is not available on PATH. This suite drives')
    console.log('real model calls and cannot run without it. Install and authenticate')
    console.log('Claude Code, then re-run: npm run eval:doc-strings')
    process.exit(3)
  }

  let selected = CASES
  if (options.sabotage) {
    selected = CASES.filter((c) => c.id === options.sabotage)
    if (selected.length === 0 || !Array.isArray(selected[0].sabotageEdits)) {
      console.error(`--sabotage requires the id of a case with sabotageEdits. Available: ${CASES.filter((c) => Array.isArray(c.sabotageEdits)).map((c) => c.id).join(', ')}`)
      process.exit(2)
    }
  } else if (options.cases) {
    selected = CASES.filter((c) => options.cases.includes(c.id))
    const missing = options.cases.filter((id) => !CASES.some((c) => c.id === id))
    if (missing.length) {
      console.error(`Unknown case id(s): ${missing.join(', ')}. Available: ${CASES.map((c) => c.id).join(', ')}`)
      process.exit(2)
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const resultsRoot = path.join(__dirname, 'results', options.sabotage ? `${stamp}-sabotage` : stamp)
  fs.mkdirSync(resultsRoot, { recursive: true })

  const summary = []
  for (const spec of selected) {
    const caseDir = path.join(resultsRoot, spec.id)
    fs.mkdirSync(caseDir, { recursive: true })
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-strings-eval-cwd-'))

    const io = {
      caseDir,
      callModel (prompt) {
        fs.writeFileSync(path.join(caseDir, 'prompt.txt'), prompt)
        const result = lib.runClaude(prompt, { cwd: workDir, model: options.model })
        fs.writeFileSync(path.join(caseDir, 'model-output.txt'), result.output)
        if (result.stderr) fs.writeFileSync(path.join(caseDir, 'model-stderr.txt'), result.stderr)
        result.failed = result.timedOut || result.status !== 0
        return result
      },
      saveFixture (label, repo) {
        fs.copyFileSync(repo.targetAbs, path.join(caseDir, `fixture-${label}-${path.basename(repo.targetRel)}`))
      },
      cleanup (dir) {
        if (!options.keepTemp) fs.rmSync(dir, { recursive: true, force: true })
      }
    }

    process.stdout.write(`\n=== ${spec.id}${options.sabotage ? ' [SABOTAGE]' : ''} ===\n    ${spec.description}\n`)
    let result
    try {
      result = EXECUTORS[spec.kind](spec, io, Boolean(options.sabotage))
    } catch (err) {
      result = { status: 'HARNESS_ERROR', checks: [{ check: 'executor', pass: false, detail: err.stack }], model: null }
    }
    fs.rmSync(workDir, { recursive: true, force: true })

    for (const row of result.checks) {
      process.stdout.write(`    ${row.pass ? 'ok  ' : 'FAIL'} ${row.check}\n         ${String(row.detail).split('\n')[0]}\n`)
    }
    const ms = result.model ? result.model.ms : 0
    process.stdout.write(`    -> ${result.status}${ms ? ` (model call ${(ms / 1000).toFixed(1)}s)` : ''}\n`)

    const record = {
      id: spec.id,
      kind: spec.kind,
      sabotage: Boolean(options.sabotage),
      status: result.status,
      model_ms: ms,
      checks: result.checks
    }
    summary.push(record)
    fs.writeFileSync(path.join(caseDir, 'evidence.json'), JSON.stringify(record, null, 2))
  }

  const wallMs = Date.now() - startedAt
  fs.writeFileSync(path.join(resultsRoot, 'summary.json'), JSON.stringify({
    model: options.model,
    sabotage: options.sabotage,
    wall_ms: wallMs,
    cases: summary
  }, null, 2))

  const failed = summary.filter((c) => c.status !== 'PASS')
  process.stdout.write(`\n${'='.repeat(60)}\n`)
  for (const c of summary) process.stdout.write(`${c.status.padEnd(14)} ${c.id}\n`)
  process.stdout.write(`Total wall time: ${(wallMs / 1000).toFixed(1)}s. Results: ${path.relative(process.cwd(), resultsRoot)}\n`)

  if (options.sabotage) {
    const proven = summary.length === 1 && summary[0].status === 'FAIL'
    process.stdout.write(proven
      ? 'SABOTAGE PROVEN: the negative control FAILED against a violating fixture,\nso a model that invents suggestions cannot pass it. Restore confidence: re-run\nthe suite without --sabotage.\n'
      : 'SABOTAGE NOT PROVEN: the negative control did not fail. The harness cannot\ncurrently catch invented findings - fix the assertions.\n')
    process.exit(proven ? 0 : 1)
  }
  process.exit(failed.length === 0 ? 0 : 1)
}

main()

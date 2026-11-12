#!/usr/bin/env node

/**
 * Overrides Audit CLI
 *
 * Field-level classification of docs-side override entries against
 * extracted source strings, powering the override-retirement loop
 * (retirement: delete REDUNDANT fields on each release regeneration;
 * upstreaming: draft source PRs from UPSTREAMABLE/SPLIT candidates).
 *
 * Usage (standalone):
 *   node tools/overrides-audit/index.js \
 *     --overrides docs-data/property-overrides.json \
 *     --extracted tools/property-extractor/gen/properties-output.json \
 *     [--surface properties|rpk] [--format json|human] [--output <file>]
 *
 *   node tools/overrides-audit/index.js --surface rpk \
 *     --overrides docs-data/rpk-overrides.json \
 *     --extracted docs-data/rpk-v26.2.2.json
 *
 * For rpk, --repo takes a streaming-enterprise src/go/rpk checkout: without
 * --extracted, the audit runs `go run cmd/rpk/main.go --print-tree` there
 * (that output is the raw, pre-override tree). Unless --locations is given,
 * it also runs the locate-strings analyzer, so UPSTREAMABLE rows carry
 * source_file/source_line. --locations takes analyzer output produced
 * earlier, with --extracted or --repo.
 *
 * Also exposed as `doc-tools overrides audit` and the `audit_overrides`
 * MCP tool. See README.adoc in this directory for the classification rules
 * and the upstream_ref policy.
 */

'use strict'

const fs = require('fs')
const path = require('path')

const ADAPTERS = {
  properties: () => require('./adapters/properties'),
  rpk: () => require('./adapters/rpk')
}

/**
 * Run the audit and return the result object.
 *
 * @param {Object} options - { overrides, extracted, repo, locations, surface, format, output }.
 * @returns {Object} Audit result ({ surface, manifest, summary, ... }).
 */
function runAudit (options) {
  const surface = options.surface || 'properties'
  const adapterFactory = ADAPTERS[surface]
  if (!adapterFactory) {
    throw new Error(`Unknown surface '${surface}'. Valid surfaces: ${Object.keys(ADAPTERS).join(', ')}`)
  }
  if (!options.overrides) {
    throw new Error('Missing required option --overrides <path>')
  }
  let extractedPath = options.extracted ? path.resolve(options.extracted) : undefined
  if (surface === 'properties' && !extractedPath) {
    if (!options.repo) {
      throw new Error('Provide --extracted <path> (raw extractor JSON, no overrides applied) or --repo <path> (a redpanda checkout to extract from)')
    }
    // Extract raw source strings ourselves. Never audit against a published
    // redpanda-properties-<tag>.json: those already have overrides applied,
    // which classifies every description REDUNDANT.
    const fs = require('fs')
    const os = require('os')
    const { runExtractor } = require('../lint-strings/surfaces/properties')
    const json = runExtractor(path.resolve(options.repo), (msg) => console.error(msg))
    extractedPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'overrides-audit-')), 'extracted.json')
    fs.writeFileSync(extractedPath, JSON.stringify(json))
  }

  let locationsPath = options.locations ? path.resolve(options.locations) : undefined
  if (locationsPath && surface !== 'rpk') {
    throw new Error('--locations applies to the rpk surface only; property rows already carry source_file/source_line from the extractor')
  }
  if (surface === 'rpk' && options.repo) {
    // --repo is the src/go/rpk directory itself, already at the commit the
    // caller chose; nothing is fetched or checked out here. Progress goes to
    // stderr so stdout stays valid JSON.
    const os = require('os')
    const { fetchRpkTreeFromSource, locateRpkSourceStrings } = require('../rpk-docs/rpk-docs-handler')
    const log = (msg) => console.error(msg)
    const repoPath = path.resolve(options.repo)
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overrides-audit-'))
    if (!extractedPath) {
      // `rpk --print-tree` output has no overrides applied, so it is the
      // raw tree the adapter compares against.
      const tree = fetchRpkTreeFromSource(repoPath, log)
      extractedPath = path.join(tmpDir, 'extracted.json')
      fs.writeFileSync(extractedPath, JSON.stringify({ raw_tree: tree }))
    }
    if (!locationsPath) {
      // On failure rows carry no location and locations_file stays null in
      // the result, so no row is reported as unlocatable by mistake.
      try {
        const locations = locateRpkSourceStrings(repoPath, log)
        locationsPath = path.join(tmpDir, 'locations.json')
        fs.writeFileSync(locationsPath, JSON.stringify(locations))
      } catch (err) {
        log(`Warning: rpk source-string locator failed, continuing without source locations: ${err.message}`)
      }
    }
  }

  const adapter = adapterFactory()
  return adapter.audit({
    overridesPath: path.resolve(options.overrides),
    extractedPath,
    locationsPath
  })
}

/**
 * Render the audit result as a human-readable report.
 *
 * @param {Object} result - Audit result from runAudit().
 * @returns {string} Multi-line report.
 */
function formatHumanReport (result) {
  const lines = []
  const { summary } = result
  lines.push('='.repeat(64))
  lines.push(`Overrides audit — surface: ${result.surface}`)
  lines.push(`Overrides: ${result.overrides_file}`)
  lines.push(`Extracted: ${result.extracted_file || '(none)'}`)
  if (result.locations_file !== undefined) lines.push(`Locations: ${result.locations_file || '(locator did not run)'}`)
  lines.push('='.repeat(64))
  lines.push('')
  lines.push(`Classified ${summary.total} override field(s):`)
  const order = [
    'REDUNDANT',
    'UPSTREAMABLE',
    'KEEP_UNTIL_UPSTREAMED',
    'UPSTREAMABLE_SLOT',
    'REDUNDANT_OR_UPSTREAMABLE',
    'KEEP',
    'REVIEW'
  ]
  for (const cls of order) {
    if (summary.byClass[cls]) {
      lines.push(`  ${cls.padEnd(26)} ${summary.byClass[cls]}`)
    }
  }
  lines.push('')
  lines.push('Per field:')
  for (const [field, byClass] of Object.entries(summary.byField)) {
    const parts = Object.entries(byClass).map(([cls, count]) => `${cls}: ${count}`)
    lines.push(`  ${field.padEnd(20)} ${parts.join(', ')}`)
  }

  const sections = [
    ['REDUNDANT', 'Retire in the next auto-docs PR (source already matches)'],
    ['UPSTREAMABLE', 'Candidates to send upstream'],
    ['UPSTREAMABLE_SLOT', 'Migrate to a source metadata slot'],
    ['REDUNDANT_OR_UPSTREAMABLE', 'Needs a human ruling'],
    ['REVIEW', 'Needs attention (possible source bug, typo, or missing property)']
  ]
  for (const [cls, heading] of sections) {
    const rows = result.manifest.filter((row) => row.class === cls)
    if (rows.length === 0) continue
    lines.push('')
    lines.push(`${cls} — ${heading} (${rows.length}):`)
    for (const row of rows) {
      lines.push(`  • ${row.name} [${row.field}]${row.note ? ` — ${row.note}` : ''}`)
    }
  }

  if (result.cross_check && result.surface === 'rpk') {
    lines.push('')
    lines.push('Cross-check (generator output with every REDUNDANT field removed):')
    lines.push(`  redundant fields removed: ${result.cross_check.redundant_fields_removed}`)
    lines.push(`  commands compared: ${result.cross_check.commands_compared}`)
    if (result.cross_check.violations.length > 0) {
      lines.push(`  CLASSIFIER BUG: output changed for ${result.cross_check.violations.join(', ')}`)
    } else {
      lines.push('  consistency: OK (no rendered command changes)')
    }
  } else if (result.cross_check) {
    lines.push('')
    lines.push('Cross-check (compare-properties.js):')
    lines.push(`  descriptions still masked by overrides: ${result.cross_check.changedDescriptions}`)
    lines.push(`  empty source descriptions: ${result.cross_check.emptyDescriptions}`)
    if (result.cross_check.violations.length > 0) {
      lines.push(`  CLASSIFIER BUG — raw-equal but not REDUNDANT: ${result.cross_check.violations.join(', ')}`)
    } else {
      lines.push('  consistency: OK (every raw-equal description classified REDUNDANT)')
    }
  }

  lines.push('')
  lines.push('='.repeat(64))
  return lines.join('\n')
}

/**
 * CLI entry point.
 *
 * @param {string[]} argv - process.argv.
 */
function main (argv) {
  const { Command } = require('commander')
  const program = new Command()

  program
    .name('overrides-audit')
    .description('Classify docs-side override fields against extracted source strings')
    .requiredOption('--overrides <path>', 'Path to the overrides JSON file (for example docs-data/property-overrides.json)')
    .option('--extracted <path>', 'Path to the extracted source JSON: the property extractor raw output (properties surface) or the newest docs-data/rpk-v<version>.json snapshot, whose raw_tree is the pre-override help text (rpk surface)')
    .option('--repo <path>', 'Alternative to --extracted: a redpanda checkout (properties) or a streaming-enterprise src/go/rpk directory (rpk; also locates source strings)')
    .option('--locations <path>', 'rpk only: locate-strings analyzer output to attach source_file/source_line from')
    .option('--surface <surface>', 'Override surface: properties or rpk', 'properties')
    .option('--format <format>', 'Output format: json or human', 'json')
    .option('--output <path>', 'Also write the JSON result to this file')
    .action((options) => {
      try {
        const result = runAudit(options)
        if (options.output) {
          fs.mkdirSync(path.dirname(path.resolve(options.output)), { recursive: true })
          fs.writeFileSync(path.resolve(options.output), JSON.stringify(result, null, 2) + '\n')
          console.error(`JSON result written to ${options.output}`)
        }
        if (options.format === 'human') {
          console.log(formatHumanReport(result))
        } else {
          console.log(JSON.stringify(result, null, 2))
        }
      } catch (err) {
        console.error(`Error: ${err.message}`)
        process.exit(1)
      }
    })

  program.parse(argv)
}

if (require.main === module) {
  main(process.argv)
}

module.exports = { runAudit, formatHumanReport }

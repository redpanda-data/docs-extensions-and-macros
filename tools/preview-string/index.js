'use strict'

const fs = require('fs')
const path = require('path')

/**
 * doc-tools preview-string: render ONE doc-string declaration from local
 * engineering source to the final published snippet, so an engineer can see
 * what their string becomes on docs.redpanda.com BEFORE it ships.
 *
 * - properties: runs the real Python extractor and the real Handlebars
 *   property template. With --overrides, renders a second "as shipped"
 *   pane and prints a MASKED-BY-OVERRIDE notice when a docs-repo override
 *   would replace the source string.
 * - rpk: runs the string through the real formatDescription() transformer
 *   from tools/rpk-docs (the killer demo: an ALLCAPS line becomes a "==="
 *   heading before your eyes).
 * - metrics/helm/crd/connect: renders the description in the surface's
 *   output shape with a one-line header.
 *
 * Extraction reuses the lint-strings surface modules, so preview and lint
 * always agree on what the source declares.
 */

const HR = '-'.repeat(72)

function pane (title, body) {
  return `${HR}\n${title}\n${HR}\n${body}\n`
}

/**
 * Render a preview for one declaration.
 *
 * @param {Object} options
 * @param {string} options.repo - Path to the engineering checkout
 * @param {string} options.surface - properties|rpk|metrics|helm|crd|connect
 * @param {string} options.name - Declaration name (property name, rpk
 *   command or --flag, metric name, helm key path, crd json field, connect
 *   component/field name)
 * @param {string} [options.overrides] - Overrides JSON path (properties only)
 * @param {Function} [options.log]
 * @returns {string} The rendered preview text
 */
function previewString (options) {
  const { repo, surface, name, overrides = null, log = (msg) => process.stderr.write(`${msg}\n`) } = options
  if (!repo) throw new Error('preview-string requires --repo <path>')
  if (!surface) throw new Error('preview-string requires --surface <name>')
  if (!name) throw new Error('preview-string requires --name <name>')
  const repoPath = path.resolve(repo)
  if (!fs.existsSync(repoPath)) throw new Error(`Repo path does not exist: ${repoPath}`)

  if (overrides && surface !== 'properties') {
    log(`Note: --overrides applies to the properties surface only; ignoring it for ${surface}.`)
  }

  switch (surface) {
    case 'properties': return previewProperty(repoPath, name, overrides, log)
    case 'rpk': return previewRpk(repoPath, name, log)
    case 'metrics':
    case 'helm':
    case 'crd':
    case 'connect': return previewLintSurface(surface, repoPath, name, log)
    default: throw new Error(`Unknown surface "${surface}". Supported: properties, rpk, metrics, helm, crd, connect`)
  }
}

/* -------------------------------- properties ---------------------------- */

function previewProperty (repo, name, overridesPath, log) {
  const properties = require('../lint-strings/surfaces/properties')
  const handlebars = require('handlebars')
  // Requiring the generator registers its Handlebars helpers (eq, ...) as a
  // side effect - the same environment a real generation run uses.
  require('../property-extractor/generate-handlebars-docs')

  const json = properties.runExtractor(repo, log)
  const prop = (json.properties || {})[name]
  if (!prop) {
    const near = Object.keys(json.properties || {}).filter((k) => k.includes(name)).slice(0, 8)
    throw new Error(`Property "${name}" not found in ${repo}.${near.length > 0 ? ` Close matches: ${near.join(', ')}` : ''}`)
  }

  const templatePath = path.join(properties.TOOL_ROOT, 'templates', 'property.hbs')
  const template = handlebars.compile(fs.readFileSync(templatePath, 'utf8'))
  const asSource = template({ ...prop, name }).trim()

  const spanNote = prop.line_start != null
    ? `${prop.defined_in || ''}:${prop.line_start}-${prop.line_end != null ? prop.line_end : prop.line_start}`
    : (prop.defined_in || '(unknown source location)')
  let out = `Property: ${name}  (${spanNote})\n\n`
  out += pane('AS SOURCE (rendered from your checkout)', asSource)

  if (overridesPath) {
    const raw = JSON.parse(fs.readFileSync(path.resolve(overridesPath), 'utf8'))
    // Accept both { properties: { name: {...} } } (docs-repo
    // property-overrides.json) and a flat { name: {...} } map.
    const entry = (raw.properties && raw.properties[name]) || (!raw.properties && raw[name]) || null
    if (!entry) {
      out += `\nNo override entry for "${name}" in ${overridesPath}: the source string ships as-is.\n`
    } else {
      const shipped = { ...prop, ...entry, name }
      const asShipped = template(shipped).trim()
      out += '\n' + pane('AS SHIPPED (override applied)', asShipped)
      if (asShipped !== asSource) {
        const maskedFields = Object.keys(entry).filter((k) => JSON.stringify(prop[k]) !== JSON.stringify(entry[k]))
        out += `\nMASKED-BY-OVERRIDE: the docs repo overrides ${maskedFields.map((f) => `"${f}"`).join(', ') || 'this entry'} for ${name}.\n` +
          'Changes to the source string will NOT reach docs.redpanda.com until the override field is retired (fix the source string upstream, then delete the override field).\n'
      } else {
        out += '\nOverride entry present but the rendered output is identical: the override is redundant and can be retired.\n'
      }
    }
  }
  return out
}

/* ----------------------------------- rpk -------------------------------- */

/**
 * Mirror the real generate-rpk-docs.js pipeline for one string:
 * - Long: parseDescriptionSections first (ALLCAPS lines become "===" section
 *   headings, exactly as on the generated command page), then
 *   formatDescription + ensurePeriod on the main description and
 *   formatDescription on each section body.
 * - Short: ensurePeriod(capToTwoSentences(formatDescription(...))) - the
 *   shortDesc path.
 * - Flag usage: ensurePeriod(formatDescription(...)) - the flag table path.
 */
function publishRpkString (kind, text, helpers) {
  const { formatDescription, parseDescriptionSections, ensurePeriod, capToTwoSentences } = helpers
  if (kind === 'long') {
    const { mainDescription, sections } = parseDescriptionSections(text)
    let out = ensurePeriod(formatDescription(mainDescription))
    for (const [section, body] of Object.entries(sections)) {
      const title = section.charAt(0).toUpperCase() + section.slice(1).toLowerCase()
      out += `\n\n=== ${title}\n\n${formatDescription(body)}`
    }
    return out.trim()
  }
  if (kind === 'short') {
    return ensurePeriod(capToTwoSentences(formatDescription(text, null, { skipTableConversion: true, skipListConversion: true }))).trim()
  }
  return ensurePeriod(formatDescription(text)).trim()
}

function previewRpk (repo, name, log) {
  const rpk = require('../lint-strings/surfaces/rpk')
  const helpers = require('../rpk-docs/generate-rpk-docs')

  log(`Scanning rpk sources in ${repo}...`)
  const decls = rpk.extract({ repo, log })
  const isFlag = name.startsWith('-')
  const target = isFlag ? name.replace(/^-+/, '') : name
  const matches = decls.filter((d) => isFlag
    ? (d.meta.kind === 'flag' && d.name === target)
    : (d.meta.kind !== 'flag' && d.name === target))
  if (matches.length === 0) {
    throw new Error(`No rpk ${isFlag ? 'flag' : 'command'} named "${target}" found under src/go/rpk/pkg/cli. Use the leaf command token (for example "health") or --flag-name.`)
  }

  let out = ''
  for (const d of matches.slice(0, 10)) {
    const label = d.meta.kind === 'flag' ? `--${d.name} (flag usage)` : `${d.name} (${d.meta.kind})`
    out += `rpk ${label}  ${d.file}:${d.line_start}-${d.line_end}\n\n`
    if (d.string == null) {
      out += 'Source string is built dynamically (not a plain literal); preview unavailable.\n\n'
      continue
    }
    out += pane('AS SOURCE', d.string)
    out += '\n' + pane('AS PUBLISHED (after formatDescription)', publishRpkString(d.meta.kind, d.string, helpers)) + '\n'
  }
  if (matches.length > 10) out += `(${matches.length - 10} more matches not shown)\n`
  return out
}

/* -------------------- metrics / helm / crd / connect --------------------- */

const SHAPES = {
  // How each surface's description lands on the published page.
  metrics: (d) => `=== ${d.name}\n\n${d.string}`,
  helm: (d) => `=== ${d.name}\n\n${d.string}${d.meta.default_annotation ? `\n\n*Default:* ${d.meta.default_annotation}` : ''}`,
  crd: (d) => `| *\`${d.name}\`* +\n(table cell in the CRD reference and \`kubectl explain\` output)\n| ${d.string}`,
  connect: (d) => d.string // connect descriptions ARE the AsciiDoc page body
}

function previewLintSurface (surfaceName, repo, name, log) {
  const { SURFACES } = require('../lint-strings')
  const surface = SURFACES[surfaceName]
  log(`Scanning ${surfaceName} sources in ${repo}...`)
  const decls = surface.extract({ repo, log })
  const matches = decls.filter((d) => d.name === name ||
    (surfaceName === 'crd' && `${d.meta.struct}.${d.name}` === name))
  if (matches.length === 0) {
    throw new Error(`No ${surfaceName} declaration named "${name}" found in ${repo}.`)
  }

  let out = ''
  for (const d of matches.slice(0, 10)) {
    out += `${surfaceName}: ${d.name}${d.meta.struct ? ` (in ${d.meta.struct})` : ''}  ${d.file}:${d.line_start}-${d.line_end}\n\n`
    if (d.string == null) {
      out += 'No description in source; this ships blank.\n\n'
      continue
    }
    out += pane('AS PUBLISHED', SHAPES[surfaceName](d)) + '\n'
  }
  if (matches.length > 10) out += `(${matches.length - 10} more matches not shown)\n`
  return out
}

/* ----------------------------------- CLI --------------------------------- */

function runCli (options) {
  try {
    process.stdout.write(previewString({
      repo: options.repo,
      surface: options.surface,
      name: options.name,
      overrides: options.overrides || null
    }))
  } catch (err) {
    console.error(`Error: ${err.message}`)
    process.exit(2)
  }
  process.exit(0)
}

module.exports = { previewString, publishRpkString, runCli }

// Direct usage: node tools/preview-string --repo <path> --surface <s> --name <n> [--overrides <path>]
if (require.main === module) {
  const args = process.argv.slice(2)
  const options = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--repo') options.repo = args[++i]
    else if (arg === '--surface') options.surface = args[++i]
    else if (arg === '--name') options.name = args[++i]
    else if (arg === '--overrides') options.overrides = args[++i]
    else {
      console.error(`Unknown argument: ${arg}`)
      console.error('Usage: node tools/preview-string --repo <path> --surface <s> --name <name> [--overrides <path>]')
      process.exit(2)
    }
  }
  runCli(options)
}

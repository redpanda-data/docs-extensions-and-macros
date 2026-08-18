'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const { SourceCache } = require('../source-text')

/**
 * Properties surface: cluster/node configuration properties declared in
 * src/v/config/{configuration,node_config}.cc and friends.
 *
 * Semantic truth comes from the existing Python property extractor
 * (tools/property-extractor), invoked with `--path <repo>` against an
 * EXISTING checkout - this module never clones redpanda. It consumes the
 * extractor's JSON including the additive line_start/line_end spans recorded
 * by parser.py/transformers.py, which cover the full member-initializer
 * entry (so clang-format-wrapped descriptions map to whole declarations).
 *
 * Environment setup mirrors the Makefile's `venv` and `treesitter` targets:
 * a Python venv under tools/property-extractor/tmp and a tree-sitter-cpp
 * grammar checkout at v0.20.5.
 */

const TOOL_ROOT = path.resolve(__dirname, '../../property-extractor')
const VENV_DIR = path.join(TOOL_ROOT, 'tmp', 'redpanda-property-extractor-venv')
const VENV_PYTHON = path.join(VENV_DIR, 'bin', 'python')
const TREESITTER_DIR = path.join(TOOL_ROOT, 'tree-sitter', 'tree-sitter-cpp')
const TREESITTER_TAG = 'v0.20.5'

const CONVENTION = {
  case: 'sentence',
  terminal_period: true,
  verbatim_asciidoc: true,
  state_default: true
}

function run (cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', ...options })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed:\n${result.stderr || result.stdout}`)
  }
  return result
}

/**
 * Mirror of the Makefile `venv` target: create the venv and install
 * requirements once; later runs reuse it.
 */
function ensureVenv (log) {
  if (fs.existsSync(VENV_PYTHON)) return
  log(`Creating property-extractor venv at ${VENV_DIR}...`)
  fs.mkdirSync(path.dirname(VENV_DIR), { recursive: true })
  run('python3', ['-m', 'venv', VENV_DIR])
  run(path.join(VENV_DIR, 'bin', 'pip'), ['install', '--quiet', '--upgrade', 'pip'])
  run(path.join(VENV_DIR, 'bin', 'pip'), ['install', '--quiet', '--no-cache-dir', '-r', path.join(TOOL_ROOT, 'requirements.txt')])
}

/**
 * Mirror of the Makefile `treesitter` target: clone tree-sitter-cpp, pin to
 * v0.20.5, and generate the parser only when parser.c is missing (the pinned
 * tag ships a generated parser.c, so the npx step is normally skipped).
 */
function ensureTreesitter (log) {
  const parserC = path.join(TREESITTER_DIR, 'src', 'parser.c')
  if (!fs.existsSync(path.join(TREESITTER_DIR, '.git'))) {
    log(`Cloning tree-sitter-cpp grammar into ${TREESITTER_DIR}...`)
    fs.rmSync(TREESITTER_DIR, { recursive: true, force: true })
    fs.mkdirSync(path.dirname(TREESITTER_DIR), { recursive: true })
    run('git', ['clone', '--quiet', 'https://github.com/tree-sitter/tree-sitter-cpp.git', TREESITTER_DIR])
  }
  const tag = spawnSync('git', ['-C', TREESITTER_DIR, 'describe', '--tags', '--exact-match'], { encoding: 'utf8' })
  if ((tag.stdout || '').trim() !== TREESITTER_TAG || !fs.existsSync(parserC)) {
    run('git', ['-C', TREESITTER_DIR, 'fetch', '--tags', '--quiet'])
    run('git', ['-C', TREESITTER_DIR, 'checkout', '--quiet', TREESITTER_TAG])
    if (!fs.existsSync(parserC)) {
      log('Generating tree-sitter-cpp parser...')
      run('npm', ['install', '--silent'], { cwd: TREESITTER_DIR })
      run('npx', ['tree-sitter', 'generate'], { cwd: TREESITTER_DIR, env: { ...process.env, CFLAGS: '-Wno-unused-but-set-variable' } })
    }
  }
}

/**
 * Run the Python extractor against an existing checkout and return the
 * parsed properties JSON ({ properties, definitions }).
 */
function runExtractor (repo, log) {
  ensureVenv(log)
  ensureTreesitter(log)

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-strings-props-'))
  const outputPath = path.join(scratch, 'properties.json')
  try {
    log(`Extracting properties from ${repo} (this parses the C++ sources and can take a few minutes)...`)
    // cwd must be TOOL_ROOT: property_extractor.py resolves the tree-sitter
    // grammar relative to the working directory.
    run(VENV_PYTHON, ['-W', 'ignore', 'property_extractor.py', '--recursive', '--path', repo, '--output', outputPath], {
      cwd: TOOL_ROOT,
      maxBuffer: 256 * 1024 * 1024
    })
    return JSON.parse(fs.readFileSync(outputPath, 'utf8'))
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}

/**
 * Map extractor JSON to lint declarations. Pure - exported for tests.
 *
 * Skips:
 * - deprecated properties (no user-facing description contract)
 * - topic properties (synthesized from cluster properties, no source span)
 *
 * @param {Object} json - Extractor output ({ properties: {...} })
 * @param {string} repo - Repo path, for reading declaration_text
 * @param {Object} [options] - { files: Set<string> } restrict to these
 *   repo-relative files (diff mode)
 */
function mapExtractorJson (json, repo, options = {}) {
  const { files = null } = options
  const cache = new SourceCache(repo)
  const declarations = []

  for (const [name, prop] of Object.entries(json.properties || {})) {
    if (prop.is_deprecated) continue
    if (prop.is_topic_property) continue
    const file = prop.defined_in
    if (!file) continue
    if (files && !files.has(file)) continue

    const lineStart = prop.line_start != null ? prop.line_start : null
    const lineEnd = prop.line_end != null ? prop.line_end : lineStart
    const hasDefault = Object.prototype.hasOwnProperty.call(prop, 'default') &&
      prop.default !== null && prop.default !== ''

    declarations.push({
      surface: 'properties',
      name,
      file,
      line_start: lineStart,
      line_end: lineEnd,
      string: typeof prop.description === 'string' && prop.description.trim() !== '' ? prop.description : null,
      declaration_text: cache.span(file, lineStart, lineEnd),
      convention: CONVENTION,
      meta: {
        has_default: hasDefault,
        default: hasDefault ? prop.default : null,
        is_enum: Boolean(prop.is_enum),
        nullable: Boolean(prop.nullable)
      }
    })
  }

  return declarations
}

/**
 * Extract property declarations from an existing redpanda checkout.
 *
 * @param {Object} options - { repo, files (Set of repo-relative paths, diff
 *   mode), log (progress logger, defaults to stderr) }
 */
function extract ({ repo, files = null, log = (msg) => process.stderr.write(`${msg}\n`) }) {
  const json = runExtractor(repo, log)
  return mapExtractorJson(json, repo, { files })
}

/** Surface-specific convention rules. */
const RULES = [
  {
    name: 'missing-terminal-period',
    description: 'Property descriptions are complete sentences ending in a period',
    severity: 'warning',
    check: (decl) => {
      const text = (decl.string || '').trim()
      if (!text) return []
      if (!/[.!?]$/.test(text)) {
        return [{ message: `Description does not end with a period: "...${text.slice(-50)}"` }]
      }
      return []
    }
  },
  {
    name: 'default-not-stated',
    description: 'Property has a default the description never mentions',
    severity: 'info',
    check: (decl) => {
      const text = decl.string || ''
      if (!text || !decl.meta || !decl.meta.has_default) return []
      const defaultText = String(decl.meta.default)
      if (/\bdefaults?\b/i.test(text)) return []
      if (defaultText.length > 0 && text.includes(defaultText)) return []
      return [{ message: `Property has a default (${JSON.stringify(decl.meta.default)}) that the description does not state.` }]
    }
  }
]

module.exports = {
  name: 'properties',
  convention: CONVENTION,
  extract,
  mapExtractorJson,
  rules: RULES,
  // Exposed for tests and future tooling
  TOOL_ROOT,
  VENV_PYTHON,
  TREESITTER_DIR
}

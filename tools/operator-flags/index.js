'use strict'

/* doc-tools generate operator-flags
 *
 * Reads the flags of `redpanda-operator run` at one operator release and
 * writes, into a docs checkout:
 *
 *   modules/reference/attachments/operator-flags-<version>.json  (the data
 *     opflag: and opflagval: read; see extension-utils/operator-flags.js)
 *   modules/reference/pages/k-operator-flags.adoc                (the reference)
 *
 * The flags come from the operator itself, not from parsing its source: a
 * small Go program (flagdump.go.tmpl) is written into a temporary package of
 * the checkout and run with `go run`, so it builds `run.Command()` with the
 * release's own go.mod, and walks every flag pflag holds, deprecated and
 * hidden ones included (--help hides both). The operator version is stamped
 * with the same -ldflags the release build uses, so a default derived from
 * it (--configurator-tag) is what the release ships.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const { renderPage } = require('./render-page')
const { PAGE_MODULE, PAGE_RELATIVE } = require('../../extension-utils/operator-flags')

const REPO = 'redpanda-data/operator-enterprise'
const DUMP_PACKAGE = 'cmd/zz-doc-tools-flagdump'
const VERSION_SYMBOL = 'github.com/redpanda-data/redpanda-operator/operator/cmd/version.Version'

/**
 * The operator version a ref names: operator/v26.2.5 -> v26.2.5. A branch
 * has none, and the caller must say which version the output is for.
 */
function versionOfRef (ref) {
  const match = String(ref || '').match(/^(?:operator\/)?(v\d+\.\d+\.\d+(?:-(?:rc|beta)\.?\d+)?)$/)
  return match ? match[1] : undefined
}

function run (cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts })
  if (result.error) throw new Error(`${cmd} ${args.join(' ')}: ${result.error.message}`)
  return result
}

function token () {
  return process.env.REDPANDA_GITHUB_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ''
}

/**
 * A shallow clone of the operator at ref, in a temporary directory.
 */
function cloneOperator (ref, log) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-flags-'))
  const auth = token()
  const url = auth ? `https://x-access-token:${auth}@github.com/${REPO}.git` : `https://github.com/${REPO}.git`
  log(`Cloning ${REPO}@${ref}...`)
  const clone = run('git', ['clone', '--quiet', '--depth', '1', '--branch', ref, url, dir], { stdio: ['ignore', 'pipe', 'pipe'] })
  if (clone.status !== 0) {
    fs.rmSync(dir, { recursive: true, force: true })
    const why = String(clone.stderr || '').replace(auth || '\u0000', '***').trim()
    throw new Error(`could not clone ${REPO}@${ref}${auth ? '' : ' (no GitHub token set; the repository is private)'}: ${why}`)
  }
  return dir
}

/**
 * Run the flag dump inside an operator checkout (the repository root, which
 * holds operator/go.mod). Returns {command, flags, global_flags}.
 */
function dumpFlags (checkout, { version, log = () => {} } = {}) {
  const moduleDir = path.join(checkout, 'operator')
  if (!fs.existsSync(path.join(moduleDir, 'go.mod'))) throw new Error(`${checkout} has no operator/go.mod; pass the root of a redpanda-operator checkout`)
  const pkgDir = path.join(moduleDir, DUMP_PACKAGE)
  if (fs.existsSync(pkgDir)) throw new Error(`${pkgDir} already exists; remove it and run again`)
  fs.mkdirSync(pkgDir, { recursive: true })
  try {
    fs.copyFileSync(path.join(__dirname, 'flagdump.go.tmpl'), path.join(pkgDir, 'main.go'))
    const args = ['run']
    if (version) args.push('-ldflags', `-X ${VERSION_SYMBOL}=${version}`)
    args.push(`./${DUMP_PACKAGE}`)
    log(`Building redpanda-operator run${version ? ` (${version})` : ''} to read its flags; the first build takes a few minutes...`)
    const result = run('go', args, {
      cwd: moduleDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      // The operator binary links two copies of one proto file; its release
      // build tolerates the clash the same way.
      env: { ...process.env, GOLANG_PROTOBUF_REGISTRATION_CONFLICT: 'warn' },
    })
    if (result.status !== 0) {
      const tail = String(result.stderr || '').trim().split('\n').slice(-15).join('\n')
      throw new Error(`go run failed (exit ${result.status}). This release may predate the flag layout the dump expects (run.Command() in operator/cmd/run).\n${tail}`)
    }
    const data = JSON.parse(result.stdout)
    if (!Array.isArray(data.flags) || !data.flags.length) throw new Error('the flag dump printed no flags')
    return data
  } finally {
    fs.rmSync(pkgDir, { recursive: true, force: true })
  }
}

function headCommit (checkout) {
  const rev = run('git', ['-C', checkout, 'rev-parse', 'HEAD'])
  return rev.status === 0 ? rev.stdout.trim() : undefined
}

/**
 * Build the published data from a dump.
 */
function buildData (dump, { version, ref, commit, now = new Date() }) {
  const clean = (flag) => {
    const out = { name: flag.name, type: flag.type, default: flag.default, usage: flag.usage }
    if (flag.shorthand) out.shorthand = flag.shorthand
    if (flag.deprecated) out.deprecated = flag.deprecated
    if (flag.hidden) out.hidden = true
    return out
  }
  return {
    schema: 1,
    operator_version: version,
    generated_at: now.toISOString(),
    source: { repo: REPO, ref, ...(commit ? { commit } : {}) },
    command: dump.command || 'run',
    flags: dump.flags.map(clean).sort((a, b) => a.name.localeCompare(b.name)),
    global_flags: (dump.global_flags || []).map(clean).sort((a, b) => a.name.localeCompare(b.name)),
  }
}

/**
 * @param {object} opts
 * @param {string} [opts.tag] - Operator release tag (operator/v26.2.5 or v26.2.5).
 * @param {string} [opts.branch] - A branch, with opts.version naming the output.
 * @param {string} [opts.version] - The version the output is for (required with a branch).
 * @param {string} [opts.sourceDir] - An existing operator checkout instead of a clone.
 * @param {string} [opts.docsDir] - The docs checkout to write into (default: cwd).
 * @param {boolean} [opts.dataOnly] - Write the JSON only, not the page.
 * @param {function} [opts.log]
 * @returns {{version, dataPath, pagePath?, flags: number, deprecated: number}}
 */
function generateOperatorFlags (opts = {}) {
  const log = opts.log || ((message) => console.log(message))
  if (!opts.tag && !opts.branch && !opts.sourceDir) throw new Error('pass --tag, --branch or --source-dir')
  if (opts.tag && opts.branch) throw new Error('pass --tag or --branch, not both')
  const ref = opts.tag ? (opts.tag.startsWith('operator/') ? opts.tag : `operator/${opts.tag}`) : opts.branch
  const version = opts.version || versionOfRef(ref)
  if (!version) throw new Error(`cannot tell the operator version from '${ref || opts.sourceDir}'; pass --version v<major>.<minor>.<patch>`)
  if (!versionOfRef(version)) throw new Error(`--version ${version} is not an operator version such as v26.2.5`)

  const docsDir = path.resolve(opts.docsDir || process.cwd())
  const checkout = opts.sourceDir ? path.resolve(opts.sourceDir) : cloneOperator(ref, log)
  try {
    const dump = dumpFlags(checkout, { version, log })
    const data = buildData(dump, { version, ref: ref || 'local checkout', commit: headCommit(checkout) })
    const attachments = path.join(docsDir, 'modules', PAGE_MODULE, 'attachments')
    fs.mkdirSync(attachments, { recursive: true })
    const dataPath = path.join(attachments, `operator-flags-${version}.json`)
    // An older snapshot of the same series is replaced: a page reads only its
    // own series, and two files of one series would leave the pick to
    // precedence rules a reader cannot see in the diff.
    const series = version.match(/^v(\d+\.\d+)\./)[1]
    for (const name of fs.readdirSync(attachments)) {
      const match = name.match(/^operator-flags-v(\d+\.\d+)\.\d+.*\.json$/)
      if (match && match[1] === series && name !== path.basename(dataPath)) {
        fs.rmSync(path.join(attachments, name))
        log(`Removed ${name}, an older snapshot of the ${series} series.`)
      }
    }
    fs.writeFileSync(dataPath, JSON.stringify(data, null, 2) + '\n')
    log(`Wrote ${path.relative(docsDir, dataPath)} (${data.flags.length} flags, ${data.global_flags.length} logging flags).`)
    let pagePath
    if (!opts.dataOnly) {
      pagePath = path.join(docsDir, 'modules', PAGE_MODULE, 'pages', PAGE_RELATIVE)
      fs.mkdirSync(path.dirname(pagePath), { recursive: true })
      fs.writeFileSync(pagePath, renderPage(data))
      log(`Wrote ${path.relative(docsDir, pagePath)}.`)
    }
    return { version, dataPath, pagePath, flags: data.flags.length, deprecated: data.flags.filter((flag) => flag.deprecated).length }
  } finally {
    if (!opts.sourceDir) fs.rmSync(checkout, { recursive: true, force: true })
  }
}

module.exports = { generateOperatorFlags, dumpFlags, buildData, versionOfRef, REPO }

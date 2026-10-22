'use strict'

/**
 * Reads the two halves of a repository_dispatch edge out of GitHub Actions
 * workflow files: the listeners (`on.repository_dispatch.types`) and the
 * senders (anything that POSTs to /repos/{owner}/{repo}/dispatches).
 *
 * Senders come in several shapes across the Redpanda org, and the check has
 * to see every one of them or a live edge gets reported as a listener with no
 * sender. The shapes supported, each with a fixture in
 * __tests__/tools/dispatch-graph/fixtures/, are:
 *
 *   - `uses: peter-evans/repository-dispatch@vN` with `with.repository` and
 *     `with.event-type` (streaming-enterprise, helm-charts, the operator).
 *     `repository` may be `${{ matrix.repo }}` over a literal matrix
 *     (docs-extensions-and-macros publish-to-npm), or `${{ env.X }}` with X
 *     set at workflow, job or step level.
 *   - `gh api repos/o/r/dispatches -f event_type=x` in a run block, one line
 *     or backslash-continued (connect, cloudv2, docs). Payload fields given as
 *     `-f 'client_payload[plugin]=ai'` are read too.
 *   - `jq -n ... '{event_type: "x", ...}' | gh api "repos/$VAR/dispatches"
 *     --input -` (doc-strings-review). The repo comes from the env chain, the
 *     event type from the only event_type literal in the same run block.
 *   - `curl ... https://api.github.com/repos/o/r/dispatches` with a JSON body
 *     carrying `"event_type": "x"`.
 *   - `github.rest.repos.createDispatchEvent({owner, repo, event_type})` in
 *     an actions/github-script step.
 *
 * Shell comment lines are stripped from run blocks first, and YAML comments
 * never reach the parsed tree, so a dispatch that is only mentioned in a
 * comment is not a sender. An event type or target that cannot be resolved
 * from the same file (`${{ inputs.x }}`, `${{ secrets.x }}`, a value computed
 * in an earlier step) is returned with `unresolved` set and the raw text kept,
 * so the report can say "could not tell" rather than drop it.
 */

const yaml = require('js-yaml')

const PETER_EVANS_RE = /^peter-evans\/repository-dispatch(?:@|$)/
const EXPR_RE = /\$\{\{\s*([^}]*?)\s*\}\}/g
const EVENT_TYPE_CHARS = '[A-Za-z0-9_.:-]+'

/**
 * `on` is a YAML 1.1 boolean, so some parsers hand it back as the key `true`.
 * js-yaml 4 keeps it as a string, but accept both so a schema change cannot
 * silently make every workflow look trigger-less.
 */
function triggersOf (doc) {
  if (!doc || typeof doc !== 'object') return null
  if (doc.on !== undefined) return doc.on
  if (doc[true] !== undefined) return doc[true]
  return null
}

function toArray (v) {
  if (v === undefined || v === null) return []
  return Array.isArray(v) ? v : [v]
}

function loadWorkflow (text) {
  const doc = yaml.load(text)
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error('not a workflow document (top level is not a mapping)')
  }
  return doc
}

/**
 * @typedef {object} Listener
 * @property {string} repo - owner/name
 * @property {string} file - workflow file name
 * @property {string} workflowName
 * @property {string|null} eventType - null when the workflow listens for ANY repository_dispatch
 * @property {boolean} cronBackstop - true when `on.schedule` is also set
 * @property {Object<string, string[]>} choiceInputs - workflow_dispatch inputs of type choice, with their options
 */

/**
 * Listeners declared by one workflow file. Empty when the file has no
 * repository_dispatch trigger.
 *
 * @param {string} text
 * @param {{repo: string, file: string}} where
 * @returns {Listener[]}
 */
function parseListeners (text, where) {
  const doc = loadWorkflow(text)
  const on = triggersOf(doc)
  if (on === null) return []

  let types = null
  let cronBackstop = false
  let choiceInputs = {}

  if (typeof on === 'string') {
    if (on === 'repository_dispatch') types = []
  } else if (Array.isArray(on)) {
    if (on.includes('repository_dispatch')) types = []
    cronBackstop = on.includes('schedule')
  } else if (typeof on === 'object') {
    if (Object.prototype.hasOwnProperty.call(on, 'repository_dispatch')) {
      const rd = on.repository_dispatch
      types = rd && typeof rd === 'object' ? toArray(rd.types).map(String) : []
    }
    cronBackstop = Object.prototype.hasOwnProperty.call(on, 'schedule')
    const inputs = on.workflow_dispatch && on.workflow_dispatch.inputs
    if (inputs && typeof inputs === 'object') {
      for (const [name, spec] of Object.entries(inputs)) {
        if (spec && spec.type === 'choice' && Array.isArray(spec.options)) {
          choiceInputs[name] = spec.options.map(String)
        }
      }
    }
  }

  if (types === null) return []

  const base = {
    repo: where.repo,
    file: where.file,
    workflowName: typeof doc.name === 'string' ? doc.name : where.file,
    cronBackstop,
    choiceInputs,
  }
  if (types.length === 0) return [{ ...base, eventType: null }]
  return types.map((t) => ({ ...base, eventType: t }))
}

/**
 * @typedef {object} Sender
 * @property {string} repo - owner/name of the repo whose workflow sends
 * @property {string} file
 * @property {string} workflowName
 * @property {string[]} triggers - top-level event names the sender fires on (release, push, ...)
 * @property {string|null} targetRepo - owner/name, or null when unresolved
 * @property {string|null} eventType - or null when unresolved
 * @property {boolean} unresolved
 * @property {string} form - which syntax it was found in
 * @property {string} [raw] - the unresolved text, for the report
 * @property {Object<string, string>} payload - literal client_payload values found beside the dispatch
 * @property {string} [stepName]
 */

/** Trigger names a workflow runs on, for the never-fired hint. */
function triggerNames (on) {
  if (typeof on === 'string') return [on]
  if (Array.isArray(on)) return on.map(String)
  if (on && typeof on === 'object') return Object.keys(on)
  return []
}

/** Literal defaults of workflow_call and workflow_dispatch inputs. */
function inputDefaults (on) {
  const out = {}
  if (!on || typeof on !== 'object' || Array.isArray(on)) return out
  for (const trigger of ['workflow_call', 'workflow_dispatch']) {
    const inputs = on[trigger] && on[trigger].inputs
    if (!inputs || typeof inputs !== 'object') continue
    for (const [name, spec] of Object.entries(inputs)) {
      if (spec && (typeof spec.default === 'string' || typeof spec.default === 'number')) {
        out[name] = String(spec.default)
      }
    }
  }
  return out
}

/** Flatten a strategy.matrix into { key: [literal values] }. */
function matrixValues (strategy) {
  const out = {}
  const matrix = strategy && strategy.matrix
  if (!matrix || typeof matrix !== 'object') return out
  for (const [k, v] of Object.entries(matrix)) {
    if (k === 'include' || k === 'exclude') continue
    if (Array.isArray(v)) out[k] = v.filter((x) => typeof x === 'string' || typeof x === 'number').map(String)
  }
  for (const inc of toArray(matrix.include)) {
    if (!inc || typeof inc !== 'object') continue
    for (const [k, v] of Object.entries(inc)) {
      if (typeof v !== 'string' && typeof v !== 'number') continue
      out[k] = out[k] || []
      if (!out[k].includes(String(v))) out[k].push(String(v))
    }
  }
  return out
}

function envChain (...levels) {
  const out = {}
  for (const lvl of levels) {
    if (lvl && typeof lvl === 'object') {
      for (const [k, v] of Object.entries(lvl)) {
        if (typeof v === 'string' || typeof v === 'number') out[k] = String(v)
      }
    }
  }
  return out
}

/**
 * Resolve a value that may carry `${{ }}` expressions or shell `$VAR`s.
 * Returns an array of candidate literals: one entry normally, several when a
 * matrix expands, empty when something could not be resolved.
 *
 * Only the forms a file can answer by itself are resolved: env.X from the env
 * chain, matrix.X from a literal matrix, github.repository as the sender's
 * own repo. Anything else (inputs, secrets, vars, step outputs) is unresolved.
 */
function resolveValue (value, ctx) {
  if (value === undefined || value === null) return []
  let text = String(value).trim()
  if (text === '') return []

  // Shell-style references inside run blocks: $X, ${X}. An env value can
  // itself be an expression (DISPATCH_REPO: ${{ inputs.dispatch_repo }}), so
  // the expression pass below runs on the substituted text.
  text = text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, a, b) => {
    const name = a || b
    if (name === 'GITHUB_REPOSITORY') return ctx.selfRepo
    return ctx.env[name] !== undefined ? ctx.env[name] : m
  })

  const variants = [text]
  let unresolved = false
  // Expand expressions; matrix refs fan out.
  const expanded = []
  for (const variant of variants) {
    let results = [variant]
    const exprs = [...variant.matchAll(EXPR_RE)]
    for (const m of exprs) {
      const expr = m[1]
      let replacements = null
      let em
      if ((em = expr.match(/^env\.([A-Za-z_][A-Za-z0-9_]*)$/))) {
        if (ctx.env[em[1]] !== undefined) replacements = [ctx.env[em[1]]]
      } else if ((em = expr.match(/^matrix\.([A-Za-z_][A-Za-z0-9_-]*)$/))) {
        if (ctx.matrix[em[1]] && ctx.matrix[em[1]].length) replacements = ctx.matrix[em[1]]
      } else if (expr === 'github.repository') {
        replacements = [ctx.selfRepo]
      } else if ((em = expr.match(/^inputs\.([A-Za-z_][A-Za-z0-9_-]*)$/))) {
        // A workflow_call/workflow_dispatch input with a literal default is
        // what runs unless a caller overrides it, so the default is the edge.
        if (ctx.inputDefaults[em[1]] !== undefined) replacements = [ctx.inputDefaults[em[1]]]
      }
      if (!replacements) { unresolved = true; break }
      const next = []
      for (const r of results) for (const rep of replacements) next.push(r.replace(m[0], rep))
      results = next
    }
    if (!unresolved) expanded.push(...results)
  }
  if (unresolved) return []
  // Anything still carrying a $ was a variable this file does not define.
  return expanded.filter((s) => !/\$/.test(s)).map((s) => s.replace(/^["']|["']$/g, ''))
}

/** owner/name, or null when the text is not a plain repo slug. */
function normalizeRepo (slug) {
  if (!slug) return null
  const m = String(slug).trim().replace(/^https?:\/\/(api\.)?github\.com\/(repos\/)?/, '').match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/)
  return m ? `${m[1]}/${m[2]}` : null
}

/** Literal `"key": "value"` pairs from a JSON-ish payload string. */
function literalPayloadPairs (text) {
  const out = {}
  if (!text) return out
  for (const m of String(text).matchAll(/["']?([A-Za-z_][A-Za-z0-9_]*)["']?\s*:\s*(["'])([^"'$]*)\2/g)) {
    if (m[1] === 'event_type' || m[1] === 'client_payload') continue
    out[m[1]] = m[3]
  }
  return out
}

/** Join backslash-continued lines and drop shell comment lines. */
function shellLogicalLines (run) {
  const lines = []
  let buf = null
  for (const raw of String(run).split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (buf === null && /^\s*#/.test(line)) continue
    if (buf === null) buf = line
    else buf += ' ' + line.trim()
    if (/\\\s*$/.test(buf)) { buf = buf.replace(/\s*\\\s*$/, ''); continue }
    lines.push(buf)
    buf = null
  }
  if (buf !== null) lines.push(buf)
  return lines
}

// The repo part may be one shell variable (`repos/$DISPATCH_REPO/dispatches`)
// or two literal segments, so it is captured whole and resolved afterwards.
const DISPATCH_PATH_RE = /(?:https?:\/\/api\.github\.com\/)?\/?repos\/([^\s"']+?)\/dispatches\b/
const EVENT_TYPE_FLAG_RE = new RegExp(`(?:-f|-F|--field|--raw-field)[= ]+["']?event_type=["']?(${EVENT_TYPE_CHARS})`)
const EVENT_TYPE_JSON_RE = new RegExp(`["']?event_type["']?\\s*[:=]\\s*["'](${EVENT_TYPE_CHARS})["']`, 'g')
const PAYLOAD_FLAG_RE = /(?:-f|-F|--field|--raw-field)[= ]+["']?client_payload\[([A-Za-z_][A-Za-z0-9_]*)\]=["']?([^"'\s$]+)/g

function sendersFromRun (run, ctx, step) {
  const senders = []
  const cleaned = shellLogicalLines(run)
  const block = cleaned.join('\n')
  // Event types stated anywhere in the (comment-stripped) block, for the
  // piped --input form where the type is not on the gh api line.
  const blockTypes = [...new Set([...block.matchAll(EVENT_TYPE_JSON_RE)].map((m) => m[1]))]
  const blockPayload = literalPayloadPairs(block)

  for (const line of cleaned) {
    const pm = line.match(DISPATCH_PATH_RE)
    if (!pm) continue
    const repos = resolveValue(pm[1], ctx).map(normalizeRepo).filter(Boolean)

    let eventTypes = []
    const fm = line.match(EVENT_TYPE_FLAG_RE)
    if (fm) eventTypes = [fm[1]]
    else {
      const inline = [...line.matchAll(EVENT_TYPE_JSON_RE)].map((m) => m[1])
      if (inline.length) eventTypes = [...new Set(inline)]
      else if (blockTypes.length === 1) eventTypes = blockTypes
    }

    const payload = { ...blockPayload }
    for (const m of line.matchAll(PAYLOAD_FLAG_RE)) payload[m[1]] = m[2]

    const form = /curl/.test(line) ? 'curl' : 'gh-api'
    if (repos.length === 0 || eventTypes.length === 0) {
      senders.push(ctx.make({
        targetRepo: repos[0] || null,
        eventType: eventTypes[0] || null,
        unresolved: true,
        raw: line.trim(),
        form,
        payload,
        stepName: step && step.name,
      }))
      continue
    }
    for (const r of repos) {
      for (const t of eventTypes) {
        senders.push(ctx.make({ targetRepo: r, eventType: t, unresolved: false, form, payload, stepName: step && step.name }))
      }
    }
  }
  return senders
}

const GITHUB_SCRIPT_DISPATCH_RE = /createDispatchEvent\s*\(\s*\{([\s\S]*?)\}\s*\)/g

function sendersFromGithubScript (script, ctx, step) {
  const senders = []
  const stripped = String(script).split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n')
  for (const m of stripped.matchAll(GITHUB_SCRIPT_DISPATCH_RE)) {
    const body = m[1]
    const lit = (key) => {
      const r = body.match(new RegExp(`\\b${key}\\s*:\\s*["'\`]([^"'\`$]+)["'\`]`))
      return r ? r[1] : null
    }
    const owner = lit('owner')
    const repo = lit('repo')
    const eventType = lit('event_type')
    const selfOwner = /\bowner\s*:\s*context\.repo\.owner\b/.test(body)
    const selfRepo = /\brepo\s*:\s*context\.repo\.repo\b/.test(body)
    let target = null
    if (owner && repo) target = `${owner}/${repo}`
    else if (selfOwner && repo) target = `${ctx.selfRepo.split('/')[0]}/${repo}`
    else if (selfOwner && selfRepo) target = ctx.selfRepo
    senders.push(ctx.make({
      targetRepo: target,
      eventType,
      unresolved: !(target && eventType),
      raw: target && eventType ? undefined : body.trim().replace(/\s+/g, ' ').slice(0, 160),
      form: 'github-script',
      payload: Object.fromEntries(Object.entries(literalPayloadPairs(body)).filter(([k]) => !['owner', 'repo'].includes(k))),
      stepName: step && step.name,
    }))
  }
  return senders
}

/**
 * Senders declared by one workflow file.
 *
 * @param {string} text
 * @param {{repo: string, file: string}} where
 * @returns {Sender[]}
 */
function parseSenders (text, where) {
  const doc = loadWorkflow(text)
  const on = triggersOf(doc)
  const triggers = triggerNames(on)
  const workflowName = typeof doc.name === 'string' ? doc.name : where.file
  const senders = []
  const jobs = doc.jobs && typeof doc.jobs === 'object' ? doc.jobs : {}
  const defaults = inputDefaults(on)

  for (const job of Object.values(jobs)) {
    if (!job || typeof job !== 'object') continue
    const matrix = matrixValues(job.strategy)
    for (const step of toArray(job.steps)) {
      if (!step || typeof step !== 'object') continue
      const env = envChain(doc.env, job.env, step.env)
      const ctx = {
        env,
        matrix,
        inputDefaults: defaults,
        selfRepo: where.repo,
        make: (fields) => ({
          repo: where.repo,
          file: where.file,
          workflowName,
          triggers,
          payload: {},
          ...fields,
        }),
      }

      if (typeof step.uses === 'string' && PETER_EVANS_RE.test(step.uses.trim())) {
        const w = step.with && typeof step.with === 'object' ? step.with : {}
        // peter-evans defaults `repository` to the workflow's own repo.
        const repoCandidates = w.repository === undefined ? [where.repo] : resolveValue(w.repository, ctx).map(normalizeRepo).filter(Boolean)
        const typeCandidates = resolveValue(w['event-type'], ctx)
        const payload = literalPayloadPairs(w['client-payload'])
        if (repoCandidates.length === 0 || typeCandidates.length === 0) {
          senders.push(ctx.make({
            targetRepo: repoCandidates[0] || null,
            eventType: typeCandidates[0] || null,
            unresolved: true,
            raw: `repository: ${w.repository === undefined ? '(default)' : w.repository}, event-type: ${w['event-type']}`,
            form: 'peter-evans',
            payload,
            stepName: step.name,
          }))
          continue
        }
        for (const r of repoCandidates) {
          for (const t of typeCandidates) {
            senders.push(ctx.make({ targetRepo: r, eventType: t, unresolved: false, form: 'peter-evans', payload, stepName: step.name }))
          }
        }
        continue
      }

      if (typeof step.run === 'string' && /\/dispatches\b/.test(step.run)) {
        senders.push(...sendersFromRun(step.run, ctx, step))
      }

      if (typeof step.uses === 'string' && /^actions\/github-script(?:@|$)/.test(step.uses.trim()) &&
          step.with && typeof step.with.script === 'string' && /createDispatchEvent/.test(step.with.script)) {
        senders.push(...sendersFromGithubScript(step.with.script, ctx, step))
      }
    }
  }
  return senders
}

module.exports = {
  parseListeners,
  parseSenders,
  resolveValue,
  normalizeRepo,
  shellLogicalLines,
  literalPayloadPairs,
  triggersOf,
}

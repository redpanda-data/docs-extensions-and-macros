'use strict'

/**
 * Turns a workflow's recent run list (GET /repos/{r}/actions/workflows/{file}/runs)
 * into the few numbers the dispatch-graph report needs, and says whether they
 * amount to a finding.
 *
 * The run list is the only place a broken receiver shows up. A dispatch is
 * accepted with 204 whether or not anyone listens, and a receiver that fails
 * every time looks, from the sender's side, exactly like one that works every
 * time. So "48 of 48 failed at Commit changes" is invisible until something
 * reads the receiver's runs, which is what this does.
 */

const FAILURE_CONCLUSIONS = new Set(['failure', 'timed_out', 'startup_failure', 'action_required'])
// Not counted either way: the run did not get as far as doing the work.
const NEUTRAL_CONCLUSIONS = new Set(['skipped', 'cancelled', 'neutral', 'stale'])

/**
 * @typedef {object} RunSummary
 * @property {number} total - runs the API returned (capped by per_page)
 * @property {Object<string, number>} byConclusion
 * @property {string|null} lastRunAt - ISO date of the newest run
 * @property {string|null} lastConclusion
 * @property {string|null} lastRunUrl
 * @property {number} dispatchRuns - runs whose event was repository_dispatch
 * @property {string|null} lastDispatchRunAt
 * @property {{size: number, failures: number, successes: number, considered: number, failRate: number|null}} window
 */

/**
 * @param {Array<object>} runs - workflow_runs from the API, newest first
 * @param {{window?: number}} [opts] - how many of the newest runs the fail rate is computed over (default 20)
 * @returns {RunSummary}
 */
function summarizeRuns (runs, opts = {}) {
  const windowSize = opts.window || 20
  const list = Array.isArray(runs) ? runs.slice() : []
  // The API returns newest first; sort defensively in case a stub does not.
  list.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))

  const byConclusion = {}
  let dispatchRuns = 0
  let lastDispatchRunAt = null
  for (const r of list) {
    const c = r.conclusion || (r.status === 'completed' ? 'unknown' : (r.status || 'in_progress'))
    byConclusion[c] = (byConclusion[c] || 0) + 1
    if (r.event === 'repository_dispatch') {
      dispatchRuns += 1
      if (!lastDispatchRunAt) lastDispatchRunAt = r.created_at || null
    }
  }

  const recent = list.slice(0, windowSize)
  let failures = 0
  let successes = 0
  let considered = 0
  for (const r of recent) {
    if (!r.conclusion || NEUTRAL_CONCLUSIONS.has(r.conclusion)) continue
    considered += 1
    if (FAILURE_CONCLUSIONS.has(r.conclusion)) failures += 1
    else if (r.conclusion === 'success') successes += 1
  }

  const newest = list[0] || null
  return {
    total: list.length,
    byConclusion,
    lastRunAt: newest ? newest.created_at || null : null,
    lastConclusion: newest ? newest.conclusion || newest.status || null : null,
    lastRunUrl: newest ? newest.html_url || null : null,
    dispatchRuns,
    lastDispatchRunAt,
    window: {
      size: recent.length,
      failures,
      successes,
      considered,
      failRate: considered ? failures / considered : null,
    },
  }
}

/**
 * Is a receiver's run record a finding?
 *
 * @param {RunSummary} summary
 * @param {{threshold?: number}} [opts] - fail rate above which the receiver is flagged (default 0.5, strictly greater)
 * @returns {{status: 'healthy'|'failing'|'never-ran'|'no-dispatch-runs'|'quiet', failRate: number|null}}
 *   failing:          more than `threshold` of the considered runs in the window failed
 *   never-ran:        the workflow has no runs at all
 *   no-dispatch-runs: it has run, but never from a repository_dispatch (manual or cron only)
 *   quiet:            runs exist but none in the window reached a conclusion to judge
 */
function classifyReceiver (summary, opts = {}) {
  const threshold = opts.threshold === undefined ? 0.5 : opts.threshold
  if (!summary || summary.total === 0) return { status: 'never-ran', failRate: null }
  const { failRate } = summary.window
  if (failRate !== null && failRate > threshold) return { status: 'failing', failRate }
  if (summary.dispatchRuns === 0) return { status: 'no-dispatch-runs', failRate }
  if (failRate === null) return { status: 'quiet', failRate }
  return { status: 'healthy', failRate }
}

/**
 * Is a sender's run record a finding? A sender that has never run has never
 * dispatched, whatever its workflow file says.
 *
 * @param {RunSummary} summary
 * @returns {{status: 'fired'|'never-fired'}}
 */
function classifySender (summary) {
  if (!summary || summary.total === 0) return { status: 'never-fired' }
  return { status: 'fired' }
}

function formatRate (rate) {
  return rate === null || rate === undefined ? '-' : `${Math.round(rate * 100)}%`
}

module.exports = {
  summarizeRuns,
  classifyReceiver,
  classifySender,
  formatRate,
  FAILURE_CONCLUSIONS,
  NEUTRAL_CONCLUSIONS,
}

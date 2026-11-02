#!/usr/bin/env node
'use strict';
/*
 * mine-candidates.js
 *
 * Mines candidate items for the doc-impact benchmark: engineering PRs where
 * the doc-strings-review workflow ran, joined to DOC Jira tickets and to docs
 * and cloud-docs PRs that reference them, with a proposed label per PR.
 *
 * Requirements: node 18+ and an authenticated `gh` on PATH whose token can
 * read redpanda-data/streaming-enterprise, redpanda-data/redpanda-operator,
 * redpanda-data/docs and redpanda-data/cloud-docs (Actions runs, job logs,
 * PRs, and the search API).
 *
 * Jira input. This script cannot call the Atlassian MCP server, so you export
 * the DOC tickets yourself and pass the file with --jira. Run this JQL through
 * the Atlassian MCP tool searchJiraIssuesUsingJql (fields: summary,
 * description, status, labels, resolution, created, updated, issuelinks,
 * comment; responseContentFormat: markdown), with the created date set to a
 * few days before the first doc-strings-review run:
 *
 *   project = DOC AND (labels = auto-doc-impact
 *     OR text ~ "streaming-enterprise" OR text ~ "redpanda-operator/pull"
 *     OR text ~ "redpanda-data/redpanda/pull") AND created >= 2026-08-25
 *
 * Then normalize the saved result with jq into the shape this script reads:
 *
 *   jq '[.issues.nodes[] | {key, summary: .fields.summary,
 *        status: .fields.status.name,
 *        resolution: (.fields.resolution.name // null),
 *        labels: .fields.labels, created: .fields.created,
 *        description: (.fields.description // ""),
 *        comments: [(.fields.comment.comments // [])[] | {created, body}],
 *        issuelinks: [(.fields.issuelinks // [])[] |
 *          {type: .type.name, key: (.outwardIssue.key // .inwardIssue.key)}]}]' \
 *     mcp-result.json > jira-export.json
 *
 * A ticket joins to an engineering PR when its description or a comment
 * contains that PR's URL.
 *
 * Usage (from the repository root; keep --out outside the repository, the
 * cache and the writer sheet are not committed):
 *   node evals/doc-strings/doc-impact/mine-candidates.js \
 *     --jira jira-export.json --out <dir>
 *     [--cache <dir>] [--cache-hours 12] [--settle-days 14] [--provisional]
 *     [--no-search]
 *
 * Seeding the eval items from a mine (no network):
 *   node evals/doc-strings/doc-impact/mine-candidates.js \
 *     --to-items <dir>/candidates.json \
 *     --items-out evals/doc-strings/doc-impact/items.json \
 *     --private-out <private-dir>/items.json
 *
 * --to-items converts candidates into the item shape run.js reads. An item
 * already in --items-out with a confirmed_by value is kept as the writer
 * left it; every other item is replaced from the candidates. Items from a
 * private repository (GitHub is asked) go to --private-out instead, which
 * must live outside any public repository: this repository is public, and
 * an item carries the PR's title and description, and its frozen diff the
 * source. Freeze the inputs afterwards with `run-evals.js --doc-impact
 * --refresh-diffs --include-unconfirmed [--items <private-dir>/items.json]`.
 *
 * Time-correct recordings from production (no Jira, no cache):
 *   node evals/doc-strings/doc-impact/mine-candidates.js \
 *     --from-production evals/doc-strings/doc-impact/items.json \
 *     [--recordings <dir>]
 *
 * --from-production replaces an item's recording with the docs MCP answers
 * the production review got when it reviewed the item's reviewed_head_sha.
 * The review uploads them as the workflow artifact
 * doc-impact-mcp-<pr>-<run attempt>; this finds the newest run on that head
 * that has one, downloads it with gh, and writes it as
 * <recordings>/<id>.json (default: recordings/ beside the items file, so a
 * private item's recording stays beside its private items file) with
 * source "production" and the recorded_at the run wrote. Items with no
 * reviewed_head_sha, no run on it, or no artifact (runs older than the
 * artifact step, or past its retention) keep the recording they have. The
 * report lists both.
 *
 * Outputs in --out:
 *   candidates.json  every item, with the frozen inputs (base, merge-base and
 *                    head SHAs, title, body) and the evidence behind its label
 *   candidates.csv   the writer sheet: the proposed label plus empty columns
 *                    for the writer's label, pages, reason, and a second
 *                    writer's label
 *   excluded.json    PRs where the review ran but no item was proposed, with
 *                    the reason, so you can audit what was left out
 *
 * API responses are cached in --cache (default: <out>/cache) for
 * --cache-hours (default 12), so a rerun the same day is cheap but a mine a
 * day later sees new runs, merges and docs PRs. A verdict read from a job
 * log is kept for good because a finished job's log never changes; a log
 * that could not be fetched is asked for again on the next mine. Delete
 * the cache to re-mine from scratch.
 *
 * Labels, from the dataset table in the plan:
 *   needs_docs / strong  a merged docs or cloud-docs PR that references the
 *                        engineering PR (directly, or through its DOC ticket)
 *                        edited a non-generated file; or an auto-doc-impact
 *                        ticket whose description names it is In Review or
 *                        Done
 *   needs_docs / medium  as strong, but the docs PR is still open
 *   needs_docs / pending an auto-doc-impact ticket exists but is untriaged
 *                        (To Do), or the PR was only appended to another
 *                        PR's ticket. The pass itself raised it, so it is
 *                        not ground truth until a writer accepts it
 *   no_change / strong   a ticket whose description names the merged PR
 *                        closed Will not implement; the closing comment is
 *                        the rationale
 *   needs_docs / weak    such a ticket closed Will not implement only because
 *                        the PR never merged: the finding was right for the
 *                        diff
 *   no_change / weak     the review ran and touched declarations, the PR
 *                        merged at least --settle-days ago, and no DOC ticket
 *                        or docs PR references it
 *   no_change / medium   a merged docs PR references it but changed only
 *                        generated, override or release-note files
 *   no_change / provisional  with --provisional: as weak, but the PR merged
 *                        under --settle-days ago or is unmerged. Useful to
 *                        reach a target size early; writers must confirm
 *
 * "Within one release" is approximated by --settle-days: the repos ship
 * feature releases months apart, so waiting for the next release would leave
 * nothing to label. Writers confirm every weak label.
 *
 * Generated files are learned, not listed: any path changed by a bot-authored
 * docs or cloud-docs PR (auto-docs regen, rpk renders, property syncs) in the
 * lookback window counts as generated, plus a few fixed patterns. Override
 * JSON (docs-data/), release notes, and nav files are treated the same way:
 * release notes list every PR in a release, and none of these is a page a
 * writer rewrote because of the PR. A docs PR that edits only these files
 * does not count as needs_docs evidence.
 *
 * Page URLs come from each docs repo's antora.yml: the component name, plus
 * "current" when the component is versioned. Partials are reported as
 * partial:<repo>:<path> because the pages that include them are not
 * resolved here.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { limitRefusals } = require('./lib');

// ---------- args ----------
function parseArgs(argv) {
  const a = { settleDays: 14, search: true, lookbackDays: 150, provisional: false, cacheHours: 12 };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const v = () => argv[++i];
    if (k === '--jira') a.jira = v();
    else if (k === '--out') a.out = v();
    else if (k === '--cache') a.cache = v();
    else if (k === '--settle-days') a.settleDays = Number(v());
    else if (k === '--lookback-days') a.lookbackDays = Number(v());
    else if (k === '--no-search') a.search = false;
    else if (k === '--provisional') a.provisional = true;
    else if (k === '--cache-hours') a.cacheHours = Number(v());
    else if (k === '--to-items') a.toItems = v();
    else if (k === '--items-out') a.itemsOut = v();
    else if (k === '--private-out') a.privateOut = v();
    else if (k === '--from-production') a.fromProduction = v();
    else if (k === '--recordings') a.recordings = v();
    else if (k === '-h' || k === '--help') { a.help = true; }
    else { throw new Error(`unknown argument: ${k}`); }
  }
  return a;
}

const ORG = 'redpanda-data';
const ENG_REPOS = ['streaming-enterprise', 'redpanda-operator'];
const DOCS_REPOS = ['docs', 'cloud-docs'];
const WORKFLOW = 'doc-strings-review.yml';
// Steps that run only when lint-strings reported declarations or removals.
const GATED_STEPS = [/^Save the source diff/, /^Claude review/, /^Dispatch doc-impact/];
const GENERATED_PATTERNS = [
  /modules\/reference\/partials\/properties\//,
  /modules\/reference\/(pages|partials)\/rpk[^/]*\//,
  /modules\/reference\/(pages|partials)\/.*metrics/,
  /modules\/reference\/(pages|partials)\/k-.*(helm|crd)/,
  /modules\/reference\/attachments\//,
  /\/attachments\/.*\.(json|ya?ml)$/,
  /(^|\/)package(-lock)?\.json$/,
  /^docs-data\//,
  // Not generated, but not evidence either: release notes list every PR in
  // a release, and a nav entry alone changes no page content.
  /modules\/[^/]+\/pages\/releases?\//,
  /release-notes/,
  /(^|\/)nav\.adoc$/,
];
const BOT_AUTHORS = /(\[bot\]$|^app\/|^vbotbuildovich$|^github-actions)/;

// ---------- gh helpers with cache and retry ----------
let CACHE_DIR;
let CACHE_MAX_AGE_MS = 12 * 3600000;
function cacheFile(key) {
  return path.join(CACHE_DIR, crypto.createHash('sha1').update(key).digest('hex') + '.json');
}
function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

function ghRaw(args, { retries = 4, allowFail = false } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      const msg = String(e.stderr || e.message);
      const transient = /HTTP 5\d\d|timeout|ECONNRESET|rate limit|secondary rate|HTTP 403.*rate/i.test(msg);
      if (transient && attempt < retries) { sleep(2000 * (attempt + 1) ** 2); continue; }
      if (allowFail) return null;
      throw new Error(`gh ${args.join(' ')} failed: ${msg.slice(0, 400)}`);
    }
  }
}
function ghJson(args, opts = {}) {
  // A caller that loads this module without running main() has no cache.
  const f = CACHE_DIR ? cacheFile(JSON.stringify(args)) : null;
  if (f && !opts.noCache && fs.existsSync(f) && Date.now() - fs.statSync(f).mtimeMs < CACHE_MAX_AGE_MS) {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  }
  const out = ghRaw(args, opts);
  if (out === null) return null;
  const val = out.trim() ? JSON.parse(out) : null;
  if (f) fs.writeFileSync(f, JSON.stringify(val));
  return val;
}
// Page through a REST list endpoint. `pick` extracts the array from a page.
// `stop` ends paging once a page contains an item it returns true for.
function ghPages(endpoint, pick = (x) => x, perPage = 100, stop = null) {
  const all = [];
  for (let page = 1; page < 200; page++) {
    const sep = endpoint.includes('?') ? '&' : '?';
    const res = ghJson(['api', `${endpoint}${sep}per_page=${perPage}&page=${page}`]);
    const items = pick(res) || [];
    all.push(...items);
    if (items.length < perPage) break;
    if (stop && items.some(stop)) break;
  }
  return all;
}

// ---------- engineering side ----------
function listRuns(repo) {
  return ghPages(`repos/${ORG}/${repo}/actions/workflows/${WORKFLOW}/runs`, (r) => r && r.workflow_runs);
}

function prForBranch(repo, branch) {
  const res = ghJson(['api', `repos/${ORG}/${repo}/pulls?state=all&head=${ORG}:${encodeURIComponent(branch)}&per_page=10`]);
  return res && res.length ? res[0].number : null;
}

function jobSteps(repo, runId) {
  const res = ghJson(['api', `repos/${ORG}/${repo}/actions/runs/${runId}/jobs`], { allowFail: true });
  return (res && res.jobs) || [];
}

// What the dispatch step decided, from the job log. Returns one of
// dispatched | no_findings | no_token | schema_rejected | log_unavailable |
// step_not_found. A successful dispatch prints nothing (the dispatches API
// answers 204), so "dispatched" means the step ran and printed none of its
// skip messages. The step is found by its env block, which names
// DISPATCH_REPO; source lines echoed by the runner carry an ANSI prefix and
// are ignored so the script's own echo text never counts as output.
function dispatchOutcome(repo, jobId) {
  const key = `dispatch-outcome:v2:${repo}:${jobId}`;
  const f = cacheFile(key);
  if (fs.existsSync(f)) {
    const cached = JSON.parse(fs.readFileSync(f, 'utf8'));
    // Older caches stored a failed fetch too; ask again for those.
    if (cached.outcome !== 'log_unavailable') return cached;
  }
  const log = ghRaw(['api', `repos/${ORG}/${repo}/actions/jobs/${jobId}/logs`], { allowFail: true });
  // No log, no verdict: a failed fetch (expired log, a non-retried gh
  // error) is reported but never cached, so the next mine asks again.
  if (!log) return { outcome: 'log_unavailable' };
  let outcome;
  const lines = log.split('\n');
  let groupStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/##\[group\]Run /.test(lines[i])) groupStart = i;
    if (/^\S+\s+DISPATCH_REPO:/.test(lines[i]) && groupStart >= 0) break;
    if (i === lines.length - 1) groupStart = -1;
  }
  if (groupStart < 0) outcome = 'step_not_found';
  else {
    let i = groupStart;
    while (i < lines.length && !/##\[endgroup\]/.test(lines[i])) i++;
    const out = [];
    for (i++; i < lines.length; i++) {
      const l = lines[i];
      if (/##\[group\]|Post job cleanup\./.test(l)) break;
      if (l.includes('\u001b[36;1m')) continue;
      out.push(l.replace(/^\S+Z\s?/, ''));
    }
    const text = out.join('\n');
    if (/No high-impact findings/.test(text)) outcome = 'no_findings';
    else if (/No bot token; skipping dispatch/.test(text)) outcome = 'no_token';
    else if (/does not match the expected schema/.test(text)) outcome = 'schema_rejected';
    else if (/##\[error\]/.test(text)) outcome = 'dispatch_error';
    else outcome = 'dispatched';
  }
  const val = { outcome };
  if (f) fs.writeFileSync(f, JSON.stringify(val));
  return val;
}

function prDetails(repo, number) {
  // allowFail: a #N reference can name an issue, not a PR.
  const pr = ghJson(['api', `repos/${ORG}/${repo}/pulls/${number}`], { allowFail: true });
  if (!pr || !pr.head) return null;
  const files = ghPages(`repos/${ORG}/${repo}/pulls/${number}/files`);
  let mergeBase = null;
  const cmp = ghJson(['api', `repos/${ORG}/${repo}/compare/${pr.base.sha}...${pr.head.sha}?per_page=1`], { allowFail: true });
  if (cmp && cmp.merge_base_commit) mergeBase = cmp.merge_base_commit.sha;
  return { pr, files, mergeBase };
}

// ---------- docs side ----------
function isoDaysAgo(days) {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}

function listDocsPrs(repo, since) {
  return ghPages(`repos/${ORG}/${repo}/pulls?state=all&sort=created&direction=desc`, (x) => x, 100, (p) => p.created_at.slice(0, 10) < since)
    .filter((p) => p.created_at.slice(0, 10) >= since);
}

function docsPrFiles(repo, number) {
  return ghPages(`repos/${ORG}/${repo}/pulls/${number}/files`).map((f) => f.filename);
}

function docsPrComments(repo, number) {
  return ghPages(`repos/${ORG}/${repo}/issues/${number}/comments`).map((c) => c.body || '');
}

function isGenerated(file, learned) {
  return learned.has(file) || GENERATED_PATTERNS.some((re) => re.test(file));
}

// The URL prefix of each docs repo comes from its antora.yml on the default
// branch: the component name, plus "current" when the component is
// versioned. A rename in antora.yml is picked up without a code change.
const componentPrefix = new Map();
function docsUrlPrefix(repo) {
  if (componentPrefix.has(repo)) return componentPrefix.get(repo);
  const res = ghJson(['api', `repos/${ORG}/${repo}/contents/antora.yml`]);
  const yml = Buffer.from(res.content, 'base64').toString('utf8');
  const name = (yml.match(/^name:\s*['"]?([^'"\s]+)/m) || [])[1];
  const version = (yml.match(/^version:\s*['"]?([^'"\s]+)/m) || [])[1];
  if (!name) throw new Error(`no component name in ${repo}/antora.yml`);
  const unversioned = !version || version === '~' || version === 'null' || version === 'false';
  const prefix = `https://docs.redpanda.com/${name}${unversioned ? '' : '/current'}`;
  componentPrefix.set(repo, prefix);
  return prefix;
}

function adocToUrl(repo, file) {
  const m = file.match(/^modules\/([^/]+)\/pages\/(.+)\.adoc$/);
  if (!m) {
    const p = file.match(/^modules\/([^/]+)\/partials\/(.+\.adoc)$/);
    return p ? `partial:${repo}:${file}` : null;
  }
  const base = docsUrlPrefix(repo);
  const mod = m[1] === 'ROOT' ? '' : `/${m[1]}`;
  let p = m[2];
  if (p === 'index') p = '';
  else if (p.endsWith('/index')) p = p.slice(0, -'/index'.length);
  return `${base}${mod}${p ? '/' + p : ''}/`;
}

// Regexes that find a reference to an engineering PR in free text. The
// public redpanda-data/redpanda repo still exists with its own, much larger
// PR numbers, so a redpanda link never counts as a streaming-enterprise one.
function refPatterns(repo, number) {
  return [
    new RegExp(`github\\.com/${ORG}/${repo}/pull/${number}(?!\\d)`),
    // Short form, with or without the org: redpanda-operator#1852.
    new RegExp(`(?:^|[^\\w/-])(?:${ORG}/)?${repo}#${number}(?!\\d)`),
  ];
}
// Every engineering PR a block of text references, as [repo, number].
function engRefs(text) {
  const out = [];
  const re = new RegExp(`(?:github\\.com/${ORG}/(${ENG_REPOS.join('|')})/pull/|(?:^|[^\\w/-])(?:${ORG}/)?(${ENG_REPOS.join('|')})#)(\\d+)`, 'g');
  let m;
  while ((m = re.exec(text || ''))) out.push([m[1] || m[2], Number(m[3])]);
  return out;
}
// A file counts as needs_docs evidence only if it is page content a writer
// edits: an .adoc page or partial under modules/ that is not generated. CI,
// scripts, and config changes in a docs repo are not.
function isContent(file, learned) {
  return /^modules\/[^/]+\/(pages|partials)\/.+\.adoc$/.test(file) && !isGenerated(file, learned);
}
function mentions(text, pats) { return !!text && pats.some((re) => re.test(text)); }

// Sort the DOC tickets that reference one engineering PR by what they say
// about it. The router appends a later PR's findings to an existing ticket
// as a comment, so a ticket's verdict (accepted, or closed Will not
// implement) is a verdict on the PR named in its DESCRIPTION, not on every
// PR appended to it: a stacked PR whose stale base showed its parent's
// changes is appended this way. Only that originating PR takes the
// ticket's verdict. A ticket closed Won't Do or Duplicate is never
// accepted, whatever its status column says.
const isWni = (t) => /will not implement|won't do|won't fix/i.test(`${t.status} ${t.resolution || ''}`);
const isDup = (t) => /duplicate/i.test(`${t.status} ${t.resolution || ''}`);
function classifyTickets(tickets, pats) {
  const originates = (t) => mentions(t.description, pats);
  const auto = (t) => (t.labels || []).includes('auto-doc-impact');
  const accepted = tickets.filter((t) => auto(t) && !isWni(t) && !isDup(t) && /in review|done/i.test(t.status) && originates(t));
  const wni = tickets.filter((t) => isWni(t) && originates(t));
  const pendingAuto = tickets.filter((t) => auto(t) && !isWni(t) && !isDup(t) && !accepted.includes(t));
  return { accepted, wni, pendingAuto };
}

// ---------- csv ----------
function csvCell(v) {
  const s = v === null || v === undefined ? '' : Array.isArray(v) ? v.join(' ') : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// ---------- candidates -> eval items ----------
function repoIsPrivate(repo) {
  const out = ghRaw(['api', `repos/${repo}`, '--jq', '.private'], { allowFail: true });
  return out === null ? true : out.trim() !== 'false';
}

// The item shape run.js reads (see lib.validateItem). The mined strength is
// kept as label_strength; only strong counts by default, every other
// strength runs with --include-unconfirmed until a writer sets confirmed_by.
// Partials are kept apart from expected_pages because a partial is not a
// URL a finding can name.
const ORIGINAL_TITLE = /^\[(?:release|backport)[^\]]*\]\s*/i;
function toItems(candidates, existing) {
  const keep = new Map((existing || []).filter((i) => i.confirmed_by && String(i.confirmed_by).trim()).map((i) => [i.id, i]));
  const byTitle = new Map(candidates.filter((c) => !c.backport).map((c) => [`${c.repo}\n${c.title.trim()}`, c.id]));
  return candidates.map((c) => {
    if (keep.has(c.id)) return keep.get(c.id);
    // A backport repeats its original's change, so flagging both would open
    // a second ticket for the same work: stack it on the original when the
    // original is in the set (matched by title without the [release/...]
    // prefix and a trailing (#N)).
    let stackedOn = null;
    if (c.backport) {
      const bare = c.title.replace(ORIGINAL_TITLE, '').replace(/\s*\(#\d+\)\s*$/, '').trim();
      stackedOn = byTitle.get(`${c.repo}\n${bare}`) || null;
    }
    const pages = c.proposed_label === 'needs_docs' ? c.pages.filter((p) => p.startsWith('https://docs.redpanda.com/')) : [];
    return {
      id: c.id,
      repo: c.repo,
      pr_url: c.pr_url,
      title: c.title,
      body: c.body || '',
      label: c.proposed_label,
      label_strength: c.label_strength,
      confirmed_by: null,
      expected_pages: pages,
      expected_partials: c.proposed_label === 'needs_docs' ? c.pages.filter((p) => p.startsWith('partial:')) : [],
      ...(stackedOn ? { stacked_on: stackedOn } : {}),
      reason: c.reason,
      base_sha: c.base_sha,
      merge_base_sha: c.merge_base_sha,
      head_sha: c.head_sha,
      reviewed_head_sha: c.reviewed_head_sha || null,
      state: c.state,
      backport: Boolean(c.backport),
      review_ran: c.review_ran,
      production_dispatched: Boolean(c.production && c.production.dispatched),
      evidence: c.evidence,
    };
  });
}

// An item headed for a public file keeps only what the harness and a
// reader of this repository need. The label evidence points into private
// repositories (docs PR links, partial paths) and Jira (ticket keys and
// resolutions), so it is dropped, and the one-line reason keeps its sense
// without the references. The PR's own URL, its title and body, and the
// published docs.redpanda.com pages stay, because they are public.
function publicItem(item) {
  const { evidence, expected_partials, ...rest } = item;
  const own = item.pr_url || '';
  const reason = String(item.reason || '')
    .replace(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g, (url) => (url === own ? url : 'a docs PR'))
    .replace(/\b[A-Z][A-Z0-9]+-\d+\b/g, 'a DOC ticket')
    .replace(/(a docs PR)(?:,\s*a docs PR)+/g, 'docs PRs')
    .replace(/\bmerged docs PR a docs PR\b/g, 'a merged docs PR')
    .replace(/\bmerged docs PR docs PRs\b/g, 'merged docs PRs');
  return { ...rest, reason: reason || 'label mined from history' };
}

// ---------- production recordings ----------
// Plain gh calls, uncached: an artifact can appear (a re-run) or expire
// between two invocations, and this mode makes few calls.
const liveGh = {
  json(args) {
    const out = ghRaw(['api', ...args], { allowFail: true });
    if (out == null) return null;
    try { return JSON.parse(out); } catch { return null; }
  },
  download(repo, runId, name, dir) {
    return ghRaw(['run', 'download', String(runId), '-R', repo, '-n', name, '-D', dir], { allowFail: true }) !== null;
  },
};

function prNumberOf(item) {
  const m = /\/pull\/(\d+)/.exec(item.pr_url || '');
  return m ? Number(m[1]) : null;
}

// A recording is usable when every call has the shape the replay server
// reads. Anything else is reported, never written.
function validRecording(rec) {
  return Boolean(rec && Array.isArray(rec.calls) && rec.calls.length && rec.calls.every((c) =>
    c && typeof c.tool === 'string' && c.arguments && typeof c.arguments === 'object' && Array.isArray(c.content)));
}

/**
 * The production recording for one item, or why there is none. Looks at
 * every doc-strings-review run on the item's reviewed head, newest first,
 * and takes the first one with a doc-impact-mcp artifact for this PR (the
 * highest run attempt when a run was re-run). Later runs on the same head
 * often skip the model (each string is reviewed once), so the newest run
 * is not always the one that saved docs answers.
 */
function productionRecording(item, { gh = liveGh, tmpDir } = {}) {
  const sha = item.reviewed_head_sha;
  const number = prNumberOf(item);
  if (!sha) return { reason: 'no reviewed_head_sha (the review never ran the model on this PR)' };
  if (!number) return { reason: 'no PR number in pr_url' };
  const res = gh.json([`repos/${item.repo}/actions/workflows/${WORKFLOW}/runs?head_sha=${sha}&per_page=100`]);
  if (!res) return { reason: 'could not list workflow runs' };
  const runs = (res.workflow_runs || [])
    .filter((r) => r.head_sha === sha && (!(r.pull_requests || []).length || r.pull_requests.some((p) => p.number === number)))
    .sort((a, b) => String(b.run_started_at || b.created_at).localeCompare(String(a.run_started_at || a.created_at)));
  if (!runs.length) return { reason: `no ${WORKFLOW} run on ${sha.slice(0, 7)}` };
  const pattern = new RegExp(`^doc-impact-mcp-${number}-(\\d+)$`);
  for (const run of runs) {
    const arts = (gh.json([`repos/${item.repo}/actions/runs/${run.id}/artifacts?per_page=100`]) || {}).artifacts || [];
    const named = arts
      .filter((a) => !a.expired && pattern.test(a.name))
      .sort((a, b) => Number(pattern.exec(b.name)[1]) - Number(pattern.exec(a.name)[1]));
    if (!named.length) continue;
    const dir = fs.mkdtempSync(path.join(tmpDir || os.tmpdir(), 'doc-impact-mcp-'));
    if (!gh.download(item.repo, run.id, named[0].name, dir)) return { reason: `could not download ${named[0].name} from run ${run.id}` };
    const file = fs.readdirSync(dir).find((f) => f.endsWith('.json'));
    let rec = null;
    try { rec = file ? JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) : null; } catch { rec = null; }
    if (!validRecording(rec)) return { reason: `${named[0].name} from run ${run.id} is not a usable recording` };
    const refused = limitRefusals(rec.calls);
    if (refused.length) return { reason: `${named[0].name} holds ${refused.length} call(s) the docs server refused for its limit` };
    return {
      run,
      artifact: named[0].name,
      recording: {
        ...rec,
        item: item.id,
        recorded_at: rec.recorded_at || run.run_started_at || run.created_at,
        source: 'production',
        production_run: run.html_url || null,
      },
    };
  }
  return { reason: `no doc-impact-mcp artifact on ${runs.length} run(s) for ${sha.slice(0, 7)} (older than the artifact step, or expired)` };
}

/** Write production recordings for every item that has one; report the rest. */
function fromProduction(items, { recordingsDir, gh = liveGh, tmpDir } = {}) {
  const report = { production: [], kept: [] };
  fs.mkdirSync(recordingsDir, { recursive: true });
  for (const item of items) {
    const got = productionRecording(item, { gh, tmpDir });
    if (!got.recording) { report.kept.push({ id: item.id, reason: got.reason }); continue; }
    fs.writeFileSync(path.join(recordingsDir, `${item.id}.json`), JSON.stringify(got.recording, null, 2) + '\n');
    report.production.push({ id: item.id, calls: got.recording.calls.length, recorded_at: got.recording.recorded_at, artifact: got.artifact });
  }
  return report;
}

// ---------- main ----------
function main() {
  const args = parseArgs(process.argv);
  if (args.fromProduction) {
    const items = JSON.parse(fs.readFileSync(args.fromProduction, 'utf8'));
    const recordingsDir = args.recordings || path.join(path.dirname(path.resolve(args.fromProduction)), 'recordings');
    console.log(JSON.stringify(fromProduction(items, { recordingsDir }), null, 2));
    return;
  }
  if (args.toItems) {
    if (!args.itemsOut) { console.error('--to-items needs --items-out <file>'); process.exit(2); }
    const candidates = JSON.parse(fs.readFileSync(args.toItems, 'utf8'));
    // A private repo's PR text and diffs must never land in a public file.
    // Visibility is asked of GitHub, not listed here, and an unknown answer
    // counts as private.
    const repos = [...new Set(candidates.map((c) => c.repo))];
    const isPrivate = new Map(repos.map((r) => [r, repoIsPrivate(r)]));
    const groups = [[args.itemsOut, candidates.filter((c) => !isPrivate.get(c.repo))]];
    const privateCands = candidates.filter((c) => isPrivate.get(c.repo));
    if (privateCands.length) {
      if (!args.privateOut) {
        console.error(`${privateCands.length} candidate(s) come from private repos (${repos.filter((r) => isPrivate.get(r)).join(', ')}). Pass --private-out <file> outside any public repository for them.`);
        process.exit(2);
      }
      groups.push([args.privateOut, privateCands]);
    }
    const report = {};
    for (const [file, cands] of groups) {
      const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
      const seeded = toItems(cands, existing);
      const items = file === args.itemsOut ? seeded.map(publicItem) : seeded;
      fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(items, null, 2) + '\n');
      const tally = {};
      for (const it of items) { const k = `${it.label}/${it.label_strength}`; tally[k] = (tally[k] || 0) + 1; }
      report[file] = { items: items.length, kept_confirmed: items.filter((i) => i.confirmed_by).length, tally };
    }
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (args.help || !args.out) {
    console.error('usage: node mine-candidates.js --jira jira-export.json --out <dir> [--cache <dir>] [--cache-hours 12] [--settle-days 14] [--provisional] [--no-search]\n       node mine-candidates.js --to-items <candidates.json> --items-out <items.json>\n       node mine-candidates.js --from-production <items.json> [--recordings <dir>]');
    process.exit(args.help ? 0 : 2);
  }
  if (!(args.cacheHours >= 0)) { console.error('--cache-hours must be a number >= 0'); process.exit(2); }
  CACHE_MAX_AGE_MS = args.cacheHours * 3600000;
  fs.mkdirSync(args.out, { recursive: true });
  CACHE_DIR = args.cache || path.join(args.out, 'cache');
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const jira = args.jira ? JSON.parse(fs.readFileSync(args.jira, 'utf8')) : [];
  if (!args.jira) console.error('warning: no --jira export given; no ticket joins will be made');
  const now = Date.now();

  // 1. Runs, grouped by PR.
  const prs = new Map(); // key repo#n -> {repo, number, runs: []}
  let firstRun = null;
  for (const repo of ENG_REPOS) {
    const runs = listRuns(repo);
    console.error(`${repo}: ${runs.length} doc-strings-review runs`);
    for (const r of runs) {
      if (!firstRun || r.created_at < firstRun) firstRun = r.created_at;
      let n = r.pull_requests && r.pull_requests.length ? r.pull_requests[0].number : null;
      if (!n && r.head_branch) n = prForBranch(repo, r.head_branch);
      if (!n) continue;
      const key = `${repo}#${n}`;
      if (!prs.has(key)) prs.set(key, { repo, number: n, runs: [] });
      prs.get(key).runs.push(r);
    }
  }
  console.error(`PRs with a run: ${prs.size}; first run ${firstRun}`);

  // 2. Docs PRs in the window, and the learned generated-file set.
  const docsSince = (firstRun || isoDaysAgo(60)).slice(0, 10);
  const learnedSince = isoDaysAgo(args.lookbackDays);
  const learnedGenerated = new Set();
  const docsPrs = [];
  for (const repo of DOCS_REPOS) {
    const list = listDocsPrs(repo, learnedSince < docsSince ? learnedSince : docsSince);
    for (const p of list) {
      const bot = BOT_AUTHORS.test(p.user.login) || /^auto-docs:/i.test(p.title);
      if (bot) docsPrFiles(repo, p.number).forEach((f) => learnedGenerated.add(f));
      if (!bot) docsPrs.push({ repo, pr: p });
    }
  }
  console.error(`docs PRs in window: ${docsPrs.length}; learned generated paths: ${learnedGenerated.size}`);

  const docsPrCache = new Map();
  function docsPrInfo(repo, number, pr) {
    const k = `${repo}#${number}`;
    if (docsPrCache.has(k)) return docsPrCache.get(k);
    pr = pr || ghJson(['api', `repos/${ORG}/${repo}/pulls/${number}`]);
    const files = docsPrFiles(repo, number);
    const authored = files.filter((f) => isContent(f, learnedGenerated));
    const info = {
      repo, number, url: pr.html_url, title: pr.title,
      state: pr.merged_at ? 'merged' : pr.state, merged_at: pr.merged_at,
      files, authored_files: authored,
      pages: [...new Set(authored.map((f) => adocToUrl(repo, f)).filter(Boolean))],
    };
    docsPrCache.set(k, info);
    return info;
  }

  // Engineering PRs a docs PR in the lookback window references, where the
  // review never ran (it predates the review, or the PR was a draft). These
  // are the only needs_docs items whose label does not come from the pass's
  // own output, so they are kept, marked review_ran: false.
  for (const { pr: dp } of docsPrs) {
    for (const [repo, number] of engRefs(`${dp.title}\n${dp.body || ''}`)) {
      const key = `${repo}#${number}`;
      if (!prs.has(key)) prs.set(key, { repo, number, runs: [], historical: true });
    }
  }

  const items = [];
  const excluded = [];
  for (const entry of prs.values()) {
    const { repo, number } = entry;
    const ran = entry.runs.filter((r) => r.conclusion && r.conclusion !== 'skipped' && r.conclusion !== 'startup_failure');
    if (!ran.length && !entry.historical) { excluded.push({ repo, number, reason: 'every run skipped (draft or fork)' }); continue; }

    // 3. Did any run touch declarations, and what did the pass decide?
    let touched = false;
    const runEvidence = [];
    for (const r of ran) {
      for (const j of jobSteps(repo, r.id)) {
        const gated = (j.steps || []).filter((s) => GATED_STEPS.some((re) => re.test(s.name)));
        const hit = gated.some((s) => s.conclusion && s.conclusion !== 'skipped');
        if (!hit) continue;
        touched = true;
        const disp = (j.steps || []).find((s) => /^Dispatch doc-impact/.test(s.name));
        const d = disp && disp.conclusion === 'success' ? dispatchOutcome(repo, j.id)
          : { outcome: disp ? `dispatch_step_${disp.conclusion}` : 'no_dispatch_step' };
        runEvidence.push({ run_id: r.id, head_sha: r.head_sha, created_at: r.created_at, ...d });
      }
    }
    const details = prDetails(repo, number);
    if (!details) { excluded.push({ repo, number, reason: 'referenced number is not a pull request' }); continue; }
    const { pr, files, mergeBase } = details;
    const prUrl = pr.html_url;
    const pats = refPatterns(repo, number);

    // 4. Joins.
    const tickets = jira.filter((t) => mentions(t.description, pats) || (t.comments || []).some((c) => mentions(c.body, pats)));
    const linkedDocs = new Map();
    for (const { repo: dr, pr: dp } of docsPrs) {
      const text = `${dp.title}\n${dp.body || ''}\n${dp.head && dp.head.ref}`;
      const viaTicket = tickets.find((t) => new RegExp(`\\b${t.key}\\b`).test(text));
      if (mentions(text, pats) || viaTicket) {
        linkedDocs.set(`${dr}#${dp.number}`, { info: docsPrInfo(dr, dp.number, dp), via: viaTicket ? `ticket ${viaTicket.key}` : 'body' });
      }
    }
    if (args.search && touched) {
      // The search API also covers comments, which the body scan misses.
      const term = `${repo}/pull/${number}`;
      const q = `${DOCS_REPOS.map((r) => `repo:${ORG}/${r}`).join(' ')} is:pr "${term}"`;
      sleep(2200); // search API: 30 requests per minute
      const res = ghJson(['api', '-X', 'GET', 'search/issues', '-f', `q=${q}`, '-f', 'per_page=50'], { allowFail: true });
      for (const hit of (res && res.items) || []) {
        const dr = hit.repository_url.split('/').pop();
        const k = `${dr}#${hit.number}`;
        if (linkedDocs.has(k)) continue;
        const bodies = [hit.title, hit.body || '', ...docsPrComments(dr, hit.number)];
        if (bodies.some((b) => mentions(b, pats))) linkedDocs.set(k, { info: docsPrInfo(dr, hit.number), via: 'comment' });
      }
    }

    const docsLinks = [...linkedDocs.values()].map(({ info, via }) => ({ ...info, via }));
    const authoredDocs = docsLinks.filter((d) => d.authored_files.length > 0 && d.state !== 'closed');
    const mergedAuthored = authoredDocs.filter((d) => d.state === 'merged');
    const { accepted, wni, pendingAuto } = classifyTickets(tickets, pats);
    const mergedAt = pr.merged_at ? Date.parse(pr.merged_at) : null;
    const settled = mergedAt && now - mergedAt >= args.settleDays * 86400000;

    // ticketRationale holds Jira text. It goes to the writer sheet and
    // candidates.json, never into eval items, which may be published.
    let label = null; let strength = null; let reason = ''; let pages = []; let ticketRationale = null;
    const evidence = [];
    tickets.forEach((t) => evidence.push(`${t.key} [${t.status}${t.resolution ? '/' + t.resolution : ''}${(t.labels || []).includes('auto-doc-impact') ? ', auto-doc-impact' : ''}]`));
    docsLinks.forEach((d) => evidence.push(`${d.url} [${d.state}, via ${d.via}, ${d.authored_files.length}/${d.files.length} non-generated files]`));
    const flaggedRuns = runEvidence.filter((r) => r.outcome === 'dispatched');
    evidence.push(`review: ${runEvidence.length} gated run(s), ${flaggedRuns.length} dispatched`);

    if (mergedAuthored.length || accepted.length) {
      label = 'needs_docs'; strength = 'strong';
      pages = [...new Set(mergedAuthored.flatMap((d) => d.pages))];
      reason = mergedAuthored.length
        ? `merged docs PR ${mergedAuthored.map((d) => d.url).join(', ')} edited non-generated pages`
        : `auto-doc-impact ticket ${accepted.map((t) => t.key).join(', ')} accepted (${accepted.map((t) => t.status).join(', ')})`;
      if (!mergedAuthored.length && authoredDocs.length) pages = [...new Set(authoredDocs.flatMap((d) => d.pages))];
      if (!pages.length) reason += '; no docs PR found, writer must supply pages';
    } else if (authoredDocs.length) {
      label = 'needs_docs'; strength = 'medium';
      pages = [...new Set(authoredDocs.flatMap((d) => d.pages))];
      reason = `open docs PR ${authoredDocs.map((d) => d.url).join(', ')} edits non-generated pages`;
    } else if (wni.length) {
      const t = wni[0];
      const last = (t.comments || []).slice(-1)[0];
      const why = (last ? last.body : t.summary).replace(/\s+/g, ' ').slice(0, 300);
      if (!pr.merged_at) {
        // Closed because the change never shipped, not because the finding
        // was wrong. Judged on its diff, flagging it was correct.
        label = 'needs_docs'; strength = 'weak';
        reason = `${t.key} closed ${t.status} only because the PR was ${pr.state} unmerged; the finding itself was not rejected`;
        ticketRationale = why;
      } else {
        label = 'no_change'; strength = 'strong';
        reason = `${t.key} closed ${t.status}; the closing comment is the rationale`;
        ticketRationale = why;
      }
    } else if (pendingAuto.length) {
      label = 'needs_docs'; strength = 'pending';
      reason = `auto-doc-impact ticket ${pendingAuto.map((t) => t.key).join(', ')} untriaged (${pendingAuto.map((t) => t.status).join(', ')}); the pass raised it, so confirm before freezing`;
    } else if (touched && !tickets.length && docsLinks.some((d) => d.state === 'merged') && !authoredDocs.length) {
      // A writer acted on the PR and changed only generated output or
      // overrides: the regenerated reference was the whole fix.
      label = 'no_change'; strength = 'medium';
      reason = `docs PR ${docsLinks.filter((d) => d.state === 'merged').map((d) => d.url).join(', ')} changed only generated, override or release-note files`;
    } else if (touched && !tickets.length && !authoredDocs.length) {
      const smoke = /DO NOT MERGE|smoke|live test|demo/i.test(pr.title);
      if (settled) {
        label = 'no_change'; strength = 'weak';
        reason = `review touched declarations, merged ${pr.merged_at.slice(0, 10)}, no DOC ticket or docs PR after ${args.settleDays}+ days`;
      } else if (args.provisional) {
        label = 'no_change'; strength = 'provisional';
        const st = pr.merged_at ? `merged ${pr.merged_at.slice(0, 10)}, under ${args.settleDays} days ago` : `${pr.state}, not merged`;
        reason = `review touched declarations, ${st}, no DOC ticket or docs PR yet${smoke ? '; synthetic smoke-test PR' : ''}`;
      } else {
        excluded.push({ repo, number, url: prUrl, title: pr.title, reason: pr.merged_at ? `merged under ${args.settleDays} days ago` : `not merged (${pr.state})` });
        continue;
      }
    } else {
      const why = entry.historical ? 'review never ran, and no docs PR edited content pages for it'
        : touched ? 'only closed docs PRs reference it' : 'review ran but touched no declarations';
      excluded.push({ repo, number, url: prUrl, title: pr.title, reason: why });
      continue;
    }

    const lastGated = runEvidence.slice().sort((a, b) => a.created_at.localeCompare(b.created_at)).pop();
    items.push({
      id: `${repo}-${number}`,
      repo: `${ORG}/${repo}`,
      pr_number: number,
      pr_url: prUrl,
      title: pr.title,
      backport: /^\[(release|backport)|^backport/i.test(pr.title) || /^(release|v)\//.test(pr.base.ref),
      body: pr.body || '',
      author: pr.user.login,
      state: pr.merged_at ? 'merged' : pr.state,
      created_at: pr.created_at,
      merged_at: pr.merged_at,
      base_ref: pr.base.ref,
      base_sha: pr.base.sha,
      merge_base_sha: mergeBase,
      head_sha: pr.head.sha,
      reviewed_head_sha: lastGated ? lastGated.head_sha : null,
      review_ran: !entry.historical,
      changed_files: files.length,
      changed_paths_sample: files.slice(0, 40).map((f) => f.filename),
      proposed_label: label,
      label_strength: strength,
      pages,
      reason,
      ticket_rationale: ticketRationale,
      evidence,
      production: {
        gated_runs: runEvidence.length,
        dispatched: flaggedRuns.length > 0,
        runs: runEvidence,
      },
      tickets: tickets.map((t) => ({ key: t.key, status: t.status, resolution: t.resolution, labels: t.labels, summary: t.summary })),
      docs_prs: docsLinks.map((d) => ({ url: d.url, state: d.state, via: d.via, files: d.files, authored_files: d.authored_files, pages: d.pages })),
    });
  }

  const order = { needs_docs: 0, no_change: 1 };
  items.sort((a, b) => order[a.proposed_label] - order[b.proposed_label] || a.repo.localeCompare(b.repo) || a.pr_number - b.pr_number);
  fs.writeFileSync(path.join(args.out, 'candidates.json'), JSON.stringify(items, null, 2) + '\n');
  fs.writeFileSync(path.join(args.out, 'excluded.json'), JSON.stringify(excluded, null, 2) + '\n');
  const cols = ['repo', 'pr_url', 'title', 'proposed_label', 'label_strength', 'proposed_pages', 'reason', 'ticket_rationale', 'evidence', 'writer_label', 'writer_pages', 'writer_reason', 'second_writer_label'];
  const rows = [cols.join(',')];
  for (const it of items) {
    rows.push([it.repo, it.pr_url, it.title, it.proposed_label, it.label_strength, it.pages, it.reason, it.ticket_rationale, it.evidence.join('; '), '', '', '', ''].map(csvCell).join(','));
  }
  fs.writeFileSync(path.join(args.out, 'candidates.csv'), rows.join('\n') + '\n');

  const tally = {};
  for (const it of items) { const k = `${it.proposed_label}/${it.label_strength}`; tally[k] = (tally[k] || 0) + 1; }
  console.log(JSON.stringify({ items: items.length, excluded: excluded.length, tally }, null, 2));
}

if (require.main === module) {
  try { main(); } catch (e) { console.error(e.stack || String(e)); process.exit(1); }
}

module.exports = { toItems, publicItem, refPatterns, engRefs, isContent, adocToUrl, parseArgs, classifyTickets, productionRecording, fromProduction };

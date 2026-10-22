'use strict';

// Executes .github/scripts/check-dispatch-graph.sh against stubbed `gh` and
// `npx`, mirroring kapa-source-groups-drift.test.js.
//
// What matters is the 1-vs-2 split. A scheduled job that reads "the token
// cannot see the private repos" or "the API was down" as "the graph is broken"
// files a false issue on every blip and people stop reading them. So every
// inconclusive case must fail the job and file NOTHING, and every genuine
// finding must file or update exactly one issue. The clean run is the
// negative control: exit 0, no gh call at all.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const repoRoot = path.join(__dirname, '..', '..');
const SCRIPT_PATH = path.join(repoRoot, '.github', 'scripts', 'check-dispatch-graph.sh');
const WORKFLOW_PATH = path.join(repoRoot, '.github', 'workflows', 'check-dispatch-graph.yml');
const HERMETIC_TOOLS = ['bash', 'sh', 'sed', 'awk', 'grep', 'cat', 'printf', 'rm', 'date'];

let harnessDir, stubDir, toolDir, hermeticPath, ghCallLog, npxCallLog;

const which = (t) => execFileSync('/usr/bin/which', [t], { encoding: 'utf8' }).trim();

beforeAll(() => {
  harnessDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-graph-'));
  stubDir = path.join(harnessDir, 'stub');
  toolDir = path.join(harnessDir, 'tools');
  fs.mkdirSync(stubDir);
  fs.mkdirSync(toolDir);
  for (const tool of HERMETIC_TOOLS) {
    try { fs.symlinkSync(which(tool), path.join(toolDir, tool)); } catch { /* shell builtin */ }
  }

  fs.writeFileSync(path.join(stubDir, 'npx'), [
    '#!/bin/sh',
    'echo "$*" >> "$NPX_STUB_CALL"',
    'printf "%s\\n" "$CHECK_OUTPUT"',
    'exit "${CHECK_STATUS:-0}"',
  ].join('\n'), { mode: 0o755 });

  fs.writeFileSync(path.join(stubDir, 'gh'), [
    '#!/bin/sh',
    'echo "$*" >> "$GH_STUB_CALL"',
    'case "$1 $2" in',
    '  "label create") [ "${GH_LABEL_MODE:-exists}" = "exists" ] && exit 1 ;;',
    '  "issue list")',
    '    if [ "${GH_LIST_MODE:-none}" = "existing" ]; then echo "$GH_EXISTING_NUMBER"; ',
    '    elif [ "${GH_LIST_MODE}" = "error" ]; then exit 1;',
    '    else echo ""; fi ;;',
    '  "issue edit") [ "${GH_WRITE_MODE:-ok}" = "fail" ] && exit 1 ;;',
    '  "issue create") [ "${GH_WRITE_MODE:-ok}" = "fail" ] && exit 1 ;;',
    'esac',
    'exit 0',
  ].join('\n'), { mode: 0o755 });

  hermeticPath = `${stubDir}:${toolDir}`;
});

afterAll(() => fs.rmSync(harnessDir, { recursive: true, force: true }));

beforeEach(() => {
  ghCallLog = path.join(harnessDir, `gh-${Math.random().toString(36).slice(2)}.log`);
  npxCallLog = path.join(harnessDir, `npx-${Math.random().toString(36).slice(2)}.log`);
  fs.writeFileSync(ghCallLog, '');
  fs.writeFileSync(npxCallLog, '');
});

function run (env = {}) {
  const res = spawnSync('bash', [SCRIPT_PATH], {
    encoding: 'utf8',
    env: {
      PATH: hermeticPath,
      ISSUE_REPO: 'redpanda-data/docs-extensions-and-macros',
      RUN_URL: 'https://github.com/x/y/actions/runs/1',
      GH_STUB_CALL: ghCallLog,
      NPX_STUB_CALL: npxCallLog,
      ...env,
    },
  });
  return {
    status: res.status,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    ghCalls: fs.readFileSync(ghCallLog, 'utf8'),
    npxCalls: fs.readFileSync(npxCallLog, 'utf8'),
  };
}

const FINDINGS_OUTPUT = [
  'Dispatch graph: 2 repos scanned (1 engineering, 1 docs), 1 senders, 0 listeners, 1 edges.',
  '',
  '✗ 1 finding(s):',
  '  [sender-without-listener] helm-charts/dispatch_helm_docs.yaml -> docs#generate-helm-spec-docs: no workflow listens.',
  '',
  'Edges:',
  '  SENDER  EVENT  RECEIVER',
  '  helm-charts/dispatch_helm_docs.yaml  generate-helm-spec-docs  (none in docs)',
  '',
  'DISPATCH_GRAPH_FINDINGS_CONFIRMED',
].join('\n');

describe('dispatch graph: the workflow runs the script file', () => {
  const yaml = require('js-yaml');
  const parsed = yaml.load(fs.readFileSync(WORKFLOW_PATH, 'utf8'));
  const steps = parsed.jobs.check.steps;

  test('the check step invokes .github/scripts/check-dispatch-graph.sh rather than an inline copy', () => {
    const check = steps.find((st) => st.name === 'Check the dispatch graph');
    expect(check.run.trim()).toBe('bash .github/scripts/check-dispatch-graph.sh');
    expect(steps.findIndex((st) => st.uses && st.uses.startsWith('actions/checkout')))
      .toBeLessThan(steps.indexOf(check));
    expect(check.env.GITHUB_REF).toBe('${{ github.ref }}');
    expect(check.env.EVENT_NAME).toBe('${{ github.event_name }}');
    expect(check.env.GH_TOKEN).toBe('${{ env.ACTIONS_BOT_TOKEN }}');
  });

  test('the bot token is fetched only on the default branch', () => {
    // workflow_dispatch can be aimed at any branch, and checkout has no
    // explicit ref, so a plain event_name guard would hand the org token to
    // whatever script a dispatched branch carried.
    const aws = steps.find((st) => st.uses && st.uses.startsWith('aws-actions/configure-aws-credentials'));
    const bot = steps.find((st) => st.with && /actions_bot_token/.test(st.with['secret-ids']));
    expect(aws).toBeDefined();
    expect(bot).toBeDefined();
    expect(String(aws.if)).toBe("github.ref == 'refs/heads/main'");
    expect(String(bot.if)).toBe("github.ref == 'refs/heads/main'");
  });

  test('it is scheduled and dispatchable, never PR-triggered, and never a PR comment or push', () => {
    expect(Object.keys(parsed.on).sort()).toEqual(['schedule', 'workflow_dispatch']);
    expect(parsed.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
    const text = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    expect(text).not.toMatch(/git push/);
    expect(text).not.toMatch(/pr comment/);
  });

  test('uses npm ci and the pinned doc-tools', () => {
    expect(steps.some((st) => st.run === 'npm ci')).toBe(true);
  });
});

describe('dispatch graph: healthy', () => {
  test('exit 0 and files nothing', () => {
    const r = run({ CHECK_STATUS: '0', CHECK_OUTPUT: '✓ No findings.' });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Nothing to report/);
    expect(r.ghCalls.trim()).toBe('');
  });

  test('runs the pinned doc-tools via npx --no-install', () => {
    const r = run({ CHECK_STATUS: '0', CHECK_OUTPUT: 'ok' });
    expect(r.npxCalls).toMatch(/--no-install doc-tools check-dispatch-graph/);
  });
});

describe('dispatch graph: findings file or update exactly one issue', () => {
  const findings = { CHECK_STATUS: '1', CHECK_OUTPUT: FINDINGS_OUTPUT };

  test('creates an issue with the dispatch-graph label when none is open', () => {
    const r = run({ ...findings, GH_LIST_MODE: 'none' });
    expect(r.status).toBe(1);
    expect(r.ghCalls).toMatch(/issue create[^\n]*--label dispatch-graph/);
    expect(r.ghCalls).not.toMatch(/issue edit/);
    expect(r.ghCalls).not.toMatch(/issue comment/);
    expect(r.stdout).toMatch(/Opened a new issue in redpanda-data\/docs-extensions-and-macros/);
  });

  test('updates the existing issue in place rather than opening a second or commenting', () => {
    const r = run({ ...findings, GH_LIST_MODE: 'existing', GH_EXISTING_NUMBER: '412' });
    expect(r.status).toBe(1);
    expect(r.ghCalls).toMatch(/issue edit 412[^\n]*--body/);
    expect(r.ghCalls).not.toMatch(/issue create/);
    expect(r.ghCalls).not.toMatch(/issue comment/);
    expect(r.stdout).toMatch(/Updated existing issue redpanda-data\/docs-extensions-and-macros#412/);
  });

  test('looks up the issue by label and title only, so an unrelated issue is never overwritten', () => {
    const r = run({ ...findings });
    expect(r.ghCalls).toMatch(/issue list[^\n]*--label dispatch-graph[^\n]*in:title/);
  });

  test('makes sure the label exists first and tolerates it already existing', () => {
    const r = run({ ...findings, GH_LABEL_MODE: 'exists' });
    expect(r.status).toBe(1);
    expect(r.ghCalls).toMatch(/label create dispatch-graph/);
    expect(r.ghCalls).toMatch(/issue create/);
  });

  test('the body carries the findings and the run URL, not the sentinel or the edge table', () => {
    const r = run({ ...findings, GH_LIST_MODE: 'none' });
    expect(r.ghCalls).toMatch(/sender-without-listener/);
    expect(r.ghCalls).toMatch(/actions\/runs\/1/);
    expect(r.ghCalls).not.toMatch(/DISPATCH_GRAPH_FINDINGS_CONFIRMED/);
    expect(r.ghCalls).not.toMatch(/SENDER {2}EVENT/);
  });

  test('on a pull_request it annotates the check and files nothing', () => {
    const r = run({ ...findings, EVENT_NAME: 'pull_request' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/::error::/);
    expect(r.ghCalls.trim()).toBe('');
  });

  test('a workflow_dispatch from a branch other than main reports and files nothing', () => {
    const r = run({ ...findings, EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/jake/wip' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Not filing an issue from refs\/heads\/jake\/wip/);
    expect(r.ghCalls.trim()).toBe('');
  });

  test('a workflow_dispatch on main files like a scheduled run', () => {
    const r = run({ ...findings, EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', GH_LIST_MODE: 'none' });
    expect(r.status).toBe(1);
    expect(r.ghCalls).toMatch(/issue create/);
  });

  test('ISSUE_REPO falls back to GITHUB_REPOSITORY, then to this repo', () => {
    const a = run({ ...findings, ISSUE_REPO: '', GITHUB_REPOSITORY: 'redpanda-data/somewhere' });
    expect(a.ghCalls).toMatch(/--repo redpanda-data\/somewhere/);
    const b = run({ ...findings, ISSUE_REPO: '' });
    expect(b.ghCalls).toMatch(/--repo redpanda-data\/docs-extensions-and-macros/);
  });
});

describe('dispatch graph: inconclusive runs fail loudly and file nothing', () => {
  test('exit 2 (a private repo unreadable, bad token) files no issue', () => {
    const r = run({ CHECK_STATUS: '2', CHECK_OUTPUT: '✗ Could not read 8 thing(s): redpanda-data/docs: Not Found (HTTP 404)' });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/Could not check the whole dispatch graph/);
    expect(r.ghCalls.trim()).toBe('');
  });

  test('an unexpected status also files nothing', () => {
    const r = run({ CHECK_STATUS: '7', CHECK_OUTPUT: 'boom' });
    expect(r.status).toBe(2);
    expect(r.ghCalls.trim()).toBe('');
  });

  test('exit 1 without the sentinel is a tool failure (usage error, crash), not a finding', () => {
    for (const out of ["error: unknown option '--nope'", "TypeError: Cannot read properties of undefined\n    at Object.<anonymous>", 'prose mentioning DISPATCH_GRAPH_FINDINGS_CONFIRMED mid-line']) {
      const r = run({ CHECK_STATUS: '1', CHECK_OUTPUT: out });
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/exited 1 without confirming findings/);
      expect(r.ghCalls.trim()).toBe('');
    }
  });

  test('findings but the issue create fails exits 2 rather than claiming it filed', () => {
    const r = run({ CHECK_STATUS: '1', CHECK_OUTPUT: FINDINGS_OUTPUT, GH_LIST_MODE: 'none', GH_WRITE_MODE: 'fail' });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/could not create an issue/);
  });

  test('findings but the issue update fails exits 2', () => {
    const r = run({ CHECK_STATUS: '1', CHECK_OUTPUT: FINDINGS_OUTPUT, GH_LIST_MODE: 'existing', GH_EXISTING_NUMBER: '9', GH_WRITE_MODE: 'fail' });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/could not update/);
  });

  test('an unreadable issue list still files a new issue rather than dropping the report', () => {
    const r = run({ CHECK_STATUS: '1', CHECK_OUTPUT: FINDINGS_OUTPUT, GH_LIST_MODE: 'error' });
    expect(r.status).toBe(1);
    expect(r.ghCalls).toMatch(/issue create/);
  });
});

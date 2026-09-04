'use strict';

// Executes .github/scripts/kapa-source-groups-drift.sh against stubbed `gh` and
// `npx`, mirroring the guard-generated-files harness.
//
// What matters here is the 1-vs-2 split. A scheduled job that reads "Kapa was
// unreachable" as "the mapping is stale" files a false issue every blip and
// people stop reading the issues. So every inconclusive case must fail the job
// and file NOTHING, and every genuine-drift case must file exactly one issue.
// Each of those has a negative control proving the same script still exits 0 and
// files nothing on a clean run.
//
// The harness is hermetic: PATH holds only the stubs plus symlinks to the
// utilities the script uses, so a real gh or a real doc-tools can never answer.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const repoRoot = path.join(__dirname, '..', '..');
const SCRIPT_PATH = path.join(repoRoot, '.github', 'scripts', 'kapa-source-groups-drift.sh');
const WORKFLOW_PATH = path.join(repoRoot, '.github', 'workflows', 'kapa-source-groups-drift.yml');
const HERMETIC_TOOLS = ['bash', 'sh', 'sed', 'awk', 'grep', 'cat', 'printf', 'rm'];

let harnessDir, stubDir, toolDir, hermeticPath, ghCallLog, npxCallLog;

const which = (t) => execFileSync('/usr/bin/which', [t], { encoding: 'utf8' }).trim();

beforeAll(() => {
  harnessDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kapa-drift-'));
  stubDir = path.join(harnessDir, 'stub');
  toolDir = path.join(harnessDir, 'tools');
  fs.mkdirSync(stubDir);
  fs.mkdirSync(toolDir);
  for (const tool of HERMETIC_TOOLS) {
    try { fs.symlinkSync(which(tool), path.join(toolDir, tool)); } catch { /* shell builtin */ }
  }

  // `npx --no-install doc-tools validate kapa-source-groups` -> replay a canned
  // exit status and output, so the script's branching is what is under test
  // rather than Kapa.
  fs.writeFileSync(path.join(stubDir, 'npx'), [
    '#!/bin/sh',
    'echo "$*" >> "$NPX_STUB_CALL"',
    'printf "%s\\n" "$VALIDATE_OUTPUT"',
    'exit "${VALIDATE_STATUS:-0}"',
  ].join('\n'), { mode: 0o755 });

  fs.writeFileSync(path.join(stubDir, 'gh'), [
    '#!/bin/sh',
    'echo "$*" >> "$GH_STUB_CALL"',
    'case "$1 $2" in',
    '  "issue list")',
    '    if [ "${GH_LIST_MODE:-none}" = "existing" ]; then echo "$GH_EXISTING_NUMBER"; ',
    '    elif [ "${GH_LIST_MODE}" = "error" ]; then exit 1;',
    '    else echo ""; fi ;;',
    '  "issue comment") [ "${GH_WRITE_MODE:-ok}" = "fail" ] && exit 1 ;;',
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
      GITHUB_REPOSITORY: 'redpanda-data/docs-extensions-and-macros',
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

describe('kapa drift: the script and the workflow cannot diverge', () => {
  test('the workflow embeds the script verbatim', () => {
    const script = fs.readFileSync(SCRIPT_PATH, 'utf8');
    const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    // Every non-blank script line must appear in the workflow, so an edit to one
    // without the other is caught here rather than at 6am on a Monday.
    const missing = script.split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#!'))
      .filter((l) => !workflow.includes(l));
    expect(missing).toEqual([]);
  });
});

describe('kapa drift: in sync', () => {
  test('exit 0 and files nothing', () => {
    const r = run({ VALIDATE_STATUS: '0', VALIDATE_OUTPUT: '✓ in sync with Kapa and the published version list.' });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Nothing to report/);
    expect(r.ghCalls.trim()).toBe('');
  });
});

describe('kapa drift: genuine drift files exactly one issue', () => {
  const drift = { VALIDATE_STATUS: '1', VALIDATE_OUTPUT: '✗ 26.3: published but has no Kapa source group.' };

  test('creates an issue when none is open', () => {
    const r = run({ ...drift, GH_LIST_MODE: 'none' });
    expect(r.status).toBe(1);
    expect(r.ghCalls).toMatch(/issue create/);
    expect(r.ghCalls).not.toMatch(/issue comment/);
    expect(r.stdout).toMatch(/Opened a new drift issue/);
  });

  test('comments on the existing issue rather than opening a second', () => {
    const r = run({ ...drift, GH_LIST_MODE: 'existing', GH_EXISTING_NUMBER: '412' });
    expect(r.status).toBe(1);
    expect(r.ghCalls).toMatch(/issue comment 412/);
    expect(r.ghCalls).not.toMatch(/issue create/);
  });

  test('searches by title only, so an unrelated Kapa issue is never hijacked', () => {
    const r = run({ ...drift });
    expect(r.ghCalls).toMatch(/in:title/);
  });

  test('the issue body carries the validate output and the run URL', () => {
    const r = run({ ...drift, GH_LIST_MODE: 'none' });
    expect(r.ghCalls).toMatch(/26\.3/);
    expect(r.ghCalls).toMatch(/actions\/runs\/1/);
  });

  test('on a pull_request it annotates the check and files nothing', () => {
    const r = run({ ...drift, EVENT_NAME: 'pull_request' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/::error::/);
    expect(r.ghCalls.trim()).toBe('');
  });
});

describe('kapa drift: inconclusive runs fail loudly and file nothing', () => {
  test('validate exit 2 (Kapa unreachable / bad creds) files no issue', () => {
    const r = run({ VALIDATE_STATUS: '2', VALIDATE_OUTPUT: 'Error: Could not check Kapa source groups: 403' });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/Could not determine/);
    expect(r.ghCalls.trim()).toBe('');
  });

  test('an unexpected non-0/1/2 status also files nothing', () => {
    const r = run({ VALIDATE_STATUS: '7', VALIDATE_OUTPUT: 'boom' });
    expect(r.status).toBe(2);
    expect(r.ghCalls.trim()).toBe('');
  });

  test('drift found but the issue write fails exits 2 rather than claiming success', () => {
    // Reporting exit 1 here would say "issue filed" when nothing was filed.
    const r = run({
      VALIDATE_STATUS: '1', VALIDATE_OUTPUT: '✗ drift',
      GH_LIST_MODE: 'none', GH_WRITE_MODE: 'fail',
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/could not create an issue/);
  });

  test('drift found but the comment write fails exits 2', () => {
    const r = run({
      VALIDATE_STATUS: '1', VALIDATE_OUTPUT: '✗ drift',
      GH_LIST_MODE: 'existing', GH_EXISTING_NUMBER: '9', GH_WRITE_MODE: 'fail',
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/could not comment/);
  });

  test('an unreadable issue list still files a new issue rather than dying', () => {
    // gh issue list failing is not proof no issue exists, but filing a possible
    // duplicate beats dropping the drift report entirely.
    const r = run({ VALIDATE_STATUS: '1', VALIDATE_OUTPUT: '✗ drift', GH_LIST_MODE: 'error' });
    expect(r.status).toBe(1);
    expect(r.ghCalls).toMatch(/issue create/);
  });

  test('a missing GITHUB_REPOSITORY fails before calling gh', () => {
    const res = spawnSync('bash', [SCRIPT_PATH], {
      encoding: 'utf8',
      env: { PATH: hermeticPath, GH_STUB_CALL: ghCallLog, NPX_STUB_CALL: npxCallLog },
    });
    expect(res.status).not.toBe(0);
    expect(fs.readFileSync(ghCallLog, 'utf8').trim()).toBe('');
  });
});

describe('kapa drift: it runs the pinned doc-tools', () => {
  test('uses npx --no-install so CI cannot silently pull a different release', () => {
    const r = run({ VALIDATE_STATUS: '0', VALIDATE_OUTPUT: 'ok' });
    expect(r.npxCalls).toMatch(/--no-install doc-tools validate kapa-source-groups/);
  });
});

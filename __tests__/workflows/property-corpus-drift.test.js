'use strict';

// Executes .github/scripts/property-corpus-drift.sh against a stubbed `gh`,
// mirroring the kapa-source-groups-drift harness.
//
// What matters is the same 1-vs-2 split. A scheduled job that reads "the docs
// repo was unreachable" as "the mirror is current" is a check that silently
// stops checking, which is exactly the failure this script exists to prevent
// (the mirror sat three months and 114 entries stale). So every inconclusive
// case must exit 2 and file nothing, every genuine-drift case must file exactly
// one issue and exit 1, and a clean run must exit 0 and file nothing.
//
// The harness is hermetic: PATH holds only the stubs plus symlinks to the
// utilities the script uses, so a real gh can never answer.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const YAML = require('yaml');

const repoRoot = path.join(__dirname, '..', '..');
const SCRIPT_PATH = path.join(repoRoot, '.github', 'scripts', 'property-corpus-drift.sh');
const WORKFLOW_PATH = path.join(repoRoot, '.github', 'workflows', 'property-corpus-drift.yml');
const CORPUS_DIR = path.join(repoRoot, '__tests__', 'docs-data');
const HERMETIC_TOOLS = ['bash', 'sh', 'sed', 'awk', 'grep', 'cat', 'printf', 'rm', 'mktemp', 'node', 'command'];

const which = (t) => execFileSync('/usr/bin/which', [t], { encoding: 'utf8' }).trim();

let harnessDir, stubDir, toolDir, hermeticPath, ghCallLog, liveDir;

beforeAll(() => {
  harnessDir = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-drift-'));
  stubDir = path.join(harnessDir, 'stub');
  toolDir = path.join(harnessDir, 'tools');
  liveDir = path.join(harnessDir, 'live');
  fs.mkdirSync(stubDir);
  fs.mkdirSync(toolDir);
  fs.mkdirSync(liveDir);
  for (const tool of HERMETIC_TOOLS) {
    try { fs.symlinkSync(which(tool), path.join(toolDir, tool)); } catch { /* shell builtin */ }
  }

  // `gh api <contents url>` serves whatever the current case put in liveDir;
  // `gh issue ...` records the call and replays a canned answer. So the
  // script's branching is under test rather than GitHub.
  fs.writeFileSync(path.join(stubDir, 'gh'), [
    '#!/bin/sh',
    'echo "$*" >> "$GH_STUB_CALL"',
    'if [ "$1" = "api" ]; then',
    '  if [ "$GH_STUB_API_FAIL" = "1" ]; then exit 1; fi',
    '  case "$2" in',
    '    *property-overrides.json*) cat "$GH_STUB_LIVE/property-overrides.json"; exit 0 ;;',
    '    *redpanda-properties-*)',
    // Real gh writes exactly this on a 404, and nothing else it can fail with
    // matches "HTTP 404" -- the script greps for that string to tell "this
    // tag has been renamed forward" apart from "the fetch is broken".
    '      if [ "$GH_STUB_ATTACHMENT_404" = "1" ]; then echo "gh: Not Found (HTTP 404)" >&2; exit 1; fi',
    '      if [ "$GH_STUB_ATTACHMENT_FAIL" = "1" ]; then echo "gh: some other error" >&2; exit 1; fi',
    '      cat "$GH_STUB_LIVE/attachment.json"; exit 0 ;;',
    '  esac',
    '  exit 1',
    'fi',
    'if [ "$1" = "issue" ]; then',
    '  case "$2" in',
    '    list) if [ "$GH_STUB_LIST_FAIL" = "1" ]; then exit 1; fi; printf "%s" "$GH_STUB_EXISTING" ;;',
    '    create|comment) if [ "$GH_STUB_WRITE_FAIL" = "1" ]; then exit 1; fi ;;',
    '  esac',
    '  exit 0',
    'fi',
    'exit 1',
  ].join('\n'), { mode: 0o755 });

  hermeticPath = `${stubDir}:${toolDir}`;
  ghCallLog = path.join(harnessDir, 'gh-calls.log');
});

afterAll(() => fs.rmSync(harnessDir, { recursive: true, force: true }));

/**
 * Build the "live docs repo" side. `matching` derives it from the committed
 * corpus so a clean run is genuinely clean; otherwise it perturbs it.
 */
function setLive ({ matching = true, dropEntries = 0, changeField = false, changeEntry = false } = {}) {
  const snapshot = JSON.parse(fs.readFileSync(path.join(CORPUS_DIR, 'property-snapshot.json'), 'utf8'));
  const overrides = JSON.parse(fs.readFileSync(path.join(CORPUS_DIR, 'property-overrides.json'), 'utf8'));

  if (!matching && changeEntry) {
    // Same keys on both sides, different content: the case a count comparison
    // cannot see.
    const first = Object.keys(overrides.properties)[0];
    overrides.properties[first] = Object.assign({}, overrides.properties[first], {
      description: 'a description only the live repo has',
    });
  }

  if (!matching && dropEntries > 0) {
    for (const name of Object.keys(overrides.properties).slice(0, dropEntries)) {
      // Dropped from the MIRROR's point of view means present live, absent
      // here, so add rather than remove: the live side is what we build.
      overrides.properties[`${name}__live_only`] = overrides.properties[name];
    }
  }

  // The attachment the script reduces. Reverse the reduction: the snapshot's
  // own properties already carry exactly the kept fields.
  const attachment = { properties: JSON.parse(JSON.stringify(snapshot.properties)) };
  if (!matching && changeField) {
    // cloud_supported, not description: description is deliberately not in
    // the keep list (see the script), so perturbing it would prove nothing
    // once that list is correct -- this needs a field the reduction actually
    // keeps, to prove the reduction-based comparison catches ITS OWN
    // invisible-to-a-count-check case, same as changeEntry does for overrides.
    const first = Object.keys(attachment.properties)[0];
    attachment.properties[first].cloud_supported = !attachment.properties[first].cloud_supported;
  }

  fs.writeFileSync(path.join(liveDir, 'property-overrides.json'), JSON.stringify(overrides));
  fs.writeFileSync(path.join(liveDir, 'attachment.json'), JSON.stringify(attachment));
}

function run (env = {}) {
  fs.writeFileSync(ghCallLog, '');
  const result = spawnSync('bash', [SCRIPT_PATH], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      PATH: hermeticPath,
      HOME: harnessDir,
      GH_STUB_CALL: ghCallLog,
      GH_STUB_LIVE: liveDir,
      GH_STUB_EXISTING: '',
      CORPUS_DIR,
      ...env,
    },
  });
  return { ...result, ghCalls: fs.readFileSync(ghCallLog, 'utf8') };
}

describe('property-corpus-drift.sh', () => {
  it('exits 0 and files nothing when the mirror matches the docs repo', () => {
    setLive({ matching: true });
    const { status, stdout, ghCalls } = run();
    expect(status).toBe(0);
    expect(stdout).toMatch(/matches redpanda-data\/docs@main/);
    expect(ghCalls).not.toMatch(/issue (create|comment)/);
  });

  it('exits 1 and opens one issue when entries are missing from the mirror', () => {
    setLive({ matching: false, dropEntries: 3 });
    const { status, stdout, ghCalls } = run();
    expect(status).toBe(1);
    expect(stdout).toMatch(/Drift found/);
    expect(stdout).toMatch(/property-overrides\.json/);
    expect(ghCalls).toMatch(/issue create/);
    expect(ghCalls).not.toMatch(/issue comment/);
  });

  it('detects a field-value change even when the property count matches', () => {
    // The snapshot is a reduction, so a changed description is invisible to a
    // count comparison. This is the case a naive length check would miss.
    setLive({ matching: false, changeField: true });
    const { status, stdout } = run();
    expect(status).toBe(1);
    expect(stdout).toMatch(/property-snapshot\.json/);
    expect(stdout).toMatch(/same count, so the difference is in the field values/);
  });

  it('reports drift, not exit 2, when the pinned tag has been renamed forward on the docs side', () => {
    // docs' regen renames the attachment file forward on every release, so
    // any tag the corpus is still pinned to eventually 404s. That is drift in
    // its own right -- the corpus cannot be compared against a tag with no
    // live file -- and must reach an issue, not just a red Actions run: exit 2
    // never files one, which is exactly how this went unnoticed before.
    setLive({ matching: true });
    const { status, stdout, ghCalls } = run({ GH_STUB_ATTACHMENT_404: '1' });
    expect(status).toBe(1);
    expect(stdout).toMatch(/Drift found/);
    expect(stdout).toMatch(/no longer exists on redpanda-data\/docs@main/);
    expect(stdout).toMatch(/refresh the pin to a current tag/);
    expect(ghCalls).toMatch(/issue create/);
  });

  it('still reports the overrides drift alongside a renamed-forward tag', () => {
    setLive({ matching: false, dropEntries: 3 });
    const { status, stdout } = run({ GH_STUB_ATTACHMENT_404: '1', FILE_ISSUE: 'false' });
    expect(status).toBe(1);
    expect(stdout).toMatch(/property-overrides\.json/);
    expect(stdout).toMatch(/no longer exists on redpanda-data\/docs@main/);
  });

  it('still fails closed with 2 when the attachment fetch fails for a reason other than 404', () => {
    // A renamed-forward tag is drift; a broken token or network is not --
    // collapsing the two would turn every transient fetch failure into a
    // filed issue telling someone to refresh a pin that was never stale.
    setLive({ matching: true });
    const { status, stderr, ghCalls } = run({ GH_STUB_ATTACHMENT_FAIL: '1' });
    expect(status).toBe(2);
    expect(stderr).toMatch(/could not be determined/);
    expect(ghCalls).not.toMatch(/issue (create|comment)/);
  });

  it('comments on an existing issue instead of opening a duplicate', () => {
    setLive({ matching: false, dropEntries: 3 });
    const { status, stdout, ghCalls } = run({ GH_STUB_EXISTING: '4321' });
    expect(status).toBe(1);
    expect(stdout).toMatch(/Commented on existing issue .*#4321/);
    expect(ghCalls).toMatch(/issue comment 4321/);
    expect(ghCalls).not.toMatch(/issue create/);
  });

  it('fails closed with 2 and files nothing when the docs repo cannot be read', () => {
    // The whole point: unreachable must never read as "current".
    setLive({ matching: true });
    const { status, stderr, ghCalls } = run({ GH_STUB_API_FAIL: '1' });
    expect(status).toBe(2);
    expect(stderr).toMatch(/could not be determined/);
    expect(ghCalls).not.toMatch(/issue (create|comment)/);
  });

  it('fails closed with 2 when it cannot list issues to report drift', () => {
    setLive({ matching: false, dropEntries: 3 });
    const { status, stderr } = run({ GH_STUB_LIST_FAIL: '1' });
    expect(status).toBe(2);
    expect(stderr).toMatch(/could not list issues/);
  });

  it('fails closed with 2 when the issue write fails', () => {
    setLive({ matching: false, dropEntries: 3 });
    const { status, stderr } = run({ GH_STUB_WRITE_FAIL: '1' });
    expect(status).toBe(2);
    expect(stderr).toMatch(/could not create an issue/);
  });

  it('reports drift without filing when FILE_ISSUE is not true', () => {
    // A pull request that updates the corpus is ahead of docs main by design.
    // Left to itself the check filed an issue against the very branch fixing
    // it, which is noise a human is already looking at.
    setLive({ matching: false, dropEntries: 3 });
    const { status, stdout, ghCalls } = run({ FILE_ISSUE: 'false' });
    expect(status).toBe(1);
    expect(stdout).toMatch(/Drift found/);
    expect(stdout).toMatch(/Not filing an issue/);
    expect(ghCalls).not.toMatch(/issue (create|comment|list)/);
  });

  it('names what differs when both sides have the same entries', () => {
    // "438 entries live, 438 in the mirror" on its own says nothing about what
    // changed, which is exactly what the first real CI run reported.
    setLive({ matching: false, changeEntry: true });
    const { status, stdout } = run({ FILE_ISSUE: 'false' });
    expect(status).toBe(1);
    expect(stdout).toMatch(/same entries/);
    expect(stdout).toMatch(/differing in content/);
  });

  it('fails closed with 2 when gh is not on PATH at all', () => {
    setLive({ matching: true });
    const result = spawnSync('bash', [SCRIPT_PATH], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { PATH: toolDir, HOME: harnessDir, CORPUS_DIR, GH_STUB_CALL: ghCallLog, GH_STUB_LIVE: liveDir },
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/gh is required/);
  });
});

describe('property-corpus-drift.yml', () => {
  const workflow = () => fs.readFileSync(WORKFLOW_PATH, 'utf8');

  it('runs the committed script rather than inlining its own copy', () => {
    expect(workflow()).toMatch(/bash \.github\/scripts\/property-corpus-drift\.sh/);
  });

  it('treats exit 2 as a build failure and exit 1 as a notice', () => {
    // Collapsing the two would either fail the build on every genuine drift
    // report, or pass the build when the check could not run.
    const text = workflow();
    expect(text).toMatch(/1\)\s*echo "::notice::/);
    expect(text).toMatch(/\*\)\s*echo "::error::.*exit 1/s);
  });

  it('skips on a fork PR, which cannot have the credential', () => {
    expect(workflow()).toMatch(/head\.repo\.full_name == github\.repository/);
  });

  it('passes the bot token, since the docs repo is private', () => {
    expect(workflow()).toMatch(/GH_TOKEN: \$\{\{ env\.ACTIONS_BOT_TOKEN \}\}/);
  });

  // A plain `github.event_name != 'pull_request'` guard, on its own, also
  // admits workflow_dispatch on ANY branch -- and checkout below has no
  // explicit ref, so it checks out whatever branch that dispatch selected.
  // GitHub lets any user with write access dispatch a workflow against a
  // branch they chose, so a contributor could edit this script or this
  // workflow on their own branch, dispatch that branch, and receive the
  // org-wide write-capable bot token running their own code.
  describe('credentialed steps are restricted to the default branch, not just non-PR events', () => {
    const doc = YAML.parse(workflow());
    const steps = Object.values(doc.jobs)[0].steps;
    const stepNamed = (name) => {
      const step = steps.find((s) => s.name === name);
      if (!step) throw new Error(`no step named ${name}`);
      return step;
    };

    it.each([
      'Configure AWS credentials',
      'Get secrets from AWS Secrets Manager',
      'Check corpus against the docs repo',
    ])('%s runs only when github.ref is the default branch', (name) => {
      expect(stepNamed(name).if).toBe("github.ref == 'refs/heads/main'");
    });

    it('the token-free fallback runs in every OTHER case, so nothing silently does no check at all', () => {
      expect(stepNamed('Check the vendored corpus is well formed').if).toBe("github.ref != 'refs/heads/main'");
    });

    it('the two conditions are complementary across every real trigger shape', () => {
      const credentialed = stepNamed('Configure AWS credentials').if;
      const tokenFree = stepNamed('Check the vendored corpus is well formed').if;
      const refs = ['refs/heads/main', 'refs/heads/some-feature-branch', 'refs/pull/123/merge'];
      for (const ref of refs) {
        // eslint-disable-next-line no-eval -- evaluating GitHub Actions'
        // own expression syntax against a stand-in context, not user input.
        const evalCond = (expr) => eval(expr.replace(/github\.ref/g, JSON.stringify(ref)));
        expect(evalCond(credentialed)).toBe(!evalCond(tokenFree));
      }
    });
  });
});

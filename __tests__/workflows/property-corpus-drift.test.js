'use strict';

// Executes .github/scripts/property-corpus-drift.sh against a stubbed `gh`,
// mirroring the kapa-source-groups-drift harness.
//
// What matters is the same 1-vs-2 split. A scheduled job that reads "the docs
// repo was unreachable" as "the mirror is current" is a check that silently
// stops checking, which is exactly the failure this script exists to prevent
// (the mirror sat three months and 114 entries stale). So every inconclusive
// case must exit 2 and open nothing, every genuine-drift case must push the
// refresh and open or update exactly one PR and exit 1, and a clean run must
// exit 0 and open nothing.
//
// The refresh cases commit and push, so they run against a throwaway git repo
// holding a copy of the corpus, with a local bare repo as the remote. The
// committed corpus is never written to.
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
const HERMETIC_TOOLS = ['bash', 'sh', 'sed', 'awk', 'grep', 'cat', 'printf', 'rm', 'mktemp', 'node', 'command', 'git', 'sort', 'tail', 'cp', 'base64', 'tr'];
const BOT_EMAIL = '62446873+vbotbuildovich@users.noreply.github.com';
const PINNED_TAG = JSON.parse(fs.readFileSync(path.join(CORPUS_DIR, 'property-snapshot.json'), 'utf8')).source_tag;

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
  // `gh pr ...` records the call and replays a canned answer. So the
  // script's branching is under test rather than GitHub.
  fs.writeFileSync(path.join(stubDir, 'gh'), [
    '#!/bin/sh',
    'echo "$*" >> "$GH_STUB_CALL"',
    'if [ "$1" = "api" ]; then',
    '  if [ "$GH_STUB_API_FAIL" = "1" ]; then exit 1; fi',
    '  case "$2" in',
    '    *property-overrides.json*) cat "$GH_STUB_LIVE/property-overrides.json"; exit 0 ;;',
    // The directory listing, already reduced to names as `--jq .[].name` would.
    '    *modules/reference/attachments\\?ref=*)',
    '      if [ "$GH_STUB_LISTING_FAIL" = "1" ]; then exit 1; fi',
    '      printf "%s\\n" $GH_STUB_ATTACHMENTS; exit 0 ;;',
    '    *redpanda-properties-*)',
    // Real gh writes exactly this on a 404, and nothing else it can fail with
    // matches "HTTP 404" -- the script greps for that string to tell "this
    // tag has been renamed forward" apart from "the fetch is broken". Only the
    // pinned tag 404s: the latest tag is what the refresh fetches next.
    '      case "$2" in *"redpanda-properties-$GH_STUB_LATEST_TAG.json"*) ;; *)',
    '        if [ "$GH_STUB_ATTACHMENT_404" = "1" ]; then echo "gh: Not Found (HTTP 404)" >&2; exit 1; fi ;;',
    '      esac',
    '      if [ "$GH_STUB_ATTACHMENT_FAIL" = "1" ]; then echo "gh: some other error" >&2; exit 1; fi',
    '      cat "$GH_STUB_LIVE/attachment.json"; exit 0 ;;',
    '  esac',
    '  exit 1',
    'fi',
    'if [ "$1" = "pr" ]; then',
    '  case "$2" in',
    '    list) if [ "$GH_STUB_LIST_FAIL" = "1" ]; then exit 1; fi; printf "%s" "$GH_STUB_EXISTING" ;;',
    '    create|edit) if [ "$GH_STUB_WRITE_FAIL" = "1" ]; then exit 1; fi ;;',
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
      GH_STUB_LATEST_TAG: PINNED_TAG,
      GH_STUB_ATTACHMENTS: `redpanda-properties-${PINNED_TAG}.json`,
      CORPUS_DIR,
      ...env,
    },
  });
  return { ...result, ghCalls: fs.readFileSync(ghCallLog, 'utf8') };
}

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

/**
 * A throwaway checkout holding a copy of the committed corpus, on main, with
 * a bare repo as its remote. Returns the env that points the script at it.
 */
function makeCheckout () {
  const root = fs.mkdtempSync(path.join(harnessDir, 'checkout-'));
  const work = path.join(root, 'work');
  const remote = path.join(root, 'remote.git');
  const corpus = path.join(work, 'corpus');
  fs.mkdirSync(corpus, { recursive: true });
  for (const f of ['property-overrides.json', 'property-snapshot.json']) {
    fs.copyFileSync(path.join(CORPUS_DIR, f), path.join(corpus, f));
  }
  git(root, 'init', '--quiet', '--bare', remote);
  git(work, 'init', '--quiet', '-b', 'main');
  git(work, 'add', '.');
  git(work, '-c', 'user.name=Someone', '-c', 'user.email=someone@example.com', 'commit', '--quiet', '-m', 'base');
  git(work, 'push', '--quiet', remote, 'main');
  return { work, remote, corpus, env: { CORPUS_DIR: corpus, GIT_REMOTE_URL: remote } };
}

const remoteHead = (remote, branch = 'bot/refresh-property-corpus') => {
  try { return git(remote, 'rev-parse', `refs/heads/${branch}`); } catch { return null; }
};
const remoteFile = (remote, file) =>
  git(remote, 'show', `bot/refresh-property-corpus:corpus/${file}`);

describe('property-corpus-drift.sh', () => {
  test('runs from the relative path the workflow uses', () => {
    // The workflow runs `bash .github/scripts/property-corpus-drift.sh` from
    // the checkout, so BASH_SOURCE is relative. The snapshot derivation is
    // required from next to the script, and a bare relative path handed to
    // require() resolves as a package name, not a file.
    setLive({ matching: true });
    fs.writeFileSync(ghCallLog, '');
    const result = spawnSync('bash', [path.relative(repoRoot, SCRIPT_PATH)], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { PATH: hermeticPath, HOME: harnessDir, GH_STUB_CALL: ghCallLog, GH_STUB_LIVE: liveDir, GH_STUB_EXISTING: '', CORPUS_DIR },
    });
    expect(result.stderr).not.toMatch(/Cannot find module/);
    expect(result.status).toBe(0);
  });

  it('exits 0 and opens nothing when the mirror matches the docs repo', () => {
    setLive({ matching: true });
    const { status, stdout, ghCalls } = run();
    expect(status).toBe(0);
    expect(stdout).toMatch(/matches redpanda-data\/docs@main/);
    expect(ghCalls).not.toMatch(/pr (create|edit)/);
  });

  it('exits 1, pushes the refresh, and opens one PR when entries are missing from the mirror', () => {
    setLive({ matching: false, dropEntries: 3 });
    const { env, remote, corpus } = makeCheckout();
    const { status, stdout, ghCalls } = run(env);
    expect(status).toBe(1);
    expect(stdout).toMatch(/Drift found/);
    expect(stdout).toMatch(/property-overrides\.json/);
    expect(stdout).toMatch(/Pushed the refresh/);
    expect(ghCalls).toMatch(/pr create .*--head bot\/refresh-property-corpus/);
    expect(ghCalls).not.toMatch(/pr edit/);
    // The pushed overrides are a byte copy of the live file, and the commit
    // is the bot's, so a later run recognizes the branch as its own.
    expect(remoteFile(remote, 'property-overrides.json'))
      .toBe(fs.readFileSync(path.join(liveDir, 'property-overrides.json'), 'utf8'));
    expect(git(remote, 'log', '-1', '--format=%ae', 'bot/refresh-property-corpus')).toBe(BOT_EMAIL);
    // Scoped to the two corpus files: nothing else in the checkout is committed.
    const changed = git(remote, 'diff', '--name-only', 'main', 'bot/refresh-property-corpus').split('\n');
    expect(changed).toContain('corpus/property-overrides.json');
    for (const file of changed) {
      expect(['corpus/property-overrides.json', 'corpus/property-snapshot.json']).toContain(file);
    }
    // Proof the refresh is the recipe the check compares against: rerunning
    // the check on the refreshed files finds no drift.
    expect(fs.existsSync(corpus)).toBe(true);
    expect(run({ ...env, OPEN_PR: 'false' }).status).toBe(0);
  });

  it('detects a field-value change even when the property count matches', () => {
    // The snapshot is a reduction, so a changed description is invisible to a
    // count comparison. This is the case a naive length check would miss.
    setLive({ matching: false, changeField: true });
    const { status, stdout } = run({ OPEN_PR: 'false' });
    expect(status).toBe(1);
    expect(stdout).toMatch(/property-snapshot\.json/);
    expect(stdout).toMatch(/same count, so the difference is in the field values/);
  });

  it('refreshes to the highest live tag when the pinned tag has been renamed forward on the docs side', () => {
    // docs' regen renames the attachment file forward on every release, so
    // any tag the corpus is still pinned to eventually 404s. That is drift in
    // its own right -- the corpus cannot be compared against a tag with no
    // live file -- and must reach a PR, not just a red Actions run: exit 2
    // never opens one, which is exactly how this went unnoticed before.
    //
    // v26.2.10 against v26.2.9 is a version sort, not a string sort, and the
    // change report beside them is not a properties file at all.
    setLive({ matching: true });
    const { env, remote } = makeCheckout();
    const { status, stdout, ghCalls } = run({
      ...env,
      GH_STUB_ATTACHMENT_404: '1',
      GH_STUB_LATEST_TAG: 'v26.2.10',
      GH_STUB_ATTACHMENTS: 'redpanda-properties-v26.2.9.json redpanda-properties-v26.2.10.json redpanda-property-changes-v26.2.9-to-v26.2.10.json',
    });
    expect(status).toBe(1);
    expect(stdout).toMatch(/no longer exists on redpanda-data\/docs@main/);
    expect(ghCalls).toMatch(/redpanda-properties-v26\.2\.10\.json/);
    expect(JSON.parse(remoteFile(remote, 'property-snapshot.json')).source_tag).toBe('v26.2.10');
    expect(ghCalls).toMatch(/pr create .*--title test\(property-extractor\): refresh the overrides corpus to docs main and v26\.2\.10/);
  });

  it('refreshes to the GA tag, not its RC, when both attachments are on docs main', () => {
    // sort -V puts v26.3.1-rc1 above v26.3.1, so without the GA filter the
    // refresh would pin the snapshot to the RC.
    setLive({ matching: true });
    const { env, remote } = makeCheckout();
    const { status, ghCalls } = run({
      ...env,
      GH_STUB_ATTACHMENT_404: '1',
      GH_STUB_LATEST_TAG: 'v26.3.1',
      GH_STUB_ATTACHMENTS: 'redpanda-properties-v26.2.9.json redpanda-properties-v26.3.1-rc1.json redpanda-properties-v26.3.1.json',
    });
    expect(status).toBe(1);
    expect(ghCalls).not.toMatch(/redpanda-properties-v26\.3\.1-rc1\.json/);
    expect(JSON.parse(remoteFile(remote, 'property-snapshot.json')).source_tag).toBe('v26.3.1');
  });

  it('still refreshes to an RC when its x.y.z has no GA attachment yet', () => {
    setLive({ matching: true });
    const { env, remote } = makeCheckout();
    const { status } = run({
      ...env,
      GH_STUB_ATTACHMENT_404: '1',
      GH_STUB_LATEST_TAG: 'v26.4.0-rc2',
      GH_STUB_ATTACHMENTS: 'redpanda-properties-v26.3.1.json redpanda-properties-v26.4.0-rc2.json',
    });
    expect(status).toBe(1);
    expect(JSON.parse(remoteFile(remote, 'property-snapshot.json')).source_tag).toBe('v26.4.0-rc2');
  });

  it('fails closed with 2 when no properties attachment can be found to refresh against', () => {
    setLive({ matching: false, dropEntries: 3 });
    const { env } = makeCheckout();
    for (const extra of [{ GH_STUB_LISTING_FAIL: '1' }, { GH_STUB_ATTACHMENTS: 'redpanda-property-changes-v1-to-v2.json' }]) {
      const { status, stderr, ghCalls } = run({ ...env, ...extra });
      expect(status).toBe(2);
      expect(stderr).toMatch(/could not find a redpanda-properties-<tag>\.json attachment/);
      expect(ghCalls).not.toMatch(/pr (create|edit)/);
    }
  });

  it('still reports the overrides drift alongside a renamed-forward tag', () => {
    setLive({ matching: false, dropEntries: 3 });
    const { status, stdout } = run({ GH_STUB_ATTACHMENT_404: '1', GH_STUB_LATEST_TAG: 'v99.0.0', OPEN_PR: 'false' });
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
    expect(ghCalls).not.toMatch(/pr (create|edit)/);
  });

  it('updates the open PR instead of opening a duplicate', () => {
    setLive({ matching: false, dropEntries: 3 });
    const { env } = makeCheckout();
    const { status, stdout, ghCalls } = run({ ...env, GH_STUB_EXISTING: '4321' });
    expect(status).toBe(1);
    expect(stdout).toMatch(/Updated existing pull request .*#4321/);
    expect(ghCalls).toMatch(/pr edit 4321/);
    expect(ghCalls).not.toMatch(/pr create/);
  });

  it('does not push again when the bot branch already holds this refresh', () => {
    // A weekly run against unchanged drift would otherwise force-push a new
    // commit with the same content every Monday.
    setLive({ matching: false, dropEntries: 3 });
    const checkout = makeCheckout();
    expect(run(checkout.env).status).toBe(1);
    const first = remoteHead(checkout.remote);

    const again = makeCheckout();
    const { status, stdout } = run({ ...again.env, GIT_REMOTE_URL: checkout.remote, GH_STUB_EXISTING: '4321' });
    expect(status).toBe(1);
    expect(stdout).toMatch(/already holds this refresh/);
    expect(remoteHead(checkout.remote)).toBe(first);
  });

  // A bot branch whose head is someone else's commit, as after a fix is pushed to it.
  function botBranchWithHumanHead () {
    setLive({ matching: false, dropEntries: 3 });
    const checkout = makeCheckout();
    expect(run(checkout.env).status).toBe(1);
    const fixer = path.join(harnessDir, `fixer-${Date.now()}`);
    git(harnessDir, 'clone', '--quiet', '--branch', 'bot/refresh-property-corpus', checkout.remote, fixer);
    fs.writeFileSync(path.join(fixer, 'fix.txt'), 'a fix');
    git(fixer, 'add', 'fix.txt');
    git(fixer, '-c', 'user.name=Someone', '-c', 'user.email=someone@example.com', 'commit', '--quiet', '-m', 'fix');
    git(fixer, 'push', '--quiet', 'origin', 'bot/refresh-property-corpus');
    return { remote: checkout.remote, fixed: remoteHead(checkout.remote) };
  }

  it('exits 3 and never pushes over a commit someone else added while the PR is open', () => {
    // A refresh that exposes a bug gets its fix on this branch, as PR 329's
    // did. Force-pushing next Monday would throw that fix away.
    const { remote, fixed } = botBranchWithHumanHead();
    setLive({ matching: false, dropEntries: 5 });
    const again = makeCheckout();
    const { status, stderr, ghCalls } = run({ ...again.env, GIT_REMOTE_URL: remote, GH_STUB_EXISTING: '4321' });
    expect(status).toBe(3);
    expect(stderr).toMatch(/has a commit from someone@example\.com/);
    expect(remoteHead(remote)).toBe(fixed);
    expect(ghCalls).not.toMatch(/pr (create|edit)/);
  });

  it('rebuilds the branch and opens a new PR when the PR with a human commit was closed', () => {
    // GitHub deletes the branch only on merge, so a closed PR leaves the human
    // commit at its head. Guarding it with no PR open stalls the job silently.
    const { remote, fixed } = botBranchWithHumanHead();
    setLive({ matching: false, dropEntries: 5 });
    const again = makeCheckout();
    const { status, stdout, ghCalls } = run({ ...again.env, GIT_REMOTE_URL: remote });
    expect(status).toBe(1);
    expect(stdout).toMatch(/no open pull request, so rebuilding it/);
    expect(remoteHead(remote)).not.toBe(fixed);
    expect(git(remote, 'log', '-1', '--format=%ae', 'bot/refresh-property-corpus')).toBe(BOT_EMAIL);
    expect(ghCalls).toMatch(/pr create .*--head bot\/refresh-property-corpus/);
  });

  it('fails closed with 2 when the remote cannot be read, rather than taking it for "no branch yet"', () => {
    // ls-remote exits 2 only for a missing branch. Any other failure read as
    // "no branch" would go on to force-push over whatever is there.
    setLive({ matching: false, dropEntries: 3 });
    const { env } = makeCheckout();
    const { status, stderr, ghCalls } = run({ ...env, GIT_REMOTE_URL: path.join(harnessDir, 'no-such-remote.git') });
    expect(status).toBe(2);
    expect(stderr).toMatch(/could not read bot\/refresh-property-corpus/);
    expect(ghCalls).not.toMatch(/pr (create|edit)/);
  });

  it('fails closed with 2 when the push itself fails', () => {
    setLive({ matching: false, dropEntries: 3 });
    const { env, remote } = makeCheckout();
    // A pre-receive hook that rejects everything: the remote reads fine, the push does not.
    fs.writeFileSync(path.join(remote, 'hooks', 'pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const { status, stderr, ghCalls } = run(env);
    expect(status).toBe(2);
    expect(stderr).toMatch(/could not commit and push/);
    expect(ghCalls).not.toMatch(/pr (create|edit)/);
  });

  it('fails closed with 2 when the corpus is not in a git checkout', () => {
    setLive({ matching: false, dropEntries: 3 });
    const loose = fs.mkdtempSync(path.join(harnessDir, 'loose-'));
    for (const f of ['property-overrides.json', 'property-snapshot.json']) {
      fs.copyFileSync(path.join(CORPUS_DIR, f), path.join(loose, f));
    }
    const { status, stderr } = run({ CORPUS_DIR: loose });
    expect(status).toBe(2);
    expect(stderr).toMatch(/not inside a git checkout/);
  });

  it('fails closed with 2 and files nothing when the docs repo cannot be read', () => {
    // The whole point: unreachable must never read as "current".
    setLive({ matching: true });
    const { status, stderr, ghCalls } = run({ GH_STUB_API_FAIL: '1' });
    expect(status).toBe(2);
    expect(stderr).toMatch(/could not be determined/);
    expect(ghCalls).not.toMatch(/pr (create|edit)/);
  });

  it('fails closed with 2 when it cannot list pull requests', () => {
    setLive({ matching: false, dropEntries: 3 });
    const { env } = makeCheckout();
    const { status, stderr } = run({ ...env, GH_STUB_LIST_FAIL: '1' });
    expect(status).toBe(2);
    expect(stderr).toMatch(/could not list pull requests/);
  });

  it('fails closed with 2 when the PR write fails', () => {
    setLive({ matching: false, dropEntries: 3 });
    const { env } = makeCheckout();
    const { status, stderr } = run({ ...env, GH_STUB_WRITE_FAIL: '1' });
    expect(status).toBe(2);
    expect(stderr).toMatch(/could not open a pull request/);
  });

  it('reports drift without refreshing when OPEN_PR is not true', () => {
    // A pull request that updates the corpus is ahead of docs main by design.
    // Left to itself the check filed an issue against the very branch fixing
    // it, which is noise a human is already looking at.
    setLive({ matching: false, dropEntries: 3 });
    const before = fs.readFileSync(path.join(CORPUS_DIR, 'property-overrides.json'), 'utf8');
    const { status, stdout, ghCalls } = run({ OPEN_PR: 'false' });
    expect(status).toBe(1);
    expect(stdout).toMatch(/Drift found/);
    expect(stdout).toMatch(/Not opening a refresh PR/);
    expect(ghCalls).not.toMatch(/pr (create|edit|list)/);
    expect(fs.readFileSync(path.join(CORPUS_DIR, 'property-overrides.json'), 'utf8')).toBe(before);
  });

  it('names what differs when both sides have the same entries', () => {
    // "438 entries live, 438 in the mirror" on its own says nothing about what
    // changed, which is exactly what the first real CI run reported.
    setLive({ matching: false, changeEntry: true });
    const { status, stdout } = run({ OPEN_PR: 'false' });
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
    // Exit 3, drift left to someone else's open PR, gets its own notice.
    expect(text).toMatch(/3\)\s*echo "::notice::.*left alone/);
    expect(text).toMatch(/\*\)\s*echo "::error::.*exit 1/s);
  });

  it('skips on a fork PR, which cannot have the credential', () => {
    expect(workflow()).toMatch(/head\.repo\.full_name == github\.repository/);
  });

  it('passes the bot token, since the docs repo is private', () => {
    expect(workflow()).toMatch(/GH_TOKEN: \$\{\{ env\.ACTIONS_BOT_TOKEN \}\}/);
  });

  it('does not persist github.token in the checkout, since the script pushes with the bot token', () => {
    const doc = YAML.parse(workflow());
    const checkout = Object.values(doc.jobs)[0].steps.find((s) => String(s.uses).startsWith('actions/checkout'));
    expect(checkout.with['persist-credentials']).toBe(false);
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

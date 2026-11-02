'use strict';

// Executes .github/scripts/guard-generated-files.sh, the bash that
// .github/workflows/guard-generated-files.yml embeds, against a stubbed `gh`.
//
// The guard is a merge gate, so what these tests mostly pin is the fail-closed
// behaviour: an API error, a truncated changed-file list, a missing pull request
// context or an unreadable label list must exit non-zero. A gate that cannot
// fail is worth nothing, so every fail-closed case has a matching negative
// control that proves the same script still exits 0 on a genuinely clean PR.
//
// The harness is hermetic: PATH contains only the stub `gh` and symlinks to the
// utilities the script uses, so the machine's real gh can never answer.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const embed = require('../../.github/scripts/embed-guard-script.js');

const SCRIPT_PATH = embed.SCRIPT_PATH;
const HERMETIC_TOOLS = ['bash', 'sh', 'sed', 'awk', 'grep', 'jq', 'cat', 'mktemp', 'rm'];

let harnessDir;
let stubDir;
let toolDir;
let hermeticPath;

function which(tool) {
  return execFileSync('/usr/bin/which', [tool], { encoding: 'utf8' }).trim();
}

beforeAll(() => {
  harnessDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-generated-files-'));
  stubDir = path.join(harnessDir, 'stub');
  toolDir = path.join(harnessDir, 'tools');
  fs.mkdirSync(stubDir);
  fs.mkdirSync(toolDir);
  for (const tool of HERMETIC_TOOLS) {
    fs.symlinkSync(which(tool), path.join(toolDir, tool));
  }
  // The stub answers `gh api ... --jq <filter>` by running the real filter over
  // a JSON fixture, so the script's own jq expression is under test too.
  fs.writeFileSync(path.join(stubDir, 'gh'), [
    '#!/bin/sh',
    'echo "$*" > "$GH_STUB_CALL"',
    'case "${GH_STUB_MODE:-ok}" in',
    '  fail403)',
    '    echo "gh: Resource not accessible by integration (HTTP 403)" >&2; exit 1 ;;',
    '  authfail)',
    '    echo "gh: To use GitHub CLI in a GitHub Actions workflow, set the GH_TOKEN environment variable." >&2; exit 4 ;;',
    '  notfound)',
    '    case "$*" in',
    '      *pulls//files*) echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;',
    '    esac ;;',
    'esac',
    'filter=""',
    'prev=""',
    'for arg in "$@"; do',
    '  if [ "$prev" = "--jq" ]; then filter=$arg; fi',
    '  prev=$arg',
    'done',
    'jq -r "$filter" < "$GH_STUB_JSON"',
    '',
  ].join('\n'), { mode: 0o755 });
  hermeticPath = `${stubDir}:${toolDir}`;
});

afterAll(() => {
  fs.rmSync(harnessDir, { recursive: true, force: true });
});

/**
 * Run the guard.
 *
 * @param {object} options
 * @param {Array<string|object>} options.files changed files, as paths or
 *   `{ filename, previous_filename }` objects, exactly as the API reports them.
 */
function runGuard(options = {}) {
  const {
    files = [],
    generatedPaths = 'modules/reference/partials/generated/',
    excludePaths = '',
    allowLabels = 'auto-docs',
    prLabels = '[]',
    prNumber = '42',
    eventName = 'pull_request',
    stubMode = 'ok',
    withGh = true,
  } = options;

  const fixture = files.map((file) => (typeof file === 'string' ? { filename: file } : file))
    .map((file) => ({ filename: file.filename, previous_filename: file.previous_filename || null }));
  const jsonPath = path.join(harnessDir, 'files.json');
  const callPath = path.join(harnessDir, 'gh-call.txt');
  fs.writeFileSync(jsonPath, JSON.stringify(fixture));
  fs.writeFileSync(callPath, '');

  const env = {
    PATH: withGh ? hermeticPath : toolDir,
    HOME: harnessDir,
    TMPDIR: harnessDir,
    GH_TOKEN: 'stub-token',
    GH_STUB_MODE: stubMode,
    GH_STUB_JSON: jsonPath,
    GH_STUB_CALL: callPath,
    EVENT_NAME: eventName,
    REPO: 'redpanda-data/docs',
    PR_NUMBER: prNumber,
    GENERATED_PATHS: generatedPaths,
    EXCLUDE_PATHS: excludePaths,
    ALLOW_LABELS: allowLabels,
  };
  if (prLabels !== null) env.PR_LABELS_JSON = prLabels;

  const result = spawnSync(which('bash'), [SCRIPT_PATH], { env, encoding: 'utf8' });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    output: `${result.stdout || ''}${result.stderr || ''}`,
    ghCall: fs.readFileSync(callPath, 'utf8').trim(),
  };
}

const GENERATED_FILE = 'modules/reference/partials/generated/props.adoc';

describe('guard-generated-files: the gate can fail and can pass', () => {
  test('flags a generated file changed without an allow label', () => {
    const run = runGuard({ files: [GENERATED_FILE] });
    expect(run.status).toBe(1);
    expect(run.output).toContain(`::error file=${GENERATED_FILE}::Auto-generated file edited by hand`);
  });

  test('passes a PR that touches nothing generated', () => {
    const run = runGuard({ files: ['modules/ROOT/pages/index.adoc'] });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('No generated files changed.');
  });

  test('passes a generated change that carries an allow label', () => {
    const run = runGuard({ files: [GENERATED_FILE], prLabels: '["auto-docs"]' });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("PR has the 'auto-docs' label");
  });
});

describe('guard-generated-files: fails closed when it cannot check', () => {
  test('a 403 from the API fails the check instead of reporting green', () => {
    const run = runGuard({ files: ['modules/ROOT/pages/index.adoc'], stubMode: 'fail403' });
    expect(run.status).not.toBe(0);
    expect(run.output).toContain('::error::Could not list the changed files');
    expect(run.output).toContain('permissions: pull-requests: read');
    expect(run.stdout).not.toContain('No generated files changed.');
  });

  test('an unauthenticated gh fails the check', () => {
    const run = runGuard({ files: ['modules/ROOT/pages/index.adoc'], stubMode: 'authfail' });
    expect(run.status).not.toBe(0);
    expect(run.output).toContain('::error::Could not list the changed files');
  });

  test('a missing gh fails the check', () => {
    const run = runGuard({ files: ['modules/ROOT/pages/index.adoc'], withGh: false });
    expect(run.status).not.toBe(0);
    expect(run.output).toContain('gh CLI not found');
  });

  test('a changed-file list at the API 3000-file cap fails the check', () => {
    const padding = [];
    for (let i = 0; i < 3000; i += 1) padding.push(`modules/ROOT/pages/pad-${i}.adoc`);
    const run = runGuard({ files: padding });
    expect(run.status).not.toBe(0);
    expect(run.output).toContain("3000-file limit");
    expect(run.stdout).not.toContain('No generated files changed.');
  });

  test('a large but complete changed-file list still passes', () => {
    const padding = [];
    for (let i = 0; i < 2999; i += 1) padding.push(`modules/ROOT/pages/pad-${i}.adoc`);
    const run = runGuard({ files: padding });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('No generated files changed.');
  });

  test('a non-pull_request caller event fails the check instead of passing', () => {
    for (const eventName of ['merge_group', 'push', 'workflow_dispatch', 'schedule']) {
      const run = runGuard({ files: [GENERATED_FILE], eventName, prNumber: '' });
      expect(run.status).not.toBe(0);
      expect(run.output).toContain('runs on pull_request events only');
      expect(run.ghCall).toBe('');
    }
  });

  test('an empty PR number fails before building a malformed API URL', () => {
    const run = runGuard({ files: [GENERATED_FILE], prNumber: '', stubMode: 'notfound' });
    expect(run.status).not.toBe(0);
    expect(run.output).toContain('PR_NUMBER is empty');
    expect(run.ghCall).toBe('');
  });

  test('labels that are not a JSON array fail with a readable error, not a jq stack trace', () => {
    for (const prLabels of ['null', '']) {
      const run = runGuard({ files: [GENERATED_FILE], prLabels });
      expect(run.status).not.toBe(0);
      expect(run.output).toContain('Could not read the pull request labels');
      expect(run.output).not.toContain('Cannot iterate over null');
    }
    const unset = runGuard({ files: [GENERATED_FILE], prLabels: null });
    expect(unset.status).not.toBe(0);
    expect(unset.output).toContain('Could not read the pull request labels');
  });

  test('an empty generated-paths or allow-labels input fails the check', () => {
    const noPaths = runGuard({ files: [GENERATED_FILE], generatedPaths: '   \n  ' });
    expect(noPaths.status).not.toBe(0);
    expect(noPaths.output).toContain('generated-paths input is empty');

    const noLabels = runGuard({ files: [GENERATED_FILE], allowLabels: '' });
    expect(noLabels.status).not.toBe(0);
    expect(noLabels.output).toContain('allow-labels input is empty');
  });
});

describe('guard-generated-files: paths match at a path boundary', () => {
  test('an exclusion written for a directory does not exempt its siblings', () => {
    const run = runGuard({
      files: ['modules/reference/partials/generated/hand-written-props.adoc'],
      excludePaths: 'modules/reference/partials/generated/hand-written',
    });
    expect(run.status).toBe(1);
    expect(run.output).toContain('::error file=modules/reference/partials/generated/hand-written-props.adoc::');
  });

  test('an exclusion still exempts the directory it was written for', () => {
    const run = runGuard({
      files: ['modules/reference/partials/generated/hand-written/notes.adoc'],
      excludePaths: 'modules/reference/partials/generated/hand-written',
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('No generated files changed.');
  });

  test('an exclusion written as an exact file does not exempt name extensions', () => {
    const run = runGuard({
      files: [
        'modules/reference/partials/generated/overview.adoc.bak',
        'modules/reference/partials/generated/overview.adocx',
      ],
      excludePaths: 'modules/reference/partials/generated/overview.adoc',
    });
    expect(run.status).toBe(1);
    expect(run.output).toContain('::error file=modules/reference/partials/generated/overview.adoc.bak::');
    expect(run.output).toContain('::error file=modules/reference/partials/generated/overview.adocx::');
  });

  test('a generated path written as an exact file does not flag name extensions', () => {
    const run = runGuard({
      files: ['modules/reference/pages/rpk/index.adoc.bak', 'modules/reference/pages/rpk/index.adoc-notes.md'],
      generatedPaths: 'modules/reference/pages/rpk/index.adoc',
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('No generated files changed.');
  });

  test('a generated path written as an exact file still flags that file', () => {
    const run = runGuard({
      files: ['modules/reference/pages/rpk/index.adoc'],
      generatedPaths: 'modules/reference/pages/rpk/index.adoc',
    });
    expect(run.status).toBe(1);
  });

  test('a directory written without a trailing slash does not flag a similarly named sibling', () => {
    const run = runGuard({
      files: ['modules/reference/partials/generated-by-hand/notes.adoc'],
      generatedPaths: 'modules/reference/partials/generated',
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('No generated files changed.');
  });

  test('paths containing spaces and glob metacharacters are matched literally', () => {
    const excluded = runGuard({
      files: ['docs/my notes/x.adoc'],
      generatedPaths: 'docs/',
      excludePaths: 'docs/my notes/',
    });
    expect(excluded.status).toBe(0);

    const flagged = runGuard({ files: ['docs/my notes/x.adoc'], generatedPaths: 'docs/my notes/' });
    expect(flagged.status).toBe(1);
    expect(flagged.output).toContain('::error file=docs/my notes/x.adoc::');

    const noGlob = runGuard({ files: ['modules/genX/a.adoc'], generatedPaths: 'modules/gen*/' });
    expect(noGlob.status).toBe(0);
  });
});

describe('guard-generated-files: input lists are parsed the same way', () => {
  test('an over-indented generated path still guards its tree', () => {
    const run = runGuard({
      files: ['modules/reference/partials/rpk/rpk-topic.adoc'],
      generatedPaths: 'modules/reference/partials/generated/\n  modules/reference/partials/rpk/',
    });
    expect(run.status).toBe(1);
    expect(run.output).toContain('::error file=modules/reference/partials/rpk/rpk-topic.adoc::');
  });

  test('an over-indented exclude path still exempts its tree', () => {
    const run = runGuard({
      files: ['modules/reference/partials/generated/hand-written/notes.adoc'],
      excludePaths: 'modules/reference/partials/generated/other\n  modules/reference/partials/generated/hand-written/',
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('No generated files changed.');
  });

  test('an over-indented allow label is still honoured', () => {
    const run = runGuard({
      files: [GENERATED_FILE],
      allowLabels: 'auto-docs\n  docs-bot',
      prLabels: '["docs-bot"]',
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("PR has the 'docs-bot' label");
  });

  test('the allow-label list is rendered as a comma-separated list', () => {
    const run = runGuard({
      files: [GENERATED_FILE],
      allowLabels: 'auto-docs\ngenerated\ndocs-bot',
    });
    expect(run.status).toBe(1);
    expect(run.output).toContain('(auto-docs, generated, docs-bot)');
    expect(run.output).not.toContain('auto-docs,generated docs-bot');
  });

  test('label matching is exact', () => {
    const substring = runGuard({ files: [GENERATED_FILE], prLabels: '["auto-docs-extra"]' });
    expect(substring.status).toBe(1);

    const wrongCase = runGuard({ files: [GENERATED_FILE], prLabels: '["Auto-Docs"]' });
    expect(wrongCase.status).toBe(1);
  });
});

describe('guard-generated-files: renames', () => {
  test('moving a generated file out of a generated directory is flagged', () => {
    const run = runGuard({
      files: [{
        filename: 'modules/reference/partials/handwritten/props.adoc',
        previous_filename: GENERATED_FILE,
      }],
    });
    expect(run.status).toBe(1);
    expect(run.output).toContain(`::error file=${GENERATED_FILE}::`);
  });

  test('moving an unrelated file is not flagged', () => {
    const run = runGuard({
      files: [{
        filename: 'modules/ROOT/pages/b.adoc',
        previous_filename: 'modules/ROOT/pages/a.adoc',
      }],
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('No generated files changed.');
  });

  test('a file is reported once even when both of its paths are generated', () => {
    const run = runGuard({
      files: [{
        filename: GENERATED_FILE,
        previous_filename: GENERATED_FILE,
      }],
    });
    expect(run.status).toBe(1);
    const annotations = run.output.split('\n').filter((line) => line.startsWith('::error file='));
    expect(annotations).toHaveLength(1);
  });
});

describe('guard-generated-files.yml', () => {
  test('embeds the script verbatim', () => {
    const result = embed.check();
    expect(result.problems).toEqual([]);
  });

  test('declares the permissions the API call needs, on the job and in the caller example', () => {
    const workflow = fs.readFileSync(embed.WORKFLOW_PATH, 'utf8');
    const parsed = require('js-yaml').load(workflow);
    const job = parsed.jobs['block-manual-edits'];
    expect(job.permissions).toEqual({ contents: 'none', 'pull-requests': 'read' });
    expect(job['timeout-minutes']).toBeGreaterThan(0);
    // The caller's job is what actually scopes the token, so the copy-paste
    // example has to grant it as well.
    const example = workflow.split('name: guard-generated-files')[0];
    expect(example).toContain('#       permissions:');
    expect(example).toContain('#         pull-requests: read');
  });

  test('passes the caller event name to the script', () => {
    const parsed = require('js-yaml').load(fs.readFileSync(embed.WORKFLOW_PATH, 'utf8'));
    const step = parsed.jobs['block-manual-edits'].steps.slice(-1)[0];
    expect(step.env.EVENT_NAME).toBe('${{ github.event_name }}');
  });
});

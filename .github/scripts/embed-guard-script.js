#!/usr/bin/env node
'use strict';

// Keeps .github/workflows/guard-generated-files.yml in sync with
// .github/scripts/guard-generated-files.sh.
//
// A reusable workflow runs in the caller's repository and cannot read files out
// of this one, so the guard's bash has to live inline in the workflow. The
// script file is the source of truth and this generator embeds it, so the bash
// stays directly testable and lintable instead of being trapped in YAML.
//
//   node .github/scripts/embed-guard-script.js          # report drift, exit 1 if any
//   node .github/scripts/embed-guard-script.js --write  # re-embed
//
// __tests__/workflows/guard-generated-files.test.js calls check() so drift fails
// the test suite.

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT_PATH = path.join(REPO_ROOT, '.github', 'scripts', 'guard-generated-files.sh');
const WORKFLOW_PATH = path.join(REPO_ROOT, '.github', 'workflows', 'guard-generated-files.yml');
const RUN_MARKER = '        run: |';
const INDENT = ' '.repeat(10);

function build() {
  const script = fs.readFileSync(SCRIPT_PATH, 'utf8');
  const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');
  const lines = workflow.split('\n');
  const runIndex = lines.indexOf(RUN_MARKER);
  if (runIndex === -1) {
    throw new Error(`Could not find a "${RUN_MARKER.trim()}" line in ${WORKFLOW_PATH}`);
  }
  const head = lines.slice(0, runIndex + 1);
  const body = script.replace(/\n$/, '').split('\n')
    .map((line) => (line === '' ? '' : INDENT + line));
  return {
    scriptPath: SCRIPT_PATH,
    workflowPath: WORKFLOW_PATH,
    script,
    actual: workflow,
    expected: head.concat(body, ['']).join('\n'),
  };
}

// The embedded block has to parse back out of the YAML as the script, byte for
// byte, or the workflow is not running the code the tests exercise.
function embeddedScript(workflowSource) {
  const parsed = yaml.load(workflowSource);
  const steps = parsed.jobs['block-manual-edits'].steps;
  return steps[steps.length - 1].run;
}

function check() {
  const built = build();
  const problems = [];
  if (built.actual !== built.expected) {
    problems.push('the workflow does not match the embedded script');
  }
  let embedded;
  try {
    embedded = embeddedScript(built.actual);
  } catch (err) {
    problems.push(`the workflow YAML does not parse: ${err.message}`);
  }
  if (embedded !== undefined && embedded !== built.script) {
    problems.push('the run: block does not parse back out as the script');
  }
  return Object.assign(built, { problems });
}

function write() {
  const built = build();
  fs.writeFileSync(built.workflowPath, built.expected);
  return built;
}

if (require.main === module) {
  if (process.argv.includes('--write')) {
    write();
    console.log('Embedded .github/scripts/guard-generated-files.sh into .github/workflows/guard-generated-files.yml');
  } else {
    const result = check();
    if (result.problems.length > 0) {
      console.error(`guard-generated-files.yml is out of date: ${result.problems.join('; ')}.`);
      console.error('Run: node .github/scripts/embed-guard-script.js --write');
      process.exit(1);
    }
    console.log('guard-generated-files.yml matches .github/scripts/guard-generated-files.sh');
  }
}

module.exports = { build, check, write, embeddedScript, SCRIPT_PATH, WORKFLOW_PATH };

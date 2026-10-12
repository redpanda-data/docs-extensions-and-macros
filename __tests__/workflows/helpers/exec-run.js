'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

/**
 * Execute one step's `run:` body the way the runner does, for any workflow.
 *
 * GitHub Actions substitutes ${{ }} expressions textually BEFORE handing the
 * body to bash, then runs it as `bash -e {0}`. Both details matter: textual
 * substitution is what makes an unquoted input injectable, and `-e` without
 * `-o pipefail` is what let a failing gh in a pipeline look like success.
 *
 * `defaults` supplies the expression map a given workflow's tests want
 * resolved; `expressions` overrides per call.
 */
function execRun (step, { env = {}, stubs = {}, expressions = {}, files = {}, defaults = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-step-'))
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin)

  for (const [name, body] of Object.entries(stubs)) {
    const p = path.join(bin, name)
    fs.writeFileSync(p, body.startsWith('#!') ? body : `#!/bin/bash\n${body}\n`)
    fs.chmodSync(p, 0o755)
  }
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), body)
  }

  // Substituted the way the runner does it: textually, before bash. The map
  // covers the expressions an EARLIER version of this workflow inlined into
  // its run: bodies as well as the ones the current version uses, so a
  // regression that moves an input back inline still executes here and fails
  // on behaviour rather than on an unresolved-placeholder error.
  const allExpressions = {
    ...defaults,
    ...expressions
  }
  let body = step.run
  for (const [expr, value] of Object.entries(allExpressions)) {
    body = body.split(expr).join(value)
  }
  const unresolved = body.match(/\$\{\{[^}]*\}\}/g)
  if (unresolved) throw new Error(`unresolved expressions in step body: ${unresolved.join(', ')}`)

  const scriptPath = path.join(dir, 'step.sh')
  fs.writeFileSync(scriptPath, body)
  const outputFile = path.join(dir, 'github_output')
  fs.writeFileSync(outputFile, '')

  const result = spawnSync('/bin/bash', ['-e', scriptPath], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: dir,
      GITHUB_OUTPUT: outputFile,
      ...env
    }
  })

  const outputs = {}
  for (const line of fs.readFileSync(outputFile, 'utf8').split('\n')) {
    const m = line.match(/^([^=]+)=(.*)$/)
    if (m) outputs[m[1]] = m[2]
  }

  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    all: `${result.stdout || ''}${result.stderr || ''}`,
    outputs,
    dir,
    exists: (f) => fs.existsSync(path.join(dir, f)),
    size: (f) => (fs.existsSync(path.join(dir, f)) ? fs.statSync(path.join(dir, f)).size : -1),
    read: (f) => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), 'utf8') : null)
  }
}

module.exports = { execRun }

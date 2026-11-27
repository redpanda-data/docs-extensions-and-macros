'use strict'

// Runs the locate-strings analyzer's Go tests (tools/rpk-docs/scripts/
// locate-strings/main_test.go) so CI covers them. Skipped when Go is not on
// PATH.

const path = require('path')
const { spawnSync } = require('child_process')

const analyzerDir = path.join(__dirname, '..', '..', '..', 'tools', 'rpk-docs', 'scripts', 'locate-strings')
const hasGo = spawnSync('go', ['version'], { encoding: 'utf8' }).status === 0

;(hasGo ? describe : describe.skip)('locate-strings analyzer (go test)', () => {
  test('go vet and go test pass', () => {
    const vet = spawnSync('go', ['vet', './...'], { cwd: analyzerDir, encoding: 'utf8', timeout: 120000 })
    expect(vet.stderr).toBe('')
    expect(vet.status).toBe(0)
    const test = spawnSync('go', ['test', './...'], { cwd: analyzerDir, encoding: 'utf8', timeout: 120000 })
    if (test.status !== 0) console.error(test.stdout + test.stderr)
    expect(test.status).toBe(0)
  }, 180000)
})

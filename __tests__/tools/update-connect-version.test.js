const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const BIN = path.join(__dirname, '..', '..', 'bin', 'doc-tools.js')
const PRELOAD = path.join(__dirname, 'fixtures', 'fake-latest-connect.js')

function run (tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucv-'))
  fs.writeFileSync(path.join(dir, 'antora.yml'), 'name: ROOT\nversion: ~\nasciidoc:\n  attributes:\n    latest-connect-version: 4.100.0\n')
  const result = spawnSync('node', ['-r', PRELOAD, BIN, 'generate', 'update-connect-version'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, FAKE_CONNECT_TAG: tag },
  })
  const antora = fs.readFileSync(path.join(dir, 'antora.yml'), 'utf8')
  fs.rmSync(dir, { recursive: true, force: true })
  return { result, antora }
}

describe('generate update-connect-version without -v', () => {
  test('writes the latest release without its leading v', () => {
    const { result, antora } = run('v4.117.0')
    expect(result.status).toBe(0)
    expect(antora).toMatch(/latest-connect-version: 4\.117\.0\n/)
  })

  test('fails and leaves antora.yml alone when no release is found', () => {
    const { result, antora } = run('null')
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/could not fetch the latest Connect release/)
    expect(antora).toMatch(/latest-connect-version: 4\.100\.0\n/)
    expect(antora).not.toMatch(/null/)
  })
})

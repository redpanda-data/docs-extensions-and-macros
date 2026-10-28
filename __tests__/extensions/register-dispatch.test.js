'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

/**
 * Antora 3.1 decides how to call an extension's register function from its
 * .length (generator-context.js _registerExtensions): with .length 0 it calls
 * register() with no arguments, so the playbook entry's settings never arrive.
 * A parameter with a default does not count toward .length, which is how
 * `function ({ config = {} } = {})` silently ignored every playbook setting of
 * solutions-catalog and kapa-source-groups.
 *
 * These tests register extensions through Antora's real GeneratorContext, the
 * same code a build runs, and check that the settings take effect.
 */

const ROOT = path.join(__dirname, '..', '..')
const GeneratorContext = require(path.join(path.dirname(require.resolve('@antora/site-generator')), 'generator-context.js'))

/**
 * Register one extension the way `antora` does, from a playbook entry, with
 * a logger that records warnings. Returns the context and its listeners.
 */
async function registerViaAntora (request, settings = {}) {
  const ctx = new GeneratorContext(module)
  const logs = { warn: [], info: [], error: [], debug: [] }
  const logger = Object.fromEntries(Object.keys(logs).map((level) => [level, (...args) => logs[level].push(args.map(String).join(' '))]))
  ctx.getLogger = () => logger
  await GeneratorContext.start(ctx, { dir: ROOT, antora: { extensions: [{ require: request, ...settings }] }, site: { url: 'https://docs.redpanda.com' } })
  const handler = (event) => {
    const [listener] = ctx.rawListeners(event)
    return listener && ((vars) => listener.call(ctx, vars))
  }
  return { ctx, logs, handler }
}

describe('extension register functions under Antora\'s calling convention', () => {
  // solutions-catalog: see 'playbook settings through Antora' in
  // solutions-catalog.test.js, which runs the extension over its fixtures.

  test('kapa-source-groups reads mapping_file from the playbook', async () => {
    const missing = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kapa-dispatch-')), 'nope.json')
    const { logs, handler } = await registerViaAntora(path.join(ROOT, 'extensions', 'kapa-source-groups.js'), { mapping_file: missing })
    await handler('contentClassified')({ contentCatalog: { getComponents: async () => [] } })
    expect(logs.warn.join('\n')).toContain(missing)
  })

  // Every extension in this repository: one whose register function reads
  // config or playbook from its first parameter must have a .length Antora
  // passes arguments to.
  const files = execFileSync('git', ['ls-files', 'extensions'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((f) => f.endsWith('.js'))
  const registers = []
  for (const file of files) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8')
    if (!/(?:exports\.register\s*=|function register\s*\()/.test(src)) continue
    registers.push(file)
  }

  test('the scan finds the extensions', () => {
    expect(registers).toEqual(expect.arrayContaining(['extensions/solutions-catalog/index.js', 'extensions/kapa-source-groups.js', 'extensions/algolia-indexer/index.js']))
  })

  test.each(registers)('%s: a register function that takes settings gets them', (file) => {
    const { register } = require(path.join(ROOT, file))
    if (typeof register !== 'function') return
    const params = register.toString().slice(register.toString().indexOf('(') + 1).split(')')[0]
    if (!/\b(?:config|playbook)\b/.test(params)) return
    expect(register.length).toBeGreaterThan(0)
  })
})

#!/usr/bin/env node
'use strict'

/**
 * End-to-end test of the component catalog's Use case filter.
 *
 * Builds the preview's component-catalog page (preview/extensions-and-macros)
 * with Antora, using the macros and extensions in this working tree and the
 * fixtures next to this file: a connect component, the docs taxonomy's
 * use-case scheme, an info.csv with the use_cases column, and a solutions
 * catalog published where solutions-catalog publishes it. Then it drives the
 * built page in headless Chrome over the DevTools protocol (no browser
 * library needed): open the filter, pick Change data capture, check the
 * cards and the solutions links, close with Escape, clear the filter, and
 * fail on any page error.
 *
 *   npm run test:catalog-e2e
 *
 * Environment:
 *   CATALOG_E2E_CSV          an info.csv to use instead of fixtures/info.csv
 *   CATALOG_E2E_SCREENSHOTS  a directory to save screenshots in
 *   CATALOG_E2E_UI_BUNDLE    a UI bundle path or URL (default: the latest docs-ui release)
 *   CHROME_PATH              the Chrome or Chromium binary
 *
 * Needs network access only to download the UI bundle, which Antora caches.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { spawn, spawnSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..', '..', '..')
const FIXTURES = path.join(__dirname, 'fixtures')
const PAGE = '/preview/component-catalog/'
const USE_CASE = 'change-data-capture'
const USE_CASE_LABEL = 'Change data capture'

const started = Date.now()
const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)}s`
const log = (message) => console.log(`[catalog-e2e ${elapsed()}] ${message}`)

function relativeToRoot (file) {
  return path.relative(ROOT, file).split(path.sep).join('/')
}

// Antora reads local content only from a git repository with a .git
// directory, which a linked worktree of this repository does not have. Copy
// the content into a throwaway repository instead, so the test runs from any
// checkout and sees uncommitted changes.
function stageContent (dir) {
  const content = path.join(dir, 'content')
  const paths = {
    'preview/extensions-and-macros': path.join(ROOT, 'preview', 'extensions-and-macros'),
    'preview/shared': path.join(ROOT, 'preview', 'shared'),
    'fixtures/connect': path.join(FIXTURES, 'connect'),
    'fixtures/shared': path.join(FIXTURES, 'shared')
  }
  for (const [to, from] of Object.entries(paths)) fs.cpSync(from, path.join(content, to), { recursive: true })
  const git = (...args) => {
    const r = spawnSync('git', ['-c', 'user.name=catalog-e2e', '-c', 'user.email=catalog-e2e@localhost', '-c', 'commit.gpgsign=false', ...args], { cwd: content, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
  }
  git('init', '-q')
  git('add', '-A')
  git('commit', '-q', '-m', 'catalog e2e content')
  return { url: content, startPaths: Object.keys(paths) }
}

function writePlaybook (dir, csvPath) {
  const content = stageContent(dir)
  const uiBundle = process.env.CATALOG_E2E_UI_BUNDLE ||
    'https://github.com/redpanda-data/docs-ui/releases/latest/download/ui-bundle.zip'
  const macros = ['glossary', 'config-ref', 'badge', 'enterprise', 'prop', 'helm-ref', 'rp-connect-components', 'iceberg-explorer']
  const yaml = `site:
  title: Component catalog e2e
  url: http://localhost
urls:
  html_extension_style: indexify
output:
  clean: true
  dir: ${JSON.stringify(path.join(dir, 'site'))}
runtime:
  log:
    level: error
content:
  sources:
  - url: ${JSON.stringify(content.url)}
    branches: HEAD
    start_paths:
${content.startPaths.map((p) => `    - ${p}`).join('\n')}
ui:
  bundle:
    url: ${JSON.stringify(uiBundle)}
asciidoc:
  extensions:
  - '@asciidoctor/tabs'
${macros.map((m) => `  - ${JSON.stringify(path.join(ROOT, 'macros', m))}`).join('\n')}
antora:
  extensions:
  - require: ${JSON.stringify(path.join(ROOT, 'extensions', 'generate-rp-connect-info'))}
    csvpath: ${JSON.stringify(csvPath)}
  - require: ${JSON.stringify(path.join(__dirname, 'publish-solutions-fixture'))}
    file: ${JSON.stringify(path.join(FIXTURES, 'solutions.json'))}
`
  const file = path.join(dir, 'antora-playbook.yml')
  fs.writeFileSync(file, yaml)
  return file
}

function build (playbook) {
  const antora = path.join(ROOT, 'node_modules', '.bin', 'antora')
  const result = spawnSync(antora, ['--stacktrace', playbook], { cwd: path.dirname(playbook), encoding: 'utf8', env: { ...process.env, CI: 'true' } })
  if (result.status !== 0) {
    throw new Error(`Antora failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`)
  }
  return `${result.stdout}${result.stderr}`
}

function serve (dir) {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' }
  const server = http.createServer((req, res) => {
    let file = path.join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname))
    if (!file.startsWith(dir)) { res.writeHead(403); return res.end() }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html')
    if (!fs.existsSync(file)) { res.writeHead(404, { 'Content-Type': 'text/html' }); return res.end('<h1>Not found</h1>') }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' })
    fs.createReadStream(file).pipe(res)
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

function findChrome () {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ].filter(Boolean)
  // A Chrome that puppeteer downloaded on this machine, newest first
  for (const flavor of ['chrome-headless-shell', 'chrome']) {
    const base = path.join(os.homedir(), '.cache', 'puppeteer', flavor)
    if (!fs.existsSync(base)) continue
    for (const version of fs.readdirSync(base).sort().reverse()) {
      const dir = path.join(base, version)
      const found = spawnSync('find', [dir, '-type', 'f', '-perm', '-u+x', '(', '-name', 'chrome-headless-shell', '-o', '-name', 'chrome', '-o', '-name', 'Google Chrome for Testing', ')'], { encoding: 'utf8' })
      candidates.push(...found.stdout.split('\n').filter(Boolean))
    }
  }
  return candidates.find((c) => fs.existsSync(c))
}

/** A minimal Chrome DevTools protocol client over Node's built-in WebSocket. */
async function launchChrome (binary, profileDir) {
  const chrome = spawn(binary, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profileDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1280,900', 'about:blank'
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  const wsUrl = await new Promise((resolve, reject) => {
    let stderr = ''
    const timer = setTimeout(() => reject(new Error(`Chrome did not start:\n${stderr}`)), 20000)
    chrome.stderr.on('data', (chunk) => {
      stderr += chunk
      const m = stderr.match(/DevTools listening on (ws:\/\/\S+)/)
      if (m) { clearTimeout(timer); resolve(m[1]) }
    })
    chrome.on('exit', (code) => reject(new Error(`Chrome exited with ${code}:\n${stderr}`)))
  })
  const ws = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  let nextId = 0
  const pending = new Map()
  const listeners = []
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      return msg.error ? reject(new Error(`${msg.error.message}`)) : resolve(msg.result)
    }
    for (const fn of listeners) fn(msg)
  }
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++nextId
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  })
  return {
    send,
    on: (fn) => listeners.push(fn),
    close: () => { try { ws.close() } catch (e) {} chrome.kill() }
  }
}

async function openPage (browser) {
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true })
  const send = (method, params) => browser.send(method, params, sessionId)
  const errors = []
  const events = []
  browser.on((msg) => {
    if (msg.sessionId !== sessionId) return
    events.push(msg.method)
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails
      errors.push(`exception: ${(d.exception && d.exception.description) || d.text}`)
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      errors.push(`console.error: ${msg.params.args.map((a) => a.value || a.description).join(' ')}`)
    }
  })
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (exceptionDetails) throw new Error(`evaluate failed: ${expression}\n${exceptionDetails.exception ? exceptionDetails.exception.description : exceptionDetails.text}`)
    return result.value
  }
  const waitFor = async (expression, what, timeout = 10000) => {
    const end = Date.now() + timeout
    while (Date.now() < end) {
      if (await evaluate(expression)) return
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error(`timed out waiting for ${what}`)
  }
  const navigate = async (url) => {
    const loaded = events.length
    await send('Page.navigate', { url })
    const end = Date.now() + 20000
    while (!events.slice(loaded).includes('Page.loadEventFired')) {
      if (Date.now() > end) throw new Error(`page did not load: ${url}`)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  // A real mouse click at the center of the element
  const click = async (selector) => {
    const box = await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`)
    if (!box) throw new Error(`no element matches ${selector}`)
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
    }
  }
  const pressKey = async (key, code, keyCode) => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode })
  }
  const screenshot = async (file) => {
    const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    fs.writeFileSync(file, Buffer.from(data, 'base64'))
  }
  return { evaluate, waitFor, navigate, click, pressKey, screenshot, errors }
}

function assert (condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`)
  log(`ok: ${message}`)
}

async function main () {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-e2e-'))
  const csvPath = path.resolve(process.env.CATALOG_E2E_CSV || path.join(FIXTURES, 'info.csv'))
  const shots = process.env.CATALOG_E2E_SCREENSHOTS && path.resolve(process.env.CATALOG_E2E_SCREENSHOTS)
  if (shots) fs.mkdirSync(shots, { recursive: true })
  let server
  let browser
  try {
    const chromePath = findChrome()
    if (!chromePath) throw new Error('no Chrome found: set CHROME_PATH to a Chrome or Chromium binary')

    log(`building the preview with ${relativeToRoot(csvPath).startsWith('..') ? csvPath : relativeToRoot(csvPath)}`)
    const buildLog = build(writePlaybook(work, csvPath))
    const site = path.join(work, 'site')
    const pageFile = path.join(site, PAGE, 'index.html')
    assert(fs.existsSync(pageFile), `the build wrote ${PAGE}`)
    assert(fs.existsSync(path.join(site, 'assets', 'data', 'solutions.json')), 'the build published assets/data/solutions.json')
    const unknown = buildLog.split('\n').filter((line) => /Unknown use case/.test(line))
    if (unknown.length) log(`build warnings about unknown use cases:\n${unknown.join('\n')}`)

    server = await serve(site)
    const base = `http://127.0.0.1:${server.address().port}`
    browser = await launchChrome(chromePath, path.join(work, 'profile'))
    const page = await openPage(browser)
    log(`opening ${PAGE} in ${path.basename(chromePath)}`)
    await page.navigate(base + PAGE)
    await page.waitFor(`document.querySelectorAll('#componentCardsContainer .component-card').length > 0`, 'the cards')

    const visibleCards = `Array.from(document.querySelectorAll('#componentCardsContainer .component-card')).filter(c => getComputedStyle(c).display !== 'none')`
    const total = await page.evaluate(`document.querySelectorAll('#componentCardsContainer .component-card').length`)
    const tagged = await page.evaluate(`Array.from(document.querySelectorAll('#componentCardsContainer .component-card')).filter(c => (c.dataset.useCases || '').split(',').includes(${JSON.stringify(USE_CASE)})).length`)
    assert(total > tagged && tagged > 0, `${total} cards, ${tagged} with ${USE_CASE}`)
    assert(await page.evaluate(`${visibleCards}.length`) === total, 'every card is visible before filtering')
    assert(await page.evaluate(`document.querySelector('#useCaseFilterToggle .dropdown-text').textContent`) === 'All Use Cases', 'the Use case filter starts unfiltered')
    assert(await page.evaluate(`document.getElementById('componentCatalogSolutions').hidden`) === true, 'no solutions show before a use case is picked')

    // Open the filter
    await page.click('#useCaseFilterToggle')
    await page.waitFor(`document.getElementById('useCaseFilterMenu').classList.contains('show')`, 'the menu to open')
    assert(await page.evaluate(`document.getElementById('useCaseFilterToggle').getAttribute('aria-expanded')`) === 'true', 'the open toggle has aria-expanded="true"')
    const labels = await page.evaluate(`Array.from(document.querySelectorAll('#useCaseFilterMenu .dropdown-checkbox-option span')).map(s => s.textContent)`)
    assert(labels.includes(USE_CASE_LABEL), `the menu offers ${USE_CASE_LABEL} (${labels.join(', ')})`)
    if (shots) await page.screenshot(path.join(shots, '1-menu-open.png'))

    // Pick Change data capture
    await page.click(`#useCaseFilterMenu input[value="${USE_CASE}"]`)
    await page.waitFor(`!document.getElementById('componentCatalogSolutions').hidden`, 'the solutions links')
    const shown = await page.evaluate(`${visibleCards}.map(c => c.dataset.useCases || '')`)
    assert(shown.length === tagged, `${shown.length} cards stay visible, the ${tagged} with ${USE_CASE}`)
    assert(shown.every((ids) => ids.split(',').includes(USE_CASE)), `every visible card has ${USE_CASE}`)
    assert(await page.evaluate(`document.querySelector('#useCaseFilterToggle .dropdown-text').textContent`) === USE_CASE_LABEL, 'the toggle names the selected use case')
    assert(await page.evaluate(`new URLSearchParams(location.search).get('usecase')`) === USE_CASE, 'the URL carries ?usecase=')
    const heading = await page.evaluate(`document.querySelector('#componentCatalogSolutions .catalog-solutions-title').textContent`)
    assert(heading === `Solutions for ${USE_CASE_LABEL}`, `the heading reads "${heading}"`)
    const links = await page.evaluate(`Array.from(document.querySelectorAll('#componentCatalogSolutions a')).map(a => [a.textContent, a.getAttribute('href')])`)
    assert(JSON.stringify(links) === JSON.stringify([['CDC to lakehouse', '/solutions/cdc-to-lakehouse/']]), `only the matching, non-deprecated solution links show: ${JSON.stringify(links)}`)
    if (shots) await page.screenshot(path.join(shots, '2-filtered.png'))

    // Escape closes the menu and returns focus to its toggle
    await page.pressKey('Escape', 'Escape', 27)
    await page.waitFor(`!document.getElementById('useCaseFilterMenu').classList.contains('show')`, 'Escape to close the menu')
    assert(await page.evaluate(`document.getElementById('useCaseFilterToggle').getAttribute('aria-expanded')`) === 'false', 'Escape sets aria-expanded="false"')
    assert(await page.evaluate(`document.activeElement && document.activeElement.id`) === 'useCaseFilterToggle', 'Escape returns focus to the toggle')

    // Clear the filter
    await page.click('#useCaseFilterToggle')
    await page.waitFor(`document.getElementById('useCaseFilterMenu').classList.contains('show')`, 'the menu to reopen')
    await page.click(`#useCaseFilterMenu input[value="${USE_CASE}"]`)
    await page.waitFor(`${visibleCards}.length === ${total}`, 'every card to return')
    assert(true, `all ${total} cards return when the filter is cleared`)
    assert(await page.evaluate(`document.getElementById('componentCatalogSolutions').hidden`) === true, 'the solutions links go away')
    assert(await page.evaluate(`document.querySelector('#useCaseFilterToggle .dropdown-text').textContent`) === 'All Use Cases', 'the toggle reads All Use Cases again')
    assert(await page.evaluate(`new URLSearchParams(location.search).has('usecase')`) === false, 'the URL drops ?usecase=')

    // A link with ?usecase= opens filtered
    await page.navigate(`${base}${PAGE}?usecase=${USE_CASE}`)
    await page.waitFor(`!document.getElementById('componentCatalogSolutions').hidden`, 'the solutions links from the URL')
    assert(await page.evaluate(`${visibleCards}.length`) === tagged, '?usecase= in the URL applies the filter on load')

    assert(page.errors.length === 0, `no page errors${page.errors.length ? `: ${page.errors.join('; ')}` : ''}`)
    log(`passed${shots ? `; screenshots in ${shots}` : ''}`)
  } finally {
    if (browser) browser.close()
    if (server) server.close()
    fs.rmSync(work, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(`[catalog-e2e ${elapsed()}] FAILED: ${error.message}`)
  process.exit(1)
})

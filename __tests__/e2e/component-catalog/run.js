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
 * Needs Node.js 22 or later (for its global WebSocket), and network access
 * only to download the UI bundle, which Antora caches.
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
// Each CDP command gets this long before the test fails instead of hanging
const COMMAND_TIMEOUT_MS = 30000

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
  // Chrome went away: fail every command still waiting instead of hanging
  const failPending = (reason) => {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer)
      reject(new Error(reason))
    }
    pending.clear()
  }
  ws.onclose = () => failPending('the DevTools connection closed')
  ws.onerror = () => failPending('the DevTools connection failed')
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject, timer } = pending.get(msg.id)
      clearTimeout(timer)
      pending.delete(msg.id)
      return msg.error ? reject(new Error(`${msg.error.message}`)) : resolve(msg.result)
    }
    for (const fn of listeners) fn(msg)
  }
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++nextId
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`${method} got no answer in ${COMMAND_TIMEOUT_MS / 1000}s`))
    }, COMMAND_TIMEOUT_MS)
    pending.set(id, { resolve, reject, timer })
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  })
  return {
    send,
    on: (fn) => listeners.push(fn),
    close: () => new Promise((resolve) => {
      try { ws.close() } catch (e) {}
      if (chrome.exitCode !== null) return resolve()
      chrome.once('exit', resolve)
      chrome.kill()
    })
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
  const setViewport = (width, height = 900) =>
    send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  await setViewport(1280)
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
  // Types into the focused element, one real key event per character
  const typeText = async (text) => {
    for (const ch of text) {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch })
    }
  }
  // The accessible name and role Chrome computes for an element
  const accessible = async (selector) => {
    await send('DOM.enable')
    await send('Accessibility.enable')
    const { root } = await send('DOM.getDocument', { depth: 0 })
    const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector })
    if (!nodeId) throw new Error(`no element matches ${selector}`)
    const { nodes } = await send('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false })
    const node = nodes[0] || {}
    return { name: node.name && node.name.value, role: node.role && node.role.value }
  }
  return { evaluate, waitFor, navigate, click, pressKey, typeText, accessible, screenshot, setViewport, errors }
}

// The filter panel's layout: the search row, then the dropdown filters as
// rows of { count, widths, fills } where fills means the row reaches the
// panel's right edge (no empty cell).
const FILTER_LAYOUT = `(() => {
  const panel = document.querySelector('.table-filters');
  const style = getComputedStyle(panel);
  const left = panel.getBoundingClientRect().left + parseFloat(style.paddingLeft) + parseFloat(style.borderLeftWidth);
  const right = panel.getBoundingClientRect().right - parseFloat(style.paddingRight) - parseFloat(style.borderRightWidth);
  const search = panel.querySelector('.table-filters-search').getBoundingClientRect();
  const groups = Array.from(panel.querySelectorAll(':scope > .filter-group')).map(g => g.getBoundingClientRect());
  const rows = [];
  for (const r of groups) {
    let row = rows.find(x => Math.abs(x.top - r.top) < 2);
    if (!row) rows.push(row = { top: r.top, rects: [] });
    row.rects.push(r);
  }
  return {
    searchFullWidth: Math.abs(search.left - left) < 2 && Math.abs(search.right - right) < 2,
    searchAbove: groups.every(g => g.top >= search.bottom),
    labels: Array.from(panel.querySelectorAll(':scope > .filter-group > label')).map(l => l.textContent.replace(':', '')),
    rows: rows.map(row => ({
      count: row.rects.length,
      widths: row.rects.map(r => Math.round(r.width)),
      fills: Math.abs(row.rects[0].left - left) < 2 && Math.abs(row.rects[row.rects.length - 1].right - right) < 2
    }))
  };
})()`

async function checkFilterLayout (page, what, expectedColumns) {
  const layout = await page.evaluate(FILTER_LAYOUT)
  const shape = layout.rows.map((r) => r.count).join('+')
  assert(layout.searchFullWidth && layout.searchAbove, `${what}: search has its own full-width row`)
  assert(layout.rows.every((r) => r.fills), `${what}: every filter row fills the panel (${shape}: ${layout.labels.join(', ')})`)
  assert(layout.rows.every((r) => Math.max(...r.widths) - Math.min(...r.widths) <= 1), `${what}: filters in a row are equal width (${layout.rows.map((r) => r.widths.join('/')).join(', ')})`)
  if (expectedColumns) assert(shape === expectedColumns, `${what}: filters sit ${shape}, expected ${expectedColumns}`)
  return layout
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
    // Node 22 has a global WebSocket; older releases need a flag or a library
    if (typeof WebSocket === 'undefined') throw new Error(`this test needs Node.js 22 or later (global WebSocket); this is ${process.version}`)
    const chromePath = findChrome()
    if (!chromePath) throw new Error('no Chrome found: set CHROME_PATH to a Chrome or Chromium binary')

    log(`building the preview with ${relativeToRoot(csvPath).startsWith('..') ? csvPath : relativeToRoot(csvPath)}`)
    const buildLog = build(writePlaybook(path.join(work, 'with'), csvPath))
    const site = path.join(work, 'with', 'site')
    const pageFile = path.join(site, PAGE, 'index.html')
    assert(fs.existsSync(pageFile), `the build wrote ${PAGE}`)
    assert(fs.existsSync(path.join(site, 'assets', 'data', 'solutions.json')), 'the build published assets/data/solutions.json')
    // CATALOG_E2E_KEEP_SITE=<dir>: keep a copy of the built site, for manual
    // review of the page with the same data the test used
    if (process.env.CATALOG_E2E_KEEP_SITE) {
      const keep = path.resolve(process.env.CATALOG_E2E_KEEP_SITE)
      fs.rmSync(keep, { recursive: true, force: true })
      fs.cpSync(site, keep, { recursive: true })
      log(`kept the built site in ${keep}`)
    }
    const unknown = buildLog.split('\n').filter((line) => /Unknown use case/.test(line))
    if (unknown.length) log(`build warnings about unknown use cases:\n${unknown.join('\n')}`)

    // The same page from an info.csv without the use_cases column (an older
    // Connect release): no Use case filter
    const noUseCasesCsv = path.join(work, 'info-no-use-cases.csv')
    fs.writeFileSync(noUseCasesCsv, fs.readFileSync(path.join(FIXTURES, 'info.csv'), 'utf8')
      .split('\n').map((line) => line.replace(/,[^,]*$/, '')).join('\n'))
    log('building the preview again without the use_cases column')
    build(writePlaybook(path.join(work, 'without'), noUseCasesCsv))

    server = await serve(work)
    const origin = `http://127.0.0.1:${server.address().port}`
    const base = `${origin}/with/site`
    browser = await launchChrome(chromePath, path.join(work, 'profile'))
    const page = await openPage(browser)
    log(`opening ${PAGE} in ${path.basename(chromePath)}`)
    await page.navigate(base + PAGE)
    await page.waitFor(`document.querySelectorAll('#componentCardsContainer .component-card').length > 0`, 'the cards')

    const usingFixture = !process.env.CATALOG_E2E_CSV
    const visibleCards = `Array.from(document.querySelectorAll('#componentCardsContainer .component-card')).filter(c => getComputedStyle(c).display !== 'none')`
    const visibleNames = `${visibleCards}.map(c => c.querySelector('.card-title code').textContent).sort()`
    const status = `document.getElementById('componentCatalogStatus').textContent`
    const toggleText = `document.querySelector('#useCaseFilterToggle .dropdown-text').textContent`
    const total = await page.evaluate(`document.querySelectorAll('#componentCardsContainer .component-card').length`)
    const tagged = await page.evaluate(`Array.from(document.querySelectorAll('#componentCardsContainer .component-card')).filter(c => (c.dataset.useCases || '').split(',').includes(${JSON.stringify(USE_CASE)})).length`)
    assert(total > tagged && tagged >= 3, `${total} cards, ${tagged} with ${USE_CASE}`)
    assert(await page.evaluate(`${visibleCards}.length`) === total, 'every card is visible before filtering')
    assert(await page.evaluate(toggleText) === 'Any use case', 'the Use case filter starts unfiltered, reading "Any use case"')
    assert(await page.evaluate(`document.getElementById('componentCatalogSolutions').hidden`) === true, 'no solutions show before a use case is picked')
    assert(await page.evaluate(`!document.getElementById('componentCatalogSolutions').hasAttribute('aria-live')`), 'the solutions panel is not a live region')
    const region = await page.evaluate(`(() => { const r = document.getElementById('componentCatalogStatus'); return r && [r.getAttribute('role'), r.getAttribute('aria-live'), r.textContent, r.getBoundingClientRect().width <= 1].join('|') })()`)
    assert(region === 'status|polite||true', `one visually hidden, empty role=status aria-live=polite region (${region})`)

    // Threshold: an option needs at least 3 cards in the view
    const counts = await page.evaluate(`(() => {
      const counts = {};
      document.querySelectorAll('#componentCardsContainer .component-card').forEach(c => (c.dataset.useCases || '').split(',').filter(Boolean).forEach(id => { counts[id] = (counts[id] || 0) + 1 }));
      return counts;
    })()`)
    const offered = await page.evaluate(`Array.from(document.querySelectorAll('#useCaseFilterMenu input')).map(i => i.value)`)
    assert(offered.every((id) => counts[id] >= 3), `every offered use case has at least 3 cards (${offered.map((id) => `${id}: ${counts[id]}`).join(', ')})`)
    const rare = Object.keys(counts).filter((id) => counts[id] < 3)
    assert(rare.every((id) => !offered.includes(id)), `use cases on 1 or 2 cards are not offered (${rare.join(', ') || 'none in this data'})`)
    if (usingFixture) assert(rare.includes('data-lakehouse'), 'the fixture has a 1-card use case (data-lakehouse) to hide')

    // Accessibility: names and roles as Chrome computes them
    const toggleAx = await page.accessible('#useCaseFilterToggle')
    assert(toggleAx.name === 'Use case: Any use case', `the toggle's accessible name is the label plus the value ("${toggleAx.name}")`)
    const aria = await page.evaluate(`(() => ({
      haspopup: document.querySelectorAll('.table-filters [aria-haspopup]').length,
      menus: document.querySelectorAll('.table-filters [role="menu"]').length,
      arrows: Array.from(document.querySelectorAll('.table-filters .dropdown-arrow')).every(a => a.getAttribute('aria-hidden') === 'true'),
      groups: Array.from(document.querySelectorAll('.table-filters .dropdown-checkbox-menu')).every(m => m.getAttribute('role') === 'group')
    }))()`)
    assert(aria.haspopup === 0 && aria.menus === 0 && aria.arrows && aria.groups, `no filter claims to be an ARIA menu; every arrow is aria-hidden; every option list is a group (${JSON.stringify(aria)})`)
    const typeAx = await page.accessible('#typeFilterToggle')
    assert(typeAx.name === 'Type: All Types Selected', `the older filters are named the same way ("${typeAx.name}")`)

    await checkFilterLayout(page, '1280px')
    if (shots) await page.screenshot(path.join(shots, 'layout-1280.png'))

    // Search finds use cases by label, ID, and altLabel
    const searches = usingFixture
      ? { 'change data capture': ['mongodb_cdc', 'mysql_cdc', 'postgres_cdc'], lakehouse: ['iceberg'], warehouse: ['snowflake_streaming'], analytics: ['questdb'], cdc: ['mongodb_cdc', 'mysql_cdc', 'postgres_cdc'] }
      : { 'change data capture': null, lakehouse: null, warehouse: null, analytics: null, cdc: null }
    for (const [term, expected] of Object.entries(searches)) {
      await page.click('#componentTableSearch')
      await page.evaluate(`document.getElementById('componentTableSearch').value = ''`)
      await page.typeText(term)
      const names = await page.evaluate(visibleNames)
      if (expected) {
        assert(JSON.stringify(names) === JSON.stringify(expected), `searching "${term}" finds ${names.join(', ')}`)
      } else {
        const matching = await page.evaluate(`Array.from(document.querySelectorAll('#componentCardsContainer .component-card')).filter(c => (c.dataset.search || '').includes(${JSON.stringify(term)})).length`)
        assert(names.length > 0 && names.length === matching, `searching "${term}" finds the ${matching} cards whose names or use cases contain it`)
      }
    }
    const searchStatus = await page.evaluate(status)
    assert(/^\d+ components? match(es)? "cdc"\.$/.test(searchStatus), `the status region announces the search ("${searchStatus}")`)

    // Empty state, then Clear filters
    await page.evaluate(`document.getElementById('componentTableSearch').value = ''`)
    await page.typeText('zzzz-no-such-component')
    await page.waitFor(`!document.getElementById('componentCatalogEmpty').hidden`, 'the empty state')
    assert(await page.evaluate(status) === 'No components match "zzzz-no-such-component".', 'the status region says nothing matches')
    if (shots) await page.screenshot(path.join(shots, '3-empty-state.png'))
    await page.click('#componentCatalogClear')
    await page.waitFor(`${visibleCards}.length === ${total}`, 'Clear filters to bring every card back')
    assert(await page.evaluate(`document.getElementById('componentCatalogEmpty').hidden && document.getElementById('componentTableSearch').value === '' && document.activeElement.id === 'componentTableSearch'`), 'Clear filters empties the search, hides the empty state, and focuses the search box')
    assert(await page.evaluate(status) === `Showing all ${total} components.`, `the status region says all ${total} components show`)

    // Open the filter
    await page.click('#useCaseFilterToggle')
    await page.waitFor(`document.getElementById('useCaseFilterMenu').classList.contains('show')`, 'the menu to open')
    assert(await page.evaluate(`document.getElementById('useCaseFilterToggle').getAttribute('aria-expanded')`) === 'true', 'the open toggle has aria-expanded="true"')
    const labels = await page.evaluate(`Array.from(document.querySelectorAll('#useCaseFilterMenu .dropdown-checkbox-option span')).map(s => s.textContent)`)
    assert(labels.includes(USE_CASE_LABEL), `the menu offers ${USE_CASE_LABEL} (${labels.join(', ')})`)
    const menuAx = await page.accessible('#useCaseFilterMenu')
    assert(menuAx.role === 'group' && menuAx.name === 'Use case:', `the open options are a group named by the label (${menuAx.role}, "${menuAx.name}")`)
    assert(await page.evaluate(`document.querySelector('#useCaseFilterMenu > :first-child').id`) === 'useCaseFilterClear', 'Clear is the first item in the menu')
    const optionTitle = await page.evaluate(`document.querySelector('#useCaseFilterMenu input[value="${USE_CASE}"]').closest('label').title`)
    assert(optionTitle.length > 20, `the option's tooltip is the taxonomy definition ("${optionTitle.slice(0, 50)}...")`)
    // The open menu overlays what is below it
    const overlay = await page.evaluate(`(() => {
      const menu = document.getElementById('useCaseFilterMenu');
      const r = menu.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.bottom - 4);
      return { below: r.bottom > document.querySelector('.table-filters').getBoundingClientRect().bottom, onTop: menu.contains(hit) };
    })()`)
    assert(overlay.onTop, `the open menu is on top of the content below it${overlay.below ? ' (it extends past the filter panel)' : ''}`)
    if (shots) await page.screenshot(path.join(shots, '1-menu-open.png'))

    // Pick Change data capture
    await page.click(`#useCaseFilterMenu input[value="${USE_CASE}"]`)
    await page.waitFor(`!document.getElementById('componentCatalogSolutions').hidden`, 'the solutions links')
    const shown = await page.evaluate(`${visibleCards}.map(c => c.dataset.useCases || '')`)
    assert(shown.length === tagged, `${shown.length} cards stay visible, the ${tagged} with ${USE_CASE}`)
    assert(shown.every((ids) => ids.split(',').includes(USE_CASE)), `every visible card has ${USE_CASE}`)
    assert(await page.evaluate(toggleText) === USE_CASE_LABEL, 'the toggle names the selected use case')
    assert((await page.accessible('#useCaseFilterToggle')).name === `Use case: ${USE_CASE_LABEL}`, 'the toggle\'s accessible name follows the value')
    const truncation = await page.evaluate(`(() => { const t = document.querySelector('#useCaseFilterToggle .dropdown-text'); const c = document.createElement('span'); c.textContent = t.textContent; c.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;'; t.parentNode.appendChild(c); const full = c.getBoundingClientRect().width; c.remove(); return { text: full, box: t.getBoundingClientRect().width, cut: full > t.getBoundingClientRect().width + 0.01, title: document.getElementById('useCaseFilterToggle').getAttribute('title') } })()`)
    assert(truncation.cut ? truncation.title === USE_CASE_LABEL : truncation.title === null, `a cut-off value is in the toggle's title (${JSON.stringify(truncation)})`)
    assert(await page.evaluate(`new URLSearchParams(location.search).get('usecase')`) === USE_CASE, 'the URL carries ?usecase=')
    const heading = await page.evaluate(`document.querySelector('#componentCatalogSolutions .catalog-solutions-title').textContent`)
    assert(heading === 'Redpanda Solutions', `the heading reads "${heading}"`)
    const lead = await page.evaluate(`document.querySelector('#componentCatalogSolutions .catalog-solutions-lead').textContent`)
    assert(lead === `Runnable reference architectures for ${USE_CASE_LABEL}`, `the lead reads "${lead}"`)
    assert(await page.evaluate(`Array.from(document.querySelectorAll('#componentCatalogSolutions .catalog-solutions-chips .badge-use-case')).map(c => c.textContent).join()`) === USE_CASE_LABEL, 'the selected use case shows as a chip')
    const links = await page.evaluate(`Array.from(document.querySelectorAll('#componentCatalogSolutions li a')).map(a => [a.textContent, a.getAttribute('href')])`)
    assert(JSON.stringify(links) === JSON.stringify([
      ['CDC to lakehouse', '/solutions/cdc-to-lakehouse/'],
      ['Postgres CDC to Iceberg', '/solutions/postgres-cdc-to-iceberg/'],
      ['MongoDB CDC replay', '/solutions/mongodb-cdc-replay/']
    ]), `solutions match by concept ID, by label (the DEM#320 shape), and by altLabel, without the deprecated one: ${JSON.stringify(links)}`)
    await page.waitFor(`${status}.includes('related solution')`, 'the status region to count the solutions')
    const pickedStatus = await page.evaluate(status)
    assert(pickedStatus === `${tagged} components match ${USE_CASE_LABEL}. 3 related solutions.`, `the status region reads "${pickedStatus}"`)
    if (shots) await page.screenshot(path.join(shots, '2-filtered.png'))

    // The panel is not rebuilt when the list does not change
    await page.evaluate(`window.__panelMarker = document.querySelector('#componentCatalogSolutions li'); window.filterComponentTable({ type: 'test' })`)
    await page.waitFor(`${status}.includes('related solution')`, 'the status after a no-op change')
    assert(await page.evaluate(`document.querySelector('#componentCatalogSolutions li') === window.__panelMarker`), 'an unchanged solutions list is not re-rendered')

    // Escape closes the menu and returns focus to its toggle
    await page.pressKey('Escape', 'Escape', 27)
    await page.waitFor(`!document.getElementById('useCaseFilterMenu').classList.contains('show')`, 'Escape to close the menu')
    assert(await page.evaluate(`document.getElementById('useCaseFilterToggle').getAttribute('aria-expanded')`) === 'false', 'Escape sets aria-expanded="false"')
    assert(await page.evaluate(`document.activeElement && document.activeElement.id`) === 'useCaseFilterToggle', 'Escape returns focus to the toggle')

    // Dark mode: the badge group labels keep at least 4.5:1 contrast on the card
    await page.evaluate(`document.documentElement.setAttribute('data-theme', 'dark')`)
    // Cards transition their colors; let the transition finish
    await new Promise((resolve) => setTimeout(resolve, 600))
    const contrast = await page.evaluate(`(() => {
      const label = document.querySelector('#componentCardsContainer .component-card:not(.hidden) .badge-group-label');
      const card = label.closest('.component-card');
      const rgb = (c) => c.match(/[\\d.]+/g).slice(0, 3).map(Number);
      const lum = (c) => { const [r, g, b] = rgb(c).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }); return 0.2126 * r + 0.7152 * g + 0.0722 * b };
      const fg = getComputedStyle(label).color;
      const bg = getComputedStyle(card).backgroundColor;
      const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
      return { fg, bg, ratio: (hi + 0.05) / (lo + 0.05) };
    })()`)
    assert(contrast.ratio >= 4.5, `dark mode: badge group label ${contrast.fg} on ${contrast.bg} is ${contrast.ratio.toFixed(2)}:1`)
    if (shots) await page.screenshot(path.join(shots, '4-dark-filtered.png'))
    await page.evaluate(`document.documentElement.removeAttribute('data-theme')`)

    // Clear, at the top of the menu
    await page.click('#useCaseFilterToggle')
    await page.waitFor(`document.getElementById('useCaseFilterMenu').classList.contains('show')`, 'the menu to reopen')
    await page.click('#useCaseFilterClear')
    await page.waitFor(`${visibleCards}.length === ${total}`, 'every card to return')
    assert(true, `all ${total} cards return when Clear is used`)
    assert(await page.evaluate(`document.getElementById('componentCatalogSolutions').hidden`) === true, 'the solutions links go away')
    assert(await page.evaluate(toggleText) === 'Any use case', 'the toggle reads "Any use case" again')
    assert(await page.evaluate(`new URLSearchParams(location.search).has('usecase')`) === false, 'the URL drops ?usecase=')
    assert(await page.evaluate(status) === `Showing all ${total} components.`, 'the status region says all components show')

    // Medium width
    await page.setViewport(700)
    await page.navigate(base + PAGE)
    await page.waitFor(`document.querySelectorAll('#componentCardsContainer .component-card').length > 0`, 'the cards at 700px')
    await checkFilterLayout(page, '700px')
    if (shots) await page.screenshot(path.join(shots, 'layout-700.png'))
    // Narrow width
    await page.setViewport(380)
    await page.navigate(base + PAGE)
    await page.waitFor(`document.querySelectorAll('#componentCardsContainer .component-card').length > 0`, 'the cards at 380px')
    const narrow = await checkFilterLayout(page, '380px')
    assert(narrow.rows.every((r) => r.count === 1), 'narrow: one filter per row')
    await page.setViewport(1280)

    // A link with ?usecase= opens filtered
    await page.navigate(`${base}${PAGE}?usecase=${USE_CASE}`)
    await page.waitFor(`!document.getElementById('componentCatalogSolutions').hidden`, 'the solutions links from the URL')
    assert(await page.evaluate(`${visibleCards}.length`) === tagged, '?usecase= in the URL applies the filter on load')

    // No use-case data: no Use case filter, and the other filters still sit evenly
    await page.navigate(`${origin}/without/site${PAGE}`)
    await page.waitFor(`document.querySelectorAll('#componentCardsContainer .component-card').length > 0`, 'the cards without use cases')
    assert(await page.evaluate(`!document.getElementById('useCaseFilterToggle') && !document.getElementById('componentCatalogSolutions') && !document.querySelector('.badge-use-case')`), 'without use_cases there is no Use case filter, solutions list, or chip')
    assert(await page.evaluate(`!!document.getElementById('componentCatalogStatus')`), 'the status region is there without use cases too')
    await checkFilterLayout(page, 'no use cases, 1280px')
    if (shots) await page.screenshot(path.join(shots, 'layout-no-use-cases.png'))

    assert(page.errors.length === 0, `no page errors${page.errors.length ? `: ${page.errors.join('; ')}` : ''}`)
    log(`passed${shots ? `; screenshots in ${shots}` : ''}`)
  } finally {
    if (browser) await browser.close()
    if (server) server.close()
    // A cleanup failure (Chrome still flushing its profile) must not hide the result
    try {
      fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
    } catch (error) {
      log(`could not remove ${work}: ${error.message}`)
    }
  }
}

main().catch((error) => {
  console.error(`[catalog-e2e ${elapsed()}] FAILED: ${error.message}`)
  process.exit(1)
})

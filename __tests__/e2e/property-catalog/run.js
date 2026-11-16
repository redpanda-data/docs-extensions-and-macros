#!/usr/bin/env node
'use strict'

/**
 * End-to-end test of the property catalog (property_catalog::[]).
 *
 * Builds the preview's property-catalog page (preview/extensions-and-macros)
 * with Antora, using the macros and extensions in this working tree. The
 * preview component's own slim property data is swapped for the fixture next
 * to this file: the real redpanda-properties-v26.2.6.json, the generated
 * property partials, and the reference pages' include lines, all copied from
 * redpanda-data/docs. The same fixture is staged as a `streaming` component,
 * which lends its data to a Cloud component (env-cloud) with its own catalog
 * page, the way cloud-docs borrows from docs.
 *
 * Then it drives the built pages in headless Chrome over the DevTools
 * protocol (no browser library needed): search, every filter, URL state, the
 * status region, the empty state, links, copy buttons, tooltips, the 390px
 * layout, filtering time, and the Markdown export. It fails on any page error.
 *
 *   npm run test:property-catalog-e2e
 *
 * Environment:
 *   CATALOG_E2E_UI_BUNDLE    a UI bundle path or URL (default: the latest docs-ui release)
 *   CATALOG_E2E_SCREENSHOTS  a directory to save screenshots in
 *   CATALOG_E2E_KEEP_SITE    a directory to keep a copy of the built site in
 *   CHROME_PATH              the Chrome or Chromium binary
 *
 * Needs Node.js 22 or later (for its global WebSocket), and network access
 * for the UI bundle and the tooltip library the UI loads.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { spawn, spawnSync } = require('child_process')
const { convertPageHtml } = require('../../../extensions/convert-to-markdown')
const { propertyPageFor } = require('../../../tools/property-extractor/property-page')
const catalogMacro = require('../../../macros/property-catalog')

const ROOT = path.resolve(__dirname, '..', '..', '..')
const FIXTURES = path.join(__dirname, 'fixtures')
const PAGE = '/preview/property-catalog/'
const CLOUD_PAGE = '/cloud-fixture/all-properties/'
const TOPIC_PAGE = '/preview/reference/properties/topic-properties/'
const CLUSTER_PAGE = '/preview/reference/properties/cluster-properties/'
const COMMAND_TIMEOUT_MS = 30000
const FILTER_BUDGET_MS = 50

const started = Date.now()
const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)}s`
const log = (message) => console.log(`[property-catalog-e2e ${elapsed()}] ${message}`)

function assert (condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`)
  log(`ok: ${message}`)
}

// Antora reads local content only from a git repository with a .git
// directory, which a linked worktree does not have. Copy the content into a
// throwaway repository, so the test runs from any checkout and sees
// uncommitted changes.
function stageContent (dir) {
  const content = path.join(dir, 'content')
  const reference = path.join(FIXTURES, 'reference')
  const copy = (from, to) => fs.cpSync(from, path.join(content, to), { recursive: true })
  copy(path.join(ROOT, 'preview', 'extensions-and-macros'), 'preview/extensions-and-macros')
  copy(path.join(ROOT, 'preview', 'shared'), 'preview/shared')
  // The preview's reference module gets the real data in place of its slim fixture
  const previewReference = path.join(content, 'preview/extensions-and-macros/modules/reference')
  for (const sub of ['attachments', 'partials/properties', 'pages/properties']) {
    fs.rmSync(path.join(previewReference, sub), { recursive: true, force: true })
  }
  copy(reference, 'preview/extensions-and-macros/modules/reference')
  copy(path.join(FIXTURES, 'streaming'), 'fixtures/streaming')
  copy(reference, 'fixtures/streaming/modules/reference')
  copy(path.join(FIXTURES, 'cloud'), 'fixtures/cloud')
  const git = (...args) => {
    const r = spawnSync('git', ['-c', 'user.name=catalog-e2e', '-c', 'user.email=catalog-e2e@localhost', '-c', 'commit.gpgsign=false', ...args], { cwd: content, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
  }
  git('init', '-q')
  git('add', '-A')
  git('commit', '-q', '-m', 'property catalog e2e content')
  return { url: content, startPaths: ['preview/extensions-and-macros', 'preview/shared', 'fixtures/streaming', 'fixtures/cloud'] }
}

function writePlaybook (dir) {
  const content = stageContent(dir)
  const uiBundle = process.env.CATALOG_E2E_UI_BUNDLE ||
    'https://github.com/redpanda-data/docs-ui/releases/latest/download/ui-bundle.zip'
  const macros = ['glossary', 'config-ref', 'badge', 'enterprise', 'prop', 'property-catalog', 'helm-ref']
  const yaml = `site:
  title: Property catalog e2e
  url: http://localhost
urls:
  html_extension_style: indexify
output:
  clean: true
  dir: ${JSON.stringify(path.join(dir, 'site'))}
runtime:
  log:
    level: fatal
content:
  sources:
  - url: ${JSON.stringify(content.url)}
    branches: HEAD
    start_paths:
${content.startPaths.map((p) => `    - ${p}`).join('\n')}
ui:
  bundle:
    url: ${JSON.stringify(path.isAbsolute(uiBundle) || /^\w+:\/\//.test(uiBundle) ? uiBundle : path.resolve(uiBundle))}
asciidoc:
  attributes:
    idprefix: ''
    idseparator: '-'
  extensions:
  - '@asciidoctor/tabs'
${macros.map((m) => `  - ${JSON.stringify(path.join(ROOT, 'macros', m))}`).join('\n')}
antora:
  extensions:
  - require: ${JSON.stringify(path.join(ROOT, 'extensions', 'property-page-index'))}
`
  const file = path.join(dir, 'antora-playbook.yml')
  fs.writeFileSync(file, yaml)
  return file
}

function build (playbook) {
  const antora = path.join(ROOT, 'node_modules', '.bin', 'antora')
  const result = spawnSync(antora, ['--stacktrace', playbook], { cwd: path.dirname(playbook), encoding: 'utf8', env: { ...process.env, CI: 'true' } })
  if (result.status !== 0) throw new Error(`Antora failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`)
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
  for (const flavor of ['chrome-headless-shell', 'chrome']) {
    const base = path.join(os.homedir(), '.cache', 'puppeteer', flavor)
    if (!fs.existsSync(base)) continue
    for (const version of fs.readdirSync(base).sort().reverse()) {
      const found = spawnSync('find', [path.join(base, version), '-type', 'f', '-perm', '-u+x', '(', '-name', 'chrome-headless-shell', '-o', '-name', 'chrome', '-o', '-name', 'Google Chrome for Testing', ')'], { encoding: 'utf8' })
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
  const failPending = (reason) => {
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(new Error(reason)) }
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
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} got no answer in ${COMMAND_TIMEOUT_MS / 1000}s`)) }, COMMAND_TIMEOUT_MS)
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
    send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 500 })
  await setViewport(1280)
  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
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
    const end = Date.now() + 30000
    while (!events.slice(loaded).includes('Page.loadEventFired')) {
      if (Date.now() > end) throw new Error(`page did not load: ${url}`)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  const center = async (selector) => {
    const box = await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`)
    if (!box) throw new Error(`no element matches ${selector}`)
    return box
  }
  const click = async (selector) => {
    const box = await center(selector)
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
    }
  }
  const hover = async (selector) => {
    const box = await center(selector)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y })
  }
  // Enter and Space carry text, which is what activates a focused button
  const pressKey = async (key, code, keyCode, modifiers = 0) => {
    const text = key === 'Enter' ? '\r' : key === ' ' ? ' ' : undefined
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, modifiers, ...(text ? { text } : {}) })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, modifiers })
  }
  const typeText = async (text) => {
    for (const ch of text) {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch })
    }
  }
  const screenshot = async (file, fullPage = false) => {
    const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: fullPage })
    fs.writeFileSync(file, Buffer.from(data, 'base64'))
  }
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
  return { send, evaluate, waitFor, navigate, click, hover, pressKey, typeText, accessible, screenshot, setViewport, errors }
}

// Page-side expressions
const VISIBLE = `Array.from(document.querySelectorAll('.prop-catalog-list > li.prop-card')).filter(c => !c.hidden)`
const VISIBLE_NAMES = `${VISIBLE}.map(c => c.dataset.name)`
const STATUS = `document.querySelector('.prop-catalog-status').textContent`
const READY = `!!document.querySelector('.prop-catalog--ready')`
const groupSel = (param) => `.prop-catalog .filter-group[data-param="${param}"]`
const chipFor = (param) => `.prop-catalog .prop-chip[data-chip-for="${param}"]`
const groupChip = (value) => `.prop-catalog .prop-chip--group[data-value="${value}"]`
const PRESSED = (selector) => `document.querySelector('${selector}').getAttribute('aria-pressed')`
const TAGS = `Array.from(document.querySelectorAll('.prop-catalog .prop-active-tag')).map(t => t.textContent)`
const COUNT = `document.querySelector('.prop-catalog .prop-catalog-count').textContent`

// WCAG contrast of an element's text on its effective background, with
// translucent layers composited over their ancestors (gradients ignored)
const CONTRAST_FN = `(() => {
  const parse = (c) => { const k = String(c).match(/color\\(srgb ([^)]+)\\)/); if (k) { const p = k[1].split(/[\\s\\/]+/).filter(Boolean).map(Number); return { r: p[0] * 255, g: p[1] * 255, b: p[2] * 255, a: p.length > 3 ? p[3] : 1 } } const m = String(c).match(/rgba?\\(([^)]+)\\)/); if (!m) return null; const p = m[1].split(/[\\s,\\/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 } };
  const blend = (t, b) => ({ r: t.r * t.a + b.r * (1 - t.a), g: t.g * t.a + b.g * (1 - t.a), b: t.b * t.a + b.b * (1 - t.a), a: 1 });
  const bgOf = (el) => {
    const layers = [];
    for (let n = el; n; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break } }
    let base = { r: 255, g: 255, b: 255, a: 1 };
    if (!layers.length || layers[layers.length - 1].a < 1) base = document.documentElement.getAttribute('data-theme') === 'dark' ? { r: 16, g: 24, b: 40, a: 1 } : base;
    for (let i = layers.length - 1; i >= 0; i--) base = blend(layers[i], base);
    return base;
  };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b) };
  window.__bgOf = bgOf;
  window.__ratio = (x, y) => { const a = lum(x); const b = lum(y); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) };
  window.__borderContrast = (el, against) => { const bg = bgOf(against || el.parentElement); let c = parse(getComputedStyle(el).borderTopColor); if (c.a < 1) c = blend(c, bg); return window.__ratio(c, bg) };
  window.__fillContrast = (el) => { const bg = bgOf(el.parentElement); let c = parse(getComputedStyle(el).backgroundColor); if (c.a < 1) c = blend(c, bg); return window.__ratio(c, bg) };
  window.__contrast = (el) => { const bg = bgOf(el); let fg = parse(getComputedStyle(el).color); if (fg.a < 1) fg = blend(fg, bg); const a = lum(fg); const b = lum(bg); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) };
  return true;
})()`

const AXE_URL = 'https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.10.2/axe.min.js'

/**
 * Runs axe-core on the catalog's own markup and returns its violations as
 * "rule: target" strings.
 */
async function axeViolations (page, selector) {
  await page.evaluate(`window.axe ? true : new Promise((resolve, reject) => { const s = document.createElement('script'); s.src = '${AXE_URL}'; s.onload = () => resolve(true); s.onerror = () => reject(new Error('could not load axe-core')); document.head.appendChild(s) })`)
  return page.evaluate(`axe.run({ include: [['${selector}']] }, { resultTypes: ['violations'] }).then(r => r.violations.flatMap(v => v.nodes.slice(0, 3).map(n => v.id + ' (' + v.impact + '): ' + n.target.join(' ') + ' ' + (n.failureSummary || '').split('\\n').slice(1, 2).join(''))))`)
}

async function setSearch (page, text) {
  await page.click('.prop-catalog-search')
  await page.evaluate(`(() => { const s = document.querySelector('.prop-catalog-search'); s.value = ''; })()`)
  await page.typeText(text)
  // The status region and the URL follow the search once typing pauses
  await new Promise((resolve) => setTimeout(resolve, 450))
}

/** Opens the More panel when it holds the given filter and is closed. */
async function openMore (page, param) {
  const closed = await page.evaluate(`(() => { const g = document.querySelector('${groupSel(param)}'); const panel = g && g.closest('.prop-catalog-more'); return !!panel && panel.hidden })()`)
  if (!closed) return
  await page.click('.prop-catalog .prop-chip--more')
  await page.waitFor(`!document.querySelector('${groupSel(param)}').closest('.prop-catalog-more').hidden`, 'the More panel')
}

/** Opens a filter and clicks the given options' checkboxes. */
async function clickOptions (page, param, values) {
  await openMore(page, param)
  await page.click(`${groupSel(param)} .dropdown-checkbox-toggle`)
  await page.waitFor(`document.querySelector('${groupSel(param)} .dropdown-checkbox-menu').classList.contains('show')`, `the ${param} menu`)
  for (const value of values) await page.click(`${groupSel(param)} input[value="${value}"]`)
}

async function main () {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'property-catalog-e2e-'))
  const shots = process.env.CATALOG_E2E_SCREENSHOTS && path.resolve(process.env.CATALOG_E2E_SCREENSHOTS)
  if (shots) fs.mkdirSync(shots, { recursive: true })
  const data = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'reference', 'attachments', 'redpanda-properties-v26.2.6.json'), 'utf8')).properties
  const entries = Object.values(data)
  const listed = entries.filter((e) => e.exclude_from_docs !== true)
  const timings = []
  let worstLayout = 0
  let server
  let browser
  try {
    if (typeof WebSocket === 'undefined') throw new Error(`this test needs Node.js 22 or later (global WebSocket); this is ${process.version}`)
    const chromePath = findChrome()
    if (!chromePath) throw new Error('no Chrome found: set CHROME_PATH to a Chrome or Chromium binary')

    log(`building the preview with ${process.env.CATALOG_E2E_UI_BUNDLE ? `the UI bundle ${process.env.CATALOG_E2E_UI_BUNDLE}` : 'the latest docs-ui release'}`)
    build(writePlaybook(work))
    const site = path.join(work, 'site')
    const pageFile = path.join(site, PAGE, 'index.html')
    assert(fs.existsSync(pageFile), `the build wrote ${PAGE}`)
    if (process.env.CATALOG_E2E_KEEP_SITE) {
      const keep = path.resolve(process.env.CATALOG_E2E_KEEP_SITE)
      fs.rmSync(keep, { recursive: true, force: true })
      fs.cpSync(site, keep, { recursive: true })
      log(`kept the built site in ${keep}`)
    }

    // The Markdown export lists the cards, not the controls
    const html = fs.readFileSync(pageFile, 'utf8')
    const markdown = convertPageHtml({ html, page: { asciidoc: { doctitle: 'Property Catalog Preview', attributes: {} }, pub: { url: PAGE }, src: { component: 'preview', path: 'property-catalog.adoc' } }, siteUrl: 'http://localhost' })
    const mdItems = markdown.split('\n').filter((l) => l.startsWith('- `'))
    assert(mdItems.length === listed.length, `the Markdown export lists all ${listed.length} properties (${mdItems.length})`)
    assert(/^- `retention_bytes` \(integer\): Cluster\. .*\[Full reference\]\(http:\/\/localhost\/preview\/reference\/properties\/cluster-properties\/#retention_bytes\)$/m.test(markdown), 'a Markdown item carries the badges, summary, and an absolute reference link')
    assert(!/Search properties|Clear filters|dropdown/.test(markdown), 'the Markdown export leaves out the filter controls')

    server = await serve(site)
    const base = `http://127.0.0.1:${server.address().port}`
    browser = await launchChrome(chromePath, path.join(work, 'profile'))
    await browser.send('Browser.grantPermissions', { origin: base, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] })
    const page = await openPage(browser)
    log(`opening ${PAGE} in ${path.basename(chromePath)}`)
    const loadStart = Date.now()
    await page.navigate(base + PAGE)
    await page.waitFor(READY, 'the catalog script')
    log(`page load to catalog ready: ${Date.now() - loadStart}ms`)

    // Counts: every listed property is a card; deprecated ones start hidden
    const total = await page.evaluate(`document.querySelectorAll('.prop-catalog-list > li.prop-card').length`)
    const deprecated = listed.filter((e) => e.is_deprecated === true).length
    assert(total === listed.length, `${total} cards, one per property not excluded from docs (${entries.length} in the data, ${entries.length - listed.length} excluded)`)
    assert(await page.evaluate(`${VISIBLE}.length`) === total - deprecated, `${total - deprecated} cards show; the ${deprecated} deprecated ones are hidden by default`)
    assert(await page.evaluate(`${VISIBLE}.every(c => c.dataset.deprecated === 'no')`), 'no visible card is deprecated by default')
    assert(await page.evaluate(`document.querySelector('.prop-catalog-more').hidden && document.querySelector('.prop-chip--more').getAttribute('aria-expanded') === 'false'`), 'the More panel starts closed')
    assert(await page.evaluate(PRESSED(chipFor('deprecated'))) === 'false', 'the Show deprecated chip starts unpressed')
    await openMore(page, 'deprecated')
    assert(await page.evaluate(`document.querySelector('.prop-chip--more').getAttribute('aria-expanded')`) === 'true', 'More filters opens the panel and sets aria-expanded')
    assert(await page.evaluate(`document.querySelector('${groupSel('deprecated')} .dropdown-text').textContent`) === 'Hidden', 'the Deprecated filter reads "Hidden"')
    assert(await page.evaluate(`document.querySelector('.prop-catalog .prop-catalog-search').placeholder`) === `Search ${total - deprecated} properties`, 'the search placeholder counts the properties')
    assert(await page.evaluate(COUNT) === `${total - deprecated} properties`, `the count reads "${total - deprecated} properties"`)
    const region = await page.evaluate(`(() => { const r = document.querySelectorAll('.prop-catalog [role="status"]'); return r.length + '|' + r[0].getAttribute('aria-live') + '|' + r[0].textContent + '|' + (r[0].getBoundingClientRect().width <= 1) })()`)
    assert(region === '1|polite||true', `one visually hidden, empty role=status region (${region})`)

    // Badges follow the meaning-system contract
    const badges = await page.evaluate(`(() => {
      const all = Array.from(document.querySelectorAll('.prop-catalog .rp-badge'));
      return { count: all.length, sm: all.every(b => b.classList.contains('rp-badge--sm')), tooltips: all.every(b => (b.getAttribute('data-tooltip') || '').trim()), titles: all.filter(b => b.hasAttribute('title')).length,
        kinds: Array.from(new Set(all.map(b => b.className.match(/rp-badge--(?!sm)([a-z-]+)/)[1] + ':' + b.querySelector('.prop-badge-label').textContent))).sort(),
        detail: all.every(b => { const h = b.querySelector('.prop-catalog-visually-hidden'); return h && h.textContent === '. ' + b.getAttribute('data-tooltip') }) };
    })()`)
    assert(badges.count > total && badges.sm && badges.tooltips && badges.titles === 0, `${badges.count} badges, every one rp-badge--sm with a data-tooltip and no title`)
    assert(badges.detail, 'every badge carries its tooltip text as visually hidden text, for assistive technology')
    const cardA11y = await page.evaluate(`(() => {
      const list = document.querySelector('.prop-catalog-list');
      const cards = Array.from(list.children);
      return {
        listName: list.getAttribute('aria-label'), nofocus: list.hasAttribute('data-tooltip-nofocus'),
        headings: cards.filter(c => c.querySelector(':scope > .prop-card-head > h2.prop-card-sig')).length,
        cv: getComputedStyle(cards[cards.length - 1]).contentVisibility,
        countHidden: document.querySelector('.prop-catalog-count').getAttribute('aria-hidden'),
        dupLabels: document.querySelectorAll('.prop-catalog label[for$="-toggle"]').length
      };
    })()`)
    assert(cardA11y.listName === 'Properties' && cardA11y.nofocus && cardA11y.headings === total, `the list is named "Properties", opts its badges out of the tab order, and every card's name is an h2 (${JSON.stringify(cardA11y)})`)
    assert(cardA11y.cv !== 'auto', `cards do not use content-visibility, so off-screen cards stay in the accessibility tree (${cardA11y.cv})`)
    assert(cardA11y.countHidden === null && cardA11y.dupLabels === 0, 'the count is readable in browse mode, and no filter label is read twice')
    // A card far down the list, with the page at the top, has its named link in the tree
    const lastLink = await page.accessible('li.prop-card[data-name="write_caching_default"] .prop-card-link')
    assert(lastLink.role === 'link' && lastLink.name === 'write_caching_default', `a card at the end of the list exposes its link while off screen, named with the exact name (${JSON.stringify(lastLink)})`)
    for (const kind of ['neutral:Cluster', 'neutral:Object storage', 'neutral:Broker', 'neutral:Topic', 'neutral:Restart required', 'enterprise:Enterprise values', 'deprecated:Deprecated']) {
      assert(badges.kinds.includes(kind), `a ${kind.replace(':', ' badge reads ')}`)
    }
    const signature = await page.evaluate(`document.querySelector('li.prop-card[data-name="retention_bytes"] .prop-card-sig').textContent`)
    assert(signature === 'retention_bytes: integer', `the signature reads "${signature}"`)
    const desc = await page.evaluate(`document.querySelector('li.prop-card[data-name="retention_bytes"] .prop-card-desc').textContent`)
    assert(desc === 'Default maximum number of bytes per partition on disk before triggering deletion of the oldest messages.', `the summary is the first sentence, as plain text ("${desc}")`)
    const raw = await page.evaluate(`Array.from(document.querySelectorAll('.prop-card-desc')).filter(p => /xref:|\\\`|\\*\\*|include::|<<|\\{[a-z-]+\\}/.test(p.textContent)).map(p => p.closest('li').dataset.name)`)
    assert(raw.length === 0, `no summary shows raw AsciiDoc (${raw.join(', ') || 'none'})`)

    // Enterprise values: derived from the reference templates' rules
    const sasl = await page.evaluate(`(() => { const b = document.querySelector('li.prop-card[data-name="sasl_mechanisms"] .rp-badge--enterprise'); return b && b.querySelector('.prop-badge-label').textContent + '|' + b.getAttribute('data-tooltip') })()`)
    assert(sasl === 'Enterprise values|The values GSSAPI or OAUTHBEARER require an Enterprise Edition license.', `sasl_mechanisms names its Enterprise values (${sasl})`)
    const enumOnly = await page.evaluate(`(() => { const b = document.querySelector('li.prop-card[data-name="sasl_mechanism"] .rp-badge--enterprise'); return b && b.getAttribute('data-tooltip') })()`)
    assert(enumOnly === 'The value OAUTHBEARER requires an Enterprise Edition license.', 'sasl_mechanism, not is_enterprise but with an Enterprise enum value, is marked from x-enum-metadata')
    const sanctioned = await page.evaluate(`document.querySelector('li.prop-card[data-name="partition_autobalancing_mode"] .rp-badge--enterprise').getAttribute('data-tooltip')`)
    assert(sanctioned === 'The value continuous requires an Enterprise Edition license. Without a license, the default is node_add.', 'a restricted_with_sanctioned property names the license-free default')

    // Search over name and description
    const retentionNames = listed.filter((e) => e.is_deprecated !== true && e.name.includes('retention')).map((e) => e.name)
    await setSearch(page, 'retention')
    timings.push(await page.evaluate(`document.querySelector('.prop-catalog').lastFilterMs`))
    const found = await page.evaluate(VISIBLE_NAMES)
    assert(retentionNames.every((n) => found.includes(n)), `searching "retention" finds all ${retentionNames.length} properties named for it`)
    assert(found.length > retentionNames.length, `and ${found.length - retentionNames.length} more whose descriptions mention it`)
    const searchStatus = await page.evaluate(STATUS)
    assert(await page.evaluate(`(() => { const s = document.querySelector('.prop-catalog-status'); let n = 0; const o = new MutationObserver(() => n++); o.observe(s, { childList: true, characterData: true, subtree: true }); window.__propAnnounces = () => { o.disconnect(); return n } })()`) === undefined, 'watching the status region')
    await setSearch(page, 'retention_ms')
    const announces = await page.evaluate('window.__propAnnounces()')
    assert(announces <= 2, `typing a 12-letter search announces at most twice, not once a keystroke (${announces})`)
    await setSearch(page, 'retention')
    assert(searchStatus === `${found.length} properties match "retention".`, `the status region announces "${searchStatus}"`)
    assert(await page.evaluate(`new URLSearchParams(location.search).get('q')`) === 'retention', 'the URL carries ?q=retention')
    await setSearch(page, 'enables iceberg')
    const multi = await page.evaluate(VISIBLE_NAMES)
    assert(multi.includes('iceberg_enabled') && multi.length < 10, `a two-word search matches both words (${multi.join(', ')})`)
    // Ranking: exact name, then name prefix, then name contains, then description
    await setSearch(page, 'log_segment_size')
    const ranked = await page.evaluate(VISIBLE_NAMES)
    assert(ranked[0] === 'log_segment_size', `searching log_segment_size lists it first (${ranked.slice(0, 3).join(', ')})`)
    await setSearch(page, 'retention')
    const tiers = await page.evaluate(VISIBLE_NAMES)
    const tierOf = (n) => n.replace(/[._-]+/g, '_').startsWith('retention') ? 1 : n.includes('retention') ? 2 : 3
    assert(tiers.every((n, i) => i === 0 || tierOf(tiers[i - 1]) < tierOf(n) || (tierOf(tiers[i - 1]) === tierOf(n) && tiers[i - 1].localeCompare(n) < 0)), `"retention" ranks name prefixes, then names containing it, then description matches, alphabetical within each (${tiers.slice(0, 4).join(', ')})`)
    await setSearch(page, '')
    await page.evaluate(`document.querySelector('.prop-catalog-search').dispatchEvent(new Event('input'))`)
    const restored = await page.evaluate(`Array.from(document.querySelectorAll('.prop-catalog-list > li.prop-card')).map(c => c.dataset.name)`)
    assert(restored.every((n, i) => i === 0 || restored[i - 1].localeCompare(n) <= 0), 'clearing the search restores alphabetical order')
    // Dotted paths, separators, and the command's own path
    for (const [q, want] of [['pandaproxy_client.sasl_mechanism', 'sasl_mechanism'], ['segment_bytes', 'segment.bytes'], ['log.segment.size', 'log_segment_size'], ['pandaproxy_client', 'brokers']]) {
      await setSearch(page, q)
      const hits = await page.evaluate(VISIBLE_NAMES)
      assert(hits.includes(want), `searching "${q}" finds ${want} (${hits.length} results)`)
    }
    // Badge words are searchable
    const restartCount = listed.filter((e) => e.needs_restart === true && e.is_deprecated !== true).length
    await setSearch(page, 'restart')
    assert(await page.evaluate(`${VISIBLE}.length`) >= restartCount, `searching "restart" finds every property with the Restart required badge (${restartCount})`)
    await setSearch(page, 'enterprise')
    assert(await page.evaluate(`${VISIBLE}.every(c => c.querySelector('.rp-badge--enterprise') || /enterprise/i.test(c.textContent))`) && await page.evaluate(`${VISIBLE}.length`) >= 15, 'searching "enterprise" finds the properties with an Enterprise badge')
    // The empty state fits the cause: a search alone
    await setSearch(page, 'zzzz-no-such-property')
    const emptyText = await page.evaluate(`[document.querySelector('.prop-catalog-empty-title').textContent, document.querySelector('.prop-catalog-empty-hint').textContent, document.querySelector('.prop-catalog-clear').textContent].join('|')`)
    assert(emptyText === 'No properties match "zzzz-no-such-property".|Check the spelling, or try part of the name.|Clear search', `with only a search, the empty state talks about the search (${emptyText})`)

    // Scope filter, as a disclosure with keyboard and screen-reader behavior
    await setSearch(page, '')
    await page.evaluate(`document.querySelector('.prop-catalog-search').dispatchEvent(new Event('input'))`)
    await openMore(page, 'type')
    const toggleAx = await page.accessible(`${groupSel('type')} .dropdown-checkbox-toggle`)
    assert(toggleAx.name === 'Type: All' && toggleAx.role === 'button', `the Type toggle is a button named "${toggleAx.name}"`)
    const aria = await page.evaluate(`(() => ({
      haspopup: document.querySelectorAll('.prop-catalog [aria-haspopup]').length,
      menus: document.querySelectorAll('.prop-catalog [role="menu"]').length,
      arrows: Array.from(document.querySelectorAll('.prop-catalog .dropdown-arrow')).every(a => a.getAttribute('aria-hidden') === 'true'),
      groups: Array.from(document.querySelectorAll('.prop-catalog .dropdown-checkbox-menu')).every(m => m.getAttribute('role') === 'group'),
      controls: Array.from(document.querySelectorAll('.prop-catalog .dropdown-checkbox-toggle')).every(t => document.getElementById(t.getAttribute('aria-controls')))
    }))()`)
    assert(aria.haspopup === 0 && aria.menus === 0 && aria.arrows && aria.groups && aria.controls, `no filter claims to be an ARIA menu; arrows are aria-hidden; options are groups each toggle controls (${JSON.stringify(aria)})`)
    const types = await page.evaluate(`Array.from(document.querySelectorAll('${groupSel('type')} input')).map(b => b.value)`)
    await clickOptions(page, 'type', types.filter((t) => t !== 'boolean'))
    timings.push(await page.evaluate(`document.querySelector('.prop-catalog').lastFilterMs`))
    assert(await page.evaluate(`document.querySelector('${groupSel('type')} .dropdown-checkbox-toggle').getAttribute('aria-expanded')`) === 'true', 'the open toggle has aria-expanded="true"')
    const menuAx = await page.accessible(`${groupSel('type')} .dropdown-checkbox-menu`)
    assert(menuAx.role === 'group' && menuAx.name === 'Type:', `the open options are a group named by the label (${menuAx.role}, "${menuAx.name}")`)
    const booleans = listed.filter((e) => e.type === 'boolean' && e.is_deprecated !== true).length
    assert(await page.evaluate(`${VISIBLE}.length === ${booleans} && ${VISIBLE}.every(c => c.dataset.type === 'boolean')`), `Type: Boolean leaves the ${booleans} boolean properties`)
    assert((await page.accessible(`${groupSel('type')} .dropdown-checkbox-toggle`)).name === 'Type: Boolean', 'the toggle\'s name follows the value')
    assert(await page.evaluate(`document.querySelector('${groupSel('type')} .dropdown-checkbox-toggle').classList.contains('is-active')`), 'a narrowed dropdown is marked active')
    assert(await page.evaluate(`new URLSearchParams(location.search).get('type')`) === 'boolean', 'the URL carries ?type=boolean')
    assert(await page.evaluate(STATUS) === `${booleans} properties match these filters.`, 'the status region announces the filtered count')
    assert(await page.evaluate(`document.querySelector('.prop-chip--more .prop-chip-badge').textContent === '1' && !document.querySelector('.prop-chip--more .prop-chip-badge').hidden`), 'the More button counts one changed filter')
    if (shots) await page.screenshot(path.join(shots, 'filter-open-1280.png'))
    await page.pressKey('Escape', 'Escape', 27)
    await page.waitFor(`!document.querySelector('${groupSel('type')} .dropdown-checkbox-menu').classList.contains('show')`, 'Escape to close the menu')
    assert(await page.evaluate(`document.activeElement === document.querySelector('${groupSel('type')} .dropdown-checkbox-toggle')`), 'Escape returns focus to the toggle')
    await page.pressKey('Enter', 'Enter', 13)
    await page.waitFor(`document.querySelector('${groupSel('type')} .dropdown-checkbox-menu').classList.contains('show')`, 'Enter on the toggle to reopen it')
    await page.pressKey('Tab', 'Tab', 9)
    assert(await page.evaluate(`document.activeElement && document.activeElement.matches('${groupSel('type')} input[value="${types[0]}"]')`), 'Tab moves from the open toggle to its first checkbox')
    await page.pressKey(' ', 'Space', 32)
    await page.waitFor(`document.querySelector('${groupSel('type')} input[value="${types[0]}"]').checked`, `Space to check ${types[0]}`)
    // Tab past the last checkbox: the menu closes when focus leaves it
    const boxCount = types.length
    for (let i = 1; i < boxCount; i++) await page.pressKey('Tab', 'Tab', 9)
    assert(await page.evaluate(`document.querySelector('${groupSel('type')} .dropdown-checkbox-menu').classList.contains('show')`), 'the menu stays open while focus is inside it')
    await page.pressKey('Tab', 'Tab', 9)
    assert(await page.evaluate(`!document.querySelector('${groupSel('type')} .dropdown-checkbox-menu').classList.contains('show') && document.querySelector('${groupSel('type')} .dropdown-checkbox-toggle').getAttribute('aria-expanded') === 'false'`), 'Tab out of the menu closes it')
    assert(await page.evaluate(`!document.querySelector('${groupSel('type')}').contains(document.activeElement)`), 'and focus stays where Tab moved it')
    await page.click(`${groupSel('type')} .dropdown-checkbox-toggle`)
    await page.click('.prop-catalog-count')
    assert(await page.evaluate(`!document.querySelector('.prop-catalog .dropdown-checkbox-menu.show')`), 'a click outside closes the menu')
    // Escape inside the open More panel closes it and returns to More filters
    await page.evaluate(`document.querySelector('${groupSel('type')} .dropdown-checkbox-toggle').focus()`)
    await page.pressKey('Escape', 'Escape', 27)
    assert(await page.evaluate(`document.querySelector('.prop-catalog-more').hidden && document.activeElement === document.querySelector('.prop-chip--more')`), 'Escape in the More panel closes it and focuses More filters')

    // Group chips: one press narrows to a page, with live counts
    await page.navigate(base + PAGE)
    await page.waitFor(READY, 'the catalog')
    const topics = listed.filter((e) => e.config_scope === 'topic' && e.is_deprecated !== true).length
    const groupAx = await page.accessible(groupChip('topic'))
    assert(groupAx.role === 'button' && groupAx.name === `Topic ${topics} properties`, `the Topic chip is a button named "${groupAx.name}"`)
    assert(await page.evaluate(`document.querySelector('${groupChip('')} .prop-chip-count').textContent`) === String(total - deprecated), 'the All chip counts every visible property')
    await page.click(groupChip('topic'))
    timings.push(await page.evaluate(`document.querySelector('.prop-catalog').lastFilterMs`))
    assert(await page.evaluate(PRESSED(groupChip('topic'))) === 'true' && await page.evaluate(PRESSED(groupChip(''))) === 'false', 'Topic is pressed and All is not')
    assert(await page.evaluate(`${VISIBLE}.length === ${topics} && ${VISIBLE}.every(c => c.dataset.group === 'topic')`), `Topic leaves the ${topics} topic properties`)
    assert(await page.evaluate(`new URLSearchParams(location.search).get('group')`) === 'topic', 'the URL carries ?group=topic')
    assert(await page.evaluate(`document.querySelector('${groupChip('topic')} .prop-chip-count').textContent === String(${VISIBLE}.length)`), 'the Topic count equals the rows shown')
    assert(await page.evaluate(STATUS) === `${topics} properties match these filters.`, 'the status region announces the filtered count')
    assert(JSON.stringify(await page.evaluate(TAGS)) === JSON.stringify(['Group: Topic']), 'a tag shows the Group filter')
    await setSearch(page, 'retention')
    const retentionTopics = await page.evaluate(`${VISIBLE}.length`)
    assert(retentionTopics < topics && await page.evaluate(`document.querySelector('${groupChip('topic')} .prop-chip-count').textContent`) === String(retentionTopics), `searching updates the chip counts (Topic ${retentionTopics})`)
    assert(await page.evaluate(COUNT) === `${retentionTopics} of ${total - deprecated} properties`, `the count reads "${await page.evaluate(COUNT)}"`)
    await page.click(groupChip('cluster'))
    assert(await page.evaluate(`new URLSearchParams(location.search).get('group')`) === 'cluster,object-storage,topic', 'a second chip adds its group, and Cluster brings object storage (?group=cluster,object-storage,topic)')
    await page.click(groupChip('cluster'))
    await page.click(groupChip('topic'))
    assert(await page.evaluate(PRESSED(groupChip(''))) === 'true' && await page.evaluate(`new URLSearchParams(location.search).get('group')`) === null, 'pressing Topic again restores All')
    await setSearch(page, '')
    await page.evaluate(`document.querySelector('.prop-catalog-search').dispatchEvent(new Event('input'))`)
    // Cluster covers object storage, which is cluster configuration too;
    // Object storage narrows inside it
    const clusterAndOs = listed.filter((e) => ['cluster', 'object-storage'].includes(propertyPageFor(e)) && e.is_deprecated !== true).length
    assert(await page.evaluate(`document.querySelector('${groupChip('cluster')} .prop-chip-count').textContent`) === String(clusterAndOs), `the Cluster chip counts the object storage properties too (${clusterAndOs})`)
    await page.click(groupChip('cluster'))
    assert(await page.evaluate(`${VISIBLE}.length`) === clusterAndOs && JSON.stringify(await page.evaluate(TAGS)) === JSON.stringify(['Group: Cluster']), 'Cluster keeps cluster and object storage properties, and its tag reads "Group: Cluster"')
    assert(await page.evaluate(PRESSED(groupChip('object-storage'))) === 'false', 'inside a pressed Cluster, Object storage reads as unpressed')
    await page.click(groupChip('object-storage'))
    assert(await page.evaluate(`new URLSearchParams(location.search).get('group')`) === 'object-storage' && await page.evaluate(PRESSED(groupChip('object-storage'))) === 'true' && await page.evaluate(PRESSED(groupChip('cluster'))) === 'false', 'Object storage inside Cluster narrows to object storage')
    await page.click(groupChip('object-storage'))
    assert(await page.evaluate(PRESSED(groupChip(''))) === 'true', 'pressing it again restores All')
    // The keyboard "/" stays the browser's while focus is elsewhere on the page
    await page.evaluate(`(() => { const a = Array.from(document.querySelectorAll('a[href]')).find(a => !a.closest('.prop-catalog') && a.offsetParent); a.focus(); window.__slashFrom = a })()`)
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: '/', code: 'Slash', windowsVirtualKeyCode: 191, text: '/' })
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: '/', code: 'Slash', windowsVirtualKeyCode: 191 })
    assert(await page.evaluate(`document.activeElement === window.__slashFrom`), '"/" does nothing while a link outside the catalog has focus')
    await page.evaluate(`document.querySelector('${groupChip('topic')}').focus()`)
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: '/', code: 'Slash', windowsVirtualKeyCode: 191, text: '/' })
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: '/', code: 'Slash', windowsVirtualKeyCode: 191 })
    assert(await page.evaluate(`document.activeElement === document.querySelector('.prop-catalog-search')`), '"/" from a control inside the catalog focuses its search')

    // Restart required, Type, Category: each filter narrows to its value
    await page.navigate(base + PAGE)
    await page.waitFor(READY, 'the catalog')
    await clickOptions(page, 'restart', ['no'])
    timings.push(await page.evaluate(`document.querySelector('.prop-catalog').lastFilterMs`))
    const restart = listed.filter((e) => e.needs_restart === true && e.is_deprecated !== true).length
    assert(await page.evaluate(`${VISIBLE}.length === ${restart} && ${VISIBLE}.every(c => c.dataset.restart === 'yes' && c.querySelector('.rp-badge').parentNode.textContent.includes('Restart required'))`), `Restart required: Yes leaves the ${restart} properties that need a restart`)
    assert(await page.evaluate(PRESSED(chipFor('restart'))) === 'true', 'the dropdown and the Restart required chip agree')
    await page.pressKey('Escape', 'Escape', 27)

    // Quick chips
    await page.navigate(base + PAGE)
    await page.waitFor(READY, 'the catalog')
    await page.click(chipFor('restart'))
    assert(await page.evaluate(PRESSED(chipFor('restart'))) === 'true' && await page.evaluate(`new URLSearchParams(location.search).get('restart')`) === 'yes', 'the Restart required chip presses and sets ?restart=yes')
    assert(await page.evaluate(`${VISIBLE}.length === ${restart} && ${VISIBLE}.every(c => c.querySelector('.prop-badge--restart'))`), 'every row it keeps has the Restart required badge')
    assert(await page.evaluate(`document.querySelector('.prop-catalog-more').hidden`), 'a chip does not open the More panel')
    await page.click(chipFor('enterprise'))
    assert(await page.evaluate(`${VISIBLE}.length > 0 && ${VISIBLE}.every(c => c.querySelector('.rp-badge--enterprise') && c.classList.contains('prop-card--enterprise'))`), 'Enterprise leaves only rows with an Enterprise badge and accent')
    assert(JSON.stringify(await page.evaluate(TAGS)) === JSON.stringify(['Restart required: Yes', 'Enterprise: Needs a license']), `the tags name both filters (${await page.evaluate(TAGS)})`)
    assert(await page.evaluate(`!document.querySelector('.prop-catalog-reset').hidden`), 'Clear all appears with two tags')
    assert(await page.evaluate(`document.querySelector('.prop-chip--more .prop-chip-badge').hidden && !document.querySelector('.prop-chip--more').classList.contains('is-active')`), 'filters a pressed chip shows do not light the More badge')
    assert(await page.evaluate(`(() => { const r = document.querySelector('.prop-catalog-results'); return !!r.closest('.prop-catalog-bar') && r.contains(document.querySelector('.prop-catalog-reset')) })()`), 'the count, the tags, and Clear all sit in the bar, in one row')
    const tagAx = await page.accessible('.prop-catalog .prop-active-tag')
    assert(tagAx.role === 'button' && tagAx.name === 'Remove filter: Restart required: Yes', `a tag is a button named "${tagAx.name}"`)
    if (shots) await page.screenshot(path.join(shots, 'chips-pressed-1280.png'))
    await page.click('.prop-catalog .prop-active-tag[data-reset="restart"]')
    assert(await page.evaluate(PRESSED(chipFor('restart'))) === 'false' && JSON.stringify(await page.evaluate(TAGS)) === JSON.stringify(['Enterprise: Needs a license']), 'a tag click removes its filter')
    assert(await page.evaluate(`document.activeElement === document.querySelector('.prop-catalog .prop-active-tag')`), 'focus moves to the next tag')
    assert(await page.evaluate(`document.querySelector('.prop-catalog-reset').hidden`), 'Clear all hides with one tag')
    await page.pressKey('Enter', 'Enter', 13)
    await page.waitFor(`${TAGS}.length === 0`, 'Enter on the last tag')
    assert(await page.evaluate(`document.activeElement === document.querySelector('.prop-catalog-search')`), 'with no tag left, focus moves to the search')
    await page.click(chipFor('restart'))
    await page.click(chipFor('deprecated'))
    await page.click('.prop-catalog-reset')
    assert(await page.evaluate(`location.search === '' && ${TAGS}.length === 0 && document.activeElement === document.querySelector('.prop-catalog-search')`), 'Clear all resets every filter and focuses the search')
    await page.navigate(`${base}${PAGE}?restart=no`)
    await page.waitFor(READY, 'the catalog with ?restart=no')
    assert(await page.evaluate(PRESSED(chipFor('restart'))) === 'false' && JSON.stringify(await page.evaluate(TAGS)) === JSON.stringify(['Restart required: No']), '?restart=no leaves the chip unpressed and shows "Restart required: No"')
    assert(await page.evaluate(`!document.querySelector('.prop-catalog-more').hidden`), 'a URL filter no chip shows opens the More panel')
    for (const [param, value, pick] of [
      ['type', 'boolean', (e) => e.type === 'boolean'],
      ['group', 'object-storage', (e) => propertyPageFor(e) === 'object-storage'],
      ['section', 'topic:tiered-storage', (e) => e.config_scope === 'topic' && e.category === 'tiered-storage']
    ]) {
      await page.navigate(`${base}${PAGE}?${param}=${encodeURIComponent(value)}`)
      await page.waitFor(READY, `the catalog with ?${param}=`)
      const expected = listed.filter((e) => pick(e) && e.is_deprecated !== true).length
      assert(expected > 0 && await page.evaluate(`${VISIBLE}.length === ${expected} && ${VISIBLE}.every(c => c.dataset.${param} === '${value}')`), `?${param}=${value} applies on load and leaves the ${expected} matching properties`)
    }
    const sections = await page.evaluate(`Array.from(document.querySelectorAll('${groupSel('section')} .dropdown-checkbox-option span')).map(s => s.textContent)`)
    assert(sections.includes('Topic: Tiered Storage') && sections.includes('Broker: HTTP Proxy client') && !sections.includes('Broker: Other'), `the Section filter uses the reference pages' section names, and no section that holds only deprecated properties (${sections.join(', ')})`)
    // No filter value matches nothing or everything in the default view
    const useless = await page.evaluate(`(() => {
      const cards = Array.from(document.querySelectorAll('.prop-catalog-list > li.prop-card')).filter(c => c.dataset.deprecated === 'no');
      const key = (k) => k.replace(/-([a-z])/g, (m, c) => c.toUpperCase());
      const out = [];
      document.querySelectorAll('.prop-catalog .filter-group').forEach(g => {
        const k = key(g.dataset.filter);
        const boxes = g.querySelectorAll('input');
        if (boxes.length < 2) out.push(g.dataset.filter + ' has one option');
        boxes.forEach(b => {
          if (g.dataset.filter === 'deprecated') return;
          const n = cards.filter(c => c.dataset[k] === b.value).length;
          if (n === 0 || n === cards.length) out.push(g.dataset.filter + '=' + b.value + ' matches ' + n);
        });
      });
      return out;
    })()`)
    assert(useless.length === 0, `every filter value matches some but not all properties${useless.length ? `: ${useless.join('; ')}` : ''}`)
    // The catalog groups every property on the page the generator writes it to
    const misgrouped = await page.evaluate(`Array.from(document.querySelectorAll('.prop-catalog-list > li.prop-card')).map(c => [c.dataset.name, c.dataset.group])`)
    const wrong = misgrouped.filter(([name, group]) => propertyPageFor(data[name]) !== group)
    assert(wrong.length === 0, `every card's group is the generator's page for it${wrong.length ? `: ${wrong.slice(0, 5).join('; ')}` : ''}`)

    // Enterprise: Enterprise and Enterprise values, nothing else
    await page.navigate(base + PAGE)
    await page.waitFor(READY, 'the catalog')
    await clickOptions(page, 'enterprise', ['none'])
    const licensed = await page.evaluate(VISIBLE_NAMES)
    assert(licensed.length >= 15 && licensed.includes('sasl_mechanism') && licensed.includes('cloud_storage_enabled'), `the Enterprise filter keeps the ${licensed.length} properties with Enterprise values or a license requirement`)
    assert(await page.evaluate(`${VISIBLE}.every(c => c.querySelector('.rp-badge--enterprise'))`), 'every card it keeps has an Enterprise badge')

    // Deprecated: off by default, and the catalog is where readers find them
    await page.navigate(base + PAGE)
    await page.waitFor(READY, 'the catalog')
    await clickOptions(page, 'deprecated', ['yes'])
    assert(await page.evaluate(`${VISIBLE}.length`) === total, 'checking Deprecated shows every card')
    assert(await page.evaluate(PRESSED(chipFor('deprecated'))) === 'true' && JSON.stringify(await page.evaluate(TAGS)) === JSON.stringify(['Deprecated: Shown']), 'the Show deprecated chip presses, and the tag reads "Deprecated: Shown"')
    assert(await page.evaluate(COUNT) === `${total} properties`, `with deprecated included, the count's total is ${total}`)
    await page.click(`${groupSel('deprecated')} input[value="no"]`)
    const depNames = await page.evaluate(VISIBLE_NAMES)
    assert(depNames.length === deprecated && depNames.includes('dashboard_dir'), `Deprecated alone shows the ${deprecated} deprecated properties`)
    assert(await page.evaluate(`${VISIBLE}.every(c => !c.querySelector('.prop-card-link'))`), 'deprecated properties have no reference link (the reference pages leave them out)')
    assert(await page.evaluate(`new URLSearchParams(location.search).get('deprecated')`) === 'yes', 'the URL carries ?deprecated=yes')
    await page.pressKey('Escape', 'Escape', 27)

    // Empty state, then Clear filters
    await setSearch(page, 'zzzz-no-such-property')
    await page.waitFor(`!document.querySelector('.prop-catalog-empty').hidden`, 'the empty state')
    assert(await page.evaluate(STATUS) === 'No properties match "zzzz-no-such-property" and these filters.', `the status region says nothing matches ("${await page.evaluate(STATUS)}")`)
    if (shots) await page.screenshot(path.join(shots, 'empty-state-1280.png'))
    assert(await page.evaluate(`document.querySelector('.prop-catalog-list').hidden && document.querySelector('.prop-catalog-show-deprecated').hidden`), 'the empty list hides, and no deprecated matches are offered')
    await page.click('.prop-catalog-empty .prop-catalog-clear')
    await page.waitFor(`${VISIBLE}.length === ${total - deprecated}`, 'Clear filters to restore the default view')
    assert(await page.evaluate(`document.querySelector('.prop-catalog-empty').hidden && document.querySelector('.prop-catalog-search').value === '' && document.activeElement === document.querySelector('.prop-catalog-search')`), 'Clear filters empties the search, hides the empty state, and focuses the search box')
    assert(await page.evaluate(STATUS) === `Showing ${total - deprecated} properties. Deprecated properties are hidden.`, 'the status region says what shows and that deprecated properties are hidden')
    assert(await page.evaluate(`location.search`) === '', 'the URL drops every parameter')

    // A search that matches only deprecated properties offers to show them
    const allCards = listed.map((e) => catalogMacro.cardModel(e))
    const shownText = allCards.filter((c) => c.deprecated !== 'yes').map((c) => c.search)
    const norm = catalogMacro.normalizeSearch
    const depTerm = allCards.filter((c) => c.deprecated === 'yes').map((c) => c.name).find((n) => !shownText.some((t) => t.includes(norm(n))))
    const depHits = allCards.filter((c) => c.deprecated === 'yes' && c.search.includes(norm(depTerm))).length
    await setSearch(page, depTerm)
    await page.waitFor(`!document.querySelector('.prop-catalog-empty').hidden`, 'the empty state for a deprecated-only search')
    const offer = await page.evaluate(`(() => { const b = document.querySelector('.prop-catalog-show-deprecated'); return b.hidden ? '' : b.textContent })()`)
    assert(offer === `Show ${depHits} deprecated ${depHits === 1 ? 'match' : 'matches'}`, `searching "${depTerm}" offers "${offer}"`)
    await page.click('.prop-catalog-show-deprecated')
    assert(await page.evaluate(`${VISIBLE}.length`) === depHits && await page.evaluate(PRESSED(chipFor('deprecated'))) === 'true', `the offer shows the ${depHits} deprecated rows`)
    await page.navigate(base + PAGE)
    await page.waitFor(READY, 'the catalog')

    // Keyboard: "/" focuses the search, Escape clears it
    await page.evaluate(`document.activeElement && document.activeElement.blur()`)
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: '/', code: 'Slash', windowsVirtualKeyCode: 191, text: '/' })
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: '/', code: 'Slash', windowsVirtualKeyCode: 191 })
    assert(await page.evaluate(`document.activeElement === document.querySelector('.prop-catalog-search') && document.querySelector('.prop-catalog-search').value === ''`), '"/" from the page focuses the search without typing a slash')
    await page.typeText('retention')
    await page.waitFor(`new URLSearchParams(location.search).get('q') === 'retention'`, 'the typed search')
    await page.pressKey('Escape', 'Escape', 27)
    assert(await page.evaluate(`document.querySelector('.prop-catalog-search').value === '' && ${VISIBLE}.length === ${total - deprecated} && location.search === ''`), 'Escape in the search clears it')

    // A shared link with several parameters opens in that state
    await page.navigate(`${base}${PAGE}?group=object-storage&q=cache&restart=yes`)
    await page.waitFor(READY, 'the catalog from a shared URL')
    const shared = await page.evaluate(`(() => ({ q: document.querySelector('.prop-catalog-search').value, cards: ${VISIBLE}.map(c => c.dataset.group + ':' + c.dataset.restart) }))()`)
    assert(shared.q === 'cache' && shared.cards.length > 0 && shared.cards.every((c) => c === 'object-storage:yes'), `?group=object-storage&q=cache&restart=yes applies on load (${shared.cards.length} cards)`)
    assert(await page.evaluate(STATUS) === '', 'a page load does not announce')
    assert(await page.evaluate(`document.querySelector('.prop-catalog-count').getAttribute('aria-hidden') === null && /of 674|of \\d+ properties/.test(document.querySelector('.prop-catalog-count').textContent)`), 'a shared filtered link still says "N of M" in a count assistive technology can read')

    // Filtering time, the worst of these, on all cards
    const perf = await page.evaluate(`(() => {
      const root = document.querySelector('.prop-catalog');
      const s = document.querySelector('.prop-catalog-search');
      const times = [];
      for (const q of ['', 'r', 're', 'retention', 'zzzz', '', 'cloud_storage', 'enable', '']) { s.value = q; root.filterProperties(); times.push(root.lastFilterMs); }
      document.querySelectorAll('.prop-catalog .filter-group[data-param="group"] input').forEach(b => { b.checked = !b.checked; root.filterProperties(); times.push(root.lastFilterMs); b.checked = !b.checked; root.filterProperties(); times.push(root.lastFilterMs); });
      // Every quick chip pressed, with a search
      document.querySelectorAll('.prop-catalog .prop-chip[data-chip-for]').forEach(c => { if (c.getAttribute('aria-pressed') !== 'true') c.click(); times.push(root.lastFilterMs); });
      for (const q of ['r', 'retention', 'cloud_storage', '']) { s.value = q; root.filterProperties(); times.push(root.lastFilterMs); }
      return times;
    })()`)
    timings.push(...perf)
    const worst = Math.max(...timings)
    assert(worst < FILTER_BUDGET_MS, `filtering ${total} cards takes at most ${worst.toFixed(1)}ms (median ${timings.slice().sort((a, b) => a - b)[Math.floor(timings.length / 2)].toFixed(1)}ms over ${timings.length} runs), under ${FILTER_BUDGET_MS}ms`)
    // The same changes including the browser's style and layout work, forced
    // synchronously: what a reader waits for before the page repaints
    const withLayout = await page.evaluate(`(() => {
      const root = document.querySelector('.prop-catalog');
      const s = document.querySelector('.prop-catalog-search');
      const times = [];
      for (const q of ['', 'r', 'retention', 'zzzz', '', 'cloud_storage', '']) { const t = performance.now(); s.value = q; root.filterProperties(); document.body.offsetHeight; times.push(performance.now() - t); }
      return times;
    })()`)
    worstLayout = Math.max(...withLayout)
    assert(worstLayout < FILTER_BUDGET_MS, `filtering plus layout takes at most ${worstLayout.toFixed(1)}ms, under ${FILTER_BUDGET_MS}ms`)

    // Links land on the property's entry in its reference page
    await page.navigate(base + PAGE)
    await page.waitFor(READY, 'the catalog')
    const links = await page.evaluate(`(() => Object.fromEntries(['retention_bytes', 'retention.ms', 'kafka_api', 'cloud_storage_cache_size'].map(n => [n, document.querySelector('li.prop-card[data-name="' + n + '"] .prop-card-link').href])))()`)
    assert(/\/preview\/reference\/properties\/cluster-properties\/#retention_bytes$/.test(links.retention_bytes), `retention_bytes links to the cluster reference (${links.retention_bytes})`)
    assert(/\/topic-properties\/#retention-ms$/.test(links['retention.ms']) && /\/broker-properties\/#kafka_api$/.test(links.kafka_api) && /\/object-storage-properties\/#cloud_storage_cache_size$/.test(links.cloud_storage_cache_size), 'topic, broker, and object storage properties link to their own pages, with dots as hyphens in the anchor')
    await page.click('li.prop-card[data-name="retention.ms"] .prop-card-link')
    await page.waitFor(`location.pathname.endsWith('/topic-properties/')`, 'the topic reference page')
    await page.waitFor(`!!document.getElementById('retention-ms')`, 'the anchor')
    assert(await page.evaluate(`location.hash === '#retention-ms' && document.getElementById('retention-ms').textContent.trim() === 'retention.ms'`), 'following the link lands on the retention.ms heading')

    // Copy buttons copy the right command
    await page.navigate(base + PAGE)
    await page.waitFor(READY, 'the catalog')
    const commands = {
      retention_bytes: 'rpk cluster config set retention_bytes <value>',
      'cleanup.policy': 'rpk topic alter-config <topic> --set cleanup.policy=<value>',
      kafka_api: 'rpk redpanda config set redpanda.kafka_api <value>',
      brokers: 'rpk redpanda config set pandaproxy_client.brokers <value>'
    }
    for (const [name, command] of Object.entries(commands)) {
      await page.evaluate(`navigator.clipboard.writeText('')`)
      await page.click(`li.prop-card[data-name="${name}"] .copy-button`)
      await page.waitFor(`navigator.clipboard.readText().then(t => t.length > 0)`, `the clipboard after copying ${name}`)
      const copied = await page.evaluate(`navigator.clipboard.readText()`)
      assert(copied === command, `the copy button on ${name} copies "${copied}"`)
    }
    const copyMarkup = await page.evaluate(`(() => { const b = document.querySelector('li.prop-card[data-name="retention_bytes"] .copy-button'); return { toolbox: !!b.closest('.source-toolbox'), toast: b.querySelector('.copy-toast').textContent, label: b.getAttribute('aria-label'), icon: !!b.querySelector('svg.copy-icon') } })()`)
    assert(copyMarkup.toolbox && copyMarkup.toast === 'Copied!' && copyMarkup.icon && /retention_bytes/.test(copyMarkup.label), `the copy button is the site's: copy icon, Copied! toast, named for its property (${JSON.stringify(copyMarkup)})`)

    // Tooltips through the UI's tippy setup, on hover and on keyboard focus
    await page.waitFor(`typeof tippy === 'function'`, 'the tooltip library')
    const badge = 'li.prop-card[data-name="sasl_mechanisms"] .rp-badge--enterprise'
    await page.hover(badge)
    await page.waitFor(`Array.from(document.querySelectorAll('.tippy-box')).some(b => b.textContent.includes('GSSAPI or OAUTHBEARER'))`, 'the tooltip on hover')
    assert(true, 'hovering the Enterprise values badge shows its tooltip')
    assert(await page.evaluate(`!!document.querySelector('${badge}')._tippy && !document.querySelector('${badge}').hasAttribute('tabindex')`), 'the badge has a tippy instance, and is not a tab stop (data-tooltip-nofocus)')
    assert(await page.evaluate(`document.querySelectorAll('.prop-catalog-list .rp-badge[tabindex]').length === 0 && document.querySelectorAll('.prop-catalog [aria-expanded]:not(.dropdown-checkbox-toggle):not(.prop-chip--more)').length === 0`), 'no badge is focusable, and no tooltip trigger carries aria-expanded')
    if (shots) await page.screenshot(path.join(shots, 'tooltip-1280.png'))
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 })
    await page.waitFor(`!Array.from(document.querySelectorAll('.tippy-box')).some(b => b.textContent.includes('GSSAPI or OAUTHBEARER'))`, 'the tooltip to hide')
    // Tab goes from a card's name straight to its copy button
    await page.evaluate(`document.querySelector('li.prop-card[data-name="sasl_mechanisms"] .prop-card-link').focus()`)
    await page.pressKey('Tab', 'Tab', 9)
    assert(await page.evaluate(`document.activeElement === document.querySelector('li.prop-card[data-name="sasl_mechanisms"] .copy-button')`), 'Tab skips the badges, from the name link to the copy button')
    const copyBtn = 'li.prop-card[data-name="sasl_mechanisms"] .copy-button'
    await page.waitFor(`(() => { const b = document.querySelector('${copyBtn}'); const id = b.getAttribute('aria-describedby'); const t = id && document.getElementById(id); return t && t.textContent.includes('Copy to clipboard') })()`, 'the copy tooltip on focus, linked by aria-describedby')
    assert(await page.evaluate(`!document.querySelector('${copyBtn}').hasAttribute('aria-expanded')`), 'the focused copy button is not announced as expandable')
    await page.pressKey('Escape', 'Escape', 27)
    await page.waitFor(`!Array.from(document.querySelectorAll('.tippy-box')).some(b => b.textContent.includes('Copy to clipboard') && b.closest('[data-tippy-root]') && getComputedStyle(b.closest('[data-tippy-root]')).visibility !== 'hidden' && b.getAttribute('data-state') === 'visible')`, 'Escape to hide the tooltip')
    assert(await page.evaluate(`document.activeElement === document.querySelector('${copyBtn}')`), 'Escape hides the tooltip and leaves focus where it was')

    // Sticky bar at 1280: it sticks under the site header
    await page.navigate(base + PAGE)
    await page.waitFor(READY, 'the catalog')
    const HEADER_BOTTOM = `Math.max(0, ...Array.from(document.querySelectorAll('.navbar, .header, .toolbar, .component-indicator-sticky')).filter(el => { const cs = getComputedStyle(el); const r = el.getBoundingClientRect(); return (cs.position === 'fixed' || cs.position === 'sticky') && r.height && r.top < innerHeight / 3 && r.height < innerHeight / 3 }).map(el => el.getBoundingClientRect().bottom))`
    assert(await page.evaluate(`getComputedStyle(document.querySelector('.prop-catalog-bar')).position`) === 'sticky', 'the catalog bar is sticky at 1280px')
    await page.evaluate(`window.scrollTo(0, 3000)`)
    await page.waitFor(`document.querySelector('.prop-catalog-bar').classList.contains('is-stuck')`, 'the bar to stick')
    const stuck = await page.evaluate(`(() => ({ top: document.querySelector('.prop-catalog-bar').getBoundingClientRect().top, header: ${HEADER_BOTTOM} }))()`)
    assert(stuck.top >= stuck.header - 0.5 && stuck.top - stuck.header <= 10, `after scrolling, the stuck bar sits ${(stuck.top - stuck.header).toFixed(1)}px under the header (bar ${stuck.top.toFixed(1)}, header ${stuck.header.toFixed(1)})`)
    if (shots) await page.screenshot(path.join(shots, 'stuck-1280.png'))
    await page.evaluate(`window.scrollTo(0, 0)`)
    // A short viewport with More open: the panel scrolls, so the results keep 40% of the screen
    await page.setViewport(1280, 600)
    await page.evaluate(`window.scrollTo(0, 1500)`)
    await page.click('.prop-catalog .prop-chip--more')
    await page.waitFor(`!document.querySelector('.prop-catalog-more').hidden`, 'the More panel')
    await page.evaluate(`window.scrollTo(0, 1500)`)
    await new Promise((resolve) => setTimeout(resolve, 200))
    const shortBar = await page.evaluate(`(() => { const b = document.querySelector('.prop-catalog-bar'); return { end: b.getBoundingClientRect().bottom / innerHeight, stuck: b.classList.contains('is-stuck') } })()`)
    assert(!shortBar.stuck || shortBar.end <= 0.62, `at 1280x600 with More open, the bar either scrolls away or stops at 60% of the viewport (${JSON.stringify(shortBar)})`)
    await page.setViewport(1280, 900)
    await page.evaluate(`window.scrollTo(0, 1500)`)
    await new Promise((resolve) => setTimeout(resolve, 200))
    const tallBar = await page.evaluate(`(() => { const b = document.querySelector('.prop-catalog-bar'); return { end: b.getBoundingClientRect().bottom / innerHeight, stuck: b.classList.contains('is-stuck') } })()`)
    assert(tallBar.stuck && tallBar.end <= 0.62, `at 1280x900 with More open, the stuck bar and its capped panel end at ${(tallBar.end * 100).toFixed(0)}% of the viewport`)
    await page.click('.prop-catalog .prop-chip--more')
    // At 1024 the site's own layout stops sticky from working, so the bar does not try
    await page.setViewport(1024, 768)
    await page.navigate(base + PAGE)
    await page.waitFor(READY, 'the catalog at 1024px')
    await page.evaluate(`window.scrollTo(0, 2000)`)
    await new Promise((resolve) => setTimeout(resolve, 200))
    const at1024 = await page.evaluate(`({ position: getComputedStyle(document.querySelector('.prop-catalog-bar')).position, stuck: document.querySelector('.prop-catalog-bar').classList.contains('is-stuck'), padding: document.documentElement.style.getPropertyValue('--prop-filter-offset') })`)
    assert(at1024.position === 'static' && !at1024.stuck && at1024.padding === '', `at 1024px the bar is not sticky, not marked stuck, and adds no scroll padding of its own (${JSON.stringify(at1024)})`)
    await page.setViewport(1280)
    await page.evaluate(`window.scrollTo(0, 0)`)

    // Contrast: every chip, tag, toggle, count, and command color at 4.5:1 or more
    await page.evaluate(CONTRAST_FN)
    for (const theme of ['light', 'dark']) {
      await page.navigate(`${base}${PAGE}?type=boolean`)
      await page.waitFor(READY, 'the catalog for contrast')
      await page.evaluate(CONTRAST_FN)
      if (theme === 'dark') await page.evaluate(`document.documentElement.setAttribute('data-theme', 'dark')`)
      await new Promise((resolve) => setTimeout(resolve, 300))
      const SAMPLE = `(() => {
        const out = [];
        const add = (what, el) => { if (el) out.push([what, Math.round(__contrast(el) * 100) / 100]) };
        document.querySelectorAll('.prop-catalog .prop-chip').forEach(c => { add('chip ' + c.textContent.trim(), c.querySelector('.prop-chip-label') || c); add('chip count ' + c.textContent.trim(), c.querySelector('.prop-chip-count')) });
        add('active toggle value', document.querySelector('.prop-catalog .dropdown-checkbox-toggle.is-active .dropdown-text'));
        add('active toggle label', document.querySelector('.prop-catalog .dropdown-checkbox-toggle.is-active .dropdown-label'));
        document.querySelectorAll('.prop-catalog .prop-active-tag').forEach(t => add('tag ' + t.textContent, t));
        add('count number', document.querySelector('.prop-catalog .prop-catalog-count strong'));
        add('count text', document.querySelector('.prop-catalog .prop-catalog-count'));
        add('command name', document.querySelector('.prop-card:not([hidden]) .prop-cmd-name'));
        add('command placeholder', document.querySelector('.prop-card:not([hidden]) .prop-cmd-ph'));
        add('type', document.querySelector('.prop-card:not([hidden]) .prop-card-type'));
        add('license value', document.querySelector('.prop-card:not([hidden]) .prop-card-license code'));
        return out;
      })()`
      const rest = await page.evaluate(SAMPLE)
      // Press every chip that can be pressed together: a group and each quick chip
      await page.click(groupChip('cluster'))
      for (const param of ['restart', 'enterprise', 'deprecated']) await page.click(chipFor(param))
      await new Promise((resolve) => setTimeout(resolve, 300))
      const pressed = (await page.evaluate(SAMPLE)).map(([what, ratio]) => [`${what} (pressed state)`, ratio])
      const low = rest.concat(pressed).filter(([, ratio]) => ratio < 4.5)
      assert(rest.length > 15 && low.length === 0, `${theme}: ${rest.length + pressed.length} text colors reach 4.5:1 (lowest ${Math.min(...rest.concat(pressed).map(([, r]) => r)).toFixed(2)})${low.length ? `; below: ${low.map(([w, r]) => `${w} ${r}`).join('; ')}` : ''}`)
      // Non-text: field borders and pressed fills reach 3:1 against the bar
      const edges = await page.evaluate(`(() => {
        const bar = document.querySelector('.prop-catalog-bar');
        const out = [['search border', __borderContrast(document.querySelector('.prop-catalog-search'), bar)]];
        document.querySelectorAll('.prop-catalog .dropdown-checkbox-toggle:not(.is-active)').forEach(t => out.push(['toggle border ' + t.textContent, __borderContrast(t, bar)]));
        document.querySelectorAll('.prop-catalog .prop-chip[aria-pressed=true]').forEach(c => out.push(['pressed fill ' + c.textContent.trim(), __fillContrast(c)]));
        const all = document.querySelector('.prop-catalog .prop-chip--group[data-value=""]');
        return out.map(([w, r]) => [w, Math.round(r * 100) / 100]);
      })()`)
      const weak = edges.filter(([, r]) => r < 3)
      assert(edges.length > 4 && weak.length === 0, `${theme}: ${edges.length} field borders and pressed fills reach 3:1 (lowest ${Math.min(...edges.map(([, r]) => r)).toFixed(2)})${weak.length ? `; below: ${weak.map(([w, r]) => `${w} ${r}`).join('; ')}` : ''}`)
      await page.click(groupChip(''))
      await new Promise((resolve) => setTimeout(resolve, 300))
      const allChip = await page.evaluate(`(() => { const c = document.querySelector('${groupChip('')}'); return { pressed: c.getAttribute('aria-pressed'), check: getComputedStyle(c, '::after').display, fill: Math.round(__fillContrast(c) * 100) / 100 } })()`)
      assert(allChip.pressed === 'true' && allChip.check !== 'none' && allChip.fill >= 3, `${theme}: the pressed All chip shows its check and a 3:1 fill (${JSON.stringify(allChip)})`)
      if (shots && theme === 'dark') await page.screenshot(path.join(shots, 'chips-pressed-dark-1280.png'))
      await page.evaluate(`document.documentElement.removeAttribute('data-theme')`)
    }

    // Screenshots light and dark at 1280
    if (shots) {
      await page.evaluate(`window.scrollTo(0, 0)`)
      await page.navigate(base + PAGE)
      await page.waitFor(READY, 'the catalog')
      await page.evaluate(`document.querySelector('.prop-catalog').scrollIntoView()`)
      await page.screenshot(path.join(shots, 'light-1280.png'))
      await page.evaluate(`document.documentElement.setAttribute('data-theme', 'dark')`)
      await new Promise((resolve) => setTimeout(resolve, 400))
      await page.screenshot(path.join(shots, 'dark-1280.png'))
      await page.evaluate(`document.documentElement.removeAttribute('data-theme')`)
    }

    // 390px: everything fits, no horizontal overflow
    await page.setViewport(390, 844)
    await page.navigate(base + PAGE)
    await page.waitFor(READY, 'the catalog at 390px')
    const fit = await page.evaluate(`(() => {
      const width = document.documentElement.clientWidth;
      const over = Array.from(document.querySelectorAll('.prop-catalog, .prop-catalog *')).filter(el => { const r = el.getBoundingClientRect(); return r.width && r.right > width + 0.5 && !el.closest('[hidden]') && !el.closest('.dropdown-checkbox-menu:not(.show)') && !(el.parentElement && el.parentElement.closest('.prop-chip-group')); }).slice(0, 5).map(el => el.className || el.nodeName);
      return { scroll: document.documentElement.scrollWidth, width, over };
    })()`)
    assert(fit.scroll <= fit.width && fit.over.length === 0, `at 390px nothing overflows (scrollWidth ${fit.scroll}, width ${fit.width}${fit.over.length ? `; over: ${fit.over.join(', ')}` : ''})`)
    assert(await page.evaluate(`getComputedStyle(document.querySelector('.prop-catalog-bar')).position`) === 'static', 'the bar is not sticky at 390px')
    await page.evaluate(`document.documentElement.setAttribute('data-theme', 'dark')`)
    await openMore(page, 'type')
    const darkFit = await page.evaluate(`(() => { const w = document.documentElement.clientWidth; return { scroll: document.documentElement.scrollWidth, w, over: Array.from(document.querySelectorAll('.prop-catalog, .prop-catalog *')).filter(el => { const r = el.getBoundingClientRect(); return r.width && r.right > w + 0.5 && !el.closest('[hidden]') && !el.closest('.dropdown-checkbox-menu:not(.show)') && !(el.parentElement && el.parentElement.closest('.prop-chip-group')) }).length } })()`)
    assert(darkFit.scroll <= darkFit.w && darkFit.over === 0, `at 390px in dark mode, with More open, nothing overflows (${JSON.stringify(darkFit)})`)
    const chipRow = await page.evaluate(`(() => { const g = document.querySelector('.prop-catalog .prop-chip-group'); const w = document.documentElement.clientWidth; const chips = Array.from(g.querySelectorAll('.prop-chip')); return { rows: new Set(chips.map(c => Math.round(c.getBoundingClientRect().top))).size, offscreen: chips.filter(c => c.getBoundingClientRect().right > w).length, x: getComputedStyle(g).overflowX } })()`)
    assert(chipRow.offscreen === 0 && chipRow.x === 'visible', `at 390px with a mouse, the Group chips wrap and every one is in view (${JSON.stringify(chipRow)})`)
    // The right-most dropdown in More opens leftward instead of past the edge
    const lastParam = await page.evaluate(`(() => { const gs = Array.from(document.querySelectorAll('.prop-catalog-more > .filter-group')); gs.sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right); return gs[0].dataset.param })()`)
    await page.click(`${groupSel(lastParam)} .dropdown-checkbox-toggle`)
    await page.waitFor(`document.querySelector('${groupSel(lastParam)} .dropdown-checkbox-menu').classList.contains('show')`, `the ${lastParam} menu`)
    const edge = await page.evaluate(`(() => { const m = document.querySelector('${groupSel(lastParam)} .dropdown-checkbox-menu'); return { end: m.classList.contains('align-end'), right: m.getBoundingClientRect().right, w: window.innerWidth } })()`)
    assert(edge.end && edge.right <= edge.w, `the right-most menu (${lastParam}) gets .align-end and stays on screen (${JSON.stringify(edge)})`)
    await page.click(`${groupSel(lastParam)} .dropdown-checkbox-toggle`)
    assert(await page.evaluate(`!document.querySelector('${groupSel(lastParam)} .dropdown-checkbox-menu').classList.contains('align-end')`), 'closing the menu drops .align-end')
    if (shots) {
      await page.evaluate(`document.querySelector('.prop-catalog').scrollIntoView()`)
      await page.screenshot(path.join(shots, 'more-open-dark-390.png'))
    }
    await page.evaluate(`document.documentElement.removeAttribute('data-theme')`)
    await page.navigate(base + PAGE)
    await page.waitFor(READY, 'the catalog at 390px')
    if (shots) {
      await page.evaluate(`document.querySelector('.prop-catalog').scrollIntoView()`)
      await page.screenshot(path.join(shots, 'light-390.png'))
      await page.evaluate(`document.documentElement.setAttribute('data-theme', 'dark')`)
      await new Promise((resolve) => setTimeout(resolve, 400))
      await page.screenshot(path.join(shots, 'dark-390.png'))
      await page.evaluate(`document.documentElement.removeAttribute('data-theme')`)
    }
    await page.setViewport(1280)

    // The filter bar on a reference page, over the real generated entries
    const BAR = `document.querySelector('.prop-catalog--filter')`
    const ENTRIES = `JSON.parse(document.querySelector('.prop-catalog--filter .prop-catalog-index').textContent).map(r => document.getElementById(r[0])).filter(Boolean).map(h => h.parentElement)`
    const SHOWN_ENTRIES = `${ENTRIES}.filter(e => !e.hasAttribute('hidden'))`
    const topicEntries = listed.filter((e) => e.config_scope === 'topic' && e.is_deprecated !== true).map((e) => e.name)
    await page.navigate(base + TOPIC_PAGE)
    await page.waitFor(READY, 'the topic page filter bar')
    const bar = await page.evaluate(`(() => ({
      filters: Array.from(document.querySelectorAll('.prop-catalog--filter .filter-group')).map(g => g.dataset.label),
      entries: ${ENTRIES}.length,
      shown: ${SHOWN_ENTRIES}.length,
      sects: ${ENTRIES}.every(e => e.classList.contains('sect2')),
      role: document.querySelector('.prop-catalog--filter .table-filters').getAttribute('role'),
      status: document.querySelectorAll('.prop-catalog--filter [role="status"]').length
    }))()`)
    assert(bar.entries === topicEntries.length && bar.shown === bar.entries && bar.sects, `the topic page's bar finds all ${topicEntries.length} generated entries, all showing at first (${JSON.stringify(bar)})`)
    // Every topic property in this release applies without a restart, so the
    // page has no Restart required filter: it would match everything
    const topicRow = await page.evaluate(`(() => ({ more: !!document.querySelector('.prop-catalog--filter .prop-chip--more'), section: !!document.querySelector('.prop-catalog--filter .prop-catalog-chips > .filter-group[data-param="section"]'), placeholder: document.querySelector('.prop-catalog--filter .prop-catalog-search').placeholder }))()`)
    assert(topicRow.section && topicRow.placeholder === `Filter ${topicEntries.length} properties`, `the topic page shows Section in the row ("${topicRow.placeholder}")`)
    const topicRestart = new Set(listed.filter((e) => e.config_scope === 'topic' && e.is_deprecated !== true).map((e) => e.needs_restart === true)).size > 1
    assert(bar.filters.join() === (topicRestart ? 'Section,Restart required' : 'Section'), `the topic page offers only filters that divide its entries: ${bar.filters.join(', ')}`)
    assert(bar.role === 'search' && bar.status === 1, 'the bar is a search landmark with one status region')
    // The section chips follow the page: document order, the headings' words, Other last
    const order = await page.evaluate(`(() => {
      const chips = Array.from(document.querySelectorAll('.prop-catalog--filter .prop-chip--group')).filter(c => c.dataset.value).map(c => ({ v: c.dataset.value, label: c.querySelector('.prop-chip-label').textContent, n: Number(c.querySelector('.prop-chip-count').textContent), name: c.querySelector('.prop-chip-noun').textContent }));
      const rows = JSON.parse(document.querySelector('.prop-catalog--filter .prop-catalog-index').textContent);
      const seen = []; rows.forEach(r => { if (!seen.includes(r[4])) seen.push(r[4]) });
      const pageOrder = seen.filter(v => !/:other$/.test(v)).concat(seen.filter(v => /:other$/.test(v)));
      const headings = {}; rows.forEach(r => { const h = document.getElementById(r[0]); const s = h && h.closest('.sect1'); if (s && !(r[4] in headings)) headings[r[4]] = s.querySelector(':scope > h2').textContent.replace(/\\s+properties\\s*$/i, '').trim() });
      return { chips, pageOrder, headings };
    })()`)
    assert(JSON.stringify(order.chips.map((c) => c.v)) === JSON.stringify(order.pageOrder), `the section chips follow the page order, Other last (${order.chips.map((c) => c.label).join(', ')})`)
    assert(order.chips.every((c) => c.label === order.headings[c.v]), 'each section chip reads its heading, without "properties"')
    const one = order.chips.find((c) => c.n === 1)
    assert(!one || one.name === ' property', `a chip counting one property says "property" (${one ? one.label : 'no chip counts one'})`)
    assert(order.chips.filter((c) => c.n !== 1).every((c) => c.name === ' properties'), 'the others say "properties"')
    await setSearch(page, 'retention')
    timings.push(await page.evaluate(`${BAR}.lastFilterMs`))
    const pageSearch = await page.evaluate(`(() => ({ shown: ${SHOWN_ENTRIES}.map(e => e.querySelector('h3').id), hiddenMode: ${ENTRIES}.filter(e => e.hasAttribute('hidden')).map(e => e.getAttribute('hidden'))[0], inDom: document.body.innerHTML.includes('id="max.message.bytes"') || !!document.getElementById('max-message-bytes'), status: document.querySelector('.prop-catalog--filter .prop-catalog-status').textContent, q: new URLSearchParams(location.search).get('q') }))()`)
    assert(pageSearch.shown.includes('retention-ms') && pageSearch.shown.includes('retention-bytes') && pageSearch.shown.length < bar.entries, `searching "retention" on the page leaves ${pageSearch.shown.length} entries`)
    assert(pageSearch.inDom, 'filtered-out entries stay in the HTML')
    assert(pageSearch.hiddenMode === 'until-found', 'a filtered-out entry is hidden="until-found", so find in page still reaches it')
    assert(pageSearch.status === `${pageSearch.shown.length} properties match "retention".` && pageSearch.q === 'retention', `the page announces "${pageSearch.status}" and carries ?q=retention`)
    // Section filter, from the URL; emptied sections hide with their entries
    await page.navigate(`${base}${TOPIC_PAGE}?section=${encodeURIComponent('topic:tiered-storage')}`)
    await page.waitFor(READY, 'the topic page with ?section=')
    const tiered = listed.filter((e) => e.config_scope === 'topic' && e.category === 'tiered-storage' && e.is_deprecated !== true).length
    const sectionView = await page.evaluate(`(() => ({
      shown: ${SHOWN_ENTRIES}.length,
      headings: Array.from(document.querySelectorAll('.sect1')).filter(s => s.querySelector('.sect2 h3') && !s.hasAttribute('hidden')).map(s => s.querySelector('h2').textContent.trim())
    }))()`)
    assert(sectionView.shown === tiered && sectionView.headings.length === 1 && /Tiered Storage/i.test(sectionView.headings[0]), `?section=topic:tiered-storage leaves the ${tiered} entries under one visible heading (${sectionView.headings.join(', ')})`)
    // A deep link wins over a filter that would hide its entry: the entry
    // shows on its own, with a note, and the filters stay
    await page.navigate(`${base}${TOPIC_PAGE}?section=${encodeURIComponent('topic:tiered-storage')}&q=zzzz#retention-ms`)
    await page.waitFor(READY, 'the topic page with a conflicting filter and an anchor')
    const REVEAL = `(() => { const n = document.querySelector('.prop-catalog--filter .prop-catalog-reveal'); return n.hidden || n.closest('[hidden]') ? '' : n.querySelector('.prop-catalog-reveal-text').textContent })()`
    const deep = await page.evaluate(`(() => { const h = document.getElementById('retention-ms'); const r = h.getBoundingClientRect(); return { visible: !h.parentElement.hasAttribute('hidden'), inView: r.top >= 0 && r.top < innerHeight, search: location.search, hash: location.hash, q: document.querySelector('.prop-catalog--filter .prop-catalog-search').value, all: ${SHOWN_ENTRIES}.length, empty: !document.querySelector('.prop-catalog--filter .prop-catalog-empty').hidden } })()`)
    assert(deep.visible && deep.inView && deep.hash === '#retention-ms', `the linked entry shows and is in view (${JSON.stringify(deep)})`)
    assert(/section=/.test(deep.search) && deep.q === 'zzzz' && deep.all === 1 && !deep.empty, 'the filters and search stay, and only the linked entry shows outside them')
    assert(await page.evaluate(REVEAL) === 'Showing retention.ms, which your filters hide.', `a visible note says why (${await page.evaluate(REVEAL)})`)
    await page.click('.prop-catalog--filter .prop-catalog-reveal-hide')
    assert(await page.evaluate(`document.getElementById('retention-ms').parentElement.hasAttribute('hidden')`) && await page.evaluate(REVEAL) === '', '"Hide it again" hides the entry and the note')
    // The URL is already this one after the reset, so leave the page first
    await page.navigate(base + CLUSTER_PAGE)
    await page.navigate(`${base}${TOPIC_PAGE}#retention-ms`)
    await page.waitFor(READY, 'the topic page with an anchor')
    await new Promise((resolve) => setTimeout(resolve, 300))
    const landing = await page.evaluate(`(() => { const bar = ${BAR}; return { position: getComputedStyle(bar).position, sticky: bar.classList.contains('prop-catalog--sticky'), barBottom: bar.getBoundingClientRect().bottom, heading: document.getElementById('retention-ms').getBoundingClientRect().top } })()`)
    assert(landing.position === 'sticky' && landing.sticky, 'the reference page bar is sticky at 1280px')
    assert(landing.heading >= landing.barBottom - 0.5 && landing.heading < landing.barBottom + 60, `a deep-linked heading lands just below the sticky bar (heading ${landing.heading.toFixed(1)}, bar bottom ${landing.barBottom.toFixed(1)})`)
    if (shots) await page.screenshot(path.join(shots, 'reference-stuck-1280.png'))
    // Empty state on the page
    await page.navigate(`${base}${TOPIC_PAGE}?q=zzzz-no-such-property`)
    await page.waitFor(READY, 'the topic page with no matches')
    assert(await page.evaluate(`!document.querySelector('.prop-catalog--filter .prop-catalog-empty').hidden && ${SHOWN_ENTRIES}.length === 0`), 'a search with no matches shows the empty state and hides every entry')
    await page.click('.prop-catalog--filter .prop-catalog-empty .prop-catalog-clear')
    await page.waitFor(`${SHOWN_ENTRIES}.length === ${bar.entries}`, 'Clear filters on the page')
    assert(true, 'Clear filters brings every entry back')
    // The cluster page offers Enterprise; its filter keeps the licensed entries
    await page.navigate(base + CLUSTER_PAGE)
    await page.waitFor(READY, 'the cluster page filter bar')
    const clusterFilters = await page.evaluate(`Array.from(document.querySelectorAll('.prop-catalog--filter .filter-group')).map(g => g.dataset.label)`)
    assert(clusterFilters.join() === 'Restart required,Enterprise', `the cluster page offers ${clusterFilters.join(', ')}`)
    const clusterChips = await page.evaluate(`Array.from(document.querySelectorAll('.prop-catalog--filter .prop-chip')).map(c => c.textContent.trim())`)
    assert(clusterChips.join() === 'Restart required,Enterprise,More filters0', `the cluster page's row has the Restart required and Enterprise chips and More filters (${clusterChips.join(', ')})`)
    assert(await page.evaluate(`document.querySelector('.prop-catalog--filter .prop-catalog-results').hidden`), 'the tags row is hidden while nothing is filtered')
    await page.click(`.prop-catalog--filter .prop-chip[data-chip-for="enterprise"]`)
    const licensedEntries = await page.evaluate(`${SHOWN_ENTRIES}.map(e => e.querySelector('h3').id)`)
    assert(licensedEntries.includes('sasl_mechanisms') && licensedEntries.includes('partition_autobalancing_mode') && !licensedEntries.includes('retention_bytes'), `the Enterprise chip keeps the ${licensedEntries.length} cluster entries with Enterprise values`)
    assert(await page.evaluate(`!document.querySelector('.prop-catalog--filter .prop-catalog-results').hidden && document.querySelector('.prop-catalog--filter .prop-catalog-count').textContent === '${licensedEntries.length} of ' + ${ENTRIES}.length + ' properties'`), 'the tags row shows, and the count reads "N of M properties"')
    await page.click(`.prop-catalog--filter .prop-chip[data-chip-for="enterprise"]`)
    assert(await page.evaluate(`${SHOWN_ENTRIES}.length === ${ENTRIES}.length`), 'pressing the chip again shows every entry')
    await clickOptions(page, 'enterprise', ['none'])
    assert(await page.evaluate(`${SHOWN_ENTRIES}.length`) === licensedEntries.length, 'the Enterprise dropdown in More filters does the same')
    await page.pressKey('Escape', 'Escape', 27)
    // The TOC lists what the page shows, and a jump to a hidden entry shows
    // just that entry; Back puts the view back with the URL
    await page.navigate(`${base}${CLUSTER_PAGE}?restart=yes`)
    await page.waitFor(READY, 'the cluster page with ?restart=yes')
    await page.waitFor(`document.querySelectorAll('aside.toc a[href="#admin_api_require_auth"], .toc-menu a[href="#admin_api_require_auth"]').length > 0`, 'the TOC')
    const toc = await page.evaluate(`(() => {
      const li = (id) => Array.from(document.querySelectorAll('aside.toc a[href="#' + id + '"], .toc-menu a[href="#' + id + '"]')).map(a => a.closest('li'));
      const off = (id) => li(id).every(l => l.classList.contains('prop-toc-filtered') && getComputedStyle(l).display === 'none');
      const restartOne = JSON.parse(document.querySelector('.prop-catalog--filter .prop-catalog-index').textContent).find(r => r[1] === 'yes')[0];
      return { hidden: off('admin_api_require_auth'), kept: !off(restartOne), restartOne };
    })()`)
    assert(toc.hidden && toc.kept, `TOC entries for filtered-out properties hide; ${toc.restartOne}, which needs a restart, stays (${JSON.stringify(toc)})`)
    const shownBefore = await page.evaluate(`${SHOWN_ENTRIES}.length`)
    await page.evaluate(`location.hash = '#admin_api_require_auth'`)
    await page.waitFor(`!document.getElementById('admin_api_require_auth').parentElement.hasAttribute('hidden')`, 'the jump to a filtered-out entry')
    await new Promise((resolve) => setTimeout(resolve, 100))
    const jumped = await page.evaluate(`({ shown: ${SHOWN_ENTRIES}.length, restart: new URLSearchParams(location.search).get('restart'), pressed: document.querySelector('.prop-catalog--filter .prop-chip[data-chip-for="restart"]').getAttribute('aria-pressed'), note: ${REVEAL}, status: document.querySelector('.prop-catalog--filter .prop-catalog-status').textContent })`)
    assert(jumped.shown === shownBefore + 1 && jumped.restart === 'yes' && jumped.pressed === 'true', `a jump to admin_api_require_auth shows it alone and keeps Restart required (${JSON.stringify(jumped)})`)
    assert(jumped.note === 'Showing admin_api_require_auth, which your filters hide.' && jumped.status === jumped.note, 'the note says so, and the status region announces it')
    if (shots) await page.screenshot(path.join(shots, 'reference-reveal-1280.png'))
    await page.evaluate(`history.back()`)
    await page.waitFor(`location.hash === ''`, 'Back')
    await new Promise((resolve) => setTimeout(resolve, 150))
    const back = await page.evaluate(`({ shown: ${SHOWN_ENTRIES}.length, restart: new URLSearchParams(location.search).get('restart'), pressed: document.querySelector('.prop-catalog--filter .prop-chip[data-chip-for="restart"]').getAttribute('aria-pressed') })`)
    assert(back.shown === shownBefore && back.restart === 'yes' && back.pressed === 'true', `after Back, the URL and the view agree (${JSON.stringify(back)})`)
    // A URL change by history (another entry with other filters) is read again
    await page.evaluate(`history.pushState(null, '', location.pathname)`)
    await page.evaluate(`history.pushState(null, '', location.pathname + '?restart=yes')`)
    await page.evaluate(`history.back()`)
    await page.waitFor(`location.search === ''`, 'Back to the unfiltered entry')
    await page.waitFor(`${SHOWN_ENTRIES}.length === ${ENTRIES}.length && document.querySelector('.prop-catalog--filter .prop-chip[data-chip-for="restart"]').getAttribute('aria-pressed') === 'false'`, 'the view to follow the URL on popstate')
    assert(true, 'popstate re-reads the URL: no filter in the URL, none in the view')
    // Below the sticky breakpoint, a pill keeps the filtered count in view
    await page.setViewport(600, 800)
    await page.navigate(`${base}${CLUSTER_PAGE}?restart=yes`)
    await page.waitFor(READY, 'the cluster page at 600px')
    const PILL = `(() => { const p = document.querySelector('.prop-catalog--filter .prop-catalog-pill'); return p.hidden ? '' : p.textContent })()`
    assert(await page.evaluate(PILL) === '', 'the pill hides while the bar is in view')
    await page.evaluate(`window.scrollTo(0, 3000)`)
    await page.waitFor(`${PILL} !== ''`, 'the pill')
    const pillText = await page.evaluate(PILL)
    assert(/^Filtered: \d+ of \d+Edit filters$/.test(pillText), `once the bar scrolls away, the pill reads "${pillText}"`)
    if (shots) await page.screenshot(path.join(shots, 'reference-pill-600.png'))
    await page.click('.prop-catalog--filter .prop-catalog-pill-button')
    await page.waitFor(`document.activeElement === document.querySelector('.prop-catalog--filter .prop-catalog-search')`, 'the pill to lead back to the bar')
    assert(true, 'the pill leads back to the search')
    await page.setViewport(1280)
    if (shots) {
      await page.evaluate(`window.scrollTo(0, 0)`)
      await page.screenshot(path.join(shots, 'reference-filter-light-1280.png'))
    }
    // The page's Markdown export keeps every entry and drops the bar
    const topicHtml = fs.readFileSync(path.join(site, TOPIC_PAGE, 'index.html'), 'utf8')
    const topicMd = convertPageHtml({ html: topicHtml, page: { asciidoc: { doctitle: 'Topic Configuration Properties', attributes: {} }, pub: { url: TOPIC_PAGE }, src: { component: 'preview', path: 'topic-properties.adoc' } }, siteUrl: 'http://localhost' })
    const mdHeadings = topicMd.split('\n').filter((l) => /^### /.test(l)).length
    assert(mdHeadings === topicEntries.length && !/Filter this page|Clear filters/.test(topicMd), `the topic page's Markdown export has all ${mdHeadings} entries and no filter controls`)
    // 390px on the reference page
    await page.setViewport(390, 844)
    await page.navigate(`${base}${TOPIC_PAGE}?q=retention`)
    await page.waitFor(READY, 'the topic page at 390px')
    const pageFit = await page.evaluate(`(() => { const w = document.documentElement.clientWidth; const over = Array.from(document.querySelectorAll('.prop-catalog--filter, .prop-catalog--filter *')).filter(el => { const r = el.getBoundingClientRect(); return r.width && r.right > w + 0.5 && !el.closest('.dropdown-checkbox-menu:not(.show)') && !(el.parentElement && el.parentElement.closest('.prop-chip-group')) }).map(el => el.className || el.nodeName).slice(0, 5); return { scroll: document.documentElement.scrollWidth, w, over } })()`)
    assert(pageFit.over.length === 0 && pageFit.scroll <= pageFit.w, `the filter bar fits 390px (scrollWidth ${pageFit.scroll}, width ${pageFit.w}${pageFit.over.length ? `; over: ${pageFit.over.join(', ')}` : ''})`)
    assert(await page.evaluate(`getComputedStyle(${BAR}).position`) === 'static', 'the reference bar is not sticky at 390px')
    if (shots) {
      await page.evaluate(`window.scrollTo(0, 0)`)
      await page.screenshot(path.join(shots, 'reference-filter-light-390.png'))
      await page.evaluate(`document.documentElement.setAttribute('data-theme', 'dark')`)
      await new Promise((resolve) => setTimeout(resolve, 400))
      await page.screenshot(path.join(shots, 'reference-filter-dark-390.png'))
      await page.evaluate(`document.documentElement.removeAttribute('data-theme')`)
    }
    await page.setViewport(1280)

    // The Cloud build
    await page.navigate(base + CLOUD_PAGE)
    await page.waitFor(READY, 'the Cloud catalog')
    const cloud = await page.evaluate(`(() => {
      const cards = Array.from(document.querySelectorAll('.prop-catalog-list > li.prop-card'));
      return {
        total: cards.length,
        scopes: Array.from(new Set(cards.map(c => c.dataset.group))).sort(),
        filters: Array.from(document.querySelectorAll('.prop-catalog .filter-group > span[id$="-label"]')).map(l => l.textContent.replace(':', '')),
        note: (document.querySelector('.prop-catalog-note') || {}).textContent,
        defaults: document.querySelectorAll('.prop-card-default').length,
        enterprise: document.querySelectorAll('.prop-catalog .rp-badge--enterprise').length,
        byoc: cards.filter(c => c.dataset.byoc === 'yes').length,
        byocBadges: Array.from(document.querySelectorAll('.prop-catalog .rp-badge--cloud')).filter(b => b.querySelector('.prop-badge-label').textContent === 'BYOC only').length,
        editable: Array.from(document.querySelectorAll('.prop-catalog .rp-badge--cloud')).filter(b => b.querySelector('.prop-badge-label').textContent === 'Cloud editable').length,
        link: (document.querySelector('li.prop-card[data-name="iceberg_enabled"] .prop-card-link') || {}).href
      };
    })()`)
    const cloudExpected = listed.filter((e) => e.config_scope === 'topic' || (e.config_scope === 'cluster' && e.cloud_supported === true)).length
    assert(cloud.total === cloudExpected && !cloud.scopes.includes('broker'), `Cloud lists the ${cloudExpected} cloud_supported cluster properties and the topic properties, no broker ones (${cloud.total})`)
    assert(cloud.filters.includes('Cloud editable') && cloud.filters.includes('BYOC only') && !cloud.filters.includes('Enterprise'), `Cloud offers Cloud editable and BYOC only, and no Enterprise filter (${cloud.filters.join(', ')})`)
    assert(cloud.defaults === 0 && cloud.enterprise === 0, 'Cloud cards show no default and no Enterprise badge, like the Cloud reference pages')
    assert(cloud.byoc > 0 && cloud.byocBadges === cloud.byoc && cloud.editable > 0, `${cloud.byoc} BYOC only and ${cloud.editable} Cloud editable badges`)
    assert(/\/cloud-fixture\/reference\/properties\/cluster-properties\/#iceberg_enabled$/.test(cloud.link || ''), `Cloud links go to the Cloud reference page (${cloud.link})`)
    await clickOptions(page, 'byoc', ['no'])
    assert(await page.evaluate(`${VISIBLE}.every(c => c.dataset.byoc === 'yes')`), 'BYOC only: Yes leaves the BYOC-only properties')
    await page.click(`${groupSel('byoc')} input[value="no"]`)
    await clickOptions(page, 'editable', ['no'])
    assert(await page.evaluate(`${VISIBLE}.length > 0 && ${VISIBLE}.every(c => c.dataset.cloudEditable === 'yes' && c.querySelector('.copy-button'))`), 'Cloud editable: Yes leaves editable properties, each with a copy button')
    await page.pressKey('Escape', 'Escape', 27)
    const cloudChips = await page.evaluate(`Array.from(document.querySelectorAll('.prop-catalog .prop-chip[data-chip-for]')).map(c => c.textContent.trim())`)
    assert(cloudChips.includes('Cloud editable') && cloudChips.includes('BYOC only') && !cloudChips.includes('Enterprise') && cloudChips.includes('Show deprecated') === cloud.filters.includes('Deprecated'), `Cloud's quick chips are ${cloudChips.join(', ')}`)
    assert(/managed deployment of Redpanda Enterprise Edition/.test(cloud.note || ''), `the Cloud catalog says how licensing applies (${cloud.note})`)
    await page.navigate(base + CLOUD_PAGE)
    await page.waitFor(READY, 'the Cloud catalog')
    await page.click(chipFor('editable'))
    const cloudTag = await page.evaluate(`(() => { const t = document.querySelector('.prop-catalog .prop-active-tag'); const chip = document.querySelector('${chipFor('editable')} .prop-chip-icon'); return { cls: t.className, icon: chip.getAttribute('style') } })()`)
    assert(/prop-active-tag--cloud/.test(cloudTag.cls) && /--icon-cloud/.test(cloudTag.icon), `the Cloud editable tag and chip use the Cloud meaning and icon (${JSON.stringify(cloudTag)})`)
    assert(await page.evaluate(`Array.from(document.querySelectorAll('.prop-catalog .prop-chip[data-chip-for]')).every(c => (c.getAttribute('data-tooltip') || '').length > 10)`), 'every quick chip has a tooltip')
    await page.click(chipFor('editable'))
    const managed = await page.evaluate(`Array.from(document.querySelectorAll('.prop-card')).filter(c => c.dataset.cloudEditable === 'no').every(c => !c.querySelector('.copy-button') && c.querySelector('.prop-card-managed').textContent === 'Redpanda Cloud manages this property.')`)
    assert(managed, 'read-only Cloud rows say Redpanda Cloud manages them, with no command')
    if (shots) {
      await page.navigate(base + CLOUD_PAGE)
      await page.waitFor(READY, 'the Cloud catalog')
      await page.evaluate(`document.querySelector('.prop-catalog').scrollIntoView()`)
      await page.screenshot(path.join(shots, 'cloud-light-1280.png'))
    }

    // Forced colors (Windows High Contrast): a pressed chip still differs
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }] })
    await page.navigate(`${base}${PAGE}?restart=yes`)
    await page.waitFor(READY, 'the catalog in forced colors')
    const forced = await page.evaluate(`(() => { const on = getComputedStyle(document.querySelector('${chipFor('restart')}')); const off = getComputedStyle(document.querySelector('${chipFor('enterprise')}')); const check = getComputedStyle(document.querySelector('${chipFor('restart')}'), '::after'); return { on: on.backgroundColor, off: off.backgroundColor, border: on.borderTopWidth, check: check.backgroundColor, checkShown: check.display !== 'none' } })()`)
    assert(forced.on !== forced.off && forced.border === '2px' && forced.checkShown && forced.check !== forced.on, `in forced colors a pressed chip has a system Highlight fill, a 2px border, and a visible check (${JSON.stringify(forced)})`)
    if (shots) await page.screenshot(path.join(shots, 'forced-colors-1280.png'))
    await page.send('Emulation.setEmulatedMedia', { features: [] })

    // axe-core on the catalog's markup: no violations, light and dark, on the
    // catalog, a reference page's bar, and the Cloud catalog
    for (const [url, selector] of [[`${PAGE}?restart=yes`, '.prop-catalog'], [PAGE, '.prop-catalog'], [`${CLUSTER_PAGE}?restart=yes`, '.prop-catalog--filter'], [`${TOPIC_PAGE}?section=${encodeURIComponent('topic:tiered-storage')}`, '.prop-catalog--filter'], [`${CLOUD_PAGE}?editable=yes`, '.prop-catalog']]) {
      for (const theme of ['light', 'dark']) {
        await page.navigate(base + url)
        await page.waitFor(READY, `${url} for axe`)
        if (theme === 'dark') await page.evaluate(`document.documentElement.setAttribute('data-theme', 'dark')`)
        await new Promise((resolve) => setTimeout(resolve, 300))
        const violations = await axeViolations(page, selector)
        assert(violations.length === 0, `axe: no violations in ${url} (${theme})${violations.length ? `: ${violations.slice(0, 8).join('; ')}` : ''}`)
      }
    }

    assert(page.errors.length === 0, `no page errors${page.errors.length ? `: ${page.errors.join('; ')}` : ''}`)
    log(`passed; worst filtering time ${worst.toFixed(1)}ms, ${worstLayout.toFixed(1)}ms with layout${shots ? `; screenshots in ${shots}` : ''}`)
  } finally {
    if (browser) await browser.close()
    if (server) server.close()
    try {
      fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
    } catch (error) {
      log(`could not remove ${work}: ${error.message}`)
    }
  }
}

main().catch((error) => {
  console.error(`[property-catalog-e2e ${elapsed()}] FAILED: ${error.message}`)
  process.exit(1)
})

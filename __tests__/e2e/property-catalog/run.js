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

async function setSearch (page, text) {
  await page.click('.prop-catalog-search')
  await page.evaluate(`(() => { const s = document.querySelector('.prop-catalog-search'); s.value = ''; })()`)
  await page.typeText(text)
}

/** Opens a filter and clicks the given options' checkboxes. */
async function clickOptions (page, param, values) {
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
    assert(await page.evaluate(`document.querySelector('${groupSel('deprecated')} .dropdown-text').textContent`) === 'Not deprecated', 'the Deprecated filter reads "Not deprecated"')
    const region = await page.evaluate(`(() => { const r = document.querySelectorAll('.prop-catalog [role="status"]'); return r.length + '|' + r[0].getAttribute('aria-live') + '|' + r[0].textContent + '|' + (r[0].getBoundingClientRect().width <= 1) })()`)
    assert(region === '1|polite||true', `one visually hidden, empty role=status region (${region})`)

    // Badges follow the meaning-system contract
    const badges = await page.evaluate(`(() => {
      const all = Array.from(document.querySelectorAll('.prop-catalog .rp-badge'));
      return { count: all.length, sm: all.every(b => b.classList.contains('rp-badge--sm')), tooltips: all.every(b => (b.getAttribute('data-tooltip') || '').trim()), titles: all.filter(b => b.hasAttribute('title')).length,
        kinds: Array.from(new Set(all.map(b => b.className.match(/rp-badge--(?!sm)([a-z-]+)/)[1] + ':' + b.textContent))).sort() };
    })()`)
    assert(badges.count > total && badges.sm && badges.tooltips && badges.titles === 0, `${badges.count} badges, every one rp-badge--sm with a data-tooltip and no title`)
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
    const sasl = await page.evaluate(`(() => { const b = document.querySelector('li.prop-card[data-name="sasl_mechanisms"] .rp-badge--enterprise'); return b && b.textContent + '|' + b.getAttribute('data-tooltip') })()`)
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
    assert(searchStatus === `${found.length} properties match "retention".`, `the status region announces "${searchStatus}"`)
    assert(await page.evaluate(`new URLSearchParams(location.search).get('q')`) === 'retention', 'the URL carries ?q=retention')
    await setSearch(page, 'enables iceberg')
    const multi = await page.evaluate(VISIBLE_NAMES)
    assert(multi.includes('iceberg_enabled') && multi.length < 10, `a two-word search matches both words (${multi.join(', ')})`)

    // Scope filter, as a disclosure with keyboard and screen-reader behavior
    await setSearch(page, '')
    await page.evaluate(`document.querySelector('.prop-catalog-search').dispatchEvent(new Event('input'))`)
    const toggleAx = await page.accessible(`${groupSel('group')} .dropdown-checkbox-toggle`)
    assert(toggleAx.name === 'Group: All' && toggleAx.role === 'button', `the Group toggle is a button named "${toggleAx.name}"`)
    const aria = await page.evaluate(`(() => ({
      haspopup: document.querySelectorAll('.prop-catalog [aria-haspopup]').length,
      menus: document.querySelectorAll('.prop-catalog [role="menu"]').length,
      arrows: Array.from(document.querySelectorAll('.prop-catalog .dropdown-arrow')).every(a => a.getAttribute('aria-hidden') === 'true'),
      groups: Array.from(document.querySelectorAll('.prop-catalog .dropdown-checkbox-menu')).every(m => m.getAttribute('role') === 'group'),
      controls: Array.from(document.querySelectorAll('.prop-catalog .dropdown-checkbox-toggle')).every(t => document.getElementById(t.getAttribute('aria-controls')))
    }))()`)
    assert(aria.haspopup === 0 && aria.menus === 0 && aria.arrows && aria.groups && aria.controls, `no filter claims to be an ARIA menu; arrows are aria-hidden; options are groups each toggle controls (${JSON.stringify(aria)})`)
    await clickOptions(page, 'group', ['cluster', 'object-storage', 'broker'])
    timings.push(await page.evaluate(`document.querySelector('.prop-catalog').lastFilterMs`))
    assert(await page.evaluate(`document.querySelector('${groupSel('group')} .dropdown-checkbox-toggle').getAttribute('aria-expanded')`) === 'true', 'the open toggle has aria-expanded="true"')
    const menuAx = await page.accessible(`${groupSel('group')} .dropdown-checkbox-menu`)
    assert(menuAx.role === 'group' && menuAx.name === 'Group:', `the open options are a group named by the label (${menuAx.role}, "${menuAx.name}")`)
    const topics = listed.filter((e) => e.config_scope === 'topic' && e.is_deprecated !== true).length
    assert(await page.evaluate(`${VISIBLE}.length === ${topics} && ${VISIBLE}.every(c => c.dataset.group === 'topic')`), `Group: Topic leaves the ${topics} topic properties`)
    assert((await page.accessible(`${groupSel('group')} .dropdown-checkbox-toggle`)).name === 'Group: Topic', 'the toggle\'s name follows the value')
    assert(await page.evaluate(`new URLSearchParams(location.search).get('group')`) === 'topic', 'the URL carries ?group=topic')
    assert(await page.evaluate(STATUS) === `${topics} properties match these filters.`, 'the status region announces the filtered count')
    if (shots) await page.screenshot(path.join(shots, 'filter-open-1280.png'))
    await page.pressKey('Escape', 'Escape', 27)
    await page.waitFor(`!document.querySelector('${groupSel('group')} .dropdown-checkbox-menu').classList.contains('show')`, 'Escape to close the menu')
    assert(await page.evaluate(`document.activeElement === document.querySelector('${groupSel('group')} .dropdown-checkbox-toggle')`), 'Escape returns focus to the toggle')
    await page.pressKey('Enter', 'Enter', 13)
    await page.waitFor(`document.querySelector('${groupSel('group')} .dropdown-checkbox-menu').classList.contains('show')`, 'Enter on the toggle to reopen it')
    await page.pressKey('Tab', 'Tab', 9)
    assert(await page.evaluate(`document.activeElement && document.activeElement.matches('${groupSel('group')} input[value="cluster"]')`), 'Tab moves from the open toggle to its first checkbox')
    await page.pressKey(' ', 'Space', 32)
    await page.waitFor(`document.querySelector('${groupSel('group')} input[value="cluster"]').checked`, 'Space to check Cluster')
    await page.click('.prop-catalog-count')
    assert(await page.evaluate(`!document.querySelector('.prop-catalog .dropdown-checkbox-menu.show')`), 'a click outside closes the menu')

    // Restart required, Type, Category: each filter narrows to its value
    await page.navigate(base + PAGE)
    await page.waitFor(READY, 'the catalog')
    await clickOptions(page, 'restart', ['no'])
    timings.push(await page.evaluate(`document.querySelector('.prop-catalog').lastFilterMs`))
    const restart = listed.filter((e) => e.needs_restart === true && e.is_deprecated !== true).length
    assert(await page.evaluate(`${VISIBLE}.length === ${restart} && ${VISIBLE}.every(c => c.dataset.restart === 'yes' && c.querySelector('.rp-badge').parentNode.textContent.includes('Restart required'))`), `Restart required: Yes leaves the ${restart} properties that need a restart`)
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
    await page.click('.prop-catalog-clear')
    await page.waitFor(`${VISIBLE}.length === ${total - deprecated}`, 'Clear filters to restore the default view')
    assert(await page.evaluate(`document.querySelector('.prop-catalog-empty').hidden && document.querySelector('.prop-catalog-search').value === '' && document.activeElement === document.querySelector('.prop-catalog-search')`), 'Clear filters empties the search, hides the empty state, and focuses the search box')
    assert(await page.evaluate(STATUS) === `Showing ${total - deprecated} properties. Deprecated properties are hidden.`, 'the status region says what shows and that deprecated properties are hidden')
    assert(await page.evaluate(`location.search`) === '', 'the URL drops every parameter')

    // A shared link with several parameters opens in that state
    await page.navigate(`${base}${PAGE}?group=object-storage&q=cache&restart=yes`)
    await page.waitFor(READY, 'the catalog from a shared URL')
    const shared = await page.evaluate(`(() => ({ q: document.querySelector('.prop-catalog-search').value, cards: ${VISIBLE}.map(c => c.dataset.group + ':' + c.dataset.restart) }))()`)
    assert(shared.q === 'cache' && shared.cards.length > 0 && shared.cards.every((c) => c === 'object-storage:yes'), `?group=object-storage&q=cache&restart=yes applies on load (${shared.cards.length} cards)`)
    assert(await page.evaluate(STATUS) === '', 'a page load does not announce')

    // Filtering time, the worst of these, on all cards
    const perf = await page.evaluate(`(() => {
      const root = document.querySelector('.prop-catalog');
      const s = document.querySelector('.prop-catalog-search');
      const times = [];
      for (const q of ['', 'r', 're', 'retention', 'zzzz', '', 'cloud_storage', 'enable', '']) { s.value = q; root.filterProperties(); times.push(root.lastFilterMs); }
      document.querySelectorAll('.prop-catalog .filter-group[data-param="group"] input').forEach(b => { b.checked = !b.checked; root.filterProperties(); times.push(root.lastFilterMs); b.checked = !b.checked; root.filterProperties(); times.push(root.lastFilterMs); });
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
    assert(await page.evaluate(`!!document.querySelector('${badge}')._tippy && document.querySelector('${badge}').getAttribute('tabindex') === '0'`), 'the badge has a tippy instance and is focusable')
    if (shots) await page.screenshot(path.join(shots, 'tooltip-1280.png'))
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 })
    await page.waitFor(`!Array.from(document.querySelectorAll('.tippy-box')).some(b => b.textContent.includes('GSSAPI or OAUTHBEARER'))`, 'the tooltip to hide')
    await page.evaluate(`document.querySelector('li.prop-card[data-name="sasl_mechanisms"] .rp-badge').focus()`)
    await page.pressKey('Tab', 'Tab', 9)
    assert(await page.evaluate(`document.activeElement === document.querySelector('${badge}')`), 'Tab reaches the Enterprise values badge')
    await page.waitFor(`(() => { const b = document.querySelector('${badge}'); const id = b.getAttribute('aria-describedby'); const t = id && document.getElementById(id); return t && t.textContent.includes('GSSAPI') })()`, 'the tooltip on focus, linked by aria-describedby')
    assert(true, 'keyboard focus shows the tooltip, and aria-describedby points to it')

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
      const over = Array.from(document.querySelectorAll('.prop-catalog, .prop-catalog *')).filter(el => { const r = el.getBoundingClientRect(); return r.width && r.right > width + 0.5 && !el.closest('[hidden]') && !el.closest('.dropdown-checkbox-menu:not(.show)'); }).slice(0, 5).map(el => el.className || el.nodeName);
      return { scroll: document.documentElement.scrollWidth, width, over };
    })()`)
    assert(fit.scroll <= fit.width && fit.over.length === 0, `at 390px nothing overflows (scrollWidth ${fit.scroll}, width ${fit.width}${fit.over.length ? `; over: ${fit.over.join(', ')}` : ''})`)
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
      filters: Array.from(document.querySelectorAll('.prop-catalog--filter .filter-group > label')).map(l => l.textContent.replace(':', '')),
      entries: ${ENTRIES}.length,
      shown: ${SHOWN_ENTRIES}.length,
      sects: ${ENTRIES}.every(e => e.classList.contains('sect2')),
      role: document.querySelector('.prop-catalog--filter .table-filters').getAttribute('role'),
      status: document.querySelectorAll('.prop-catalog--filter [role="status"]').length
    }))()`)
    assert(bar.entries === topicEntries.length && bar.shown === bar.entries && bar.sects, `the topic page's bar finds all ${topicEntries.length} generated entries, all showing at first (${JSON.stringify(bar)})`)
    // Every topic property in this release applies without a restart, so the
    // page has no Restart required filter: it would match everything
    const topicRestart = new Set(listed.filter((e) => e.config_scope === 'topic' && e.is_deprecated !== true).map((e) => e.needs_restart === true)).size > 1
    assert(bar.filters.join() === (topicRestart ? 'Section,Restart required' : 'Section'), `the topic page offers only filters that divide its entries: ${bar.filters.join(', ')}`)
    assert(bar.role === 'search' && bar.status === 1, 'the bar is a search landmark with one status region')
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
    // A deep link wins over a filter that would hide its entry
    await page.navigate(`${base}${TOPIC_PAGE}?section=${encodeURIComponent('topic:tiered-storage')}&q=zzzz#retention-ms`)
    await page.waitFor(READY, 'the topic page with a conflicting filter and an anchor')
    const deep = await page.evaluate(`(() => { const h = document.getElementById('retention-ms'); const r = h.getBoundingClientRect(); return { visible: !h.parentElement.hasAttribute('hidden'), inView: r.top >= 0 && r.top < innerHeight, search: location.search, hash: location.hash, q: document.querySelector('.prop-catalog--filter .prop-catalog-search').value, all: ${SHOWN_ENTRIES}.length } })()`)
    assert(deep.visible && deep.inView && deep.hash === '#retention-ms', `the linked entry shows and is in view (${JSON.stringify(deep)})`)
    assert(deep.search === '' && deep.q === '' && deep.all === bar.entries, 'the conflicting filter and search are cleared from the page and the URL')
    // Empty state on the page
    await page.navigate(`${base}${TOPIC_PAGE}?q=zzzz-no-such-property`)
    await page.waitFor(READY, 'the topic page with no matches')
    assert(await page.evaluate(`!document.querySelector('.prop-catalog--filter .prop-catalog-empty').hidden && ${SHOWN_ENTRIES}.length === 0`), 'a search with no matches shows the empty state and hides every entry')
    await page.click('.prop-catalog--filter .prop-catalog-clear')
    await page.waitFor(`${SHOWN_ENTRIES}.length === ${bar.entries}`, 'Clear filters on the page')
    assert(true, 'Clear filters brings every entry back')
    // The cluster page offers Enterprise; its filter keeps the licensed entries
    await page.navigate(base + CLUSTER_PAGE)
    await page.waitFor(READY, 'the cluster page filter bar')
    const clusterFilters = await page.evaluate(`Array.from(document.querySelectorAll('.prop-catalog--filter .filter-group > label')).map(l => l.textContent.replace(':', ''))`)
    assert(clusterFilters.join() === 'Restart required,Enterprise', `the cluster page offers ${clusterFilters.join(', ')}`)
    await clickOptions(page, 'enterprise', ['none'])
    const licensedEntries = await page.evaluate(`${SHOWN_ENTRIES}.map(e => e.querySelector('h3').id)`)
    assert(licensedEntries.includes('sasl_mechanisms') && licensedEntries.includes('partition_autobalancing_mode') && !licensedEntries.includes('retention_bytes'), `the Enterprise filter keeps the ${licensedEntries.length} cluster entries with Enterprise values`)
    await page.pressKey('Escape', 'Escape', 27)
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
    const pageFit = await page.evaluate(`(() => { const w = document.documentElement.clientWidth; const over = Array.from(document.querySelectorAll('.prop-catalog--filter, .prop-catalog--filter *')).filter(el => { const r = el.getBoundingClientRect(); return r.width && r.right > w + 0.5 && !el.closest('.dropdown-checkbox-menu:not(.show)') }).map(el => el.className || el.nodeName).slice(0, 5); return { scroll: document.documentElement.scrollWidth, w, over } })()`)
    assert(pageFit.over.length === 0 && pageFit.scroll <= pageFit.w, `the filter bar fits 390px (scrollWidth ${pageFit.scroll}, width ${pageFit.w}${pageFit.over.length ? `; over: ${pageFit.over.join(', ')}` : ''})`)
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
        filters: Array.from(document.querySelectorAll('.prop-catalog .filter-group > label')).map(l => l.textContent.replace(':', '')),
        defaults: document.querySelectorAll('.prop-card-default').length,
        enterprise: document.querySelectorAll('.prop-catalog .rp-badge--enterprise').length,
        byoc: cards.filter(c => c.dataset.byoc === 'yes').length,
        byocBadges: Array.from(document.querySelectorAll('.prop-catalog .rp-badge--cloud')).filter(b => b.textContent === 'BYOC only').length,
        editable: Array.from(document.querySelectorAll('.prop-catalog .rp-badge--cloud')).filter(b => b.textContent === 'Cloud editable').length,
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
    if (shots) {
      await page.navigate(base + CLOUD_PAGE)
      await page.waitFor(READY, 'the Cloud catalog')
      await page.evaluate(`document.querySelector('.prop-catalog').scrollIntoView()`)
      await page.screenshot(path.join(shots, 'cloud-light-1280.png'))
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

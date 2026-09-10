// Preloaded with --require so global fetch is replaced before doc-tools loads.
// Avoids making KAPA_API_BASE env-overridable, which would be a way to point a
// real API key at another host.
//
// STUB_FILE: JSON with { sources: [...], sitemapVersions: [...] }
// STUB_FAIL: "kapa" or "sitemap" to make that fetch return 503
const fs = require('fs')
const data = JSON.parse(fs.readFileSync(process.env.STUB_FILE, 'utf8'))
const down = { ok: false, status: 503, statusText: 'Service Unavailable', json: async () => ({}), text: async () => '' }

global.fetch = async (url) => {
  const u = String(url)
  if (u.includes('sitemap')) {
    if (process.env.STUB_FAIL === 'sitemap') return down
    const urls = (data.sitemapVersions || []).map((v) => `<url><loc>https://docs.redpanda.com/streaming/${v}/x/</loc></url>`).join('')
    return { ok: true, status: 200, statusText: 'OK', text: async () => `<urlset>${urls}</urlset>` }
  }
  if (process.env.STUB_FAIL === 'kapa') return down
  const which = u.includes('source-groups') ? (data.groups || []) : (data.sources || [])
  return { ok: true, status: 200, statusText: 'OK', json: async () => ({ count: which.length, next: null, previous: null, results: which }) }
}

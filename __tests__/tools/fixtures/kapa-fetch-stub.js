// Preloaded with --require so global fetch is replaced before doc-tools loads.
// Avoids making KAPA_API_BASE env-overridable, which would be a way to point a
// real API key at another host.
const fs = require('fs')
const data = JSON.parse(fs.readFileSync(process.env.STUB_FILE, 'utf8'))
global.fetch = async (url) => {
  // Lets a test exercise the "could not find out" path.
  if (process.env.STUB_FAIL) {
    return { ok: false, status: 503, statusText: 'Service Unavailable', json: async () => ({}) }
  }
  const which = String(url).includes('source-groups') ? data.groups : data.sources
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ count: which.length, next: null, previous: null, results: which }),
  }
}

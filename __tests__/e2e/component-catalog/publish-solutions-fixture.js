'use strict'

// Test-only Antora extension: publishes a solutions catalog fixture where the
// solutions-catalog extension publishes the real one (assets/data/solutions.json),
// at the same event, so the catalog page can fetch it.
const fs = require('fs')

module.exports.register = function ({ config }) {
  this.on('beforePublish', ({ siteCatalog }) => {
    siteCatalog.addFile({ contents: fs.readFileSync(config.file), out: { path: 'assets/data/solutions.json' } })
  })
}

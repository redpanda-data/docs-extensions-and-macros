'use strict'

const computeOut = require('./compute-out')
const { posix: path } = require('node:path')

function createAsciiDocFile (contentCatalog, file) {
  file.mediaType = 'text/asciidoc'
  const src = file.src
  const out = computeOut.call(contentCatalog, src)
  const pub = { url: '/' + out.path, moduleRootPath: out.moduleRootPath, rootPath: out.rootPath }
  contentCatalog.removeFile((file = contentCatalog.addFile(Object.assign(file, { path: out.path, out: null, pub: pub }))))
  return file
}

module.exports = createAsciiDocFile

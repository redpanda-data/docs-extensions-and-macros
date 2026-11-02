'use strict'

const { posix: path } = require('node:path')

function computeOut (src) {
  const { component, version, module: module_, family, relative } = src
  const outRelative = family === 'page' ? relative.replace(/\.adoc$/, '.html') : relative
  const { dir: dirname, base: basename, ext: extname, name: stem } = path.parse(outRelative)
  const componentVersion = this.getComponentVersion(component, version)
  const versionSegment = componentVersion
  const outDirSegments = []
  const moduleRootPathSegments = []
  if (component !== 'ROOT') outDirSegments.push(component)
  if (versionSegment) outDirSegments.push(versionSegment)
  if (module_ !== 'ROOT') outDirSegments.push(module_)
  const outModuleDirSegments = outDirSegments.slice()
  if (family !== 'page') {
    outDirSegments.push(`_${family}s`)
    moduleRootPathSegments.push('..')
  }
  if (dirname) {
    outDirSegments.push(dirname)
    for (const _ of dirname.split('/')) moduleRootPathSegments.push('..')
  }
  const rootPathSegments = moduleRootPathSegments.slice()
  for (const _ of outModuleDirSegments) rootPathSegments.push('..')
  const outDirname = outDirSegments.join('/')
  const result = {
    dirname: outDirname,
    basename,
    path: outDirname + '/' + basename,
    moduleRootPath: moduleRootPathSegments.length ? moduleRootPathSegments.join('/') : '.',
    rootPath: rootPathSegments.length ? rootPathSegments.join('/') : '.',
  }
  return result
}

module.exports = computeOut

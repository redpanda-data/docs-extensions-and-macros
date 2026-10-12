'use strict'

// Redpanda Cloud single-sources Redpanda Connect pages and their generated
// partials. Some of that text links to Connect pages that Cloud doesn't have,
// such as streams mode or the service-wide HTTP server, because the feature
// doesn't exist in Cloud. In documents with the env-cloud attribute, this tree
// processor removes each paragraph or list item with an xref that resolves in
// the connect component but not from the Cloud page. The content catalog
// decides, so no list of pages needs maintaining. An xref that resolves
// nowhere is left alone, so Antora still reports it as broken.

const XREF_RX = /xref:([^\s[\]]+)\[/g

// The page part of an xref target, or null when the target can't be checked
// (an attribute reference, or a link within the same page).
function pageSpec (target) {
  const spec = target.split('#')[0]
  if (!spec || spec.includes('{')) return null
  return spec.endsWith('.adoc') ? spec : `${spec}.adoc`
}

// Whether the spec names a component (component:module:path or
// version@component:module:path), in which case the connect fallback doesn't
// apply.
function hasComponent (spec) {
  return spec.includes('@') || spec.split(':').length > 2
}

function cloudOnlyMissing (spec, catalog, src) {
  if (catalog.resolvePage(spec, src)) return false
  if (hasComponent(spec)) return false
  const connectSpec = spec.includes(':') ? `connect:${spec}` : `connect:${src.module}:${spec}`
  return Boolean(catalog.resolvePage(connectSpec, {}))
}

// The unsubstituted text. A list item's raw text is its text property, which
// is Opal nil, not a string, when the item has none.
function sourceText (block) {
  if (block.getContext() === 'list_item') return typeof block.text === 'string' ? block.text : ''
  const lines = block.getSourceLines()
  return Array.isArray(lines) ? lines.join('\n') : ''
}

function removeBlock (block) {
  const parent = block.getParent()
  const siblings = parent.getContext() === 'ulist' || parent.getContext() === 'olist'
    ? parent.getItems()
    : parent.getBlocks()
  const i = siblings.indexOf(block)
  if (i >= 0) siblings.splice(i, 1)
}

function register (registry, context = {}) {
  const { file, contentCatalog } = context
  registry.treeProcessor(function () {
    this.process((doc) => {
      if (!doc.hasAttribute('env-cloud') || !file || !contentCatalog) return
      const src = file.src
      const blocks = doc.findBy((b) => b.getContext() === 'paragraph' || b.getContext() === 'list_item')
      for (const block of blocks) {
        const text = sourceText(block)
        for (const m of text.matchAll(XREF_RX)) {
          const spec = pageSpec(m[1])
          if (spec && cloudOnlyMissing(spec, contentCatalog, src)) {
            removeBlock(block)
            break
          }
        }
      }
      // A list left with no items would render as an empty list.
      for (const list of doc.findBy((b) => b.getContext() === 'ulist' || b.getContext() === 'olist')) {
        if (list.getItems().length === 0) removeBlock(list)
      }
    })
  })
}

module.exports = { register, pageSpec, hasComponent, cloudOnlyMissing }

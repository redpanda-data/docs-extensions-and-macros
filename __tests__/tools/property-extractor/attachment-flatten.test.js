'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const generateHandlebarsDocs = require('../../../tools/property-extractor/generate-handlebars-docs')

/**
 * The published attachment (modules/reference/attachments/redpanda-properties-
 * <tag>.json) is copied verbatim from inputFile by the Makefile, AFTER this
 * generator runs. Two of its readers assume `description` is always a
 * string: extensions/render-property-descriptions.js silently skips
 * anything else, and docs-ui's tooltip fallback formatter does
 * `String(description)`, which comma-joins an array and publishes the
 * literal audience prefix and the wrong-audience sentence to every reader.
 *
 * These tests assert on inputFile ON DISK after generateAllDocs returns,
 * because that write-back -- not the in-memory `properties` object used for
 * the .adoc partials -- is what the Makefile's `cp` actually picks up.
 */
function tmpInput (data) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-flatten-'))
  const file = path.join(dir, 'enhanced.json')
  fs.writeFileSync(file, JSON.stringify(data))
  return { dir, file }
}

function outDir (dir) {
  const out = path.join(dir, 'out')
  fs.mkdirSync(out, { recursive: true })
  return out
}

function onDisk (file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

describe('array-form descriptions are flattened back to a string on disk', () => {
  it('turns an audience-scoped array into the same ifdef/ifndef string main used to hand-write', () => {
    const { dir, file } = tmpInput({
      properties: {
        p: {
          name: 'p',
          description: [
            'Base prose that applies everywhere.',
            'cloud-only: Cloud clusters require at least 3.'
          ],
          type: 'integer'
        }
      }
    })
    generateHandlebarsDocs.generateAllDocs(file, outDir(dir))
    const description = onDisk(file).properties.p.description

    expect(typeof description).toBe('string')
    expect(description).toContain('Base prose that applies everywhere.')
    expect(description).toMatch(/^ifdef::env-cloud\[\]$/m)
    expect(description).toContain('Cloud clusters require at least 3.')
    // The literal prefix must never survive: that IS the bug being fixed.
    expect(description).not.toContain('cloud-only:')
  })

  it('renders correctly for both audiences through Asciidoctor, matching pre-array-form behaviour', () => {
    const asciidoctor = require('@asciidoctor/core')()
    const { dir, file } = tmpInput({
      properties: {
        p: {
          name: 'p',
          description: [
            'Base sentence.',
            'cloud-only: Only for Cloud.',
            'self-managed-only: Only for Self-Managed.'
          ],
          type: 'string'
        }
      }
    })
    generateHandlebarsDocs.generateAllDocs(file, outDir(dir))
    const description = onDisk(file).properties.p.description

    const strip = (html) => html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
    const selfManaged = strip(asciidoctor.convert(description, { safe: 'safe' }))
    const cloud = strip(asciidoctor.convert(description, { safe: 'safe', attributes: { 'env-cloud': '' } }))

    expect(selfManaged).toContain('Only for Self-Managed.')
    expect(selfManaged).not.toContain('Only for Cloud.')
    expect(selfManaged).not.toContain('cloud-only:')

    expect(cloud).toContain('Only for Cloud.')
    expect(cloud).not.toContain('Only for Self-Managed.')
    expect(cloud).not.toContain('self-managed-only:')
  })

  it('leaves a plain string description on disk untouched', () => {
    const { dir, file } = tmpInput({
      properties: { p: { name: 'p', description: 'Already a string.', type: 'string' } }
    })
    generateHandlebarsDocs.generateAllDocs(file, outDir(dir))
    expect(onDisk(file).properties.p.description).toBe('Already a string.')
  })

  it('touches only the array-form properties, leaving every other field and property byte-identical', () => {
    const before = {
      properties: {
        scoped: { name: 'scoped', description: ['Base.', 'cloud-only: Cloud only.'], type: 'string', category: 'kept' },
        plain: { name: 'plain', description: 'Untouched string.', type: 'string', category: 'kept', aliases: ['a', 'b'] }
      }
    }
    const { dir, file } = tmpInput(before)
    generateHandlebarsDocs.generateAllDocs(file, outDir(dir))
    const after = onDisk(file)

    expect(after.properties.plain).toEqual(before.properties.plain)
    expect(after.properties.scoped.category).toBe('kept')
    expect(after.properties.scoped.type).toBe('string')
    expect(typeof after.properties.scoped.description).toBe('string')
  })
})

describe('the on-disk write-back is idempotent', () => {
  it('produces byte-identical description text across repeated runs against the same file', () => {
    const { dir, file } = tmpInput({
      properties: {
        p: {
          name: 'p',
          description: ['Base.', 'cloud-only: Cloud sentence.'],
          type: 'string'
        }
      }
    })
    generateHandlebarsDocs.generateAllDocs(file, outDir(dir))
    const first = onDisk(file).properties.p.description

    generateHandlebarsDocs.generateAllDocs(file, outDir(dir))
    const second = onDisk(file).properties.p.description

    expect(second).toBe(first)
  })

  it('never duplicates an includes directive across repeated runs', () => {
    // The bug this guards: after the first run, `description` is already a
    // string containing the include directive, but the raw `includes`
    // field is never cleared, so a second run appended it a second time.
    const { dir, file } = tmpInput({
      properties: {
        p: {
          name: 'p',
          description: 'Plain prose.',
          type: 'string',
          includes: ['reference:partial$x.adoc[]']
        }
      }
    })
    generateHandlebarsDocs.generateAllDocs(file, outDir(dir))
    generateHandlebarsDocs.generateAllDocs(file, outDir(dir))
    generateHandlebarsDocs.generateAllDocs(file, outDir(dir))

    const description = onDisk(file).properties.p.description
    expect(description.split('include::').length - 1).toBe(1)
  })
})

describe('includes are restored inline for the attachment, matching pre-includes-field behaviour', () => {
  it('appends an unconditional include after the description', () => {
    const { dir, file } = tmpInput({
      properties: {
        p: { name: 'p', description: 'Internal use only.', type: 'string', includes: ['reference:partial$internal-use-property.adoc[]'] }
      }
    })
    generateHandlebarsDocs.generateAllDocs(file, outDir(dir))
    const description = onDisk(file).properties.p.description
    expect(description).toBe('Internal use only.\n\ninclude::reference:partial$internal-use-property.adoc[]')
  })

  it('wraps a scoped include in the matching conditional', () => {
    const { dir, file } = tmpInput({
      properties: {
        p: {
          name: 'p',
          description: 'Base prose.',
          type: 'string',
          includes: ['self-managed-only: reference:partial$x.adoc[]']
        }
      }
    })
    generateHandlebarsDocs.generateAllDocs(file, outDir(dir))
    const description = onDisk(file).properties.p.description
    expect(description).toMatch(/^ifndef::env-cloud\[\]$/m)
    expect(description).toContain('include::reference:partial$x.adoc[]')
  })

  it('combines an audience-scoped description paragraph with an includes directive', () => {
    const { dir, file } = tmpInput({
      properties: {
        p: {
          name: 'p',
          description: ['Base.', 'cloud-only: Cloud sentence.'],
          type: 'string',
          includes: ['reference:partial$x.adoc[]']
        }
      }
    })
    generateHandlebarsDocs.generateAllDocs(file, outDir(dir))
    const description = onDisk(file).properties.p.description
    expect(description).toContain('Base.')
    expect(description).toMatch(/^ifdef::env-cloud\[\]$/m)
    expect(description).toContain('Cloud sentence.')
    expect(description).toContain('include::reference:partial$x.adoc[]')
  })
})

describe('extensions/render-property-descriptions.js accepts the flattened output', () => {
  it('no longer hits the non-string skip guard that dropped array descriptions silently', () => {
    const { dir, file } = tmpInput({
      properties: { p: { name: 'p', description: ['Base.', 'cloud-only: Cloud only.'], type: 'string' } }
    })
    generateHandlebarsDocs.generateAllDocs(file, outDir(dir))
    const description = onDisk(file).properties.p.description
    // This is exactly the guard at extensions/render-property-descriptions.js
    // that silently `continue`s on anything but a string.
    expect(typeof description !== 'string' || !description.trim()).toBe(false)
  })
})

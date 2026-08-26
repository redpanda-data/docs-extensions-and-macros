'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

const {
  ValidationResult,
  validateSchema,
  validateOverrides,
  loadAndValidateOverrides,
} = require('../../../tools/property-extractor/validate-overrides')

describe('property-extractor validate-overrides', () => {
  describe('ValidationResult (shared with rpk-docs)', () => {
    it('starts valid with no errors or warnings', () => {
      const result = new ValidationResult()
      expect(result.valid).toBe(true)
      expect(result.errors).toHaveLength(0)
    })
  })

  describe('validateSchema', () => {
    it('passes a minimal, well-formed overrides object', () => {
      const result = validateSchema({ properties: { admin: { description: 'x' } } })
      expect(result.valid).toBe(true)
    })

    it('accepts a plain-string see_also item', () => {
      const result = validateSchema({
        properties: { audit_enabled: { see_also: ['xref:a.adoc[]'] } },
      })
      expect(result.valid).toBe(true)
    })

    it('accepts a structured see_also item naming exactly one of cloud_only/self_hosted_only', () => {
      const result = validateSchema({
        properties: {
          audit_enabled: {
            see_also: [
              { content: 'xref:cloud.adoc[]', cloud_only: true },
              { content: 'xref:sh.adoc[]', self_hosted_only: true },
            ],
          },
        },
      })
      expect(result.valid).toBe(true)
    })

    it('rejects a see_also item that sets both cloud_only and self_hosted_only', () => {
      // Exactly the rpk-overrides mistake this shape is modeled on: setting both
      // wraps the item in ifdef::env-cloud[] AND ifndef::env-cloud[], so it never
      // renders in either build. The schema's oneOf blocks it structurally.
      const result = validateSchema({
        properties: {
          audit_enabled: {
            see_also: [{ content: 'xref:a.adoc[]', cloud_only: true, self_hosted_only: true }],
          },
        },
      })
      expect(result.valid).toBe(false)
    })

    it('rejects a see_also object item with no content', () => {
      const result = validateSchema({
        properties: { audit_enabled: { see_also: [{ cloud_only: true }] } },
      })
      expect(result.valid).toBe(false)
    })

    it('rejects an unrecognized override key (the acceptable_values/accepted_values typo class of bug)', () => {
      const result = validateSchema({
        properties: { audit_enabled: { acceptable_values: ['a', 'b'] } },
      })
      expect(result.valid).toBe(false)
      expect(result.errors[0].message).toMatch(/additional properties/i)
    })

    it('still accepts the deprecated related_topics field', () => {
      const result = validateSchema({
        properties: { audit_enabled: { related_topics: ['cloud-only: xref:a.adoc[]'] } },
      })
      expect(result.valid).toBe(true)
    })

    it('accepts a well-formed admonitions entry, with and without a title', () => {
      const result = validateSchema({
        properties: {
          node_id: {
            admonitions: [
              { type: 'warning', text: 'Do not set manually.', title: 'Custom title' },
              { type: 'NOTE', text: 'Case-insensitive type is allowed.' },
            ],
          },
        },
      })
      expect(result.valid).toBe(true)
    })

    it('rejects an admonitions entry with an unrecognized type', () => {
      const result = validateSchema({
        properties: { node_id: { admonitions: [{ type: 'bogus', text: 'x' }] } },
      })
      expect(result.valid).toBe(false)
    })

    it('rejects an admonitions entry missing text', () => {
      const result = validateSchema({
        properties: { node_id: { admonitions: [{ type: 'note' }] } },
      })
      expect(result.valid).toBe(false)
    })

    it('rejects an admonitions entry with an unknown key', () => {
      const result = validateSchema({
        properties: { node_id: { admonitions: [{ type: 'note', text: 'x', icon: 'star' }] } },
      })
      expect(result.valid).toBe(false)
    })
  })

  describe('validateOverrides', () => {
    it('rejects a non-object input', () => {
      const result = validateOverrides(null)
      expect(result.valid).toBe(false)
    })
  })

  describe('loadAndValidateOverrides', () => {
    let tempDir

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'property-overrides-validate-'))
    })

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true })
    })

    it('warns, but does not throw, when the file does not exist', () => {
      const { overrides, validation } = loadAndValidateOverrides(path.join(tempDir, 'missing.json'))
      expect(overrides).toBeNull()
      expect(validation.warnings.length).toBeGreaterThan(0)
    })

    it('errors on unparsable JSON', () => {
      const file = path.join(tempDir, 'bad.json')
      fs.writeFileSync(file, '{ not json')
      const { overrides, validation } = loadAndValidateOverrides(file)
      expect(overrides).toBeNull()
      expect(validation.valid).toBe(false)
    })

    it('loads the sibling schema next to the overrides file over the package-relative fallback', () => {
      // A schema that forbids everything, placed next to the overrides file,
      // must win over the real (permissive) docs-data/property-overrides.schema.json.
      const schemaFile = path.join(tempDir, 'property-overrides.schema.json')
      fs.writeFileSync(schemaFile, JSON.stringify({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        additionalProperties: false,
      }))
      const overridesFile = path.join(tempDir, 'property-overrides.json')
      fs.writeFileSync(overridesFile, JSON.stringify({ properties: {} }))

      const { validation } = loadAndValidateOverrides(overridesFile)
      expect(validation.valid).toBe(false)
    })

    it('validates the real docs-data/property-overrides.schema.json shipped in this repo', () => {
      const overridesFile = path.join(tempDir, 'property-overrides.json')
      fs.writeFileSync(overridesFile, JSON.stringify({
        properties: { admin: { description: 'Network addresses for Admin API servers.' } },
      }))
      const { overrides, validation } = loadAndValidateOverrides(overridesFile)
      expect(overrides).toBeTruthy()
      expect(validation.valid).toBe(true)
    })
  })
})

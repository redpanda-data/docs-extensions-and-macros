'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { parseTermFile, validateTerms, indexTerms, toTermsJson, loadTermsFromDir, termsFromJson, termAnchor } = require('../../extension-utils/glossary-terms')

const file = (name, extra = '') => `=== ${name}\n:term-name: ${name}\n:hover-text: About ${name}.\n:category: Redpanda core\n${extra}\nBody.\n`

describe('parseTermFile', () => {
  test('reads the required attributes, the optional label lists, and the ID from the file name', () => {
    const t = parseTermFile(file('Schema Registry', ':alt-labels: SR, schema registry service\n:do-not-use: the Schema Registry\n'), { path: 'shared/modules/terms/partials/schema-registry.adoc' })
    expect(t).toMatchObject({
      id: 'schema-registry',
      term: 'Schema Registry',
      def: 'About Schema Registry.',
      category: 'Redpanda core',
      altLabels: ['SR', 'schema registry service'],
      doNotUse: ['the Schema Registry'],
      pageTitle: 'Schema Registry',
      anchor: 'schema-registry',
    })
  })

  test('returns null without term-name or hover-text', () => {
    expect(parseTermFile('=== x\n:term-name: x\n')).toBeNull()
    expect(parseTermFile('=== x\n:hover-text: y\n')).toBeNull()
  })

  test('the anchor matches the one the glossary page gives the section', () => {
    expect(termAnchor('Remote Read Replica (RRR)')).toBe('remote-read-replica-rrr')
    expect(termAnchor('rpk.ai_gateway')).toBe('rpk-ai-gateway')
  })
})

describe('validateTerms', () => {
  const parse = (name, extra, id) => parseTermFile(file(name, extra), { path: `p/${id || name}.adoc` })

  test('a consistent glossary has no problems', () => {
    expect(validateTerms([parse('broker', ':alt-labels: Redpanda broker\n'), parse('topic')])).toEqual([])
  })

  test('reports a duplicate name, ignoring case', () => {
    expect(validateTerms([parse('Broker', '', 'a'), parse('broker', '', 'b')])[0]).toMatch(/duplicate term-name 'broker'/)
  })

  test('reports an alt label that is another term\'s name, or names two terms', () => {
    const errors = validateTerms([parse('broker', ':alt-labels: topic, server\n'), parse('topic'), parse('node', ':alt-labels: server\n')])
    expect(errors.join('\n')).toMatch(/alt-label 'topic' of 'broker'.*is the name of another term, 'topic'/)
    expect(errors.join('\n')).toMatch(/alt-label 'server' names two terms: 'broker'.*and 'node'/)
  })

  test('reports a form a term both uses and avoids, and a do-not-use form that is another term', () => {
    const errors = validateTerms([parse('broker', ':alt-labels: Redpanda broker\n:do-not-use: Redpanda broker, topic\n'), parse('topic')])
    expect(errors.join('\n')).toMatch(/'Redpanda broker' is both a label and a do-not-use form of 'broker'/)
    expect(errors.join('\n')).toMatch(/do-not-use form 'topic' of 'broker'.*is the name of another term/)
  })

  test('a do-not-use form that differs from a label only in case is a casing rule, not a conflict', () => {
    expect(validateTerms([parse('BYOC', ':alt-labels: Bring Your Own Cloud\n:do-not-use: bring your own cloud, Bring your own cloud\n')])).toEqual([])
  })
})

describe('indexTerms', () => {
  test('finds a term by its name or an alt label, ignoring case and spacing', () => {
    const broker = parseTermFile(file('broker', ':alt-labels: Redpanda  broker\n'), { path: 'p/broker.adoc' })
    const index = indexTerms([broker])
    expect(index.get('broker')).toBe(broker)
    expect(index.get('redpanda broker')).toBe(broker)
  })
})

describe('toTermsJson and termsFromJson', () => {
  test('publishes sorted terms with glossary URLs, and reads them back', () => {
    const terms = [
      parseTermFile(file('topic'), { path: 'p/topic.adoc' }),
      parseTermFile(file('broker', ':do-not-use: Broker node\n'), { path: 'p/broker.adoc' }),
    ]
    const json = toTermsJson(terms, { glossaryUrl: '/home/glossary/', generatedBy: 'doc-tools 0.0.0' })
    expect(json).toEqual({
      schema: 1,
      source: 'shared/modules/terms/partials',
      generatedBy: 'doc-tools 0.0.0',
      terms: [
        { id: 'broker', term: 'broker', definition: 'About broker.', category: 'Redpanda core', altLabels: [], doNotUse: [{ form: 'Broker node', useInstead: 'broker' }], url: '/home/glossary/#broker' },
        { id: 'topic', term: 'topic', definition: 'About topic.', category: 'Redpanda core', altLabels: [], doNotUse: [], url: '/home/glossary/#topic' },
      ],
    })
    expect(termsFromJson(json).map((t) => [t.id, t.term, t.doNotUse])).toEqual([['broker', 'broker', ['Broker node']], ['topic', 'topic', []]])
  })
})

describe('useInstead', () => {
  test('is the label that matches ignoring case, otherwise the term name', () => {
    const byoc = parseTermFile(file('BYOC', ':alt-labels: Bring Your Own Cloud\n:do-not-use: Bring your own cloud, byoc cloud\n'), { path: 'p/byoc.adoc' })
    expect(toTermsJson([byoc]).terms[0].doNotUse).toEqual([
      { form: 'Bring your own cloud', useInstead: 'Bring Your Own Cloud' },
      { form: 'byoc cloud', useInstead: 'BYOC' },
    ])
  })
})

describe('loadTermsFromDir', () => {
  test('reads every .adoc file and skips incomplete ones', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terms-'))
    fs.writeFileSync(path.join(dir, 'broker.adoc'), file('broker'))
    fs.writeFileSync(path.join(dir, 'broken.adoc'), '=== x\n')
    fs.writeFileSync(path.join(dir, 'README.md'), 'not a term')
    expect(loadTermsFromDir(dir).map((t) => t.id)).toEqual(['broker'])
  })
})

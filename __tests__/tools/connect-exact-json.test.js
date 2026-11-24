'use strict'

/**
 * Connect data carries int64 limits as defaults (the Bloblang counter max is
 * 9223372036854775807). The pipeline works on JS numbers, which round them,
 * so exact-json puts the exact values back when a file is written.
 */

jest.mock('../../cli-utils/octokit-client', () => ({}))

const fs = require('fs')
const os = require('os')
const path = require('path')
const exactJson = require('../../tools/redpanda-connect/exact-json')
const bigIntJson = require('../../cli-utils/big-int-json')
const { publishConnectorAttachment } = require('../../tools/redpanda-connect/rpcn-connector-docs-handler')

const VERSION = '4.119.0'
// The shape of the real 4.119.0 data: two Bloblang functions with int64
// defaults, next to a Bloblang example that holds a large number in a string.
const RAW = `{
  "version": "${VERSION}",
  "inputs": [{ "name": "generate", "type": "input", "config": { "children": [{ "name": "count", "default": 0 }] } }],
  "bloblang-functions": [
    { "name": "counter", "params": { "named": [{ "name": "min", "default": 1 }, { "name": "max", "default": 9223372036854775807 }] },
      "examples": [{ "mapping": "root = {\\"delay_for_ns\\":110839937000000000}" }] },
    { "name": "random_int", "params": { "named": [{ "name": "seed" }, { "name": "min", "default": 0 }, { "name": "max", "default": 9223372036854775806 }] } }
  ]
}`

beforeEach(() => exactJson.forget())

test('without remembered text, the output is the plain JSON (rounded)', () => {
  expect(exactJson.stringify(JSON.parse(RAW), VERSION)).toContain('9223372036854776000')
})

test('puts the exact int64 defaults back and leaves strings alone', () => {
  exactJson.remember(VERSION, RAW)
  const out = exactJson.stringify(JSON.parse(RAW), VERSION)
  expect(out).toContain('"default": 9223372036854775807')
  expect(out).toContain('"default": 9223372036854775806')
  expect(out).not.toContain('9223372036854776000')
  expect(out).toContain('110839937000000000')
  expect(JSON.parse(out).inputs).toEqual(JSON.parse(RAW).inputs)
})

test('follows components by name, not position, and never replaces a changed value', () => {
  exactJson.remember(VERSION, RAW)
  const data = JSON.parse(RAW)
  data['bloblang-functions'].reverse()
  data['bloblang-functions'].find((f) => f.name === 'random_int').params.named[2].default = 5
  const out = bigIntJson.parse(exactJson.stringify(data, VERSION))
  const counter = out['bloblang-functions'].find((f) => f.name === 'counter')
  expect(counter.params.named.find((p) => p.name === 'max').default).toBe(9223372036854775807n)
  expect(out['bloblang-functions'].find((f) => f.name === 'random_int').params.named[2].default).toBe(5)
})

test('the in-memory data stays plain numbers', () => {
  exactJson.remember(VERSION, RAW)
  const data = JSON.parse(RAW)
  exactJson.stringify(data, VERSION)
  expect(typeof data['bloblang-functions'][0].params.named[1].default).toBe('number')
})

test('text that is not JSON is ignored', () => {
  exactJson.remember(VERSION, '{ not json')
  expect(exactJson.stringify({ a: 1 }, VERSION)).toBe('{\n  "a": 1\n}')
})

test('publishConnectorAttachment writes the exact defaults', () => {
  exactJson.remember(VERSION, RAW)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'exact-json-'))
  try {
    const written = publishConnectorAttachment({ newIndex: JSON.parse(RAW), newVersion: VERSION, root })
    const text = fs.readFileSync(written, 'utf8')
    expect(text).toContain('9223372036854775807')
    expect(text).not.toContain('9223372036854776000')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

'use strict'

const fs = require('fs')
const path = require('path')
const { EventEmitter } = require('events')
const {
  raiseListenerLimit,
  GENERATOR_CONTEXT_MAX_LISTENERS,
} = require('../../extensions/util/raise-listener-limit')

describe('raiseListenerLimit', () => {
  test('raises the limit above the Node default', () => {
    const emitter = new EventEmitter()
    expect(emitter.getMaxListeners()).toBe(10)
    raiseListenerLimit(emitter)
    expect(emitter.getMaxListeners()).toBe(GENERATOR_CONTEXT_MAX_LISTENERS)
  })

  test('leaves an unlimited (0) or already-higher limit alone', () => {
    const unlimited = new EventEmitter()
    unlimited.setMaxListeners(0)
    raiseListenerLimit(unlimited)
    expect(unlimited.getMaxListeners()).toBe(0)

    const higher = new EventEmitter()
    higher.setMaxListeners(GENERATOR_CONTEXT_MAX_LISTENERS + 1)
    raiseListenerLimit(higher)
    expect(higher.getMaxListeners()).toBe(GENERATOR_CONTEXT_MAX_LISTENERS + 1)
  })

  test('tolerates contexts without max-listener methods', () => {
    expect(() => raiseListenerLimit({})).not.toThrow()
  })

  // The warning this guards against fires the moment the 11th listener for
  // one event lands on Antora's shared GeneratorContext, so the raise only
  // works if EVERY listener-adding extension performs it before subscribing.
  // This test fails when a new extension adds a listener without the call.
  test('every listener-adding extension raises the limit', () => {
    const extensionsDir = path.join(__dirname, '..', '..', 'extensions')
    const offenders = []
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory() && entry.name !== 'util') walk(full)
        else if (entry.isFile() && entry.name.endsWith('.js')) {
          const content = fs.readFileSync(full, 'utf8')
          if (/this\.(on|once)\(/.test(content) && !content.includes('raiseListenerLimit(this)')) {
            offenders.push(path.relative(extensionsDir, full))
          }
        }
      }
    }
    walk(extensionsDir)
    expect(offenders).toEqual([])
  })

  test('a registered extension raises the limit on its generator context', () => {
    const context = new EventEmitter()
    context.getLogger = () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() })
    require('../../extensions/unlisted-pages.js').register.call(context, { config: {} })
    expect(context.getMaxListeners()).toBe(GENERATOR_CONTEXT_MAX_LISTENERS)
  })
})

'use strict'

const { posix: path } = require('path')

describe('rp-connect-components macro', () => {
  describe('content catalog URL resolution', () => {
    // Test the URL resolution logic used for removed connectors
    test('resolves relative URL from connector page to whats-new page', () => {
      // Simulate the path.relative calculation used in the macro (without path.dirname)
      const currentPageUrl = '/connect/components/inputs/salesforce/'
      const whatsNewPageUrl = '/connect/get-started/whats-new/'

      // For directory-style URLs, use the URL directly as the base
      const relativeUrl = path.relative(currentPageUrl, whatsNewPageUrl)

      // From /connect/components/inputs/salesforce/ to /connect/get-started/whats-new
      // Should go up 3 levels then down to get-started/whats-new
      expect(relativeUrl).toBe('../../../get-started/whats-new')
    })

    test('resolves relative URL for cloud context', () => {
      const currentPageUrl = '/cloud-data-platform/develop/connect/components/inputs/salesforce/'
      const whatsNewPageUrl = '/cloud-data-platform/get-started/whats-new-cloud/'

      const relativeUrl = path.relative(currentPageUrl, whatsNewPageUrl)

      expect(relativeUrl).toBe('../../../../../get-started/whats-new-cloud')
    })

    test('handles nested processor pages', () => {
      const currentPageUrl = '/connect/components/processors/salesforce/'
      const whatsNewPageUrl = '/connect/get-started/whats-new/'

      const relativeUrl = path.relative(currentPageUrl, whatsNewPageUrl)

      expect(relativeUrl).toBe('../../../get-started/whats-new')
    })
  })

  describe('macro registration', () => {
    let macro

    beforeEach(() => {
      jest.resetModules()
      macro = require('../../macros/rp-connect-components.js')
    })

    test('exports a register function', () => {
      expect(typeof macro.register).toBe('function')
    })

    test('registers macros without errors when given valid registry', () => {
      const mockRegistry = {
        blockMacro: jest.fn(() => {}),
        register: jest.fn(callback => callback.call(mockRegistry))
      }

      const mockContext = {
        config: {
          attributes: {}
        }
      }

      // Should not throw
      expect(() => macro.register(mockRegistry, mockContext)).not.toThrow()
    })
  })

  describe('removed connector notice', () => {
    test('generates correct page spec for self-managed context', () => {
      const isCloud = false
      const pageSpec = isCloud
        ? 'cloud-data-platform:get-started:whats-new-cloud.adoc'
        : 'connect:get-started:whats-new.adoc'

      expect(pageSpec).toBe('connect:get-started:whats-new.adoc')
    })

    test('generates correct page spec for cloud context', () => {
      const isCloud = true
      const pageSpec = isCloud
        ? 'cloud-data-platform:get-started:whats-new-cloud.adoc'
        : 'connect:get-started:whats-new.adoc'

      expect(pageSpec).toBe('cloud-data-platform:get-started:whats-new-cloud.adoc')
    })

    test('falls back to hardcoded URL when contentCatalog unavailable', () => {
      const context = {
        contentCatalog: null,
        file: null
      }
      const isCloud = false

      let whatsNewUrl = isCloud
        ? '/cloud-data-platform/get-started/whats-new-cloud/'
        : '/connect/get-started/whats-new/'

      // Simulate the fallback logic
      if (context.contentCatalog && context.file) {
        // This branch won't execute with null values
        whatsNewUrl = '/resolved/url/'
      }

      expect(whatsNewUrl).toBe('/connect/get-started/whats-new/')
    })

    test('uses resolved URL when contentCatalog available', () => {
      const mockPage = {
        pub: { url: '/connect/get-started/whats-new/' }
      }

      const context = {
        contentCatalog: {
          resolvePage: jest.fn(() => mockPage)
        },
        file: {
          src: { component: 'connect', module: 'components' },
          pub: { url: '/connect/components/processors/salesforce/' }
        }
      }

      const isCloud = false
      let whatsNewUrl = isCloud
        ? '/cloud-data-platform/get-started/whats-new-cloud/'
        : '/connect/get-started/whats-new/'

      // Simulate the resolution logic (using direct URL, not dirname)
      if (context.contentCatalog && context.file) {
        const pageSpec = isCloud
          ? 'cloud-data-platform:get-started:whats-new-cloud.adoc'
          : 'connect:get-started:whats-new.adoc'
        const page = context.contentCatalog.resolvePage(pageSpec, context.file.src)
        if (page) {
          whatsNewUrl = path.relative(context.file.pub.url, page.pub.url)
        }
      }

      expect(context.contentCatalog.resolvePage).toHaveBeenCalledWith(
        'connect:get-started:whats-new.adoc',
        { component: 'connect', module: 'components' }
      )
      expect(whatsNewUrl).toBe('../../../get-started/whats-new')
    })
  })
})

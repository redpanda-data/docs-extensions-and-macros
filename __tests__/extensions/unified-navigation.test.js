const unifiedNavigationExtension = require('../../extensions/unified-navigation')

describe('unified-navigation extension', () => {
  let mockContext
  let mockContentCatalog
  let mockComponents
  let mockPages
  let extensionInstance

  beforeEach(() => {
    // Reset mocks
    mockPages = []
    mockComponents = []

    mockContentCatalog = {
      getComponents: jest.fn(() => mockComponents),
      getPages: jest.fn(() => mockPages),
      getComponent: jest.fn((name) => mockComponents.find(c => c.name === name)),
    }

    // Create extension instance with getLogger and on methods
    extensionInstance = {
      getLogger: jest.fn(() => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
      })),
    }

    const handlers = {}
    extensionInstance.on = jest.fn((event, handler) => {
      handlers[event] = handler
    })

    unifiedNavigationExtension.register.call(extensionInstance)

    // Store handlers for testing
    extensionInstance._handlers = handlers
  })

  describe('components without page-navigation', () => {
    it('should not add custom navigation attributes', () => {
      // Setup: component without page-navigation config
      const page = {
        src: { component: 'docs', version: 'master' },
        asciidoc: { attributes: {} },
        out: {},
        pub: { url: '/docs/' },
      }

      mockPages.push(page)

      const component = {
        name: 'docs',
        versions: [{
          version: 'master',
          navigation: [{ content: 'Overview', url: '/docs/' }],
          asciidoc: {
            attributes: {} // No page-navigation
          },
        }],
      }

      mockComponents.push(component)

      // Execute navigationBuilt event
      extensionInstance._handlers.navigationBuilt({ contentCatalog: mockContentCatalog })

      // Assert: page should not have custom navigation
      expect(page.asciidoc.attributes['page-custom-navigation']).toBeUndefined()
      expect(page.asciidoc.attributes['page-has-custom-nav']).toBeUndefined()
    })
  })

  describe('parent component with children', () => {
    it('should show parent nav items outside buckets when component owns config', () => {
      // Setup: data-platform with children
      const dataPlatformPage = {
        src: { component: 'data-platform', version: 'master' },
        asciidoc: { attributes: {} },
        out: {},
        pub: { url: '/data-platform/' },
      }

      const mcpPage = {
        src: { component: 'data-platform', version: 'master' },
        asciidoc: { attributes: {} },
        out: {},
        pub: { url: '/data-platform/mcp/' },
      }

      mockPages.push(dataPlatformPage, mcpPage)

      const dataPlatform = {
        name: 'data-platform',
        latest: null, // Set below, as Antora does
        versions: [{
          version: 'master',
          displayVersion: 'master',
          url: '/data-platform/',
          navigation: [
            { content: 'Overview', url: '/data-platform/', urlType: 'internal' },
            { content: 'Install MCP', url: '/data-platform/mcp/', urlType: 'internal' },
          ],
          asciidoc: {
            attributes: {
              'component-metadata': { title: 'Data Platform', color: '#5239CC', icon: 'stack-2' },
              'page-navigation': `
                - data-platform:
                    - cloud-data-platform
                    - self-managed:
                        - streaming
                        - connect
              `,
            },
          },
        }],
      }
      dataPlatform.latest = dataPlatform.versions[0]

      const cloudDataPlatform = {
        name: 'cloud-data-platform',
        latest: null,
        versions: [{
          version: 'master',
          displayVersion: 'master',
          url: '/cloud/',
          navigation: [{ content: 'Cloud Home', url: '/cloud/', urlType: 'internal' }],
          asciidoc: { attributes: { 'component-metadata': { title: 'Cloud', color: '#blue', icon: 'cloud' } } },
        }],
      }
      cloudDataPlatform.latest = cloudDataPlatform.versions[0]

      const selfManaged = {
        name: 'self-managed',
        latest: null,
        versions: [{
          version: 'master',
          displayVersion: 'master',
          url: '/self-managed/',
          navigation: [{ content: 'Self-Managed Home', url: '/self-managed/', urlType: 'internal' }],
          asciidoc: { attributes: { 'component-metadata': { title: 'Self-Managed', color: '#red', icon: 'server' } } },
        }],
      }
      selfManaged.latest = selfManaged.versions[0]

      mockComponents.push(dataPlatform, cloudDataPlatform, selfManaged)

      // Execute
      extensionInstance._handlers.navigationBuilt({ contentCatalog: mockContentCatalog })

      // Assert: data-platform should have custom navigation
      expect(dataPlatformPage.asciidoc.attributes['page-has-custom-nav']).toBe('true')

      const customNav = JSON.parse(dataPlatformPage.asciidoc.attributes['page-custom-navigation'])

      // First item should be parent's nav items with showNavItemsOnly
      expect(customNav[0]).toHaveProperty('showNavItemsOnly', true)
      expect(customNav[0].items).toHaveLength(2) // Overview + Install MCP
      expect(customNav[0].items[0].content).toBe('Overview')

      // Followed by child buckets
      expect(customNav[1]).toHaveProperty('componentName', 'cloud-data-platform')
      expect(customNav[2]).toHaveProperty('componentName', 'self-managed')
    })
  })

  describe('child component navigation', () => {
    it('should not duplicate nav items for components that inherit config', () => {
      // Setup: self-managed page with its own config
      const selfManagedPage = {
        src: { component: 'self-managed', version: 'master' },
        asciidoc: { attributes: {} },
        out: {},
        pub: { url: '/self-managed/' },
      }

      mockPages.push(selfManagedPage)

      const selfManaged = {
        name: 'self-managed',
        latest: { version: 'master' },
        versions: [{
          version: 'master',
          navigation: [{ content: 'Self-Managed Home', url: '/self-managed/', urlType: 'internal' }],
          asciidoc: {
            attributes: {
              'component-metadata': { title: 'Self-Managed', color: '#red', icon: 'server' },
              'page-navigation': `
                - self-managed:
                    - streaming
                    - connect
              `,
            },
          },
        }],
      }

      const streaming = {
        name: 'streaming',
        latest: null,
        versions: [{
          version: 'master',
          displayVersion: 'master',
          url: '/streaming/',
          navigation: [{ content: 'Streaming Docs', url: '/streaming/', urlType: 'internal' }],
          asciidoc: { attributes: { 'component-metadata': { title: 'Streaming', color: '#green' } } },
        }],
      }
      streaming.latest = streaming.versions[0]

      const connect = {
        name: 'connect',
        latest: null,
        versions: [{
          version: 'master',
          displayVersion: 'master',
          url: '/connect/',
          navigation: [{ content: 'Connect Docs', url: '/connect/', urlType: 'internal' }],
          asciidoc: { attributes: { 'component-metadata': { title: 'Connect', color: '#purple' } } },
        }],
      }
      connect.latest = connect.versions[0]

      mockComponents.push(selfManaged, streaming, connect)

      // Execute
      extensionInstance._handlers.navigationBuilt({ contentCatalog: mockContentCatalog })

      // Assert
      const customNav = JSON.parse(selfManagedPage.asciidoc.attributes['page-custom-navigation'])

      // First item should be parent's nav items (self-managed owns its config)
      expect(customNav[0]).toHaveProperty('showNavItemsOnly', true)
      expect(customNav[0].items).toHaveLength(1)
      expect(customNav[0].items[0].content).toBe('Self-Managed Home')

      // Followed by only child buckets (streaming, connect), not self-managed bucket
      expect(customNav).toHaveLength(3) // parent nav + 2 child buckets
      expect(customNav[1].componentName).toBe('streaming')
      expect(customNav[2].componentName).toBe('connect')

      // Ensure no self-managed bucket that would duplicate the nav items
      expect(customNav.some(item => item.componentName === 'self-managed')).toBe(false)
    })
  })

  describe('unpublished page filtering', () => {
    it('should filter unpublished pages from navigation', () => {
      // Parent page
      const parentPage = {
        src: { component: 'parent', version: 'master' },
        asciidoc: { attributes: {} },
        out: {},
        pub: { url: '/parent/' },
      }

      // Published child page
      const childPage = {
        src: { component: 'docs', version: 'master' },
        asciidoc: { attributes: {} },
        out: {},
        pub: { url: '/docs/' },
      }

      // Unpublished child page (no out property)
      const unpublishedPage = {
        src: { component: 'docs', version: 'master' },
        asciidoc: { attributes: {} },
        // No out property
        pub: { url: '/docs/unpublished/' },
      }

      mockPages.push(parentPage, childPage, unpublishedPage)

      const parent = {
        name: 'parent',
        latest: null,
        versions: [{
          version: 'master',
          displayVersion: 'master',
          url: '/parent/',
          navigation: [{ content: 'Parent Home', url: '/parent/', urlType: 'internal' }],
          asciidoc: {
            attributes: {
              'component-metadata': { title: 'Parent', color: '#purple' },
              'page-navigation': '- parent:\n    - docs',
            },
          },
        }],
      }
      parent.latest = parent.versions[0]

      const docs = {
        name: 'docs',
        latest: null,
        versions: [{
          version: 'master',
          displayVersion: 'master',
          url: '/docs/',
          navigation: [
            { content: 'Published', url: '/docs/', urlType: 'internal' },
            { content: 'Unpublished', url: '/docs/unpublished/', urlType: 'internal' },
          ],
          asciidoc: {
            attributes: {
              'component-metadata': { title: 'Docs', color: '#blue' },
            },
          },
        }],
      }
      docs.latest = docs.versions[0]

      mockComponents.push(parent, docs)

      // Execute
      extensionInstance._handlers.navigationBuilt({ contentCatalog: mockContentCatalog })

      // Assert: Check parent page has custom navigation
      const customNav = JSON.parse(parentPage.asciidoc.attributes['page-custom-navigation'])
      const bucket = customNav.find(item => item.componentName === 'docs')

      // Should only have published page
      expect(bucket.items).toHaveLength(1)
      expect(bucket.items[0].content).toBe('Published')
    })
  })

  describe('standalone components', () => {
    it('should use standard Antora nav for standalone components without children', () => {
      const page = {
        src: { component: 'agentic-data-plane', version: 'master' },
        asciidoc: { attributes: {} },
        out: {},
        pub: { url: '/agentic-data-plane/' },
      }

      mockPages.push(page)

      const agenticDataPlane = {
        name: 'agentic-data-plane',
        latest: null,
        versions: [{
          version: 'master',
          displayVersion: 'master',
          url: '/agentic-data-plane/',
          navigation: [{ content: 'Agentic Home', url: '/agentic-data-plane/', urlType: 'internal' }],
          asciidoc: {
            attributes: {
              'component-metadata': { title: 'Agentic Data Plane', color: '#orange' },
              'page-navigation': '- agentic-data-plane', // Standalone, no children
            },
          },
        }],
      }
      agenticDataPlane.latest = agenticDataPlane.versions[0]

      mockComponents.push(agenticDataPlane)

      // Execute
      extensionInstance._handlers.navigationBuilt({ contentCatalog: mockContentCatalog })

      // Assert: standalone components should not get custom navigation
      expect(page.asciidoc.attributes['page-custom-navigation']).toBeUndefined()
      expect(page.asciidoc.attributes['page-has-custom-nav']).toBeUndefined()
    })
  })

  describe('a component with a prerelease version', () => {
    // Antora sets `latest` (newest non-prerelease) and `latestPrerelease` on a
    // component, and stores `versions` newest-first WITH prereleases at the
    // front. It never sets `latestVersion` -- so reading that property fell
    // through to versions[0], the prerelease, and every bucket took its
    // metadata, nav and version label from an unreleased version.
    //
    // The mocks in the tests above set `latestVersion` themselves, which is why
    // this went unnoticed: they described a component shape Antora does not
    // produce, and each had a single version, so both expressions agreed.
    function componentWithPrerelease () {
      const prerelease = {
        version: '26.1',
        displayVersion: '26.1 (beta)',
        prerelease: true,
        url: '/self-managed/26.1/',
        navigation: [{ content: 'Nav from prerelease', url: '/self-managed/26.1/', urlType: 'internal' }],
        asciidoc: { attributes: { 'component-metadata': { title: 'FROM PRERELEASE', color: '#pre', icon: 'beta' } } },
      }
      const stable = {
        version: '25.3',
        displayVersion: '25.3',
        url: '/self-managed/25.3/',
        navigation: [{ content: 'Nav from stable', url: '/self-managed/25.3/', urlType: 'internal' }],
        asciidoc: { attributes: { 'component-metadata': { title: 'FROM STABLE', color: '#stable', icon: 'server' } } },
      }
      // Antora's ordering and properties, not a convenient approximation.
      return { name: 'self-managed', versions: [prerelease, stable], latest: stable, latestPrerelease: prerelease }
    }

    function parentOwningTheConfig () {
      const version = {
        version: 'master',
        displayVersion: 'master',
        url: '/data-platform/',
        navigation: [{ content: 'Overview', url: '/data-platform/', urlType: 'internal' }],
        asciidoc: {
          attributes: {
            'component-metadata': { title: 'Data Platform', color: '#5239CC', icon: 'stack-2' },
            'page-navigation': '\n                - data-platform:\n                    - self-managed\n              ',
          },
        },
      }
      return { name: 'data-platform', versions: [version], latest: version }
    }

    function bucketsFor (page) {
      extensionInstance._handlers.navigationBuilt({ contentCatalog: mockContentCatalog })
      return JSON.parse(page.asciidoc.attributes['page-custom-navigation'])
    }

    it('takes bucket metadata from the latest released version, not the prerelease', () => {
      const page = {
        src: { component: 'data-platform', version: 'master' },
        asciidoc: { attributes: {} },
        out: {},
        pub: { url: '/data-platform/' },
      }
      // Published pages for every nav target, so nothing is filtered out.
      mockPages.push(
        page,
        { src: { component: 'self-managed', version: '25.3' }, asciidoc: { attributes: {} }, out: {}, pub: { url: '/self-managed/25.3/' } },
        { src: { component: 'self-managed', version: '26.1' }, asciidoc: { attributes: {} }, out: {}, pub: { url: '/self-managed/26.1/' } }
      )
      mockComponents.push(parentOwningTheConfig(), componentWithPrerelease())

      const buckets = bucketsFor(page)
      const selfManaged = buckets.find((b) => b.componentName === 'self-managed')

      expect(selfManaged).toBeDefined()
      expect(selfManaged.title).toBe('FROM STABLE')
      expect(selfManaged.icon).toBe('server')
      expect(selfManaged.currentVersion).toBe('25.3')
      expect(selfManaged.items[0].content).toBe('Nav from stable')
    })

    it('still works for a component whose only version is a prerelease', () => {
      // Antora sets latest to the prerelease when there is nothing else, so the
      // fallback must not be removed.
      const prereleaseOnly = componentWithPrerelease()
      prereleaseOnly.versions = [prereleaseOnly.versions[0]]
      prereleaseOnly.latest = prereleaseOnly.versions[0]
      delete prereleaseOnly.latestPrerelease

      const page = {
        src: { component: 'data-platform', version: 'master' },
        asciidoc: { attributes: {} },
        out: {},
        pub: { url: '/data-platform/' },
      }
      mockPages.push(
        page,
        { src: { component: 'self-managed', version: '26.1' }, asciidoc: { attributes: {} }, out: {}, pub: { url: '/self-managed/26.1/' } }
      )
      mockComponents.push(parentOwningTheConfig(), prereleaseOnly)

      const selfManaged = bucketsFor(page).find((b) => b.componentName === 'self-managed')
      expect(selfManaged.title).toBe('FROM PRERELEASE')
      expect(selfManaged.currentVersion).toBe('26.1 (beta)')
    })
  })
})

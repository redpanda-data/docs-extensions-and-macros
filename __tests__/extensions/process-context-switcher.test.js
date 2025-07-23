const { describe, it, expect, beforeEach } = require('@jest/globals');

// Mock the extension
const extension = require('../../extensions/process-context-switcher.js');

describe('process-context-switcher extension', () => {
  let mockLogger;
  let mockContentCatalog;
  let mockPage;
  let extensionContext;

  beforeEach(() => {
    mockLogger = {
      info: jest.fn(),
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    };

    mockPage = {
      src: {
        component: 'ROOT',
        version: 'current',
        module: 'console',
        relative: 'config/security/authentication.adoc',
        path: 'modules/console/pages/config/security/authentication.adoc'
      },
      asciidoc: {
        attributes: {
          'page-context-switcher': '[{"name": "Version 2.x", "to": "24.3@ROOT:console:config/security/authentication.adoc" },{"name": "Version 3.x", "to": "current" }]'
        }
      }
    };

    const targetPage = {
      src: {
        component: 'ROOT',
        version: '24.3',
        module: 'console',
        relative: 'config/security/authentication.adoc',
        path: 'modules/console/pages/config/security/authentication.adoc'
      },
      asciidoc: {
        attributes: {}
      }
    };

    mockContentCatalog = {
      findBy: jest.fn((criteria) => {
        if (criteria.family === 'page') {
          if (criteria.component === 'ROOT' && criteria.version === '24.3') {
            return [targetPage];
          }
          return [mockPage, targetPage];
        }
        return [];
      }),
      resolveResource: jest.fn((resourceId, currentSrc) => {
        // Mock resolveResource to return the target page for the test resource ID
        if (resourceId === '24.3@ROOT:console:config/security/authentication.adoc') {
          return targetPage;
        }
        // Support version-less resource IDs that get normalized with current page version
        if (resourceId === 'current@ROOT:console:config/security/authentication.adoc') {
          return targetPage;
        }
        return null;
      })
    };

    extensionContext = {
      getLogger: jest.fn(() => mockLogger),
      on: jest.fn()
    };
  });

  it('should register with contentCatalog event', () => {
    extension.register.call(extensionContext, { config: {} });
    expect(extensionContext.on).toHaveBeenCalledWith('documentsConverted', expect.any(Function));
  });

  it('should replace "current" with full resource ID', async () => {
    extension.register.call(extensionContext, { config: {} });

    // Get the registered handler
    const handler = extensionContext.on.mock.calls[0][1];

    // Execute the handler
    await handler({ contentCatalog: mockContentCatalog });

    // Check that "current" was replaced
    const updatedAttribute = JSON.parse(mockPage.asciidoc.attributes['page-context-switcher']);
    const currentItem = updatedAttribute.find(item => item.name === 'Version 3.x');

    expect(currentItem.to).toBe('current@ROOT:console:config/security/authentication.adoc');
  });

  it('should inject context-switcher to target pages', async () => {
    extension.register.call(extensionContext, { config: {} });

    // Get the registered handler
    const handler = extensionContext.on.mock.calls[0][1];

    // Execute the handler
    await handler({ contentCatalog: mockContentCatalog });

    // Find the target page
    const targetPages = mockContentCatalog.findBy({
      family: 'page',
      component: 'ROOT',
      version: '24.3'
    });

    const targetPage = targetPages[0];
    expect(targetPage.asciidoc.attributes['page-context-switcher']).toBeDefined();

    const targetContextSwitcher = JSON.parse(targetPage.asciidoc.attributes['page-context-switcher']);
    expect(targetContextSwitcher).toHaveLength(2);

    // When injecting context switcher to target page:
    // - "current" should be replaced with the original page's resource ID
    // - All other references remain unchanged
    const version2Item = targetContextSwitcher.find(item => item.name === 'Version 2.x');
    const version3Item = targetContextSwitcher.find(item => item.name === 'Version 3.x');

    // Version 2.x should still point to the target page (unchanged)
    expect(version2Item.to).toBe('24.3@ROOT:console:config/security/authentication.adoc');
    // Version 3.x was "current" on original page, should now point to original page
    expect(version3Item.to).toBe('current@ROOT:console:config/security/authentication.adoc');
  });

  it('should handle invalid JSON gracefully', async () => {
    mockPage.asciidoc.attributes['page-context-switcher'] = 'invalid json';

    extension.register.call(extensionContext, { config: {} });
    const handler = extensionContext.on.mock.calls[0][1];

    await handler({ contentCatalog: mockContentCatalog });

    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('Error parsing context-switcher attribute')
    );
  });

  it('should warn when target page is not found', async () => {
    mockPage.asciidoc.attributes['page-context-switcher'] = '[{"name": "Test", "to": "nonexistent@ROOT:module:file.adoc"}]';

    extension.register.call(extensionContext, { config: {} });
    const handler = extensionContext.on.mock.calls[0][1];

    await handler({ contentCatalog: mockContentCatalog });

    expect(mockLogger.warn).toHaveBeenCalledWith(
      "Target page not found for resource ID: 'nonexistent@ROOT:module:file.adoc'. Check that the component, module, and path exist. Enable debug logging to see available pages."
    );
  });

  it('should inject current page version into resource IDs when missing', async () => {
    // Test with a resource ID without version
    mockPage.asciidoc.attributes['page-context-switcher'] = '[{"name": "Version 2.x", "to": "ROOT:console:config/security/authentication.adoc" },{"name": "Version 3.x", "to": "current" }]';

    extension.register.call(extensionContext, { config: {} });
    const handler = extensionContext.on.mock.calls[0][1];

    await handler({ contentCatalog: mockContentCatalog });

    // Verify that resolveResource was called with the normalized version
    expect(mockContentCatalog.resolveResource).toHaveBeenCalledWith(
      'current@ROOT:console:config/security/authentication.adoc', 
      mockPage.src
    );
    
    // Should log about the normalization
    expect(mockLogger.debug).toHaveBeenCalledWith(
      "Normalized resource ID 'ROOT:console:config/security/authentication.adoc' to 'current@ROOT:console:config/security/authentication.adoc' using current page version"
    );
  });

  it('should skip pages without context-switcher attribute', async () => {
    mockContentCatalog.findBy = jest.fn(() => [
      {
        src: { path: 'test.adoc' },
        asciidoc: { attributes: {} }
      }
    ]);

    extension.register.call(extensionContext, { config: {} });
    const handler = extensionContext.on.mock.calls[0][1];

    await handler({ contentCatalog: mockContentCatalog });

    expect(mockLogger.debug).toHaveBeenCalledWith(
      'No pages found with page-context-switcher attribute'
    );
  });

  it('should correctly handle target page injection with proper URL swapping', async () => {
    // This test specifically addresses the issue where both links were pointing to the same URL
    const originalPage = {
      src: {
        component: 'ROOT',
        version: 'current',
        module: 'console',
        relative: 'config/security/authentication.adoc',
        path: 'modules/console/pages/config/security/authentication.adoc'
      },
      asciidoc: {
        attributes: {
          'page-context-switcher': '[{"name": "Version 2.x", "to": "24.3@ROOT:console:config/security/authentication.adoc"},{"name": "Version 3.x", "to": "current"}]'
        }
      }
    };

    const targetPage = {
      src: {
        component: 'ROOT',
        version: '24.3',
        module: 'console',
        relative: 'config/security/authentication.adoc',
        path: 'modules/console/pages/config/security/authentication.adoc'
      },
      asciidoc: {
        attributes: {}
      }
    };

    const testContentCatalog = {
      findBy: jest.fn(() => [originalPage, targetPage]),
      resolveResource: jest.fn((resourceId) => {
        if (resourceId === '24.3@ROOT:console:config/security/authentication.adoc') {
          return targetPage;
        }
        return null;
      })
    };

    extension.register.call(extensionContext, { config: {} });
    const handler = extensionContext.on.mock.calls[0][1];
    
    await handler({ contentCatalog: testContentCatalog });

    // Check original page - "current" should be replaced with full resource ID
    const originalContextSwitcher = JSON.parse(originalPage.asciidoc.attributes['page-context-switcher']);
    expect(originalContextSwitcher[0].to).toBe('24.3@ROOT:console:config/security/authentication.adoc'); // Points to target
    expect(originalContextSwitcher[1].to).toBe('current@ROOT:console:config/security/authentication.adoc'); // Points to itself

    // Check target page - should have same context switcher with "current" replaced
    expect(targetPage.asciidoc.attributes['page-context-switcher']).toBeDefined();
    const targetContextSwitcher = JSON.parse(targetPage.asciidoc.attributes['page-context-switcher']);
    
    // Both items should point to their respective pages (no swapping)
    expect(targetContextSwitcher[0].to).toBe('24.3@ROOT:console:config/security/authentication.adoc'); // Still points to target
    expect(targetContextSwitcher[1].to).toBe('current@ROOT:console:config/security/authentication.adoc'); // Points to original
  });

  it('should prevent infinite loops and redundant processing', async () => {
    // Test scenario: Page A has context switcher pointing to Page B
    // Page B also has context switcher pointing to Page A
    // This should not create infinite loops or overwrite each other
    
    const pageA = {
      src: {
        component: 'ROOT',
        version: 'current',
        module: 'console',
        relative: 'page-a.adoc',
        path: 'modules/console/pages/page-a.adoc'
      },
      asciidoc: {
        attributes: {
          'page-context-switcher': '[{"name": "Go to B", "to": "current@ROOT:console:page-b.adoc"},{"name": "Stay on A", "to": "current"}]'
        }
      }
    };

    const pageB = {
      src: {
        component: 'ROOT',
        version: 'current', 
        module: 'console',
        relative: 'page-b.adoc',
        path: 'modules/console/pages/page-b.adoc'
      },
      asciidoc: {
        attributes: {
          'page-context-switcher': '[{"name": "Go to A", "to": "current@ROOT:console:page-a.adoc"},{"name": "Stay on B", "to": "current"}]'
        }
      }
    };

    const testContentCatalog = {
      findBy: jest.fn(() => [pageA, pageB]),
      resolveResource: jest.fn((resourceId) => {
        if (resourceId === 'current@ROOT:console:page-a.adoc') {
          return pageA;
        }
        if (resourceId === 'current@ROOT:console:page-b.adoc') {
          return pageB;
        }
        return null;
      })
    };

    // Store original attributes to verify they don't get overwritten
    const originalPageAAttribute = pageA.asciidoc.attributes['page-context-switcher'];
    const originalPageBAttribute = pageB.asciidoc.attributes['page-context-switcher'];

    extension.register.call(extensionContext, { config: {} });
    const handler = extensionContext.on.mock.calls[0][1];
    
    await handler({ contentCatalog: testContentCatalog });

    // Both pages should keep their original context switcher attributes 
    // The extension should not overwrite existing attributes
    const expectedPageA = JSON.stringify([
      {"name": "Go to B", "to": "current@ROOT:console:page-b.adoc"},
      {"name": "Stay on A", "to": "current@ROOT:console:page-a.adoc"}
    ]);
    const expectedPageB = JSON.stringify([
      {"name": "Go to A", "to": "current@ROOT:console:page-a.adoc"},
      {"name": "Stay on B", "to": "current@ROOT:console:page-b.adoc"}
    ]);
    
    expect(pageA.asciidoc.attributes['page-context-switcher']).toBe(expectedPageA);
    expect(pageB.asciidoc.attributes['page-context-switcher']).toBe(expectedPageB);

    // Verify that the extension detected both pages already had context switchers
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('already has context-switcher attribute')
    );
  });

  it('should not inject context switcher if target page already has one', async () => {
    // Test the specific protection mechanism
    const sourcePage = {
      src: {
        component: 'ROOT',
        version: 'current',
        module: 'console', 
        relative: 'source.adoc',
        path: 'modules/console/pages/source.adoc'
      },
      asciidoc: {
        attributes: {
          'page-context-switcher': '[{"name": "Target", "to": "current@ROOT:console:target.adoc"},{"name": "Current", "to": "current"}]'
        }
      }
    };

    const targetPage = {
      src: {
        component: 'ROOT',
        version: 'current',
        module: 'console',
        relative: 'target.adoc', 
        path: 'modules/console/pages/target.adoc'
      },
      asciidoc: {
        attributes: {
          'page-context-switcher': '[{"name": "Existing", "to": "somewhere-else.adoc"}]'
        }
      }
    };

    const testContentCatalog = {
      findBy: jest.fn(() => [sourcePage, targetPage]),
      resolveResource: jest.fn((resourceId) => {
        if (resourceId === 'current@ROOT:console:target.adoc') {
          return targetPage;
        }
        return null;
      })
    };

    const originalTargetAttribute = targetPage.asciidoc.attributes['page-context-switcher'];

    extension.register.call(extensionContext, { config: {} });
    const handler = extensionContext.on.mock.calls[0][1];
    
    await handler({ contentCatalog: testContentCatalog });

    // Target page should keep its original context switcher unchanged
    expect(targetPage.asciidoc.attributes['page-context-switcher']).toBe(originalTargetAttribute);
    
    // Should warn that target already has context switcher (with the existing value)
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Target page current@ROOT:console:target.adoc already has context-switcher attribute. Skipping injection to avoid overwriting existing configuration: [{"name": "Existing", "to": "somewhere-else.adoc"}]'
    );
  });

  it('should return processed context-switcher data', async () => {
    // Test that the extension processes data correctly by examining the changes
    const sourcePage = {
      src: {
        component: 'ROOT',
        version: 'current',
        module: 'console',
        relative: 'source.adoc',
        path: 'modules/console/pages/source.adoc'
      },
      asciidoc: {
        attributes: {
          'page-context-switcher': '[{"name": "Target", "to": "current@ROOT:console:target.adoc"},{"name": "Current", "to": "current"}]'
        }
      }
    };

    const targetPage = {
      src: {
        component: 'ROOT',
        version: 'current',
        module: 'console',
        relative: 'target.adoc',
        path: 'modules/console/pages/target.adoc'
      },
      asciidoc: {
        attributes: {}
      }
    };

    const testContentCatalog = {
      findBy: jest.fn(() => [sourcePage]),
      resolveResource: jest.fn((resourceId) => {
        if (resourceId === 'current@ROOT:console:target.adoc') {
          return targetPage;
        }
        return null;
      })
    };

    extension.register.call(extensionContext, { config: {} });
    const handler = extensionContext.on.mock.calls[0][1];
    
    await handler({ contentCatalog: testContentCatalog });

    // Verify the source page was processed correctly
    const sourceContextSwitcher = JSON.parse(sourcePage.asciidoc.attributes['page-context-switcher']);
    expect(sourceContextSwitcher).toEqual([
      {"name": "Target", "to": "current@ROOT:console:target.adoc"},
      {"name": "Current", "to": "current@ROOT:console:source.adoc"}
    ]);

    // Verify the target page received the injected context switcher
    expect(targetPage.asciidoc.attributes['page-context-switcher']).toBeDefined();
    const targetContextSwitcher = JSON.parse(targetPage.asciidoc.attributes['page-context-switcher']);
    expect(targetContextSwitcher).toEqual([
      {"name": "Target", "to": "current@ROOT:console:target.adoc"},
      {"name": "Current", "to": "current@ROOT:console:source.adoc"}
    ]);
  });

  describe('input sanitization', () => {
    it('should handle invalid resource ID formats gracefully', async () => {
      const invalidPage = {
        src: {
          component: 'ROOT',
          version: 'current',
          module: 'console',
          relative: 'source.adoc',
          path: 'modules/console/pages/source.adoc'
        },
        asciidoc: {
          attributes: {
            'page-context-switcher': '[{"name": "Invalid", "to": "invalid-format"}]'
          }
        }
      };

      const testContentCatalog = {
        findBy: jest.fn(() => [invalidPage]),
        resolveResource: jest.fn(() => null)
      };

      extension.register.call(extensionContext, { config: {} });
      const handler = extensionContext.on.mock.calls[0][1];
      
      await handler({ contentCatalog: testContentCatalog });

      // Should warn about invalid resource ID format
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Invalid resource ID \'invalid-format\'')
      );
    });

    it('should handle empty and whitespace-only resource IDs', async () => {
      const emptyPage = {
        src: {
          component: 'ROOT',
          version: 'current',
          module: 'console',
          relative: 'source.adoc',
          path: 'modules/console/pages/source.adoc'
        },
        asciidoc: {
          attributes: {
            'page-context-switcher': '[{"name": "Empty", "to": ""}, {"name": "Whitespace", "to": "   "}]'
          }
        }
      };

      const testContentCatalog = {
        findBy: jest.fn(() => [emptyPage]),
        resolveResource: jest.fn(() => null)
      };

      extension.register.call(extensionContext, { config: {} });
      const handler = extensionContext.on.mock.calls[0][1];
      
      await handler({ contentCatalog: testContentCatalog });

      // Should warn about empty resource IDs
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Resource ID cannot be empty')
      );
    });

    it('should handle non-string resource IDs gracefully', async () => {
      const invalidTypePage = {
        src: {
          component: 'ROOT',
          version: 'current',
          module: 'console',
          relative: 'source.adoc',
          path: 'modules/console/pages/source.adoc'
        },
        asciidoc: {
          attributes: {
            'page-context-switcher': '[{"name": "Number", "to": 123}, {"name": "Null", "to": null}]'
          }
        }
      };

      const testContentCatalog = {
        findBy: jest.fn(() => [invalidTypePage]),
        resolveResource: jest.fn(() => null)
      };

      extension.register.call(extensionContext, { config: {} });
      const handler = extensionContext.on.mock.calls[0][1];
      
      await handler({ contentCatalog: testContentCatalog });

      // Should warn about non-string resource IDs
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Resource ID must be a non-empty string')
      );
    });

    it('should trim whitespace from resource IDs', async () => {
      const whitespaceTestPage = {
        src: {
          component: 'ROOT',
          version: 'current',
          module: 'console',
          relative: 'source.adoc',
          path: 'modules/console/pages/source.adoc'
        },
        asciidoc: {
          attributes: {
            'page-context-switcher': '[{"name": "Trimmed", "to": "  ROOT:console:target.adoc  "}]'
          }
        }
      };

      const targetPage = {
        src: {
          component: 'ROOT',
          version: 'current',
          module: 'console',
          relative: 'target.adoc',
          path: 'modules/console/pages/target.adoc'
        },
        asciidoc: {
          attributes: {}
        }
      };

      const testContentCatalog = {
        findBy: jest.fn(() => [whitespaceTestPage]),
        resolveResource: jest.fn((resourceId) => {
          // Should receive the trimmed and normalized resource ID
          if (resourceId === 'current@ROOT:console:target.adoc') {
            return targetPage;
          }
          return null;
        })
      };

      extension.register.call(extensionContext, { config: {} });
      const handler = extensionContext.on.mock.calls[0][1];
      
      await handler({ contentCatalog: testContentCatalog });

      // Should have successfully resolved the trimmed resource ID
      expect(testContentCatalog.resolveResource).toHaveBeenCalledWith(
        'current@ROOT:console:target.adoc',
        expect.any(Object)
      );
    });

    it('should validate resource ID format before processing', async () => {
      const malformedPage = {
        src: {
          component: 'ROOT',
          version: 'current',
          module: 'console',
          relative: 'source.adoc',
          path: 'modules/console/pages/source.adoc'
        },
        asciidoc: {
          attributes: {
            'page-context-switcher': '[{"name": "Malformed", "to": "missing-colons"}]'
          }
        }
      };

      const testContentCatalog = {
        findBy: jest.fn(() => [malformedPage]),
        resolveResource: jest.fn(() => null)
      };

      extension.register.call(extensionContext, { config: {} });
      const handler = extensionContext.on.mock.calls[0][1];
      
      await handler({ contentCatalog: testContentCatalog });

      // Should warn about invalid format
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Invalid resource ID format: \'missing-colons\'')
      );
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Expected format: [version@]component:module:path')
      );
    });
  });
});

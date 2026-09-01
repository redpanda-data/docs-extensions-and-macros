/**
 * @jest-environment node
 */

const { componentsWithExports } = require('../../extension-utils/llms-utils')

describe('componentsWithExports', () => {
  const components = [
    { name: 'streaming', title: 'Redpanda Streaming' },
    { name: 'data-platform', title: 'Data Platform' },
    { name: 'self-managed', title: 'Self-Managed' },
    { name: 'search', title: 'search' },
    { name: 'connect', title: 'Redpanda Connect' },
  ]

  it('returns only components that have at least one page', () => {
    const pages = [
      { src: { component: 'streaming' } },
      { src: { component: 'connect' } },
      { src: { component: 'streaming' } },
    ]
    expect(componentsWithExports(components, pages).map((c) => c.name)).toEqual([
      'streaming',
      'connect',
    ])
  })

  it('excludes corpus-less components so we never advertise a 404 export', () => {
    // data-platform / self-managed / search are landing/utility components with
    // no doc pages, so no `<name>-full.txt` file is generated for them.
    const pages = [{ src: { component: 'streaming' } }]
    const names = componentsWithExports(components, pages).map((c) => c.name)
    expect(names).not.toContain('data-platform')
    expect(names).not.toContain('self-managed')
    expect(names).not.toContain('search')
  })

  it('returns an empty array when there are no pages', () => {
    expect(componentsWithExports(components, [])).toEqual([])
  })

  it('ignores pages with missing src or component', () => {
    const pages = [{ src: { component: 'streaming' } }, {}, { src: {} }]
    expect(componentsWithExports(components, pages).map((c) => c.name)).toEqual([
      'streaming',
    ])
  })

  it('preserves the input component order', () => {
    const pages = [
      { src: { component: 'connect' } },
      { src: { component: 'streaming' } },
    ]
    expect(componentsWithExports(components, pages).map((c) => c.name)).toEqual([
      'streaming',
      'connect',
    ])
  })
})

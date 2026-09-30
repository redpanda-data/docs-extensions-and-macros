const { describe, it, expect } = require('@jest/globals')
const { _internal } = require('../../extensions/modify-connect-tag-playbook.js')

const { isConnectSource, toTag, pinConnectSource, filterConnectContent } = _internal

const connectOrigin = { url: 'https://github.com/redpanda-data/connect', startPath: 'docs' }
const docsOrigin = { url: 'https://github.com/redpanda-data/rp-connect-docs', startPath: '' }
const file = (path, origin) => ({ path, src: { path, origin } })

describe('modify-connect-tag-playbook', () => {
  describe('isConnectSource', () => {
    it('matches the connect repo and a local clone named connect', () => {
      expect(isConnectSource('https://github.com/redpanda-data/connect')).toBe(true)
      expect(isConnectSource('https://github.com/redpanda-data/connect.git')).toBe(true)
      expect(isConnectSource('/Users/me/repos/connect')).toBe(true)
    })
    it('does not match other repos', () => {
      expect(isConnectSource('https://github.com/redpanda-data/rp-connect-docs')).toBe(false)
      expect(isConnectSource('https://github.com/redpanda-data/connect-plugins')).toBe(false)
      expect(isConnectSource(undefined)).toBe(false)
    })
  })

  describe('toTag', () => {
    it('keeps a single v prefix', () => {
      expect(toTag('v4.110.0')).toBe('v4.110.0')
      expect(toTag('4.110.0')).toBe('v4.110.0')
      expect(toTag(null)).toBe(null)
    })
  })

  describe('pinConnectSource', () => {
    it('pins the remote connect source to the tag and clears branches', () => {
      const playbook = { content: { sources: [
        { url: 'https://github.com/redpanda-data/rp-connect-docs', branches: ['main'] },
        { url: 'https://github.com/redpanda-data/connect', tags: ['latest'], startPath: 'docs' },
      ] } }
      expect(pinConnectSource(playbook, 'v4.110.0')).toBe(true)
      expect(playbook.content.sources[1]).toMatchObject({ tags: ['v4.110.0'], branches: [] })
      expect(playbook.content.sources[0].branches).toEqual(['main'])
    })
    it('pins a source whose tags is the latest placeholder as a string', () => {
      const playbook = { content: { sources: [{ url: 'https://github.com/redpanda-data/connect', tags: 'latest' }] } }
      pinConnectSource(playbook, 'v4.110.0')
      expect(playbook.content.sources[0].tags).toEqual(['v4.110.0'])
    })
    it('leaves a source with explicit refs alone, such as a PR branch', () => {
      const source = { url: 'https://github.com/redpanda-data/connect', branches: ['docs/some-change'] }
      const playbook = { content: { sources: [source] } }
      expect(pinConnectSource(playbook, 'v4.110.0')).toBe(false)
      expect(playbook.content.sources[0]).toEqual({ url: 'https://github.com/redpanda-data/connect', branches: ['docs/some-change'] })
    })
    it('leaves a local clone alone', () => {
      const playbook = { content: { sources: [{ url: '/Users/me/repos/connect', branches: 'HEAD', tags: 'latest' }] } }
      expect(pinConnectSource(playbook, 'v4.110.0')).toBe(false)
      expect(playbook.content.sources[0]).toEqual({ url: '/Users/me/repos/connect', branches: 'HEAD', tags: 'latest' })
    })
  })

  describe('filterConnectContent', () => {
    it('keeps generated partials and examples that no other source provides', () => {
      const agg = [{ name: 'connect', files: [
        file('modules/components/partials/fields/inputs/kafka.adoc', connectOrigin),
        file('modules/components/examples/common/inputs/kafka.yaml', connectOrigin),
        file('modules/components/pages/inputs/kafka.adoc', docsOrigin),
      ], origins: [docsOrigin, connectOrigin] }]
      const report = filterConnectContent(agg)
      expect(agg[0].files).toHaveLength(3)
      expect(report).toMatchObject({ kept: 2, providedElsewhere: 0, outsideGenerated: 0 })
    })

    it('drops connect files that another source already provides', () => {
      const agg = [{ name: 'connect', files: [
        file('modules/components/partials/fields/inputs/kafka.adoc', docsOrigin),
        file('modules/components/partials/fields/inputs/kafka.adoc', connectOrigin),
      ], origins: [docsOrigin, connectOrigin] }]
      const report = filterConnectContent(agg)
      expect(agg[0].files.map((f) => f.src.origin)).toEqual([docsOrigin])
      expect(report.providedElsewhere).toBe(1)
    })

    it('drops connect pages and anything outside the generated trees', () => {
      const agg = [{ name: 'connect', files: [
        file('modules/components/pages/inputs/kafka.adoc', connectOrigin),
        file('modules/guides/pages/bloblang/functions.adoc', connectOrigin),
        file('modules/guides/pages/bloblang/functions.adoc', docsOrigin),
      ], origins: [docsOrigin, connectOrigin] }]
      const report = filterConnectContent(agg)
      expect(agg[0].files.map((f) => f.src.origin)).toEqual([docsOrigin])
      expect(report.outsideGenerated).toBe(2)
    })

    it('removes an older tag that registers its own redpanda-connect component', () => {
      const agg = [
        { name: 'connect', files: [file('modules/components/pages/about.adoc', docsOrigin)], origins: [docsOrigin] },
        { name: 'redpanda-connect', files: [file('modules/components/pages/inputs/kafka.adoc', connectOrigin)], origins: [connectOrigin] },
      ]
      const report = filterConnectContent(agg)
      expect(agg.map((b) => b.name)).toEqual(['connect'])
      expect(report.otherComponents).toBe(1)
    })

    it('leaves the aggregate untouched when there is no connect source', () => {
      const agg = [{ name: 'connect', files: [file('modules/components/pages/about.adoc', docsOrigin)], origins: [docsOrigin] }]
      expect(filterConnectContent(agg)).toMatchObject({ kept: 0, providedElsewhere: 0, outsideGenerated: 0, otherComponents: 0 })
      expect(agg[0].files).toHaveLength(1)
    })
  })
})

describe('highestStableTag', () => {
  const { highestStableTag } = require('../../extensions/modify-connect-tag-playbook.js')._internal
  it('picks the highest stable release and ignores prereleases', () => {
    const out = [
      'aaa\trefs/tags/v4.9.0',
      'bbb\trefs/tags/v4.110.0',
      'ccc\trefs/tags/v4.111.0-rc1',
      'ddd\trefs/tags/v4.100.2',
      'eee\trefs/tags/some-other-tag',
    ].join('\n')
    expect(highestStableTag(out)).toBe('v4.110.0')
  })
  it('returns null when there are no release tags', () => {
    expect(highestStableTag('')).toBe(null)
  })
})

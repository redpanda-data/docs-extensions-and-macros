const { describe, it, expect } = require('@jest/globals')
const { _internal } = require('../../extensions/modify-connect-tag-playbook.js')

const { isConnectSource, isRemote, redact, wantsLatest, toTag, removeLatestConnectSources, filterConnectContent } = _internal

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

  describe('wantsLatest', () => {
    const latest = (url, extra = {}) => wantsLatest({ url, tags: 'latest', ...extra })
    it('accepts the upstream repo over HTTPS and SSH', () => {
      expect(latest('https://github.com/redpanda-data/connect')).toBe(true)
      expect(latest('git@github.com:redpanda-data/connect.git')).toBe(true)
      expect(latest('ssh://git@github.com/redpanda-data/connect')).toBe(true)
    })
    it('rejects a fork, which has no releases of its own to pin to', () => {
      expect(latest('https://github.com/someone/connect')).toBe(false)
    })
    it('rejects latest combined with other refs', () => {
      expect(latest('https://github.com/redpanda-data/connect', { branches: ['docs/preview'] })).toBe(false)
      expect(wantsLatest({ url: 'https://github.com/redpanda-data/connect', tags: ['latest', 'v4.110.0'] })).toBe(false)
      expect(latest('https://github.com/redpanda-data/connect', { branches: [] })).toBe(true)
    })
  })

  describe('isRemote', () => {
    it('treats HTTPS, SSH, and scp-style URLs as remote and paths as local', () => {
      expect(isRemote('https://github.com/redpanda-data/connect')).toBe(true)
      expect(isRemote('ssh://git@github.com/redpanda-data/connect')).toBe(true)
      expect(isRemote('git@github.com:redpanda-data/connect')).toBe(true)
      expect(isRemote('/Users/me/repos/connect')).toBe(false)
      expect(isRemote('./connect')).toBe(false)
    })
  })

  describe('redact', () => {
    it('removes credentials from every URL in a message', () => {
      const msg = 'git ls-remote of https://x-access-token:s3cret@github.com/redpanda-data/connect failed: fatal: https://x-access-token:s3cret@github.com/redpanda-data/connect not found'
      expect(redact(msg)).not.toMatch(/s3cret/)
      expect(redact(msg)).toContain('https://github.com/redpanda-data/connect')
    })
  })

  describe('toTag', () => {
    it('keeps a single v prefix', () => {
      expect(toTag('v4.110.0')).toBe('v4.110.0')
      expect(toTag('4.110.0')).toBe('v4.110.0')
      expect(toTag(null)).toBe(null)
    })
  })

  describe('removeLatestConnectSources', () => {
    it('removes the upstream connect source with tags: latest and keeps the rest', () => {
      const docs = { url: 'https://github.com/redpanda-data/rp-connect-docs', branches: ['main'] }
      const sources = [
        { url: 'https://github.com/redpanda-data/connect', tags: ['latest'], startPath: 'docs' },
        docs,
        { url: 'git@github.com:redpanda-data/connect.git', tags: 'latest' },
      ]
      const playbook = { content: { sources } }
      expect(removeLatestConnectSources(playbook).map((s) => s.url)).toEqual(['https://github.com/redpanda-data/connect', 'git@github.com:redpanda-data/connect.git'])
      // In place, so anything holding the list sees the change.
      expect(playbook.content.sources).toBe(sources)
      expect(sources).toEqual([docs])
    })
    it('keeps a source with explicit refs, such as a PR branch or a specific tag', () => {
      const sources = [
        { url: 'https://github.com/redpanda-data/connect', branches: ['docs/some-change'] },
        { url: 'https://github.com/redpanda-data/connect', tags: ['v4.110.0'] },
        { url: 'https://github.com/redpanda-data/connect', tags: 'latest', branches: ['main'] },
      ]
      expect(removeLatestConnectSources({ content: { sources } })).toEqual([])
      expect(sources).toHaveLength(3)
    })
    it('keeps a fork and a local clone', () => {
      const sources = [
        { url: 'https://github.com/someone/connect', tags: 'latest' },
        { url: '/Users/me/repos/connect', branches: 'HEAD', tags: 'latest' },
      ]
      expect(removeLatestConnectSources({ content: { sources } })).toEqual([])
      expect(sources).toHaveLength(2)
    })
    it('tolerates a playbook without sources', () => {
      expect(removeLatestConnectSources({})).toEqual([])
      expect(removeLatestConnectSources(undefined)).toEqual([])
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

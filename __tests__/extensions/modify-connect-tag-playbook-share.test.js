const { describe, it, expect } = require('@jest/globals')

// The GitHub API lookup and the git fallback both return v4.111.1, so the
// test does not depend on which one the extension reaches.
jest.mock('../../extensions/version-fetcher/get-latest-connect', () => jest.fn(async () => '4.111.1'))
jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  execFileSync: jest.fn(() => 'abc\trefs/tags/v4.111.1\n')
}))

const catalogUtil = require('../../extensions/util/connect-catalog')
const ext = require('../../extensions/modify-connect-tag-playbook.js')

function start (sources) {
  const handlers = {}
  const noop = () => {}
  const ctx = {
    getLogger: () => ({ info: noop, warn: noop, error: noop, debug: noop }),
    on: (event, fn) => { handlers[event] = fn },
    updateVariables: noop
  }
  ext.register.call(ctx, { config: {} })
  const playbook = { content: { sources } }
  return handlers.contextStarted({ playbook }).then(() => playbook)
}

describe('modify-connect-tag-playbook shares the resolved ref', () => {
  it('shares the tag it pins the connect source to', async () => {
    catalogUtil.setResolvedConnectRef(null)
    const playbook = await start([{ url: 'https://github.com/redpanda-data/connect', tags: 'latest', start_path: 'docs' }])
    expect(playbook.content.sources[0].tags).toEqual(['v4.111.1'])
    expect(catalogUtil.getResolvedConnectRef()).toBe('v4.111.1')
  })

  it('clears a ref left from an earlier build when the playbook pins nothing', async () => {
    catalogUtil.setResolvedConnectRef('v4.100.0')
    await start([{ url: 'https://github.com/redpanda-data/connect', branches: 'my-fix', start_path: 'docs' }])
    expect(catalogUtil.getResolvedConnectRef()).toBeNull()
  })
})

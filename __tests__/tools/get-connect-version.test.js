'use strict'

jest.mock('../../cli-utils/octokit-client', () => ({ fake: 'octokit' }))
jest.mock('../../extensions/version-fetcher/get-latest-connect')

const getLatestConnect = require('../../extensions/version-fetcher/get-latest-connect')
const getConnectVersion = require('../../tools/get-connect-version')

describe('get-connect-version', () => {
  let log, error, exit

  beforeEach(() => {
    log = jest.spyOn(console, 'log').mockImplementation(() => {})
    error = jest.spyOn(console, 'error').mockImplementation(() => {})
    exit = jest.spyOn(process, 'exit').mockImplementation((code) => { throw new Error(`exit ${code}`) })
  })

  afterEach(() => jest.restoreAllMocks())

  test('prints only the version, without the leading v', async () => {
    getLatestConnect.mockResolvedValue('v4.110.0')
    await getConnectVersion()
    expect(getLatestConnect).toHaveBeenCalledWith({ fake: 'octokit' }, 'redpanda-data', 'connect')
    expect(log).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith('4.110.0')
  })

  test('leaves a tag that has no leading v as is', async () => {
    getLatestConnect.mockResolvedValue('4.110.0')
    await getConnectVersion()
    expect(log).toHaveBeenCalledWith('4.110.0')
  })

  test('exits 1 and prints nothing to stdout when no release is found', async () => {
    getLatestConnect.mockResolvedValue(null)
    await expect(getConnectVersion()).rejects.toThrow('exit 1')
    expect(exit).toHaveBeenCalledWith(1)
    expect(log).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalled()
  })
})

const fetchHelmChartIndex = require('../../../extensions/version-fetcher/fetch-helm-chart-index')

describe('fetchHelmChartIndex', () => {
  const realFetch = global.fetch
  afterEach(() => { global.fetch = realFetch })

  const respond = (status, body) => {
    global.fetch = jest.fn().mockResolvedValue({ ok: status === 200, status, text: async () => body })
  }

  it('returns every version of the redpanda chart', async () => {
    respond(200, [
      'apiVersion: v1',
      'entries:',
      '  console:',
      '  - version: 3.1.0',
      '  redpanda:',
      '  - version: 26.2.6',
      '  - version: 26.2.5',
      '  - name: missing-version',
    ].join('\n'))

    expect(await fetchHelmChartIndex()).toEqual(['26.2.6', '26.2.5'])
    expect(global.fetch).toHaveBeenCalledWith('https://charts.redpanda.com/index.yaml', expect.any(Object))
  })

  it('returns null and warns when the index cannot be read', async () => {
    respond(503, '')
    const logger = { warn: jest.fn() }

    expect(await fetchHelmChartIndex({ logger })).toBeNull()
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/HTTP 503/))
  })

  it('returns null when the index has no redpanda chart', async () => {
    respond(200, 'apiVersion: v1\nentries:\n  console:\n  - version: 3.1.0\n')
    const logger = { warn: jest.fn() }

    expect(await fetchHelmChartIndex({ logger })).toBeNull()
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/no "redpanda" chart/))
  })

  it('returns null when the request fails', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND'))
    const logger = { warn: jest.fn() }

    expect(await fetchHelmChartIndex({ logger })).toBeNull()
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/ENOTFOUND/))
  })
})

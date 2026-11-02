const getLatestHelmVersion = require('../../../extensions/version-fetcher/get-latest-redpanda-helm-version-from-operator');

describe('getLatestHelmVersion', () => {
  let mockGithub;

  beforeEach(() => {
    mockGithub = {
      repos: {
        getContent: jest.fn()
      },
      git: {
        // No published chart tags unless a test lists some, so these tests
        // exercise the Chart.yaml fallback.
        listMatchingRefs: jest.fn().mockResolvedValue({ data: [] })
      }
    };
  });

  it('should fetch stable helm chart version from release branch', async () => {
    // Mock the GitHub API response
    const mockChartYaml = `
apiVersion: v2
name: redpanda
version: 5.9.7
description: Redpanda is a streaming data platform
`;

    mockGithub.repos.getContent.mockResolvedValue({
      data: {
        content: Buffer.from(mockChartYaml).toString('base64')
      }
    });

    const result = await getLatestHelmVersion(
      mockGithub,
      'redpanda-data',
      'redpanda-operator',
      'v25.1.3',
      null
    );

    expect(result.latestStableRelease).toBe('5.9.7');
    expect(result.latestBetaRelease).toBeNull();
    expect(mockGithub.repos.getContent).toHaveBeenCalledWith({
      owner: 'redpanda-data',
      repo: 'redpanda-operator',
      path: 'charts/redpanda/chart/Chart.yaml',
      ref: 'release/v25.1.x'
    });
  });

  it('should fetch both stable and beta helm chart versions', async () => {
    const mockStableChart = `
apiVersion: v2
name: redpanda
version: 5.9.7
`;

    const mockBetaChart = `
apiVersion: v2
name: redpanda
version: 5.10.0-beta1
`;

    // The stable and beta lookups run in parallel, so answer by branch
    // rather than by call order.
    mockGithub.repos.getContent.mockImplementation(async ({ ref }) => ({
      data: { content: Buffer.from(ref === 'release/v25.1.x' ? mockStableChart : mockBetaChart).toString('base64') }
    }));

    const result = await getLatestHelmVersion(
      mockGithub,
      'redpanda-data',
      'redpanda-operator',
      'v25.1.3',
      'v25.2.1-beta1'
    );

    expect(result.latestStableRelease).toBe('5.9.7');
    expect(result.latestBetaRelease).toBe('5.10.0-beta1');
    expect(mockGithub.repos.getContent).toHaveBeenCalledTimes(2);
  });

  it('should handle older version format (v2.x.x)', async () => {
    const mockChartYaml = `
apiVersion: v2
name: redpanda
version: 2.4.5
`;

    mockGithub.repos.getContent.mockResolvedValue({
      data: { content: Buffer.from(mockChartYaml).toString('base64') }
    });

    const result = await getLatestHelmVersion(
      mockGithub,
      'redpanda-data',
      'redpanda-operator',
      'v2.4.2',
      null
    );

    expect(result.latestStableRelease).toBe('2.4.5');
    expect(mockGithub.repos.getContent).toHaveBeenCalledWith({
      owner: 'redpanda-data',
      repo: 'redpanda-operator',
      path: 'charts/redpanda/chart/Chart.yaml',
      ref: 'release/v2.4.x'
    });
  });

  it('should handle invalid docker tag format', async () => {
    const result = await getLatestHelmVersion(
      mockGithub,
      'redpanda-data',
      'redpanda-operator',
      'invalid-tag',
      null
    );

    expect(result.latestStableRelease).toBeNull();
    expect(result.latestBetaRelease).toBeNull();
    expect(mockGithub.repos.getContent).not.toHaveBeenCalled();
  });

  it('should handle GitHub API errors gracefully', async () => {
    mockGithub.repos.getContent.mockRejectedValue(
      new Error('Branch not found')
    );

    const result = await getLatestHelmVersion(
      mockGithub,
      'redpanda-data',
      'redpanda-operator',
      'v25.1.3',
      null
    );

    expect(result.latestStableRelease).toBeNull();
    expect(result.latestBetaRelease).toBeNull();
  });

  it('should handle missing version in Chart.yaml', async () => {
    const mockChartYaml = `
apiVersion: v2
name: redpanda
description: No version field
`;

    mockGithub.repos.getContent.mockResolvedValue({
      data: { content: Buffer.from(mockChartYaml).toString('base64') }
    });

    const result = await getLatestHelmVersion(
      mockGithub,
      'redpanda-data',
      'redpanda-operator',
      'v25.1.3',
      null
    );

    expect(result.latestStableRelease).toBeNull();
  });

  it('should handle beta tag with -beta suffix', async () => {
    const mockChartYaml = `
apiVersion: v2
name: redpanda
version: 5.10.0-beta1
`;

    mockGithub.repos.getContent.mockResolvedValue({
      data: { content: Buffer.from(mockChartYaml).toString('base64') }
    });

    const result = await getLatestHelmVersion(
      mockGithub,
      'redpanda-data',
      'redpanda-operator',
      null,
      'v25.2.1-beta1'
    );

    expect(result.latestStableRelease).toBeNull();
    expect(result.latestBetaRelease).toBe('5.10.0-beta1');
    expect(mockGithub.repos.getContent).toHaveBeenCalledWith({
      owner: 'redpanda-data',
      repo: 'redpanda-operator',
      path: 'charts/redpanda/chart/Chart.yaml',
      ref: 'release/v25.2.x'
    });
  });

  it('should handle null/undefined dockerTag parameters', async () => {
    const result = await getLatestHelmVersion(
      mockGithub,
      'redpanda-data',
      'redpanda-operator',
      null,
      null
    );

    expect(result.latestStableRelease).toBeNull();
    expect(result.latestBetaRelease).toBeNull();
    expect(mockGithub.repos.getContent).not.toHaveBeenCalled();
  });

  describe('published chart tags and chart paths per release line', () => {
    const notFound = () => Object.assign(new Error('Not Found'), { status: 404 });
    const chartYaml = (version) => ({
      data: { content: Buffer.from(`apiVersion: v2\nname: redpanda\nversion: ${version}\n`).toString('base64') }
    });
    const refs = (...tags) => ({ data: tags.map((tag) => ({ ref: `refs/tags/charts/redpanda/${tag}` })) });

    it('uses the newest stable published chart tag of the line, not the branch Chart.yaml', async () => {
      // release/v25.1.x has Chart.yaml at 25.1.4, but only 25.1.3 was
      // published, so `helm install --version 25.1.4` would fail.
      mockGithub.git.listMatchingRefs.mockResolvedValue(
        refs('v25.1.1', 'v25.1.1-beta1', 'v25.1.3', 'v25.1.2', 'v25.1.10-beta1')
      );
      mockGithub.repos.getContent.mockResolvedValue(chartYaml('25.1.4'));

      const result = await getLatestHelmVersion(mockGithub, 'redpanda-data', 'redpanda-operator', 'v25.1.4', null);

      expect(result.latestStableRelease).toBe('25.1.3');
      expect(mockGithub.git.listMatchingRefs).toHaveBeenCalledWith({
        owner: 'redpanda-data',
        repo: 'redpanda-operator',
        ref: 'tags/charts/redpanda/v25.1.'
      });
      expect(mockGithub.repos.getContent).not.toHaveBeenCalled();
    });

    it('ignores tags of another line that share the prefix', async () => {
      // tags/charts/redpanda/v2.1. also matches v2.10.x and v2.11.x in some
      // ref APIs; only the asked line counts.
      mockGithub.git.listMatchingRefs.mockResolvedValue(refs('v2.1.4', 'v2.10.9'));

      const result = await getLatestHelmVersion(mockGithub, 'redpanda-data', 'redpanda-operator', 'v2.1.3', null);

      expect(result.latestStableRelease).toBe('2.1.4');
    });

    it('falls back to charts/redpanda/Chart.yaml when the line has no tag and the newer path is missing', async () => {
      // The release/v25.1.x layout: no charts/redpanda/chart/ directory.
      mockGithub.repos.getContent.mockImplementation(async ({ path }) => {
        if (path === 'charts/redpanda/Chart.yaml') return chartYaml('25.1.4');
        throw notFound();
      });
      const logger = { warn: jest.fn(), error: jest.fn() };

      const result = await getLatestHelmVersion(mockGithub, 'redpanda-data', 'redpanda-operator', 'v25.1.4', null, logger);

      expect(result.latestStableRelease).toBe('25.1.4');
      expect(mockGithub.repos.getContent.mock.calls.map(([args]) => args.path)).toEqual([
        'charts/redpanda/chart/Chart.yaml',
        'charts/redpanda/Chart.yaml'
      ]);
      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('falls back to the branch when listing tags fails', async () => {
      mockGithub.git.listMatchingRefs.mockRejectedValue(new Error('rate limited'));
      mockGithub.repos.getContent.mockResolvedValue(chartYaml('25.3.11'));
      const logger = { warn: jest.fn(), error: jest.fn() };

      const result = await getLatestHelmVersion(mockGithub, 'redpanda-data', 'redpanda-operator', 'v25.3.10', null, logger);

      expect(result.latestStableRelease).toBe('25.3.11');
      expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/Could not list charts\/redpanda\/v25\.3\.\* tags/));
    });

    it('returns null and names every path it tried when no chart exists', async () => {
      mockGithub.repos.getContent.mockRejectedValue(notFound());
      const logger = { warn: jest.fn(), error: jest.fn() };

      const result = await getLatestHelmVersion(mockGithub, 'redpanda-data', 'redpanda-operator', 'v25.1.4', null, logger);

      expect(result.latestStableRelease).toBeNull();
      expect(logger.warn).toHaveBeenCalledTimes(1);
      const [message] = logger.warn.mock.calls[0];
      expect(message).toMatch(/no charts\/redpanda\/chart\/Chart\.yaml or charts\/redpanda\/Chart\.yaml on branch release\/v25\.1\.x/);
      expect(message).not.toMatch(/branch release\/v25\.1\.x not found/);
    });

    it('reads beta charts from the branch, not from tags', async () => {
      mockGithub.git.listMatchingRefs.mockResolvedValue(refs('v26.3.1'));
      mockGithub.repos.getContent.mockResolvedValue(chartYaml('26.3.1-beta1'));

      const result = await getLatestHelmVersion(mockGithub, 'redpanda-data', 'redpanda-operator', null, 'v26.3.1-beta1');

      expect(result.latestBetaRelease).toBe('26.3.1-beta1');
      expect(mockGithub.git.listMatchingRefs).not.toHaveBeenCalled();
    });
  });
});

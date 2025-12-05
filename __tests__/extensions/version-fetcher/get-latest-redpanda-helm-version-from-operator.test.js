const getLatestHelmVersion = require('../../../extensions/version-fetcher/get-latest-redpanda-helm-version-from-operator');

describe('getLatestHelmVersion', () => {
  let mockGithub;

  beforeEach(() => {
    mockGithub = {
      repos: {
        getContent: jest.fn()
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

    mockGithub.repos.getContent
      .mockResolvedValueOnce({
        data: { content: Buffer.from(mockStableChart).toString('base64') }
      })
      .mockResolvedValueOnce({
        data: { content: Buffer.from(mockBetaChart).toString('base64') }
      });

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
});

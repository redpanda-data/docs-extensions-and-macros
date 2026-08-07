const {
  getGitHubToken,
  getTokenFromGitCredentials,
  getAuthenticatedGitHubUrl
} = require('../../cli-utils/github-token');

const TOKEN_VARS = [
  'GIT_CREDENTIALS',
  'REDPANDA_GITHUB_TOKEN',
  'ACTIONS_BOT_TOKEN',
  'GITHUB_TOKEN',
  'VBOT_GITHUB_API_TOKEN',
  'GH_TOKEN'
];

describe('github-token', () => {
  const savedEnv = {};

  beforeEach(() => {
    for (const name of TOKEN_VARS) {
      savedEnv[name] = process.env[name];
      delete process.env[name];
    }
  });

  afterEach(() => {
    for (const name of TOKEN_VARS) {
      if (savedEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[name];
    }
  });

  describe('getTokenFromGitCredentials', () => {
    it('extracts a token in the username position (Antora GitHub form)', () => {
      expect(getTokenFromGitCredentials('https://github_pat_abc123:@github.com')).toBe('github_pat_abc123');
    });

    it('extracts a token without the trailing colon', () => {
      expect(getTokenFromGitCredentials('https://ghp_abc123@github.com')).toBe('ghp_abc123');
    });

    it('extracts a token in the password position', () => {
      expect(getTokenFromGitCredentials('https://x-access-token:ghs_abc123@github.com')).toBe('ghs_abc123');
    });

    it('honors a repository-path entry', () => {
      expect(getTokenFromGitCredentials('https://ghp_abc123:@github.com/org/repo')).toBe('ghp_abc123');
    });

    it('picks the github.com entry from a comma-separated list', () => {
      const creds = 'https://oauth2:glpat-xyz@gitlab.com,https://ghp_abc123:@github.com';
      expect(getTokenFromGitCredentials(creds)).toBe('ghp_abc123');
    });

    it('picks the github.com entry from a newline-separated list', () => {
      const creds = 'https://oauth2:glpat-xyz@gitlab.com\nhttps://ghp_abc123:@github.com';
      expect(getTokenFromGitCredentials(creds)).toBe('ghp_abc123');
    });

    it('percent-decodes the token', () => {
      expect(getTokenFromGitCredentials('https://user:p%40ss@github.com')).toBe('p@ss');
    });

    it('returns null for non-github hosts', () => {
      expect(getTokenFromGitCredentials('https://oauth2:glpat-xyz@gitlab.com')).toBeNull();
    });

    it('returns null when unset', () => {
      expect(getTokenFromGitCredentials(undefined)).toBeNull();
      expect(getTokenFromGitCredentials('')).toBeNull();
    });
  });

  describe('getGitHubToken', () => {
    it('prefers GIT_CREDENTIALS over other token variables', () => {
      process.env.GIT_CREDENTIALS = 'https://from-git-credentials:@github.com';
      process.env.REDPANDA_GITHUB_TOKEN = 'from-redpanda-var';
      expect(getGitHubToken()).toBe('from-git-credentials');
    });

    it('falls back to REDPANDA_GITHUB_TOKEN when GIT_CREDENTIALS is unset', () => {
      process.env.REDPANDA_GITHUB_TOKEN = 'from-redpanda-var';
      expect(getGitHubToken()).toBe('from-redpanda-var');
    });

    it('ignores GIT_CREDENTIALS entries for other hosts', () => {
      process.env.GIT_CREDENTIALS = 'https://oauth2:glpat-xyz@gitlab.com';
      process.env.GH_TOKEN = 'from-gh-var';
      expect(getGitHubToken()).toBe('from-gh-var');
    });

    it('returns null when no source is set', () => {
      expect(getGitHubToken()).toBeNull();
    });
  });

  describe('getAuthenticatedGitHubUrl', () => {
    it('injects the resolved token into a github.com URL', () => {
      process.env.GIT_CREDENTIALS = 'https://ghp_abc123:@github.com';
      expect(getAuthenticatedGitHubUrl('https://github.com/org/repo.git')).toBe('https://ghp_abc123@github.com/org/repo.git');
    });

    it('returns the URL unchanged when no token is available', () => {
      expect(getAuthenticatedGitHubUrl('https://github.com/org/repo.git')).toBe('https://github.com/org/repo.git');
    });
  });
});

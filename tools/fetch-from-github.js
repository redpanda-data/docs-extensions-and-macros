const fs = require('fs');
const path = require('path');

let octokitInstance = null;
async function loadOctokit() {
  if (!octokitInstance) {
    const { Octokit } = await import('@octokit/rest');
    octokitInstance = process.env.VBOT_GITHUB_API_TOKEN
      ? new Octokit({
          auth: process.env.VBOT_GITHUB_API_TOKEN,
        })
      : new Octokit();

    if (!process.env.VBOT_GITHUB_API_TOKEN) {
      console.warn(
        'Warning: No GitHub token found (VBOT_GITHUB_API_TOKEN). API rate limits will be restricted.'
      );
    }
  }
  return octokitInstance;
}

async function saveFile(content, saveDir, filename) {
  await fs.promises.mkdir(saveDir, { recursive: true });
  const target = path.join(saveDir, filename);
  await fs.promises.writeFile(target, content);
  console.log(`Saved: ${target}`);
}

async function fetchFromGithub(owner, repo, remotePath, saveDir, customFilename) {
  const octokit = await loadOctokit();

  try {
    const resp = await octokit.repos.getContent({ owner, repo, path: remotePath });
    if (Array.isArray(resp.data)) {
      // directory
      for (const item of resp.data) {
        if (item.type === 'file') {
          await fetchFromGithub(owner, repo, item.path, saveDir, customFilename);
        } else if (item.type === 'dir') {
          // For directories, maintain the directory structure
          const nestedDir = path.join(saveDir, path.basename(item.path));
          await fetchFromGithub(owner, repo, item.path, nestedDir);
        }
      }
    } else {
      // single file
      const content = Buffer.from(resp.data.content, 'base64').toString();
      const filename = customFilename || path.basename(resp.data.path);
      await saveFile(content, saveDir, filename);
    }
  } catch (error) {
    if (error.status === 403 && error.message.includes('rate limit')) {
      throw new Error(`GitHub API rate limit exceeded. Consider using a token via VBOT_GITHUB_API_TOKEN environment variable.`);
    } else if (error.status === 404) {
      throw new Error(`Path not found: ${remotePath} in ${owner}/${repo}`);
    } else {
      throw new Error(`Failed to fetch from GitHub: ${error.message}`);
    }
  }
}

module.exports = fetchFromGithub

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

  const resp = await octokit.repos.getContent({ owner, repo, path: remotePath });
  if (Array.isArray(resp.data)) {
    // directory
    for (const file of resp.data.filter(f => f.type === 'file')) {
      await fetchFromGithub(owner, repo, file.path, saveDir, customFilename);
    }
  } else {
    // single file
    const content = Buffer.from(resp.data.content, 'base64').toString();
    const filename = customFilename || path.basename(resp.data.path);
    await saveFile(content, saveDir, filename);
  }
}

module.exports = fetchFromGithub

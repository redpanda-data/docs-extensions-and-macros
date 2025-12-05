/**
 * MCP Tools - Antora Structure
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { MAX_RECURSION_DEPTH, DEFAULT_SKIP_DIRS, PLAYBOOK_NAMES } = require('./utils');

/**
 * Get Antora structure information for the current repository
 * @param {string|{root: string, detected: boolean, type: string|null}} repoRoot - Repository root path or info object
 * @param {string[]} [skipDirs=DEFAULT_SKIP_DIRS] - Directories to skip during search
 * @returns {Object} Antora structure information
 */
function getAntoraStructure(repoRoot, skipDirs = DEFAULT_SKIP_DIRS) {
  const rootPath = typeof repoRoot === 'string' ? repoRoot : repoRoot.root;
  const repoInfo = typeof repoRoot === 'object' ? repoRoot : { root: repoRoot, detected: true, type: null };

  const playbookPath = PLAYBOOK_NAMES
    .map(name => path.join(rootPath, name))
    .find(p => fs.existsSync(p));

  let playbookContent = null;
  if (playbookPath) {
    try {
      playbookContent = yaml.load(fs.readFileSync(playbookPath, 'utf8'));
    } catch (err) {
      console.error(`Warning: Failed to parse playbook at ${playbookPath}: ${err.message}`);
    }
  }

  const antoraYmls = [];
  const findAntoraYmls = (dir, depth = 0, visited = new Set()) => {
    if (depth > MAX_RECURSION_DEPTH || !fs.existsSync(dir)) return;

    try {
      const realPath = fs.realpathSync(dir);
      if (visited.has(realPath)) return;
      visited.add(realPath);

      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (skipDirs.includes(entry.name)) continue;

        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          findAntoraYmls(fullPath, depth + 1, visited);
        } else if (entry.name === 'antora.yml') {
          antoraYmls.push(fullPath);
        }
      }
    } catch (err) {
      console.error(`Warning: Failed to read directory ${dir}: ${err.message}`);
    }
  };
  findAntoraYmls(rootPath);

  const components = antoraYmls.map(ymlPath => {
    try {
      const content = yaml.load(fs.readFileSync(ymlPath, 'utf8'));
      const componentDir = path.dirname(ymlPath);
      const modulesDir = path.join(componentDir, 'modules');
      const modules = fs.existsSync(modulesDir)
        ? fs.readdirSync(modulesDir).filter(m => {
            const stat = fs.statSync(path.join(modulesDir, m));
            return stat.isDirectory();
          })
        : [];

      return {
        name: content.name,
        version: content.version,
        title: content.title,
        path: componentDir,
        modules: modules.map(moduleName => {
          const modulePath = path.join(modulesDir, moduleName);
          return {
            name: moduleName,
            path: modulePath,
            pages: fs.existsSync(path.join(modulePath, 'pages')),
            partials: fs.existsSync(path.join(modulePath, 'partials')),
            examples: fs.existsSync(path.join(modulePath, 'examples')),
            attachments: fs.existsSync(path.join(modulePath, 'attachments')),
            images: fs.existsSync(path.join(modulePath, 'images')),
          };
        }),
      };
    } catch (err) {
      return { error: `Failed to parse ${ymlPath}: ${err.message}` };
    }
  });

  return {
    repoRoot: rootPath,
    repoInfo,
    playbook: playbookContent,
    playbookPath,
    components,
    hasDocTools: (() => {
      // Check if we're in the source repo (docs-extensions-and-macros)
      if (fs.existsSync(path.join(rootPath, 'bin', 'doc-tools.js'))) {
        return true;
      }

      // Check if doc-tools is available via npx or as installed dependency
      try {
        const { execSync } = require('child_process');
        execSync('npx doc-tools --version', {
          stdio: 'ignore',
          timeout: 5000,
          cwd: rootPath
        });
        return true;
      } catch {
        return false;
      }
    })()
  };
}

module.exports = {
  getAntoraStructure
};

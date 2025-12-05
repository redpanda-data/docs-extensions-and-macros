/**
 * Cross-platform MCP Server Setup Utility
 *
 * Configures the Redpanda Docs MCP server for Claude Code across
 * macOS, Linux, and Windows platforms using the 'claude mcp add' command.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const chalk = require('chalk');
const { execSync } = require('child_process');

/**
 * Detect the operating system
 */
function detectOS() {
  const platform = os.platform();
  switch (platform) {
    case 'darwin':
      return 'macOS';
    case 'linux':
      return 'Linux';
    case 'win32':
      return 'Windows';
    default:
      return platform;
  }
}

/**
 * Get Claude Code config file path
 * Claude Code uses ~/.claude.json for configuration
 */
function getConfigPath() {
  return path.join(os.homedir(), '.claude.json');
}

/**
 * Check if config file exists
 */
function configExists() {
  return fs.existsSync(getConfigPath());
}

/**
 * Read and parse JSON config file
 */
function readConfig(configPath) {
  try {
    const content = fs.readFileSync(configPath, 'utf8');
    return JSON.parse(content);
  } catch (err) {
    throw new Error(`Failed to read config: ${err.message}`);
  }
}

/**
 * Check if MCP server is already configured
 */
function isMCPServerConfigured(config, serverName = 'redpanda-docs-tool-assistant') {
  return config.mcpServers && config.mcpServers[serverName];
}

/**
 * Get the absolute path to the MCP server script
 */
function getMCPServerPath() {
  // Find repo root by looking for package.json
  let currentDir = __dirname;
  while (currentDir !== path.parse(currentDir).root) {
    if (fs.existsSync(path.join(currentDir, 'package.json'))) {
      const mcpServerPath = path.join(currentDir, 'bin', 'doc-tools-mcp.js');
      if (fs.existsSync(mcpServerPath)) {
        return mcpServerPath;
      }
    }
    currentDir = path.dirname(currentDir);
  }

  throw new Error('Could not find doc-tools-mcp.js. Make sure you are running this from the docs-extensions-and-macros repository.');
}

/**
 * Main setup function using 'claude mcp add' CLI command
 */
async function setupMCP(options = {}) {
  const { force = false, target = 'auto', local = false } = options;

  console.log(chalk.blue('\n🚀 Redpanda Doc Tools MCP Server Setup\n'));
  console.log(chalk.gray(`Platform: ${detectOS()}`));
  console.log(chalk.gray(`Node: ${process.version}\n`));

  // Determine mode: local development or npx
  let mode = 'npx';
  let localPath = null;
  const packageName = '@redpanda-data/docs-extensions-and-macros';
  let packageVersion = 'unknown';

  // Only check for local installation if --local flag is set
  if (local) {
    try {
      const mcpServerPath = getMCPServerPath();
      localPath = mcpServerPath;
      const packageJsonPath = path.join(path.dirname(path.dirname(mcpServerPath)), 'package.json');
      if (fs.existsSync(packageJsonPath)) {
        const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        packageVersion = pkg.version;
      }
      mode = 'local';
    } catch (err) {
      console.error(chalk.red('✗') + ' --local flag requires running from docs-extensions-and-macros repository');
      return { success: false, error: 'Not in local repository' };
    }
  }

  if (mode === 'local') {
    console.log(chalk.green('✓') + ` Mode: ${chalk.cyan('Local Development')}`);
    console.log(chalk.gray(`  Path: ${localPath}`));
    console.log(chalk.gray(`  Version: ${packageVersion}\n`));
  } else {
    console.log(chalk.green('✓') + ` Mode: ${chalk.cyan('NPX (Published Package)')}`);
    console.log(chalk.gray(`  Package: ${packageName}`));
    console.log(chalk.gray(`  Using npx to run from node_modules or npm\n`));
  }

  // Check if MCP server is already configured
  const configPath = getConfigPath();
  let alreadyConfigured = false;
  let needsUpdate = false;

  if (configExists()) {
    try {
      const config = readConfig(configPath);
      alreadyConfigured = isMCPServerConfigured(config);

      if (alreadyConfigured) {
        const existingConfig = config.mcpServers['redpanda-doc-tools-assistant'];
        const existingCommand = existingConfig.command;
        const existingArgs = existingConfig.args || [];

        // Check if configuration matches desired mode
        const isCorrectNpxConfig = mode === 'npx' && existingCommand === 'npx' &&
                                    existingArgs.includes('doc-tools-mcp');
        const isCorrectLocalConfig = mode === 'local' && existingCommand === 'node' &&
                                      existingArgs[0] === localPath;

        if (!isCorrectNpxConfig && !isCorrectLocalConfig) {
          needsUpdate = true;
          console.log(chalk.yellow('⚠ ') + ' MCP server configured but with different setup:');
          console.log(chalk.gray(`  Current: ${existingCommand} ${existingArgs.join(' ')}`));
          const newSetup = mode === 'local' ? `node ${localPath}` : 'npx -y doc-tools-mcp';
          console.log(chalk.gray(`  New:     ${newSetup}\n`));
        } else {
          console.log(chalk.green('✓') + ` MCP server already configured correctly\n`);
          if (!force) {
            return {
              success: true,
              configPath,
              configType: 'Claude Code',
              action: 'already-configured',
              mode
            };
          }
        }
      }
    } catch (err) {
      console.log(chalk.yellow('⚠ ') + ` Could not read config: ${err.message}`);
    }
  }

  if (alreadyConfigured && !needsUpdate && !force) {
    console.log(chalk.blue('ℹ') + '  Use --force to reconfigure\n');
    return {
      success: true,
      configPath,
      configType: 'Claude Code',
      action: 'already-configured',
      mode
    };
  }

  // Build the claude mcp add command
  const serverName = 'redpanda-docs-tool-assistant';

  // If server exists and we're updating, remove it first
  if (alreadyConfigured && (needsUpdate || force)) {
    try {
      console.log(chalk.gray(`Removing existing MCP server: ${serverName}\n`));
      execSync(`claude mcp remove --scope user ${serverName}`, { stdio: 'pipe' });
    } catch (err) {
      console.log(chalk.yellow('⚠ ') + ` Could not remove existing server (may not exist): ${err.message}`);
    }
  }

  let command;
  if (mode === 'local') {
    command = `claude mcp add --transport stdio --scope user ${serverName} -- node ${localPath}`;
  } else {
    command = `claude mcp add --transport stdio --scope user ${serverName} -- npx -y doc-tools-mcp`;
  }

  // Execute the command
  try {
    console.log(chalk.gray(`Running: ${command}\n`));
    execSync(command, { stdio: 'inherit' });

    console.log(chalk.green('✓') + ` MCP server ${alreadyConfigured ? 'updated' : 'added'}: ${chalk.cyan(serverName)}\n`);

    return {
      success: true,
      configPath,
      configType: 'Claude Code',
      action: alreadyConfigured ? 'updated' : 'added',
      mode
    };
  } catch (err) {
    console.error(chalk.red('✗') + ` Failed to add MCP server: ${err.message}`);
    return { success: false, error: err.message };
  }
}

/**
 * Print next steps
 */
function printNextSteps(result) {
  if (!result.success) {
    return;
  }

  console.log(chalk.bold('📋 Next Steps:\n'));

  if (result.configType === 'Claude Desktop') {
    console.log('  1. Restart Claude Desktop');
    console.log('  2. The MCP server will be available automatically\n');
  } else {
    console.log('  1. Restart Claude Code (if running)');
    console.log('  2. Navigate to any repository:');
    console.log(chalk.gray('     cd ~/repos/docs'));
    console.log('  3. Start using the MCP server:\n');
    console.log(chalk.cyan('     "Show me the Antora structure"'));
    console.log(chalk.cyan('     "Generate property docs for v25.3.1"\n'));
  }

  if (result.mode === 'local') {
    console.log(chalk.bold('📦 To Update (Local Mode):\n'));
    console.log('  1. Pull latest changes:');
    console.log(chalk.gray('     cd /path/to/docs-extensions-and-macros'));
    console.log(chalk.gray('     git pull'));
    console.log('  2. Install dependencies:');
    console.log(chalk.gray('     npm install'));
    console.log('  3. Restart Claude Code');
    console.log(chalk.gray('     Changes will be picked up automatically!\n'));
  } else {
    console.log(chalk.bold('📦 To Update (NPX Mode):\n'));
    console.log('  1. Update the package globally or in any repo:');
    console.log(chalk.gray('     npm update -g @redpanda-data/docs-extensions-and-macros'));
    console.log('  2. Restart Claude Code');
    console.log(chalk.gray('     That\'s it! npx will use the new version.\n'));
  }

  console.log(chalk.bold('🎉 Setup complete!\n'));
  console.log(chalk.gray('Documentation: mcp/USER_GUIDE.adoc\n'));
}

/**
 * Show status of MCP server configuration
 */
function showStatus() {
  console.log(chalk.blue('\n📊 MCP Server Configuration Status\n'));
  console.log(chalk.gray(`Platform: ${detectOS()}\n`));

  // Check Claude Code config
  const configPath = getConfigPath();

  if (configExists()) {
    console.log(chalk.bold('Claude Code:'));
    console.log(chalk.gray(`  Config: ${configPath}`));

    try {
      const config = readConfig(configPath);
      const configured = isMCPServerConfigured(config);

      if (configured) {
        const server = config.mcpServers['redpanda-docs-tool-assistant'];
        const mode = server.command === 'node' ? 'Local Development' : 'NPX (Published Package)';
        const details = server.command === 'node'
          ? `Path: ${server.args[0]}`
          : `Package: ${server.args.join(' ')}`;

        console.log(chalk.green('  ✓ MCP server configured'));
        console.log(chalk.gray(`  Mode: ${mode}`));
        console.log(chalk.gray(`  ${details}\n`));
      } else {
        console.log(chalk.yellow('  ✗ MCP server not configured\n'));
      }
    } catch (err) {
      console.log(chalk.red(`  ✗ Error reading config: ${err.message}\n`));
    }
  } else {
    console.log(chalk.gray('Claude Code: Config not found\n'));
  }
}

module.exports = {
  setupMCP,
  showStatus,
  printNextSteps,
  detectOS,
  getConfigPath,
  configExists,
  getMCPServerPath
}

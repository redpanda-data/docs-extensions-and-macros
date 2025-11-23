# Redpanda Docs MCP Server

An MCP (Model Context Protocol) server that provides documentation tools to Claude Code. This allows you to manage Antora documentation through natural conversation with Claude.

## 🎯 Features

- **Context-aware**: Automatically works in any Redpanda repo based on your current directory
- **Antora intelligence**: Understands component/module structure
- **Automation**: Run `npx doc-tools` commands from any repo that has it
- **Focused**: Only provides domain-specific tools - Claude already has built-in file/search/git operations
- **No API key needed**: Uses your existing Claude Code authentication

## 🚀 Quick Start

### 1. Install Dependencies

From this repository:

```bash
npm install
```

### 2. Run Setup Command

Use the built-in setup command (works on macOS, Linux, and Windows):

```bash
npx doc-tools setup-mcp
```

This automatically:
- ✅ Detects your operating system
- ✅ Finds your Claude Code/Desktop config location
- ✅ Creates or updates the configuration
- ✅ Creates a backup of existing config
- ✅ Validates everything is correct

**Check status:**
```bash
npx doc-tools setup-mcp --status
```

**Options:**
```bash
# Force update even if already configured
npx doc-tools setup-mcp --force

# Target specific application
npx doc-tools setup-mcp --target code     # Claude Code
npx doc-tools setup-mcp --target desktop  # Claude Desktop
```

### 3. Restart Claude Code

After setup completes, restart Claude Code to load the MCP server.

### 4. Start Using It!

Navigate to any Redpanda repository and start chatting:

```bash
cd ~/repos/docs
claude-code
```

Then in Claude Code:
```
You: "Show me the Antora structure of this repo"
Claude: *uses get_antora_structure MCP tool*

You: "Generate property docs for v25.3.1"
Claude: *uses run_doc_tools_command MCP tool*
        *shows generated documentation*
```

## 📚 Available Tools

The MCP server provides **domain-specific tools** that complement Claude's built-in capabilities:

### Documentation Intelligence
- **get_antora_structure**: Analyze and understand the Antora component/module structure
  - Shows all components, versions, and modules
  - Lists available directories (pages, partials, examples, etc.)
  - Detects if doc-tools is available

### Automation
- **run_doc_tools_command**: Execute `npx doc-tools <command>`
  - Runs documentation automation tools
  - Only works in repos that have doc-tools installed
  - Examples: property docs, metrics docs, Redpanda Connect docs generation

### Why So Few Tools?

Claude Code already has excellent built-in tools for:
- **File operations** (Read, Write, Edit)
- **Search** (Glob for files, Grep for content)
- **Git operations** (Bash tool)

This MCP server focuses on what's **unique to Redpanda docs** - understanding Antora structure and running your custom automation tools.

## 💡 Usage Examples

### Example 1: Understand Documentation Structure

```
You: What's the Antora structure of this repo?
Claude: *uses get_antora_structure MCP tool*
        *shows components, modules, and available directories*
```

### Example 2: Update Documentation

```
You: Add a warning callout to the quick-start page about checking system requirements
Claude: *uses get_antora_structure to find the file location*
        *uses Read tool to view the file*
        *uses Edit tool to add the callout*
        *uses Bash tool to show git diff*
```

### Example 3: Create New Content

```
You: Create a troubleshooting page for Kafka connection timeouts in the manage module
Claude: *uses get_antora_structure to understand module layout*
        *uses Write tool to create modules/manage/pages/troubleshoot-connection-timeouts.adoc*
```

### Example 4: Run Documentation Automation

```
You: Generate property docs for v25.3.1
Claude: *uses run_doc_tools_command MCP tool*
        *executes: npx doc-tools generate property-docs --tag v25.3.1*
        *shows the output and any generated files*
```

### Example 5: Multi-Step Workflow

```
You: Generate metrics docs for v25.3.1, review the changes, then commit them
Claude: *uses run_doc_tools_command to generate docs*
        *uses Bash tool to show git diff*
        *uses Bash tool to git add and commit*
```

## 🔧 How It Works

### Context Detection

The MCP server automatically:
1. Detects the repository root from your current working directory
2. Looks for Antora structure (components, modules)
3. Checks if `doc-tools` is available
4. All operations happen relative to the detected repo

### Multi-Repo Support

You can use the **same MCP server** across all your repos:

```bash
# In docs-extensions-and-macros
cd ~/repos/docs-extensions-and-macros
claude-code  # MCP server works here

# In main docs repo
cd ~/repos/docs
claude-code  # Same MCP server, different context

# In cloud docs
cd ~/repos/cloud-docs
claude-code  # Still works!
```

### Tool Execution

When you ask Claude to do something:
1. Claude decides which tools to use
2. Claude calls the MCP server with tool requests
3. The server executes in your current repo context
4. Results are returned to Claude
5. Claude shows you what happened

## ⚙️ Configuration

### Configuration Locations

The `setup-mcp` command automatically detects the right location:

**Claude Code:**
- **All platforms**: `~/.claude/.mcp.json` (user-level MCP configuration)
- This works across macOS, Linux, and Windows

**Claude Desktop:**
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Linux**: `~/.config/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

### Manual Configuration (Advanced)

If you need to configure manually, the format for Claude Code is:

**For local development** (`~/.claude/.mcp.json`):
```json
{
  "mcpServers": {
    "redpanda-docs": {
      "type": "stdio",
      "command": "node",
      "args": [
        "/absolute/path/to/docs-extensions-and-macros/bin/doc-tools-mcp.js"
      ]
    }
  }
}
```

**For published package** (`~/.claude/.mcp.json`):
```json
{
  "mcpServers": {
    "redpanda-docs": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "doc-tools-mcp"]
    }
  }
}
```

But we recommend using `npx doc-tools setup-mcp` instead!

## 🐛 Troubleshooting

### MCP Server Not Showing Up

1. Check your config file syntax is valid JSON: `~/.claude/.mcp.json`
2. Verify the configuration includes `"type": "stdio"` field
3. For local mode: Verify the path to `doc-tools-mcp.js` is correct and absolute
4. For npx mode: Ensure the package is installed globally or locally
5. Restart Claude Code completely
6. Check Claude Code logs for errors
7. Run `npx doc-tools setup-mcp --status` to verify configuration

### "doc-tools not found" Error

This means you're in a repo that doesn't have doc-tools. The `run_doc_tools_command` tool only works in repos that have doc-tools installed.

Solution: Navigate to the docs-extensions-and-macros repo or another repo that has doc-tools.

### Tools Not Working

1. Make sure you're in a git repository
2. Check that you have the required permissions
3. For doc-tools commands, ensure dependencies are installed (`npm install`)

### Understanding Repository Structure

- Use `get_antora_structure` MCP tool to understand the Antora layout
- Then use Claude's built-in Glob/Grep tools to find specific files
- Claude's Read/Write/Edit tools handle all file operations

## 🔒 Security

- The MCP server is read-only for analysis (get_antora_structure)
- Only runs commands you explicitly request (run_doc_tools_command)
- No API key needed (uses Claude Code's authentication)
- All operations are local to your machine
- File modifications are handled by Claude's built-in tools (which you control)

## 📈 Advanced Usage

### Using with Multiple Claude Code Instances

You can run Claude Code in different directories simultaneously, and each will use the same MCP server but operate in its own repo context.

### Combining with Other MCP Servers

You can have multiple MCP servers configured. Claude will use the appropriate tools from each server as needed.

### Scripting Workflows

Since this integrates with Claude Code, you can create complex multi-step workflows through conversation:

```
You: I need to:
1. Generate property docs for v25.3.1
2. Review the changes
3. Create a branch called 'props-v25.3.1'
4. Commit with an appropriate message
5. Give me a summary for the PR description

Can you do all of that?

Claude: *executes each step sequentially*
        *asks for confirmation at key points*
        *provides final summary*
```

## 🚦 Status Messages

The MCP server logs to stderr (not stdout) so it doesn't interfere with the protocol:
- Server startup message
- Working directory
- Repository root detected

These appear in Claude Code's logs but won't clutter your chat.

## 📝 Best Practices

1. **Start with structure**: Use `get_antora_structure` MCP tool to understand the repo layout
2. **Let Claude work naturally**: It will use its built-in tools (Read, Write, Edit, Bash, Glob, Grep) automatically
3. **Run automation explicitly**: Use `run_doc_tools_command` for generating docs
4. **Trust the tools**: Claude knows when to use MCP tools vs built-in tools
5. **Be specific about goals**: Tell Claude what you want to achieve, not how to do it

## 🔄 Updates

To update the MCP server:

```bash
cd /path/to/docs-extensions-and-macros
git pull
npm install
```

Then restart Claude Code.

## 💬 Getting Help

If you encounter issues:
1. Check Claude Code logs
2. Verify your MCP server configuration
3. Test with simple commands first (e.g., "Show me the Antora structure")
4. Check that you're in a git repository
5. Open an issue in the repository

## 🎓 Learning More

- [MCP Documentation](https://modelcontextprotocol.io/)
- [Claude Code Documentation](https://docs.anthropic.com/claude-code)
- [Antora Documentation](https://docs.antora.org/)

## 🎉 What's Next

With the MCP server set up, you can:
- **Understand Antora structure** instantly with `get_antora_structure`
- **Run doc-tools automation** for generating property/metrics/component docs
- **Work efficiently** - Claude handles file operations with built-in tools
- **Focus on content** - let Claude handle the technical details

The MCP server provides the domain knowledge, Claude provides the execution. Just talk naturally!

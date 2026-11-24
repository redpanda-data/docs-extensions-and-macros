'use strict'

// The review's --mcp-config is `${{ env.DOCS_MCP_CONFIG }}`, which the
// "Build the docs MCP config" step writes at run time. An eval has no client
// key and must never send one, so it gets the config that step builds with no
// key: the docs server at the step's DOCS_MCP_URL, with no header.
const fs = require('fs')
const path = require('path')
const YAML = require('yaml')

const WORKFLOW = path.join(__dirname, '..', '..', '.github', 'workflows', 'doc-strings-review.yml')
const BUILD_STEP = 'Build the docs MCP config'
const ENV_REF = /^\$\{\{\s*env\.DOCS_MCP_CONFIG\s*\}\}$/

function resolveMcpConfig (value) {
  if (!ENV_REF.test(value.trim())) return JSON.parse(value)
  const wf = YAML.parse(fs.readFileSync(WORKFLOW, 'utf8'))
  const step = wf.jobs['doc-strings-review'].steps.find((s) => s.name === BUILD_STEP)
  const url = step && step.env && step.env.DOCS_MCP_URL
  if (!url) throw new Error(`"${BUILD_STEP}" step or its DOCS_MCP_URL not found in doc-strings-review.yml`)
  return { mcpServers: { 'redpanda-docs': { type: 'http', url } } }
}

module.exports = { resolveMcpConfig }

'use strict'

const { spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { getGitHubToken, getAuthenticatedGitHubUrl } = require('../../cli-utils/github-token')

/**
 * rp_util's cluster/node config schema JSON, for any streaming-enterprise
 * ref (tag, branch, or SHA), built from source every time.
 *
 * This is the foundation, not a fallback: doc generation for work-in-progress
 * branches depends on this working on its own, with no dependency on any
 * pre-built artifact ever having been published for that ref. A pre-built
 * cache in front of this (for tags) is a separate, optional speed layer --
 * see the publish-rp-util-schema workflow -- and always falls through to
 * this module when the cache misses.
 *
 * rp_util covers cluster and node (broker) scope only -- topic properties
 * stay on the existing C++-source-parsing path (property_extractor.py).
 */

const STREAMING_ENTERPRISE_REPO = 'https://github.com/redpanda-data/streaming-enterprise.git'
const RP_UTIL_TARGET = '//src/v/rp_util:rp_util'
const RP_UTIL_BIN_RELPATH = path.join('bazel-bin', 'src', 'v', 'rp_util', 'rp_util')
const DOCKER_LINUX_IMAGE = 'ubuntu:22.04'

/**
 * Shallow-clone streaming-enterprise at a ref into destDir. Tries a
 * branch/tag-name clone first (fast, matches almost every real call); a ref
 * that isn't a branch or tag name at HEAD (a bare SHA, for example) falls
 * back to a full clone plus checkout.
 * @param {string} ref - Branch, tag, or commit SHA
 * @param {string} destDir - Destination directory (must not exist yet)
 */
function cloneStreamingEnterprise(ref, destDir) {
  const token = getGitHubToken()
  if (!token) {
    throw new Error(
      'No GitHub token available to clone redpanda-data/streaming-enterprise (it is private).\n' +
      'Set GITHUB_TOKEN, REDPANDA_GITHUB_TOKEN, ACTIONS_BOT_TOKEN, or GIT_CREDENTIALS.'
    )
  }
  const repoUrl = getAuthenticatedGitHubUrl(STREAMING_ENTERPRISE_REPO)

  console.log(`Cloning streaming-enterprise@${ref} into ${destDir}...`)
  const shallow = spawnSync('git', [
    'clone', '-q', '--depth', '1', '--branch', ref, repoUrl, destDir
  ], { encoding: 'utf8', timeout: 300000 })

  if (shallow.status === 0) return

  // Not a branch/tag name at HEAD -- full clone, then checkout the ref directly.
  fs.rmSync(destDir, { recursive: true, force: true })
  console.log(`'${ref}' is not a branch/tag at HEAD; cloning full history to resolve it...`)
  const full = spawnSync('git', ['clone', '-q', repoUrl, destDir], {
    encoding: 'utf8', timeout: 600000
  })
  if (full.status !== 0) {
    throw new Error(`Failed to clone streaming-enterprise: ${full.stderr}`)
  }
  const checkout = spawnSync('git', ['checkout', '-q', ref], {
    cwd: destDir, encoding: 'utf8', timeout: 60000
  })
  if (checkout.status !== 0) {
    throw new Error(`Failed to checkout ref '${ref}' in streaming-enterprise: ${checkout.stderr}`)
  }
}

function checkDockerAvailable() {
  const check = spawnSync('docker', ['--version'], { encoding: 'utf8', timeout: 5000 })
  if (check.status !== 0) {
    throw new Error(
      'Docker is required to build rp_util (a Linux binary) on ' +
      `${os.platform()}, but was not found.\n` +
      'Start Docker Desktop, or run this on a Linux host/CI runner instead ' +
      '(no Docker needed there -- see publish-rp-util-schema.yaml).'
    )
  }
}

/**
 * Build //src/v/rp_util:rp_util natively via Bazel. Linux only -- the
 * hermetic LLVM toolchain this repo's .bazelrc configures targets Linux, and
 * Seastar-based binaries don't build natively on macOS/arm64.
 * @param {string} sourceDir - streaming-enterprise checkout root
 */
function buildNative(sourceDir) {
  const bazelCheck = spawnSync('bazel', ['--version'], { encoding: 'utf8', timeout: 15000 })
  if (bazelCheck.status !== 0) {
    throw new Error(
      'bazel (or bazelisk on PATH as `bazel`) is required but was not found.\n' +
      'In CI, set this up with bazel-contrib/setup-bazel before calling doc-tools; ' +
      'locally, install bazelisk: https://github.com/bazelbuild/bazelisk'
    )
  }

  console.log('Building rp_util natively via Bazel...')
  const build = spawnSync('bazel', ['build', '--lockfile_mode=off', RP_UTIL_TARGET], {
    cwd: sourceDir, encoding: 'utf8', timeout: 1800000, maxBuffer: 50 * 1024 * 1024
  })
  if (build.status !== 0) {
    throw new Error(`Failed to build rp_util: ${build.stderr}`)
  }
  return path.join(sourceDir, RP_UTIL_BIN_RELPATH)
}

/**
 * Build //src/v/rp_util:rp_util inside a Linux Docker container, and run
 * both schema dumps inside that same container -- the binary itself is a
 * Linux ELF that can't be exec'd directly on the host once the container
 * exits, so unlike buildNative() this returns the parsed JSON directly
 * rather than a binary path.
 * @param {string} sourceDir - streaming-enterprise checkout root
 * @returns {{clusterSchema: object, nodeSchema: object}}
 */
function buildAndRunInDocker(sourceDir) {
  checkDockerAvailable()
  console.log(`Building and running rp_util in a ${DOCKER_LINUX_IMAGE} container...`)

  const command = [
    'curl -fsSL -o /usr/local/bin/bazel',
    'https://github.com/bazelbuild/bazelisk/releases/latest/download/bazelisk-linux-amd64',
    '&& chmod +x /usr/local/bin/bazel',
    `&& bazel build --lockfile_mode=off ${RP_UTIL_TARGET}`,
    `&& ./${RP_UTIL_BIN_RELPATH.split(path.sep).join('/')} --config_schema_json > /tmp/cluster.json`,
    `&& ./${RP_UTIL_BIN_RELPATH.split(path.sep).join('/')} --node_config_schema_json > /tmp/node.json`,
    '&& cp /tmp/cluster.json /tmp/node.json /work/'
  ].join(' ')

  const result = spawnSync('docker', [
    'run', '--rm', '--platform', 'linux/amd64',
    '-v', `${sourceDir}:/work`,
    '-w', '/work',
    DOCKER_LINUX_IMAGE,
    'bash', '-c', command
  ], { encoding: 'utf8', timeout: 1800000, maxBuffer: 50 * 1024 * 1024 })

  if (result.status !== 0) {
    throw new Error(`Failed to build/run rp_util in Docker: ${result.stderr}`)
  }

  return {
    clusterSchema: JSON.parse(fs.readFileSync(path.join(sourceDir, 'cluster.json'), 'utf8')),
    nodeSchema: JSON.parse(fs.readFileSync(path.join(sourceDir, 'node.json'), 'utf8'))
  }
}

function runSchemaFlag(binaryPath, flag) {
  const result = spawnSync(binaryPath, [flag], {
    encoding: 'utf8', timeout: 60000, maxBuffer: 50 * 1024 * 1024
  })
  if (result.status !== 0) {
    throw new Error(`rp_util ${flag} failed: ${result.stderr}`)
  }
  try {
    return JSON.parse(result.stdout)
  } catch (err) {
    throw new Error(`rp_util ${flag} did not print valid JSON: ${err.message}`)
  }
}

/**
 * Get rp_util's cluster and node (broker) config schema JSON for a
 * streaming-enterprise ref, building from source every time.
 * @param {string} ref - Branch, tag, or commit SHA in redpanda-data/streaming-enterprise
 * @param {object} [options]
 * @param {string} [options.sourcePath] - Use an existing local streaming-enterprise
 *   checkout instead of cloning (caller is responsible for it being at `ref`)
 * @param {boolean} [options.keepSource] - Don't delete a clone this function made
 * @returns {{clusterSchema: object, nodeSchema: object, sourcePath: string}}
 */
function getRpUtilSchema(ref, options = {}) {
  const { sourcePath, keepSource = false } = options

  let sourceDir = sourcePath
  let ownsClone = false
  if (!sourceDir) {
    sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-util-source-'))
    ownsClone = true
    try {
      cloneStreamingEnterprise(ref, sourceDir)
    } catch (err) {
      fs.rmSync(sourceDir, { recursive: true, force: true })
      throw err
    }
  }

  try {
    if (os.platform() === 'linux') {
      const binaryPath = buildNative(sourceDir)
      return {
        clusterSchema: runSchemaFlag(binaryPath, '--config_schema_json'),
        nodeSchema: runSchemaFlag(binaryPath, '--node_config_schema_json'),
        sourcePath: sourceDir
      }
    }
    const { clusterSchema, nodeSchema } = buildAndRunInDocker(sourceDir)
    return { clusterSchema, nodeSchema, sourcePath: sourceDir }
  } finally {
    if (ownsClone && !keepSource) {
      fs.rmSync(sourceDir, { recursive: true, force: true })
    }
  }
}

module.exports = {
  getRpUtilSchema,
  // exported for testing
  cloneStreamingEnterprise,
  buildNative,
  buildAndRunInDocker,
  runSchemaFlag
}

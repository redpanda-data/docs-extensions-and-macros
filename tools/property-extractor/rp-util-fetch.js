'use strict'

const { spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { getGitHubToken, getAuthenticatedGitHubUrl } = require('../../cli-utils/github-token')

/**
 * rp_util's config schema JSON, for any streaming-enterprise ref (tag,
 * branch, or SHA), built from source every time.
 *
 * This is the foundation, not a fallback: doc generation for work-in-progress
 * branches depends on this working on its own, with no dependency on any
 * pre-built artifact ever having been published for that ref. A pre-built
 * cache in front of this (for tags) is a separate, optional speed layer --
 * see the publish-rp-util-schema workflow -- and always falls through to
 * this module when the cache misses.
 *
 * rp_util covers cluster scope (config::configuration) and everything that
 * makes up broker scope: config::node_config plus the three standalone
 * config_store classes that live alongside it (Pandaproxy, its Kafka
 * client, and Schema Registry). Topic properties stay on the existing
 * C++-source-parsing path (property_extractor.py) -- rp_util has no
 * equivalent for them.
 */

const STREAMING_ENTERPRISE_REPO = 'https://github.com/redpanda-data/streaming-enterprise.git'
const RP_UTIL_TARGET = '//src/v/rp_util:rp_util'
const RP_UTIL_BIN_RELPATH = path.join('bazel-bin', 'src', 'v', 'rp_util', 'rp_util')
const DOCKER_LINUX_IMAGE = 'ubuntu:22.04'
// Named (not anonymous) volumes so Bazel's output/repository cache survives
// across separate `docker run --rm` invocations -- without this, every local
// macOS run pays a full cold Bazel build (boost, seastar, openssl, ...) under
// Rosetta emulation, which can take hours instead of minutes.
const DOCKER_BAZEL_CACHE_VOLUME = 'rp-util-bazel-cache'
const DOCKER_BAZELISK_CACHE_VOLUME = 'rp-util-bazelisk-cache'

// Every schema rp_util can dump, and the key each shows up under in
// getRpUtilSchema()'s return value. One flag per config_store class --
// see rp_util/main.cc.
const SCHEMA_FLAGS = [
  { key: 'clusterSchema', flag: '--config_schema_json' },
  { key: 'nodeSchema', flag: '--node_config_schema_json' },
  { key: 'pandaproxySchema', flag: '--pandaproxy_config_schema_json' },
  { key: 'kafkaClientSchema', flag: '--kafka_client_config_schema_json' },
  { key: 'schemaRegistrySchema', flag: '--schema_registry_config_schema_json' }
]

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
 * every schema dump inside that same container -- the binary itself is a
 * Linux ELF that can't be exec'd directly on the host once the container
 * exits, so unlike buildNative() this returns the parsed JSON directly
 * rather than a binary path.
 * @param {string} sourceDir - streaming-enterprise checkout root
 * @returns {object} keyed by SCHEMA_FLAGS' `key`s
 */
function buildAndRunInDocker(sourceDir) {
  checkDockerAvailable()

  // Match the container's CPU architecture to the host's. Forcing
  // linux/amd64 on an Apple Silicon host makes Docker emulate x86_64 via
  // Rosetta for every single instruction in a from-source C++ build (boost,
  // seastar, openssl, ...) -- observed to turn a ~10-20min native build into
  // a multi-hour one. CI itself builds natively on arm64 hardware; there's
  // no reason a local arm64 Mac shouldn't too.
  const dockerArch = os.arch() === 'arm64' ? 'arm64' : 'amd64'
  const dockerPlatform = `linux/${dockerArch}`
  const bazeliskAsset = `bazelisk-linux-${dockerArch}`

  console.log(`Building and running rp_util in a ${dockerPlatform} ${DOCKER_LINUX_IMAGE} container...`)

  const binPath = RP_UTIL_BIN_RELPATH.split(path.sep).join('/')
  const dumpCommands = SCHEMA_FLAGS
    .map(({ key, flag }) => `&& ./${binPath} ${flag} > /tmp/${key}.json`)
    .join(' ')
  const copyCommand = `&& cp ${SCHEMA_FLAGS.map(({ key }) => `/tmp/${key}.json`).join(' ')} /work/`

  const command = [
    // libatomic1: the hermetic LLVM toolchain's clang binary is linked
    // against libatomic.so.1, which a bare ubuntu:22.04 image doesn't ship.
    'apt-get update -qq && apt-get install -qq -y libatomic1 curl ca-certificates',
    '&& curl -fsSL -o /usr/local/bin/bazel',
    `https://github.com/bazelbuild/bazelisk/releases/latest/download/${bazeliskAsset}`,
    '&& chmod +x /usr/local/bin/bazel',
    `&& bazel --output_user_root=/bazel-cache build --lockfile_mode=off ${RP_UTIL_TARGET}`,
    dumpCommands,
    copyCommand
  ].join(' ')

  const result = spawnSync('docker', [
    'run', '--rm', '--platform', dockerPlatform,
    '-v', `${sourceDir}:/work`,
    '-v', `${DOCKER_BAZEL_CACHE_VOLUME}:/bazel-cache`,
    '-v', `${DOCKER_BAZELISK_CACHE_VOLUME}:/root/.cache/bazelisk`,
    '-w', '/work',
    DOCKER_LINUX_IMAGE,
    'bash', '-c', command
  ], { encoding: 'utf8', timeout: 10800000, maxBuffer: 50 * 1024 * 1024 })

  if (result.status !== 0) {
    throw new Error(`Failed to build/run rp_util in Docker: ${result.stderr}`)
  }

  const schemas = {}
  for (const { key } of SCHEMA_FLAGS) {
    schemas[key] = JSON.parse(fs.readFileSync(path.join(sourceDir, `${key}.json`), 'utf8'))
  }
  return schemas
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
 * Get every schema rp_util can dump (cluster, plus everything that makes up
 * broker scope) for a streaming-enterprise ref, building from source every
 * time.
 * @param {string} ref - Branch, tag, or commit SHA in redpanda-data/streaming-enterprise
 * @param {object} [options]
 * @param {string} [options.sourcePath] - Use an existing local streaming-enterprise
 *   checkout instead of cloning (caller is responsible for it being at `ref`)
 * @param {boolean} [options.keepSource] - Don't delete a clone this function made
 * @returns {{clusterSchema: object, nodeSchema: object, pandaproxySchema: object,
 *   kafkaClientSchema: object, schemaRegistrySchema: object, sourcePath: string}}
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
    let schemas
    if (os.platform() === 'linux') {
      const binaryPath = buildNative(sourceDir)
      schemas = {}
      for (const { key, flag } of SCHEMA_FLAGS) {
        schemas[key] = runSchemaFlag(binaryPath, flag)
      }
    } else {
      schemas = buildAndRunInDocker(sourceDir)
    }
    return { ...schemas, sourcePath: sourceDir }
  } finally {
    if (ownsClone && !keepSource) {
      fs.rmSync(sourceDir, { recursive: true, force: true })
    }
  }
}

module.exports = {
  getRpUtilSchema,
  SCHEMA_FLAGS,
  // exported for testing
  cloneStreamingEnterprise,
  buildNative,
  buildAndRunInDocker,
  runSchemaFlag
}

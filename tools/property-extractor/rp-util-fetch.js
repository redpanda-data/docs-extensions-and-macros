'use strict'

const { spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { getGitHubToken } = require('../../cli-utils/github-token')

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
// 24.04, not 22.04: Bazel's rules_foreign_cc bundles a prebuilt ninja binary
// requiring glibc >= 2.38, which Ubuntu 22.04 (glibc 2.35) doesn't have --
// confirmed via CMake's own "GLIBC_2.38 not found" failure trying to run it.
const DOCKER_LINUX_IMAGE = 'ubuntu:24.04'
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
/**
 * Strip a credential out of text before it's surfaced anywhere that gets
 * logged -- an Error message ends up in plain CI logs. Covers a credential
 * embedded in a Git remote URL's userinfo (e.g. https://<token>@github.com/...),
 * which Git echoes back verbatim in common failures (a private repo it can't
 * access, a bad ref, ...), and a Basic-auth header in case Git ever echoes
 * failing config back -- defense in depth: this module keeps the token out
 * of argv and URLs entirely (see gitAuthEnv).
 */
function redactCredentials(text) {
  return String(text || '')
    .replace(/\/\/[^/@\s]+@/g, '//***@')
    .replace(/(authorization:\s*basic\s+)\S+/gi, '$1***')
}

/**
 * Build the environment that authenticates git's github.com requests via a
 * per-invocation credential helper, injected through GIT_CONFIG_* env vars.
 * No token byte ever appears in argv (readable by any local process via
 * `ps`/`/proc/<pid>/cmdline` for the full multi-minute clone) or in a URL
 * (echoed verbatim by git on common failures), and nothing is written into
 * the resulting clone's .git/config, where it would otherwise sit readable
 * on disk for the entire downstream Bazel/Docker build. Same env-only
 * pattern the property-docs Makefile migration uses.
 * @param {string} token
 * @returns {object} env for spawnSync
 */
function gitAuthEnv(token) {
  return {
    ...process.env,
    RP_UTIL_FETCH_GIT_TOKEN: token,
    GIT_CONFIG_COUNT: '2',
    // Clear any inherited helpers first so a system credential manager
    // can't intercept (or prompt) before ours answers.
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'credential.https://github.com.helper',
    // The helper reads the token from its own environment at callback time;
    // argv carries only this static, secret-free string.
    GIT_CONFIG_VALUE_1: '!f() { echo "username=x-access-token"; echo "password=$RP_UTIL_FETCH_GIT_TOKEN"; }; f'
  }
}

function cloneStreamingEnterprise(ref, destDir) {
  const token = getGitHubToken()
  if (!token) {
    throw new Error(
      'No GitHub token available to clone redpanda-data/streaming-enterprise (it is private).\n' +
      'Set GITHUB_TOKEN, REDPANDA_GITHUB_TOKEN, ACTIONS_BOT_TOKEN, or GIT_CREDENTIALS.'
    )
  }
  // Plain (unauthenticated) URL -- auth travels only via the per-invocation
  // credential-helper env below, so it's never in argv and never written to
  // destDir/.git/config.
  const repoUrl = STREAMING_ENTERPRISE_REPO
  const authEnv = gitAuthEnv(token)

  console.log(`Cloning streaming-enterprise@${ref} into ${destDir}...`)
  const shallow = spawnSync('git', [
    'clone', '-q', '--depth', '1', '--branch', ref, repoUrl, destDir
  ], { encoding: 'utf8', timeout: 300000, env: authEnv })

  if (shallow.status === 0) return

  // Not a branch/tag name at HEAD -- full clone, then checkout the ref directly.
  fs.rmSync(destDir, { recursive: true, force: true })
  console.log(`'${ref}' is not a branch/tag at HEAD; cloning full history to resolve it...`)
  const full = spawnSync('git', ['clone', '-q', repoUrl, destDir], {
    encoding: 'utf8', timeout: 600000, env: authEnv
  })
  if (full.status !== 0) {
    throw new Error(`Failed to clone streaming-enterprise: ${redactCredentials(full.stderr)}`)
  }
  const checkout = spawnSync('git', ['checkout', '-q', ref], {
    cwd: destDir, encoding: 'utf8', timeout: 60000
  })
  if (checkout.status !== 0) {
    throw new Error(`Failed to checkout ref '${ref}' in streaming-enterprise: ${redactCredentials(checkout.stderr)}`)
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
    // build-essential + the autotools set below: several rules_foreign_cc
    // genrules (liburing, krb5, ...) shell out straight to configure+make
    // on PATH rather than through Bazel's own toolchain resolution, so they
    // need a real host toolchain regardless of the hermetic LLVM one also
    // being present. This list is deliberately generous -- CI builds in a
    // purpose-built image (vtools, not checked out here) that already has
    // all of this, so there's no local Dockerfile to read the exact list
    // off of; better to over-install once than hit another 20-30min
    // round-trip per missing tool.
    'apt-get update -qq && apt-get install -qq -y libatomic1 build-essential curl ca-certificates ' +
      'perl bison flex python3 pkg-config m4 autoconf automake libtool gawk texinfo',
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

// Where publish-rp-util-schema.yaml uploads its release assets, and the
// mapping from each asset's filename back to the schema key rp_util_merge.py
// and this module's own callers key everything by.
const RP_UTIL_SCHEMA_RELEASE_REPO = 'redpanda-data/docs-extensions-and-macros'
const RELEASE_ASSET_TO_SCHEMA_KEY = {
  'cluster-config-schema.json': 'clusterSchema',
  'node-config-schema.json': 'nodeSchema',
  'pandaproxy-config-schema.json': 'pandaproxySchema',
  'kafka-client-config-schema.json': 'kafkaClientSchema',
  'schema-registry-config-schema.json': 'schemaRegistrySchema'
}

/**
 * Fetch rp_util's schema from a previously published GitHub release
 * (publish-rp-util-schema.yaml's rp-util-schema-<tag> release in this repo)
 * instead of building rp_util from source. A real doc-generation run can't
 * afford a from-source Bazel build (15-45 minutes observed) every time --
 * this is the fast path that exists so it doesn't have to.
 * @param {string} tag - The exact tag the release was published for (e.g. "v26.2.2")
 * @returns {Promise<object|null>} Schemas keyed like SCHEMA_FLAGS, or null if
 *   no release exists for this tag (caller should fall back to building)
 */
async function fetchPublishedSchema(tag) {
  const token = getGitHubToken()
  const headers = token ? { Authorization: `Bearer ${token}` } : {}

  const releaseResp = await fetch(
    `https://api.github.com/repos/${RP_UTIL_SCHEMA_RELEASE_REPO}/releases/tags/rp-util-schema-${tag}`,
    { headers }
  )
  if (releaseResp.status === 404) return null
  if (!releaseResp.ok) {
    throw new Error(
      `Failed to look up published rp_util schema release for ${tag}: ` +
      `${releaseResp.status} ${releaseResp.statusText}`
    )
  }
  const release = await releaseResp.json()

  // A published release must carry all five assets, each a real schema
  // payload, or it is not usable. Accepting whatever subset happens to be
  // there looks like success while every missing scope silently keeps its
  // Tree-sitter data -- the exact class of quiet wrong answer this whole
  // rp_util path exists to remove. The publisher itself cannot produce a
  // partial published release (`gh release create` uploads to a draft and
  // publishes only once every asset is up, and the /releases/tags endpoint
  // used above never returns drafts), but a hand-made backfill release, a
  // manually deleted asset, or a future change to the publisher all can, so
  // validate here rather than trusting the producer.
  const assetsByName = new Map()
  for (const asset of release.assets || []) {
    assetsByName.set(asset.name, asset)
  }
  const missing = Object.keys(RELEASE_ASSET_TO_SCHEMA_KEY).filter(name => !assetsByName.has(name))
  if (missing.length) {
    console.warn(
      `Published rp_util schema release rp-util-schema-${tag} is incomplete ` +
      `(missing: ${missing.join(', ')}); ignoring it.`
    )
    return null
  }

  const schemas = {}
  for (const [name, key] of Object.entries(RELEASE_ASSET_TO_SCHEMA_KEY)) {
    const asset = assetsByName.get(name)
    const assetResp = await fetch(asset.url, {
      headers: { ...headers, Accept: 'application/octet-stream' }
    })
    if (!assetResp.ok) {
      throw new Error(
        `Failed to download published rp_util schema asset ${asset.name}: ${assetResp.status}`
      )
    }
    let payload
    try {
      payload = await assetResp.json()
    } catch (err) {
      console.warn(
        `Published rp_util schema asset ${name} in rp-util-schema-${tag} is not valid JSON ` +
        `(${err.message}); ignoring the release.`
      )
      return null
    }
    // Every rp_util schema flag dumps a {"properties": {...}} object; an
    // asset without one is a truncated or wrong-shaped upload, not a schema
    // the merge can map.
    if (!payload || typeof payload.properties !== 'object' || payload.properties === null) {
      console.warn(
        `Published rp_util schema asset ${name} in rp-util-schema-${tag} has no properties ` +
        `object; ignoring the release.`
      )
      return null
    }
    schemas[key] = payload
  }
  return schemas
}

/**
 * Get every schema rp_util can dump (cluster, plus everything that makes up
 * broker scope) for a streaming-enterprise ref.
 *
 * Tries a previously published release first (fast: a few small downloads)
 * and only falls back to building rp_util from source (slow: a from-scratch
 * Bazel build) when no published release exists for this exact ref, or when
 * the caller explicitly asks to skip that check.
 * @param {string} ref - Branch, tag, or commit SHA in redpanda-data/streaming-enterprise
 * @param {object} [options]
 * @param {boolean} [options.preferPublished] - Try fetchPublishedSchema(ref) first.
 *   Default true. Set false to always build from source (e.g. `ref` isn't a
 *   released tag, or the caller explicitly wants a from-source build).
 * @param {string} [options.sourcePath] - Use an existing local streaming-enterprise
 *   checkout instead of cloning (caller is responsible for it being at `ref`).
 *   Implies building from source -- skips the published-release check.
 * @param {boolean} [options.keepSource] - Don't delete a clone this function made
 * @returns {Promise<{clusterSchema: object, nodeSchema: object, pandaproxySchema: object,
 *   kafkaClientSchema: object, schemaRegistrySchema: object, sourcePath: string|null}>}
 */
async function getRpUtilSchema(ref, options = {}) {
  const { sourcePath, keepSource = false, preferPublished = true } = options

  // streaming-enterprise release/RC tags are v-prefixed, and schema releases
  // are named rp-util-schema-<v-prefixed tag>. A v-less release-shaped ref
  // ("26.2.2") can neither be cloned nor have a schema release under its
  // verbatim name, so normalize it here -- otherwise every layer downstream
  // (release lookup, clone, the publish workflow an error message points at)
  // fails or no-ops on a name that can never exist.
  if (/^\d+\.\d+\.\d+(-rc\d+)?$/.test(ref)) {
    ref = `v${ref}`
  }

  if (!sourcePath && preferPublished) {
    const published = await fetchPublishedSchema(ref)
    if (published) {
      return { ...published, sourcePath: null }
    }
    console.log(`No published rp_util schema release for ${ref}; building from source...`)
  }

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
  runSchemaFlag,
  fetchPublishedSchema
}

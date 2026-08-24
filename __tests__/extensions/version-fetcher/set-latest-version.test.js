const { describe, it, expect } = require('@jest/globals')
const { execFileSync } = require('child_process')
const path = require('path')

// The set-latest-version extension loads @octokit/rest, @octokit/plugin-retry,
// and semver via dynamic import(), which Jest cannot evaluate without
// --experimental-vm-modules. These tests therefore drive the extension in a
// plain Node child process through a fixture harness that mocks all
// version-fetcher modules (no network access).
const harnessPath = path.join(__dirname, 'fixtures', 'set-latest-version-harness.js')

function runExtension (scenario = {}) {
  const stdout = execFileSync(process.execPath, [harnessPath, JSON.stringify(scenario)], {
    encoding: 'utf8',
  })
  return JSON.parse(stdout)
}

describe('set-latest-version extension', () => {
  it('emits -version-short (major.minor) alongside -version and -tag for semver versions', () => {
    const { versionAttributes, latestAttributes, errors } = runExtension()

    expect(errors).toEqual([])

    // Redpanda GA attributes are set on the latest component version.
    expect(latestAttributes['latest-redpanda-version']).toBe('26.2.1')
    expect(latestAttributes['latest-redpanda-tag']).toBe('v26.2.1')
    expect(latestAttributes['latest-redpanda-version-short']).toBe('26.2')

    // Console and Connect attributes are set on every component version.
    expect(versionAttributes['latest-console-version']).toBe('3.2.5')
    expect(versionAttributes['latest-console-tag']).toBe('v3.2.5')
    expect(versionAttributes['latest-console-version-short']).toBe('3.2')

    expect(versionAttributes['latest-connect-version']).toBe('4.37.0')
    expect(versionAttributes['latest-connect-tag']).toBe('4.37.0')
    expect(versionAttributes['latest-connect-version-short']).toBe('4.37')
  })

  it('emits -version-short for beta variants', () => {
    const { versionAttributes } = runExtension({
      dockerTags: {
        console: { latestStableRelease: 'v3.2.5', latestBetaRelease: 'v3.3.0-beta.1' },
        'redpanda-operator': { latestStableRelease: 'v25.1.3', latestBetaRelease: 'v25.2.1-beta1' },
      },
      helmChart: { latestStableRelease: '5.10.1', latestBetaRelease: '5.11.0-beta1' },
    })

    expect(versionAttributes['redpanda-beta-version']).toBe('26.3.1-rc1')
    expect(versionAttributes['redpanda-beta-tag']).toBe('v26.3.1-rc1')
    expect(versionAttributes['redpanda-beta-version-short']).toBe('26.3')

    expect(versionAttributes['console-beta-version']).toBe('3.3.0-beta.1')
    expect(versionAttributes['console-beta-version-short']).toBe('3.3')

    expect(versionAttributes['operator-beta-version']).toBe('25.2.1-beta1')
    expect(versionAttributes['operator-beta-version-short']).toBe('25.2')

    expect(versionAttributes['helm-beta-version']).toBe('5.11.0-beta1')
    expect(versionAttributes['helm-beta-version-short']).toBe('5.11')
  })

  it('does not emit -version-short for non-semver values', () => {
    const { versionAttributes } = runExtension({ connect: 'nightly' })

    // -version and -tag are still set for non-semver values.
    expect(versionAttributes['latest-connect-version']).toBe('nightly')
    expect(versionAttributes['latest-connect-tag']).toBe('nightly')
    // But no short version is derived.
    expect(versionAttributes).not.toHaveProperty('latest-connect-version-short')
  })

  it('leaves pre-existing attributes unchanged by the short-version feature', () => {
    const { versionAttributes, latestAttributes } = runExtension()

    // Existing behavior on the latest component version is preserved.
    expect(latestAttributes['full-version']).toBe('26.2.1')
    expect(latestAttributes['latest-release-commit']).toBe('abc123')

    // Operator and Helm chart attributes keep their original names and values.
    // The "v" prefix on latest-operator-version is load bearing: docs pages pass
    // it straight to `helm --version`, and both consuming antora.yml files seed
    // it in v-prefixed form.
    expect(versionAttributes['latest-operator-version']).toBe('v25.1.3')
    expect(versionAttributes['latest-redpanda-helm-chart-version']).toBe('5.10.1')
    expect(versionAttributes['redpanda-beta-commit']).toBe('rc456')
  })

  it('emits -version-short for the operator and Helm chart attributes too', () => {
    const { versionAttributes } = runExtension()

    expect(versionAttributes['latest-operator-version-short']).toBe('25.1')
    expect(versionAttributes['latest-redpanda-helm-chart-version-short']).toBe('5.10')
  })

  it('keeps a seeded commit attribute when the release tag has no commit hash', () => {
    const { versionAttributes, latestAttributes } = runExtension({
      redpanda: {
        latestRedpandaRelease: { version: 'v26.2.1', commitHash: null },
        latestRcRelease: { version: 'v26.3.1-rc1', commitHash: null },
      },
      latestAttributes: { 'latest-release-commit': 'seeded-in-antora-yml' },
    })

    // The version is still published even though its commit could not be resolved.
    expect(latestAttributes['latest-redpanda-version']).toBe('26.2.1')
    expect(latestAttributes['latest-redpanda-version-short']).toBe('26.2')
    expect(latestAttributes['latest-release-commit']).toBe('seeded-in-antora-yml')
    expect(versionAttributes).not.toHaveProperty('redpanda-beta-commit')
  })

  it('does not load the unused console-version module', () => {
    // Console versions come from the Docker tag lookup, so requiring
    // get-latest-console-version advertises a dependency that is never used.
    const { requires } = runExtension()

    // Positive control: the hook does see the modules the extension really loads.
    expect(requires).toContain('./get-latest-redpanda-version')
    expect(requires).toContain('./fetch-latest-docker-tag')

    expect(requires).not.toContain('./get-latest-console-version')
  })

  it('names the failed lookup instead of throwing a TypeError from the logger', () => {
    // A failed Redpanda fetch resolves to null releases rather than rejecting.
    const { versionAttributes, latestAttributes, errors } = runExtension({
      redpanda: { latestRedpandaRelease: null, latestRcRelease: null },
    })

    expect(errors.join('\n')).not.toMatch(/TypeError/)
    expect(errors.join('\n')).toMatch(/Could not resolve the latest version of: Redpanda/)
    expect(latestAttributes).not.toHaveProperty('latest-redpanda-version')
    expect(latestAttributes).not.toHaveProperty('latest-redpanda-version-short')

    // The components that did resolve are still published.
    expect(versionAttributes['latest-console-version-short']).toBe('3.2')
    expect(versionAttributes['latest-connect-version-short']).toBe('4.37')
  })

  it('does not move full-version backwards, but still publishes the GA attributes', () => {
    const { latestAttributes } = runExtension({
      latestAttributes: { 'full-version': '99.0.0' },
    })

    expect(latestAttributes['full-version']).toBe('99.0.0')
    expect(latestAttributes['latest-redpanda-version']).toBe('26.2.1')
    expect(latestAttributes['latest-redpanda-version-short']).toBe('26.2')
  })

  it('publishes the GA attributes when full-version already equals the live GA release', () => {
    // Both docs and cloud-docs seed full-version at the current GA release, so a
    // gate on full-version < GA makes every latest-redpanda-* attribute, including
    // the short one, unreachable in exactly the repos that consume them.
    const { latestAttributes, errors } = runExtension({
      latestAttributes: { 'full-version': '26.2.1' },
    })

    expect(errors).toEqual([])
    expect(latestAttributes['full-version']).toBe('26.2.1')
    expect(latestAttributes['latest-redpanda-version']).toBe('26.2.1')
    expect(latestAttributes['latest-redpanda-tag']).toBe('v26.2.1')
    expect(latestAttributes['latest-redpanda-version-short']).toBe('26.2')
    expect(latestAttributes['latest-release-commit']).toBe('abc123')
  })

  it('treats an unparseable full-version pin as no pin instead of throwing', () => {
    const { latestAttributes, errors } = runExtension({
      latestAttributes: { 'full-version': '26.2' },
    })

    expect(errors).toEqual([])
    expect(latestAttributes['full-version']).toBe('26.2.1')
    expect(latestAttributes['latest-redpanda-version']).toBe('26.2.1')
    expect(latestAttributes['latest-redpanda-version-short']).toBe('26.2')
  })
})

describe('the sibling contract extensions/REFERENCE.adoc documents', () => {
  // REFERENCE.adoc states that most <base>-version attributes get a -tag and a
  // -version-short sibling, and that full-version is the exception and gets
  // neither. That sentence was wrong once already, claiming EVERY attribute got
  // both, and prose drifts without anything noticing. Pin both halves.
  it('gives full-version neither sibling', () => {
    const { latestAttributes } = runExtension()

    expect(latestAttributes['full-version']).toBeDefined()
    expect(latestAttributes['full-version-tag']).toBeUndefined()
    expect(latestAttributes['full-version-short']).toBeUndefined()
    expect(latestAttributes['full-version-version-short']).toBeUndefined()
  })

  it('gives latest-redpanda-version both, so the exception is a real exception', () => {
    const { latestAttributes } = runExtension()

    expect(latestAttributes['latest-redpanda-tag']).toBeDefined()
    expect(latestAttributes['latest-redpanda-version-short']).toBeDefined()
  })
})

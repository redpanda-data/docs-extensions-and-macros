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

  // Assigning an attribute the value `undefined` is not the same as leaving it
  // alone: it shadows the fallback in antora.yml, and Asciidoctor then renders
  // the reference literally. That is how the published operator and helm-chart
  // release-notes pages ended up linking to
  // .../blob/{latest-operator-version}/operator/CHANGELOG.md.
  it.each([
    ['latest-operator-version', { 'redpanda-operator': { latestStableRelease: null, latestBetaRelease: null } }, {}],
    ['latest-redpanda-helm-chart-version', undefined, { latestStableRelease: null, latestBetaRelease: null }],
  ])('leaves %s unset when the fetch resolves without a version', (key, dockerTags, helmChart) => {
    const scenario = {}
    if (dockerTags) scenario.dockerTags = { console: { latestStableRelease: 'v3.2.5' }, ...dockerTags }
    if (helmChart) scenario.helmChart = helmChart
    const { versionAttributes } = runExtension(scenario)

    expect(Object.keys(versionAttributes)).not.toContain(key)
    expect(Object.keys(versionAttributes)).not.toContain(`${key}-short`)
  })

  // The empty-object cases above prove only that a null release never ADDS
  // the key. They can't catch the actual regression, which was overwriting a
  // real fallback: antora.yml seeds latest-operator-version so the attribute
  // still resolves when the GitHub fetch fails, and the bug assigned it
  // `undefined` anyway, shadowing that seed. Seed a representative fallback
  // here and assert it survives byte-for-byte.
  it.each([
    [
      'latest-operator-version', 'v2.3.8-24.3.6', '2.3',
      { dockerTags: { console: { latestStableRelease: 'v3.2.5' }, 'redpanda-operator': { latestStableRelease: null, latestBetaRelease: null } } },
    ],
    [
      'latest-redpanda-helm-chart-version', '5.9.0', '5.9',
      { helmChart: { latestStableRelease: null, latestBetaRelease: null } },
    ],
  ])('preserves an existing %s fallback when the fetch resolves without a version', (key, seededValue, seededShort, scenario) => {
    const { versionAttributes } = runExtension({
      ...scenario,
      versionAttributes: { [key]: seededValue, [`${key}-short`]: seededShort },
    })

    expect(versionAttributes[key]).toBe(seededValue)
    expect(versionAttributes[`${key}-short`]).toBe(seededShort)
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

describe('operator and Helm chart versions per docs version', () => {
  // An operator or chart release supports its own Redpanda line and the lines
  // next to it, so each docs version installs the newest release of its own
  // line. Tags are listed in Docker Hub order (recent pushes first), which is
  // not semver order within a line.
  const operatorTags = {
    console: { latestStableRelease: 'v3.2.5' },
    'redpanda-operator': {
      latestStableRelease: 'v26.2.4',
      latestBetaRelease: null,
      stableReleases: ['v25.3.10', 'v26.1.12', 'v26.2.4', 'v25.3.9', 'v26.1.9', 'v26.1.11', 'v2.3.15-24.3.18'],
    },
  }
  const helmChartByTag = { 'v26.2.4': '26.2.4', 'v26.1.12': '26.1.12', 'v25.3.10': '25.3.11' }
  const scenario = (overrides = {}) => ({
    dockerTags: operatorTags,
    helmChart: { latestStableRelease: '26.2.4', latestBetaRelease: null },
    helmChartByTag,
    versions: ['26.2', '26.1', '25.3'],
    latestVersion: '26.2',
    ...overrides,
  })

  it('pins each older version to the newest release of its own line', () => {
    const { attributesByVersion, warnings, errors } = runExtension(scenario())

    expect(errors).toEqual([])
    expect(warnings).toEqual([])
    expect(attributesByVersion['25.3']['latest-operator-version']).toBe('v25.3.10')
    expect(attributesByVersion['25.3']['latest-operator-version-short']).toBe('25.3')
    expect(attributesByVersion['25.3']['latest-redpanda-helm-chart-version']).toBe('25.3.11')
    expect(attributesByVersion['25.3']['latest-redpanda-helm-chart-version-short']).toBe('25.3')
    expect(attributesByVersion['26.1']['latest-operator-version']).toBe('v26.1.12')
    expect(attributesByVersion['26.1']['latest-redpanda-helm-chart-version']).toBe('26.1.12')
  })

  it('keeps the newest release overall on the latest version', () => {
    const { attributesByVersion } = runExtension(scenario())

    expect(attributesByVersion['26.2']['latest-operator-version']).toBe('v26.2.4')
    expect(attributesByVersion['26.2']['latest-redpanda-helm-chart-version']).toBe('26.2.4')
  })

  it('keeps the newest release overall on a prerelease ahead of the latest version', () => {
    const { attributesByVersion, warnings } = runExtension(scenario({ versions: ['26.3', '26.2'] }))

    expect(warnings).toEqual([])
    expect(attributesByVersion['26.3']['latest-operator-version']).toBe('v26.2.4')
    expect(attributesByVersion['26.3']['latest-redpanda-helm-chart-version']).toBe('26.2.4')
  })

  it('keeps the newest release overall on an unversioned component', () => {
    const { attributesByVersion, warnings, helmChartLookups } = runExtension(scenario({ versions: [null], latestVersion: null }))

    expect(warnings).toEqual([])
    expect(attributesByVersion.null['latest-operator-version']).toBe('v26.2.4')
    expect(attributesByVersion.null['latest-redpanda-helm-chart-version']).toBe('26.2.4')
    expect(helmChartLookups).toEqual(['v26.2.4'])
  })

  it('falls back to the newest release and warns when a line has no operator release', () => {
    // 24.3 shipped only legacy v2.3.x-24.3.y operator tags, which have no
    // line of their own to pin to.
    const { attributesByVersion, warnings } = runExtension(scenario({ versions: ['26.2', '24.3'] }))

    expect(attributesByVersion['24.3']['latest-operator-version']).toBe('v26.2.4')
    expect(attributesByVersion['24.3']['latest-redpanda-helm-chart-version']).toBe('26.2.4')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/No stable Redpanda Operator release found for the 24\.3 line/)
    expect(warnings[0]).toMatch(/v26\.2\.4/)
  })

  it('pins the operator but falls back to the newest chart and warns when the line has no chart', () => {
    const { attributesByVersion, warnings } = runExtension(scenario({
      helmChartByTag: { 'v26.2.4': '26.2.4', 'v26.1.12': '26.1.12' },
    }))

    expect(attributesByVersion['25.3']['latest-operator-version']).toBe('v25.3.10')
    expect(attributesByVersion['25.3']['latest-redpanda-helm-chart-version']).toBe('26.2.4')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/No Redpanda Helm chart release found for the 25\.3 line/)
  })

  it('looks up each line chart once, even when several components share the line', () => {
    const { helmChartLookups } = runExtension(scenario({ versions: ['26.2', '26.1', '25.3', '25.3'] }))

    expect(helmChartLookups.sort()).toEqual(['v25.3.10', 'v26.1.12', 'v26.2.4'])
  })

  it('preserves the old behavior when the operator lookup returns no tag list', () => {
    // Negative control: without per-line data every version gets the newest
    // release, exactly as before, and each older version says so.
    const { attributesByVersion, warnings } = runExtension(scenario({
      dockerTags: { console: { latestStableRelease: 'v3.2.5' }, 'redpanda-operator': { latestStableRelease: 'v26.2.4', latestBetaRelease: null } },
    }))

    for (const version of ['26.2', '26.1', '25.3']) {
      expect(attributesByVersion[version]['latest-operator-version']).toBe('v26.2.4')
      expect(attributesByVersion[version]['latest-redpanda-helm-chart-version']).toBe('26.2.4')
    }
    expect(warnings).toHaveLength(2)
  })
})

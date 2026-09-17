/**
 * Tests for whats-new.adoc entry spacing in the RPCN handler.
 *
 * Every release inserts a new `== Version` entry above the previous one. The
 * insertion point already carries the blank-line separator that preceded the
 * old first entry, so adding another newline gave each new entry three blank
 * lines above it where the rest of the file uses two. Writers corrected that by
 * hand after each release. Same class of bug as the rpk what's-new fix in #285.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')

// The handler transitively requires the Octokit client, which is ESM-only
// under Jest's CommonJS runtime. Same stub as rpcn-connector-summaries.test.js.
jest.mock('../../cli-utils/octokit-client', () => ({}))

const { updateWhatsNew } = require('../../tools/redpanda-connect/rpcn-connector-docs-handler')

const WHATS_NEW_REL = 'modules/get-started/pages/whats-new.adoc'

const HEADER = `= What's New in Redpanda Connect
:description: Summary of new features in Redpanda Connect.

This topic includes new content added from version 4.29.0 onwards.

For a full list of product updates, see the changelog.
`

function existingEntry (version) {
  return `== Version ${version}

link:https://github.com/redpanda-data/connect/releases/tag/v${version}[See the full release notes^].
`
}

/** Blank lines immediately above each `== Version` heading, in file order. */
function blankRunsBeforeEntries (content) {
  const lines = content.split('\n')
  const runs = []
  lines.forEach((line, i) => {
    if (!/^== Version /.test(line)) return
    let blanks = 0
    for (let j = i - 1; j >= 0 && lines[j] === ''; j--) blanks++
    runs.push(blanks)
  })
  return runs
}

function diffJson (oldVersion, newVersion) {
  return {
    comparison: { oldVersion, newVersion, timestamp: '2026-09-04T00:00:00.000Z' },
    summary: {
      newComponents: 0,
      removedComponents: 0,
      newFields: 1,
      removedFields: 0,
      deprecatedComponents: 0,
      deprecatedFields: 0,
      changedDefaults: 0
    },
    details: {
      newComponents: [],
      removedComponents: [],
      newFields: [
        {
          component: 'inputs:gcp_spanner_cdc',
          name: 'checkpoint_limit',
          description: 'The maximum number of messages that can be processed at a given time per partition.',
          version: newVersion
        }
      ],
      removedFields: [],
      deprecatedComponents: [],
      deprecatedFields: [],
      changedDefaults: [],
      platformTransitions: []
    }
  }
}

describe('updateWhatsNew - entry spacing', () => {
  let repo
  let dataDir
  let cwd

  beforeEach(() => {
    cwd = process.cwd()
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rpcn-whats-new-'))
    fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"fixture"}')
    dataDir = path.join(repo, 'docs-data')
    fs.mkdirSync(dataDir, { recursive: true })
    fs.mkdirSync(path.join(repo, path.dirname(WHATS_NEW_REL)), { recursive: true })
    process.chdir(repo)
  })

  afterEach(() => {
    process.chdir(cwd)
    fs.rmSync(repo, { recursive: true, force: true })
  })

  function run (oldVersion, newVersion) {
    fs.writeFileSync(
      path.join(dataDir, `connect-diff-${oldVersion}_to_${newVersion}.json`),
      JSON.stringify(diffJson(oldVersion, newVersion))
    )
    updateWhatsNew({ dataDir, oldVersion, newVersion, binaryAnalysis: {} })
    return fs.readFileSync(path.join(repo, WHATS_NEW_REL), 'utf8')
  }

  it('gives a new entry the same blank-line run as the entries below it', () => {
    fs.writeFileSync(
      path.join(repo, WHATS_NEW_REL),
      `${HEADER}\n\n${existingEntry('4.106.0')}\n\n${existingEntry('4.105.0')}`
    )

    const updated = run('4.106.0', '4.107.0')

    expect(updated).toContain('== Version 4.107.0')
    expect(blankRunsBeforeEntries(updated)).toEqual([2, 2, 2])
  })

  it('does not accumulate a blank line across successive releases', () => {
    fs.writeFileSync(
      path.join(repo, WHATS_NEW_REL),
      `${HEADER}\n\n${existingEntry('4.106.0')}`
    )

    run('4.106.0', '4.107.0')
    run('4.107.0', '4.108.0')
    const updated = run('4.108.0', '4.109.0')

    const runs = blankRunsBeforeEntries(updated)
    expect(runs).toHaveLength(4)
    expect(new Set(runs)).toEqual(new Set([2]))
  })

  it('normalizes an entry that a previous run left with an extra blank line', () => {
    fs.writeFileSync(
      path.join(repo, WHATS_NEW_REL),
      `${HEADER}\n\n\n${existingEntry('4.106.0')}\n\n${existingEntry('4.105.0')}`
    )

    const updated = run('4.106.0', '4.107.0')

    expect(blankRunsBeforeEntries(updated)).toEqual([2, 2, 2])
  })

  it('still writes the entry when the file has no version sections yet', () => {
    fs.writeFileSync(path.join(repo, WHATS_NEW_REL), HEADER)

    const updated = run('4.106.0', '4.107.0')

    expect(updated).toContain('== Version 4.107.0')
    expect(blankRunsBeforeEntries(updated)).toEqual([2])
    expect(updated.endsWith('\n')).toBe(true)
  })

  it('keeps spacing correct when replacing an existing section for the same version', () => {
    fs.writeFileSync(
      path.join(repo, WHATS_NEW_REL),
      `${HEADER}\n\n${existingEntry('4.107.0')}\n\n${existingEntry('4.106.0')}`
    )

    const updated = run('4.106.0', '4.107.0')

    expect(updated.match(/^== Version 4\.107\.0$/gm)).toHaveLength(1)
    expect(blankRunsBeforeEntries(updated)).toEqual([2, 2])
  })
})

'use strict'

const { changedLines } = require('../../cli-utils/unified-diff')

describe('changedLines', () => {
  const header = 'diff --git a/p.adoc b/p.adoc\n--- a/p.adoc\n+++ b/p.adoc\n'

  test('an added line that starts with "++ " is a changed line, not a file header', () => {
    // Under -U0 git prints the added text "++ echo hello" as "+++ echo hello".
    const diff = `${header}@@ -1,0 +2,2 @@\n+++ echo hello\n++ trace\n@@ -9,0 +12,1 @@\n+The flag defaults to 3.\n`
    const changed = changedLines(diff)
    expect([...changed.keys()]).toEqual(['p.adoc'])
    expect([...changed.get('p.adoc')]).toEqual([2, 3, 12])
  })

  test('a deleted line that starts with "-- " is not a file header', () => {
    const diff = `${header}@@ -3,1 +2,0 @@\n--- old\n@@ -9,0 +8,1 @@\n+new\n`
    expect([...changedLines(diff).get('p.adoc')]).toEqual([8])
  })

  test('a deleted file is not listed', () => {
    expect(changedLines('diff --git a/p.adoc b/p.adoc\n--- a/p.adoc\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n').size).toBe(0)
  })
})

const fs = require('fs');
const path = require('path');
const {
  generateReleaseNotes,
  buildReleaseSection,
  insertReleaseSection,
  compareVersions,
  isGaTag,
  readFloor,
  hasVersionSection,
} = require('../../tools/redpanda-release-notes/generate-release-notes');

const FIXTURES = path.join(__dirname, '../fixtures/release-notes');
const BODY = fs.readFileSync(path.join(FIXTURES, 'v26.2.2-streaming-enterprise.md'), 'utf8');
const CURATED_V2623 = fs.readFileSync(path.join(FIXTURES, 'curated/v26.2.3-curated.adoc'), 'utf8');

// A page shaped like modules/reference/pages/releases/redpanda.adoc.
function page({ floor = '26.2.2', withV2622 = true } = {}) {
  const lines = [
    '= Redpanda Release Notes',
    ':description: Detailed release notes for each Redpanda patch release, organized by version.',
    ':page-topic-type: reference',
    `:earliest-tracked-version: ${floor}`,
    '',
    'This page lists the changes in each Redpanda release from version {earliest-tracked-version} onward.',
    '',
  ];
  if (withV2622) {
    lines.push('== v26.2.2 (2026-08-21)', '', '=== Features', '', '* Something shipped.', '');
  }
  lines.push('== Release notes for older versions', '', 'See the Redpanda releases page.', '');
  return lines.join('\n');
}

describe('compareVersions', () => {
  it('orders versions numerically, not lexically', () => {
    expect(compareVersions('26.2.10', '26.2.2')).toBe(1);
    expect(compareVersions('v26.2.2', '26.2.2')).toBe(0);
    expect(compareVersions('26.1.9', '26.2.0')).toBe(-1);
  });
});

describe('isGaTag', () => {
  it('accepts bare vX.Y.Z', () => {
    expect(isGaTag('v26.2.3')).toBe(true);
    expect(isGaTag('26.2.3')).toBe(true);
  });
  it('rejects prereleases', () => {
    expect(isGaTag('v26.2.3-rc1')).toBe(false);
    expect(isGaTag('v26.2.3-beta')).toBe(false);
  });
});

describe('readFloor / hasVersionSection', () => {
  it('reads the floor attribute', () => {
    expect(readFloor(page())).toBe('26.2.2');
  });
  it('detects an existing version section', () => {
    expect(hasVersionSection(page(), 'v26.2.2')).toBe(true);
    expect(hasVersionSection(page(), '26.2.3')).toBe(false);
  });
});

describe('insertReleaseSection', () => {
  it('inserts before the first existing version heading (newest-first)', () => {
    const out = insertReleaseSection(page(), '== v26.2.3 (2026-09-15)\n\n=== Features\n\n* New.\n');
    expect(out.indexOf('== v26.2.3')).toBeLessThan(out.indexOf('== v26.2.2'));
  });
  it('inserts before the older-versions footer when there are no version sections yet', () => {
    const out = insertReleaseSection(page({ withV2622: false }), '== v26.2.3 (2026-09-15)\n\n* New.\n');
    expect(out.indexOf('== v26.2.3')).toBeLessThan(out.indexOf('== Release notes for older versions'));
  });
});

describe('generateReleaseNotes guards', () => {
  it('skips a non-GA tag', () => {
    const res = generateReleaseNotes({ body: BODY, tag: 'v26.2.3-rc1', date: '2026-09-15', pageContent: page() });
    expect(res.status).toBe('skipped');
    expect(res.reason).toMatch(/GA/);
  });

  it('skips a version at or below the floor', () => {
    const res = generateReleaseNotes({ body: BODY, tag: 'v26.2.1', date: '2026-09-15', pageContent: page() });
    expect(res.status).toBe('skipped');
    expect(res.reason).toMatch(/floor/);
  });

  it('skips a version already on the page (idempotent re-run)', () => {
    // Floor below the existing section, so only the idempotency guard can fire.
    const res = generateReleaseNotes({ body: BODY, tag: 'v26.2.2', date: '2026-08-21', pageContent: page({ floor: '26.2.0' }) });
    expect(res.status).toBe('skipped');
    expect(res.reason).toMatch(/already/);
  });
});

describe('generateReleaseNotes (real fixture, newer tag)', () => {
  const res = generateReleaseNotes({ body: BODY, tag: 'v26.2.3', date: '2026-09-15', pageContent: page() });

  it('returns ok and inserts the new section above the older one', () => {
    expect(res.status).toBe('ok');
    expect(res.content.indexOf('== v26.2.3 (2026-09-15)')).toBeLessThan(res.content.indexOf('== v26.2.2 (2026-08-21)'));
  });

  it('produces a candidate section with cleaned entries and no Area:: labels', () => {
    expect(res.section).toContain('=== Features');
    expect(res.section).toContain('=== Improvements');
    expect(res.section).toContain('=== Bug fixes');
    expect(res.section).not.toMatch(/by @/);
    expect(res.section).not.toMatch(/::/);
  });

  it('leaves the older-versions footer intact', () => {
    expect(res.content).toContain('== Release notes for older versions');
  });
});

// Deterministic candidate goldens: exact-match the committed expected section for
// each real release body. These lock down parse/strip/dedup/order/transforms.
// They are NOT the curated page — curation (Area:: labels, present-tense voice,
// dropping bodyless and out-of-scope entries) is a separate, judgment-bearing
// step with its own future golden. Regenerate with:
//   node -e "const fs=require('fs');const {buildReleaseSection}=require('./tools/redpanda-release-notes/generate-release-notes');\
//   for(const [t,d] of [['v26.2.2','2026-08-21'],['v26.2.3','2026-09-17']]) fs.writeFileSync(\
//   '__tests__/fixtures/release-notes/expected/'+t+'-candidate.adoc',\
//   buildReleaseSection({body:fs.readFileSync('__tests__/fixtures/release-notes/'+t+'-streaming-enterprise.md','utf8'),version:t,date:d}))"
describe('generateReleaseNotes phase 2 (insert a curated section)', () => {
  it('inserts a pre-curated section verbatim, newest-first, under the guards', () => {
    const res = generateReleaseNotes({ section: CURATED_V2623, tag: 'v26.2.3', pageContent: page() });
    expect(res.status).toBe('ok');
    expect(res.section).toBe(CURATED_V2623); // used as-is, not rebuilt from a body
    expect(res.content).toContain('Cluster:: Reconnection logic is hardened');
    expect(res.content.indexOf('== v26.2.3')).toBeLessThan(res.content.indexOf('== v26.2.2'));
  });

  it('applies the floor guard on the section path too', () => {
    const res = generateReleaseNotes({
      section: '== v26.2.2 (2026-08-21)\n\n=== Features\n\nrpk:: x.\n',
      tag: 'v26.2.2',
      pageContent: page({ floor: '26.2.2' }),
    });
    expect(res.status).toBe('skipped');
  });

  it('throws when both body and section are given', () => {
    expect(() => generateReleaseNotes({ body: BODY, section: CURATED_V2623, tag: 'v26.2.3', pageContent: page() }))
      .toThrow(/only one/i);
  });

  it('throws when neither body nor section is given', () => {
    expect(() => generateReleaseNotes({ tag: 'v26.2.3', pageContent: page() }))
      .toThrow(/either body .* or section/i);
  });
});

describe('candidate goldens', () => {
  it.each([
    ['v26.2.2', '2026-08-21'],
    ['v26.2.3', '2026-09-17'],
  ])('matches the expected candidate for %s', (tag, date) => {
    const body = fs.readFileSync(path.join(FIXTURES, `${tag}-streaming-enterprise.md`), 'utf8');
    const expected = fs.readFileSync(path.join(FIXTURES, `expected/${tag}-candidate.adoc`), 'utf8');
    expect(buildReleaseSection({ body, version: tag, date })).toBe(expected);
  });
});

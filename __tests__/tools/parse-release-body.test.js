const fs = require('fs');
const path = require('path');
const {
  parseReleaseBody,
  sectionKind,
  stripAttribution,
  stripLeadingIssueRef,
  cleanEntry,
  linkProperties,
  normalizeUnits,
  escapeAsciiDocBraces,
  KIND_FEATURE,
  KIND_IMPROVEMENT,
  KIND_FIX,
} = require('../../tools/redpanda-release-notes/parse-release-body');

const FIXTURE = fs.readFileSync(
  path.join(__dirname, '../fixtures/release-notes/v26.2.2-streaming-enterprise.md'),
  'utf8'
);

describe('sectionKind', () => {
  it('maps headings to canonical kinds by keyword', () => {
    expect(sectionKind('Features')).toBe(KIND_FEATURE);
    expect(sectionKind('Bug Fixes')).toBe(KIND_FIX);
    expect(sectionKind('Improvements')).toBe(KIND_IMPROVEMENT);
  });
  it('returns null for extra sections', () => {
    expect(sectionKind('None')).toBeNull();
    expect(sectionKind('Unclear')).toBeNull();
  });
});

describe('stripAttribution', () => {
  it('strips a single "by @author in [#PR](url)" suffix', () => {
    expect(stripAttribution('X now works. by @r-vasquez in [#31329](https://example.com/pull/31329)'))
      .toBe('X now works.');
  });
  it('strips doubled attribution from backport aggregation', () => {
    const input = 'A fix. by @a in [#1](https://e/pull/1) by @tyson-redpanda in [#2](https://e/pull/2)';
    expect(stripAttribution(input)).toBe('A fix.');
  });
  it('strips a bare "by @author" with no PR link', () => {
    expect(stripAttribution('A fix. by @nvartolomei')).toBe('A fix.');
  });
  it('leaves a mid-sentence "by" untouched', () => {
    expect(stripAttribution('Records produced by the client are validated.'))
      .toBe('Records produced by the client are validated.');
  });
});

describe('stripLeadingIssueRef', () => {
  it('removes a leading issue reference', () => {
    expect(stripLeadingIssueRef('[#31446](https://e/issues/31446) `rpk connect install` no longer fails.'))
      .toBe('`rpk connect install` no longer fails.');
  });
  it('leaves text with no leading reference untouched', () => {
    expect(stripLeadingIssueRef('Plain entry.')).toBe('Plain entry.');
  });
});

describe('cleanEntry', () => {
  it('unescapes backslash-escaped backticks', () => {
    expect(cleanEntry('Fixes a potential crash in \\`DescribeLogDirs\\` by @WillemKauf in [#1](https://e/pull/1)'))
      .toBe('Fixes a potential crash in `DescribeLogDirs`');
  });
  it('collapses whitespace from joined wrapped lines', () => {
    expect(cleanEntry('Fix the registered config name for  `x`.')).toBe('Fix the registered config name for `x`.');
  });
  it('normalizes data-size units and escapes braces', () => {
    expect(cleanEntry('`GET /schemas/ids/{id}` returned 403.')).toBe('`GET /schemas/ids/\\{id\\}` returned 403.');
    expect(cleanEntry('offset up to one interval (`4_MiB` of records).')).toBe('offset up to one interval (`4 MiB` of records).');
  });
});

describe('linkProperties', () => {
  const names = new Set([
    'cloud_storage_segment_max_upload_interval_sec', 'retention.ms', 'admin', 'rack',
  ]);

  it('rewrites an exact backticked property name as a prop: macro', () => {
    expect(linkProperties('Changing `cloud_storage_segment_max_upload_interval_sec` now requires a restart.', names))
      .toBe('Changing prop:cloud_storage_segment_max_upload_interval_sec[] now requires a restart.');
  });

  it('links a dotted topic property', () => {
    expect(linkProperties('Set `retention.ms` on the topic.', names)).toBe('Set prop:retention.ms[] on the topic.');
  });

  it('leaves a backticked identifier that is not a known property alone', () => {
    expect(linkProperties('The `health_manager` keeps ticking.', names)).toBe('The `health_manager` keeps ticking.');
  });

  it('leaves a name with a value or other text in the same backticks alone', () => {
    expect(linkProperties('Use `retention.ms=1000` here.', names)).toBe('Use `retention.ms=1000` here.');
  });

  it('never links a known name that has no _ or .', () => {
    expect(linkProperties('The `admin` and `rack` settings.', names)).toBe('The `admin` and `rack` settings.');
  });

  it('returns the text unchanged without property names', () => {
    expect(linkProperties('Set `retention.ms`.', undefined)).toBe('Set `retention.ms`.');
    expect(linkProperties('Set `retention.ms`.', new Set())).toBe('Set `retention.ms`.');
  });
});

describe('parseReleaseBody (property links)', () => {
  const body = [
    '## Bug Fixes',
    '* Changing \\`retention.ms\\` now applies to `health_manager` too. by @dev in [#1](https://example.com/1)',
  ].join('\n');

  it('links known properties when names are given, after unescaping backticks', () => {
    const { sections } = parseReleaseBody(body, { propertyNames: new Set(['retention.ms']) });
    expect(sections[0].entries).toEqual(['Changing prop:retention.ms[] now applies to `health_manager` too.']);
  });

  it('keeps plain monospace when no names are given', () => {
    const { sections } = parseReleaseBody(body);
    expect(sections[0].entries).toEqual(['Changing `retention.ms` now applies to `health_manager` too.']);
  });
});

describe('normalizeUnits', () => {
  it('rewrites underscore data sizes to readable units', () => {
    expect(normalizeUnits('4_MiB')).toBe('4 MiB');
    expect(normalizeUnits('512_KiB and 2_GB')).toBe('512 KiB and 2 GB');
  });
  it('leaves identifiers with underscores alone', () => {
    expect(normalizeUnits('s3_fifo')).toBe('s3_fifo');
    expect(normalizeUnits('last_offset_delta')).toBe('last_offset_delta');
  });
});

describe('escapeAsciiDocBraces', () => {
  it('escapes unescaped braces, including inside backticks', () => {
    expect(escapeAsciiDocBraces('`GET /schemas/ids/{id}`')).toBe('`GET /schemas/ids/\\{id\\}`');
  });
  it('does not double-escape already-escaped braces', () => {
    expect(escapeAsciiDocBraces('\\{id\\}')).toBe('\\{id\\}');
  });
});

describe('parseReleaseBody (crafted)', () => {
  it('orders sections Features -> Bug fixes -> Improvements regardless of source order', () => {
    const body = [
      '## Features', '* F1 by @a in [#1](https://e/pull/1)',
      '## Improvements', '* I1 by @c in [#3](https://e/pull/3)',
      '## Bug Fixes', '* B1 by @b in [#2](https://e/pull/2)',
    ].join('\n');
    const { sections } = parseReleaseBody(body);
    expect(sections.map((s) => s.title)).toEqual(['Features', 'Bug fixes', 'Improvements']);
  });

  it('joins wrapped bullet lines into one entry', () => {
    const body = [
      '## Bug Fixes',
      '* Fixed a crash where a snapshot write failing on a full disk (ENOSPC)',
      'aborted the node with a misleading assertion',
      'instead of surfacing the I/O error. by @nvartolomei in [#1](https://e/pull/1)',
    ].join('\n');
    const { sections } = parseReleaseBody(body);
    expect(sections[0].entries).toEqual([
      'Fixed a crash where a snapshot write failing on a full disk (ENOSPC) aborted the node with a misleading assertion instead of surfacing the I/O error.',
    ]);
  });

  it('de-duplicates identical backport entries', () => {
    const body = [
      '## Bug Fixes',
      '* Same fix. by @a in [#1](https://e/pull/1)',
      '* Same fix. by @a in [#2](https://e/pull/2) by @tyson-redpanda in [#3](https://e/pull/3)',
    ].join('\n');
    const { sections } = parseReleaseBody(body);
    expect(sections[0].entries).toEqual(['Same fix.']);
  });

  it('ignores None/Unclear sections and the changelog footer', () => {
    const body = [
      '## Features', '* F1 by @a in [#1](https://e/pull/1)',
      '## None', '* PR [#9](https://e/pull/9) some title by @x',
      '', '**Partial Changelog**: https://e/compare/v1...v2',
    ].join('\n');
    const { sections } = parseReleaseBody(body);
    expect(sections).toHaveLength(1);
    expect(sections[0].entries).toEqual(['F1']);
  });

  it('throws on an empty body', () => {
    expect(() => parseReleaseBody('')).toThrow(/empty/i);
  });
});

describe('parseReleaseBody (real v26.2.2 fixture)', () => {
  const { sections } = parseReleaseBody(FIXTURE);
  const byKind = Object.fromEntries(sections.map((s) => [s.kind, s]));
  const allEntries = sections.flatMap((s) => s.entries);

  it('produces all three categories in page order', () => {
    expect(sections.map((s) => s.title)).toEqual(['Features', 'Bug fixes', 'Improvements']);
  });

  it('strips every author handle, PR/issue link, and markdown link from entries', () => {
    for (const entry of allEntries) {
      expect(entry).not.toMatch(/by @/);
      expect(entry).not.toMatch(/\]\(https?:\/\//);
      expect(entry).not.toMatch(/github\.com/);
    }
  });

  it('leaves no backslash-escaped backticks', () => {
    for (const entry of allEntries) {
      expect(entry).not.toMatch(/\\`/);
    }
  });

  it('collapses the two backport pairs to single entries', () => {
    const sasl = allEntries.filter((e) => e.includes('freshly established SASL connection'));
    expect(sasl).toHaveLength(1);
    const enospc = allEntries.filter((e) => e.includes('snapshot writer has to be closed'));
    expect(enospc).toHaveLength(1);
  });

  it('strips the leading issue ref from the rpk connect install entry', () => {
    const entry = byKind[KIND_FIX].entries.find((e) => e.includes('rpk connect install'));
    expect(entry).toBeDefined();
    expect(entry).not.toContain('31446');
    expect(entry.startsWith('`rpk connect install --connect-version`')).toBe(true);
  });

  it('keeps a representative feature entry intact after cleaning', () => {
    expect(byKind[KIND_FEATURE].entries).toContain(
      '`rpk sql debug bundle` collects a diagnostic bundle from an Oxla (SQL) cluster.'
    );
  });
});

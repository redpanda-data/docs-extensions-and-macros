// All text here is synthetic. The operator repository is private, so no real
// changelog entry belongs in this public repository.

const { parseTag } = require('../../tools/k8s-release-notes/projects');
const {
  parseChangieBody,
  renderCandidate,
  stripPrivateReferences,
  markdownInlineToAsciiDoc,
} = require('../../tools/k8s-release-notes/changie');
const {
  parseCurated,
  findLeaks,
  findUnsupported,
  assembleSection,
  hashBody,
} = require('../../tools/k8s-release-notes/section');
const { splitPage, updatePage, SUMMARY_START, SUMMARY_END } = require('../../tools/k8s-release-notes/page');
const {
  buildCandidate,
  waitForChart,
  publishSection,
  lintPage,
} = require('../../tools/k8s-release-notes/generate-k8s-release-notes');

const BODY = [
  '### Added',
  '* Widget CRD: new `spec.mode` field. Set `{name}` to pick a mode.',
  '### Fixed',
  '* The operator no longer drops the `app` label (K8S-123). Same fix as #42, which covered widgets#7.',
  '',
  '  The helper mutated its input, so every later',
  '  pool got the first pool\'s label. See',
  '  [the issue](https://github.com/redpanda-data/redpanda-operator/issues/42).',
  '',
  '    - Brokers restart once on upgrade.',
  '    - CVE-2026-1111 is fixed.',
  '',
  '  ```yaml',
  '  mode: fast',
  '  ```',
  '* **Breaking:** `spec.old` is ignored.',
  '### Security',
  '* Ignored kind.',
  '',
].join('\n');

const CURATED = [
  '== v1.2.3 (2026-01-02)',
  '',
  'Adds a mode field to the Widget resource and fixes a label bug.',
  '',
  '=== Bug fixes',
  '',
  '* The operator keeps the `app` label on every pool.',
  '',
  '=== Before you upgrade',
  '',
  '* Brokers restart once.',
  '',
  '=== New features',
  '',
  '* The Widget resource has a new `spec.mode` field.',
  '',
].join('\n');

const PAGE = [
  '= Redpanda Operator Release Notes',
  ':page-toc-collapsible: true',
  '',
  'Intro.',
  '',
  SUMMARY_START,
  SUMMARY_END,
  '',
  '== Older versions',
  '',
  'Footer.',
  '',
].join('\n');

const project = parseTag('operator/v1.2.3').project;
const assemble = (curated = CURATED, extra = {}) => assembleSection({
  curated, tag: 'operator/v1.2.3', version: '1.2.3', project, sourceBody: BODY, ...extra,
});

describe('parseTag', () => {
  test('resolves GA tags of published projects', () => {
    expect(parseTag('operator/v26.2.6')).toMatchObject({ key: 'operator', version: '26.2.6' });
    expect(parseTag('charts/redpanda/v26.2.6').project.chart).toBe('redpanda');
    expect(parseTag('charts/console/v3.9.0').project.chart).toBe('console');
  });

  test.each(['operator/v26.2.1-beta.3', 'gotohelm/v1.1.0', 'charts/connectors/v0.1.0', 'v26.2.6', ''])(
    'returns null for %p', (tag) => expect(parseTag(tag)).toBeNull(),
  );
});

describe('stripPrivateReferences', () => {
  test('removes issue numbers, ticket keys, and private links, and tidies up', () => {
    expect(stripPrivateReferences('Fixed a crash (K8S-123) in the hook.')).toBe('Fixed a crash in the hook.');
    expect(stripPrivateReferences('caused by the redpanda#31057 wedge')).toBe('caused by the wedge');
    expect(stripPrivateReferences('See [the fix](https://github.com/redpanda-data/x/pull/9).')).toBe('See the fix.');
    expect(stripPrivateReferences('See https://github.com/redpanda-data/x/issues/9 for more.')).toBe('See for more.');
  });

  test('keeps public identifiers and code spans', () => {
    expect(stripPrivateReferences('Fixes CVE-2026-1111 and follows KIP-848.')).toBe('Fixes CVE-2026-1111 and follows KIP-848.');
    expect(stripPrivateReferences('Set `K8S-123` or `#42`.')).toBe('Set `K8S-123` or `#42`.');
  });
});

describe('markdownInlineToAsciiDoc', () => {
  test('converts bold and links, and escapes attribute references', () => {
    expect(markdownInlineToAsciiDoc('**Note:** see [docs](https://docs.redpanda.com/x).'))
      .toBe('*Note:* see https://docs.redpanda.com/x[docs].');
    expect(markdownInlineToAsciiDoc('Set `{name}` now.')).toBe('Set `\\{name}` now.');
  });
});

describe('parseChangieBody and renderCandidate', () => {
  const { sections, unknownKinds } = parseChangieBody(BODY);

  test('maps kinds to headings in page order and reports unknown kinds', () => {
    expect(sections.map((s) => s.title)).toEqual(['New features', 'Bug fixes']);
    expect(unknownKinds).toEqual(['Security']);
  });

  test('cleans leads and unwraps details', () => {
    const [fix, breaking] = sections[1].entries;
    expect(fix.lead).toBe('The operator no longer drops the `app` label. Same fix as, which covered.');
    expect(fix.details[0]).toEqual(['The helper mutated its input, so every later pool got the first pool\'s label. See the issue.']);
    expect(fix.details[1]).toEqual(['** Brokers restart once on upgrade.', '** CVE-2026-1111 is fixed.']);
    expect(fix.details[2]).toEqual(['[,yaml]', '----', 'mode: fast', '----']);
    expect(breaking.lead).toBe('*Breaking:* `spec.old` is ignored.');
  });

  test('skips a version header and joins a wrapped lead', () => {
    const parsed = parseChangieBody('## [v1.2.3](https://example.com) - 2026-01-02\n### Fixed\n* A lead that\n  wraps.\n');
    expect(parsed.sections[0].entries[0].lead).toBe('A lead that wraps.');
  });

  test('renders a candidate with no private references', () => {
    const candidate = renderCandidate({ version: '1.2.3', date: '2026-01-02', sections });
    expect(candidate.startsWith('== v1.2.3 (2026-01-02)\n\n=== New features\n\n* Widget CRD')).toBe(true);
    expect(candidate).toContain('+\n--\nThe helper mutated');
    expect(findLeaks(candidate)).toEqual([]);
  });

  test('rejects a bad date and an empty body', () => {
    expect(() => renderCandidate({ version: '1.2.3', date: 'soon', sections })).toThrow(/Invalid date/);
    expect(() => renderCandidate({ version: '1.2.3', date: '2026-01-02', sections: [] })).toThrow(/no changelog entries/);
  });
});

describe('parseCurated', () => {
  test('reads the summary, upgrade items, and categories in page order', () => {
    const parsed = parseCurated(CURATED);
    expect(parsed).toMatchObject({ version: '1.2.3', date: '2026-01-02', upgrade: ['* Brokers restart once.'] });
    expect(parsed.summary).toBe('Adds a mode field to the Widget resource and fixes a label bug.');
    expect(parsed.categories.map((c) => c.title)).toEqual(['New features', 'Bug fixes']);
  });

  test.each([
    ['no heading', 'Summary.\n\n=== Bug fixes\n\n* x\n', /exactly one/],
    ['malformed heading', '== v1.2.3\n\nSummary.\n\n=== Bug fixes\n\n* x\n', /Malformed release heading/],
    ['no summary', '== v1.2.3 (2026-01-02)\n\n=== Bug fixes\n\n* x\n', /needs a one-sentence summary/],
    ['unknown heading', '== v1.2.3 (2026-01-02)\n\nS.\n\n=== Notes\n\n* x\n', /Unknown heading/],
    ['duplicate heading', '== v1.2.3 (2026-01-02)\n\nS.\n\n=== Bug fixes\n\n* x\n\n=== Bug fixes\n\n* y\n', /appears twice/],
    ['empty category', '== v1.2.3 (2026-01-02)\n\nS.\n\n=== Bug fixes\n\ntext\n', /has no/],
    ['only upgrade notes', '== v1.2.3 (2026-01-02)\n\nS.\n\n=== Before you upgrade\n\n* x\n', /at least one category/],
    ['prose in upgrade notes', '== v1.2.3 (2026-01-02)\n\nS.\n\n=== Before you upgrade\n\n* x\nmore\n\n=== Bug fixes\n\n* y\n', /single-line/],
  ])('rejects %s', (_name, text, error) => expect(() => parseCurated(text)).toThrow(error));
});

describe('findLeaks', () => {
  test.each([
    ['a private link', 'See https://github.com/redpanda-data/redpanda-operator/pull/1.', 'private link'],
    ['a private link in code', 'Run `kubectl kustomize github.com/redpanda-data/redpanda-operator//x`.', 'private link'],
    ['an issue number', 'Same fix as #1511.', 'issue or pull request number'],
    ['a cross-repo issue number', 'Caused by redpanda#31057.', 'issue or pull request number'],
    ['a ticket key', 'Tracked in K8S-843.', 'ticket key'],
    ['an author handle', 'Fixed by @someone.', 'author handle'],
    ['a compare link', '*Full Changelog*: v1...v2', 'compare link'],
  ])('flags %s', (_name, text, kind) => {
    expect(findLeaks(text).map((f) => f.kind)).toContain(kind);
  });

  test('ignores comments, listings, code spans, and public identifiers', () => {
    const text = [
      '// release-notes-source: operator/v1.2.3 sha256=abc',
      'Fixes CVE-2026-1111. Set `#42` or `K8S-1`. Mail ops@example.com.',
      '----',
      'helm upgrade x --set a=#1',
      '----',
    ].join('\n');
    expect(findLeaks(text)).toEqual([]);
  });
});

describe('findUnsupported', () => {
  test('passes spans and versions the source has', () => {
    expect(findUnsupported(CURATED, BODY, '1.2.3')).toEqual([]);
    expect(findUnsupported('Set `\\{name}`.', BODY, '1.2.3')).toEqual([]);
  });

  test('flags an invented identifier and an invented version', () => {
    expect(findUnsupported('* Set `spec.made.up` on v9.9.9.', BODY, '1.2.3')).toEqual(['`spec.made.up`', 'v9.9.9']);
  });
});

describe('assembleSection', () => {
  test('adds the anchor, source line, callout, and pinned command', () => {
    expect(assemble()).toBe([
      '[#v1-2-3]',
      '== v1.2.3 (2026-01-02)',
      `// release-notes-source: operator/v1.2.3 sha256=${hashBody(BODY)}`,
      '',
      'Adds a mode field to the Widget resource and fixes a label bug.',
      '',
      '.Before you upgrade',
      '[IMPORTANT]',
      '====',
      '* Brokers restart once.',
      '====',
      '',
      '.Install or upgrade to this version',
      '[,bash]',
      '----',
      'helm repo update',
      'helm upgrade --install redpanda-controller redpanda/operator \\',
      '  --namespace <namespace> \\',
      '  --create-namespace \\',
      '  --version 1.2.3 \\',
      '  --set crds.enabled=true',
      '----',
      '',
      'Add your existing value overrides to the command. For the full procedure, see xref:upgrade:k-upgrade-operator.adoc[].',
      '',
      '=== New features',
      '',
      '* The Widget resource has a new `spec.mode` field.',
      '',
      '=== Bug fixes',
      '',
      '* The operator keeps the `app` label on every pool.',
      '',
    ].join('\n'));
  });

  test('states the default application version for a chart', () => {
    const chart = parseTag('charts/redpanda/v1.2.3');
    const section = assembleSection({
      curated: CURATED, tag: 'charts/redpanda/v1.2.3', version: '1.2.3', project: chart.project, sourceBody: BODY, appVersion: 'v1.2.9',
    });
    expect(section).toContain('helm upgrade --install redpanda redpanda/redpanda \\');
    expect(section).toContain('This chart deploys Redpanda v1.2.9 by default. Replace `<values-file>`');
  });

  test('omits the callout when there are no upgrade notes', () => {
    const curated = CURATED.replace('=== Before you upgrade\n\n* Brokers restart once.\n\n', '');
    expect(assemble(curated)).not.toContain('[IMPORTANT]');
  });

  test('rejects a version mismatch, a leak, and an invented identifier', () => {
    expect(() => assemble(CURATED.replace('v1.2.3', 'v1.2.4'))).toThrow(/does not match the requested tag/);
    expect(() => assemble(CURATED.replace('every pool.', 'every pool (K8S-123).'))).toThrow(/private systems: ticket key "K8S-123"/);
    expect(() => assemble(CURATED.replace('`spec.mode`', '`spec.other`'))).toThrow(/not in the release body: `spec.other`/);
  });
});

describe('updatePage', () => {
  const section = (version, date, summary, upgrade) => [
    `[#v${version.replace(/\./g, '-')}]`,
    `== v${version} (${date})`,
    `// release-notes-source: operator/v${version} sha256=${hashBody(version)}`,
    '',
    summary,
    '',
    ...(upgrade ? ['.Before you upgrade', '[IMPORTANT]', '====', '* Restart.', '====', ''] : []),
    '=== Bug fixes',
    '',
    '* A fix.',
    '',
  ].join('\n');

  test('inserts before the footer and builds the summary table', () => {
    const result = updatePage(PAGE, section('1.2.3', '2026-01-02', 'First | release.', true), hashBody('1.2.3'));
    expect(result).toMatchObject({ status: 'ok', action: 'inserted' });
    expect(result.content).toBe([
      '= Redpanda Operator Release Notes',
      ':page-toc-collapsible: true',
      '',
      'Intro.',
      '',
      SUMMARY_START,
      '[cols="2,7,2"]',
      '|===',
      '|Version |Highlights |Upgrade notes',
      '',
      '|<<v1-2-3,v1.2.3>> +',
      '2026-01-02',
      '|First \\| release.',
      '|<<v1-2-3,Yes>>',
      '',
      '|===',
      SUMMARY_END,
      '',
      section('1.2.3', '2026-01-02', 'First | release.', true).trimEnd(),
      '',
      '== Older versions',
      '',
      'Footer.',
      '',
    ].join('\n'));
  });

  test('keeps sections newest first whatever the insert order', () => {
    let content = PAGE;
    for (const v of ['1.2.3', '1.10.0', '1.2.10']) {
      content = updatePage(content, section(v, '2026-01-02', `Release ${v}.`), hashBody(v)).content;
    }
    expect(splitPage(content).sections.map((s) => s.version)).toEqual(['1.10.0', '1.2.10', '1.2.3']);
    expect(content.match(/^\|<<v[\d-]+,v[\d.]+>> \+$/gm)).toEqual(['|<<v1-10-0,v1.10.0>> +', '|<<v1-2-10,v1.2.10>> +', '|<<v1-2-3,v1.2.3>> +']);
    expect(content.endsWith('== Older versions\n\nFooter.\n')).toBe(true);
  });

  test('is a no-op for the same body and replaces the section for a changed body', () => {
    const first = updatePage(PAGE, section('1.2.3', '2026-01-02', 'Old summary.'), hashBody('1.2.3')).content;
    expect(updatePage(first, section('1.2.3', '2026-01-02', 'Old summary.'), hashBody('1.2.3')))
      .toMatchObject({ status: 'skipped' });
    const replaced = updatePage(first, section('1.2.3', '2026-01-03', 'New summary.'), hashBody('changed'));
    expect(replaced.action).toBe('replaced');
    expect(replaced.content).toContain('New summary.');
    expect(replaced.content).not.toContain('Old summary.');
    expect(splitPage(replaced.content).sections).toHaveLength(1);
  });

  test('works on a page with no footer', () => {
    const page = `= Title\n\n${SUMMARY_START}\n${SUMMARY_END}\n`;
    const result = updatePage(page, section('1.2.3', '2026-01-02', 'Only.'), hashBody('1.2.3'));
    expect(result.content.endsWith('* A fix.\n')).toBe(true);
  });

  test('needs the summary markers', () => {
    expect(() => updatePage('= Title\n', section('1.2.3', '2026-01-02', 'S.'), 'x')).toThrow(/release-summary:start/);
  });
});

describe('orchestration', () => {
  test('buildCandidate skips tags that are not published', () => {
    expect(buildCandidate({ tag: 'operator/v1.2.3-beta.1', date: '2026-01-02', body: BODY }).status).toBe('skipped');
    expect(buildCandidate({ tag: 'operator/v1.2.3', date: '2026-01-02', body: BODY }).unknownKinds).toEqual(['Security']);
  });

  test('publishSection updates the page and refuses a chart that is not published', () => {
    const args = { tag: 'operator/v1.2.3', curated: CURATED, sourceBody: BODY, pageContent: PAGE };
    const result = publishSection({ ...args, chartEntry: { version: '1.2.3', appVersion: 'v1.2.3' } });
    expect(result.action).toBe('inserted');
    expect(lintPage(result.content)).toEqual([]);
    expect(() => publishSection({ ...args, chartEntry: null })).toThrow(/not in the Helm index/);
  });

  test('waitForChart retries until the version is listed', async () => {
    const answers = [null, [{ version: '1.2.2', appVersion: 'v1' }], [{ version: '1.2.3', appVersion: 'v2' }]];
    const fetchEntries = jest.fn(async () => answers.shift());
    const sleep = jest.fn(async () => {});
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const found = await waitForChart({ chart: 'operator', version: '1.2.3', fetchEntries, waitSeconds: 600, intervalSeconds: 1, sleep });
    log.mockRestore();
    expect(found).toEqual({ version: '1.2.3', appVersion: 'v2' });
    expect(fetchEntries).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  test('waitForChart gives up when there is no wait', async () => {
    expect(await waitForChart({ chart: 'operator', version: '1.2.3', fetchEntries: async () => [] })).toBeNull();
  });
});

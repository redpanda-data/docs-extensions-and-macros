// All text here is invented. No changelog entry, issue number, or ticket key
// from a private repository belongs in this public repository.

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
  parseChanges,
  isFullyDeclared,
  declaredUpgradeNotes,
  changesToMarkdown,
} = require('../../tools/k8s-release-notes/changes');
const { hashSource, findMarkup, countEntries } = require('../../tools/k8s-release-notes/section');
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
  '* The operator no longer drops the `app` label (ABC-123). Same fix as #42, which covered widgets#7.',
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

// The same section without its own upgrade items, as curation writes it when
// the changelog entries declare every upgrade note.
const NO_UPGRADE = CURATED.replace('=== Before you upgrade\n\n* Brokers restart once.\n\n', '');

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

  test.each(['operator/v26.2.1-beta.3', 'tools/v1.1.0', 'charts/other/v0.1.0', 'v26.2.6', ''])(
    'returns null for %p', (tag) => expect(parseTag(tag)).toBeNull(),
  );
});

describe('stripPrivateReferences', () => {
  test('removes issue numbers, ticket keys, and private links, and tidies up', () => {
    expect(stripPrivateReferences('Fixed a crash (ABC-123) in the hook.')).toBe('Fixed a crash in the hook.');
    expect(stripPrivateReferences('caused by the widgets#99 wedge')).toBe('caused by the wedge');
    expect(stripPrivateReferences('See [the fix](https://github.com/redpanda-data/x/pull/9).')).toBe('See the fix.');
    expect(stripPrivateReferences('See https://github.com/redpanda-data/x/issues/9 for more.')).toBe('See for more.');
  });

  test('keeps public identifiers and code spans', () => {
    expect(stripPrivateReferences('Fixes CVE-2026-1111 and follows KIP-848.')).toBe('Fixes CVE-2026-1111 and follows KIP-848.');
    expect(stripPrivateReferences('Set `ABC-123` or `#42`.')).toBe('Set `ABC-123` or `#42`.');
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

describe('parseChangieBody list items', () => {
  test('bold inside a list item keeps the list marker and the bold', () => {
    const parsed = parseChangieBody('## [v1.2.3](https://example.com) - 2026-01-02\n### Fixed\n* A fix.\n\n  - Set **spec.mode** first\n  - Then restart\n');
    expect(parsed.sections[0].entries[0].details).toEqual([['** Set *spec.mode* first', '** Then restart']]);
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
    ['an issue number', 'Same fix as #42.', 'issue or pull request number'],
    ['a cross-repo issue number', 'Caused by widgets#99.', 'issue or pull request number'],
    ['a ticket key', 'Tracked in ABC-843.', 'ticket key'],
    ['an author handle', 'Fixed by @someone.', 'author handle'],
    ['a compare link', '*Full Changelog*: v1...v2', 'compare link'],
  ])('flags %s', (_name, text, kind) => {
    expect(findLeaks(text).map((f) => f.kind)).toContain(kind);
  });

  test('ignores comments, listings, code spans, and public identifiers', () => {
    const text = [
      '// release-notes-source: operator/v1.2.3 sha256=abc',
      'Fixes CVE-2026-1111. Set `#42` or `ABC-1`. Mail ops@example.com.',
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
      `// release-notes-source: operator/v1.2.3 sha256=${hashBody(BODY)} upgrade-notes=curated`,
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
      'helm repo add redpanda https://charts.redpanda.com',
      'helm repo update',
      'helm upgrade --install redpanda-controller redpanda/operator \\',
      '  --namespace <namespace> \\',
      '  --create-namespace \\',
      '  --version 1.2.3 \\',
      '  --set crds.enabled=true \\',
      '  --values <values-file>',
      '----',
      '',
      'Replace `<values-file>` with the file that holds your overrides. For the full procedure, see xref:upgrade:k-upgrade-operator.adoc[].',
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
    expect(() => assemble(CURATED.replace('every pool.', 'every pool (ABC-123).'))).toThrow(/private systems: ticket key "ABC-123"/);
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

  test('waitForChart retries inside a wait shorter than the interval', async () => {
    const answers = [[], [{ version: '1.2.3', appVersion: 'v2' }]];
    const fetchEntries = jest.fn(async () => answers.shift());
    const sleep = jest.fn(async () => {});
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const found = await waitForChart({ chart: 'operator', version: '1.2.3', fetchEntries, waitSeconds: 10, sleep });
    log.mockRestore();
    expect(found).toEqual({ version: '1.2.3', appVersion: 'v2' });
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep.mock.calls[0][0]).toBeGreaterThan(0);
    expect(sleep.mock.calls[0][0]).toBeLessThanOrEqual(10000);
  });

  test('waitForChart gives up when there is no wait', async () => {
    expect(await waitForChart({ chart: 'operator', version: '1.2.3', fetchEntries: async () => [] })).toBeNull();
  });
});

describe('structured entries (changes.json)', () => {
  const entry = (over) => ({
    kind: 'Fixed', body: 'The operator keeps the `app` label.', audience: 'public',
    upgrade: { note: null, action: null }, ...over,
  });
  const doc = (entries) => JSON.stringify({ schema: 1, tag: 'operator/v1.2.3', project: 'operator', version: 'v1.2.3', entries });
  const DECLARED = doc([
    entry({ kind: 'Added', body: 'Widget CRD: new `spec.mode` field.\n\nSet it to pick a mode.\n* not an entry' }),
    entry({
      upgrade: { note: 'Brokers restart once on upgrade.', action: 'Set `image.tag` first.' },
    }),
    entry({ kind: 'Changed', body: 'CI: forward the cache key.', audience: 'internal', upgrade: null }),
  ]);
  const PARTIAL = doc([
    entry({ upgrade: { note: 'The default mode changes.', action: null } }),
    entry({ kind: 'Added', body: 'Widget CRD: new `spec.mode` field.', audience: null, upgrade: null }),
  ]);
  const NOTE = '* Brokers restart once on upgrade. Set `image.tag` first.';

  test('parseChanges validates the document', () => {
    expect(parseChanges(DECLARED, 'operator/v1.2.3').entries).toHaveLength(3);
    expect(() => parseChanges('{', 'operator/v1.2.3')).toThrow(/not valid JSON/);
    expect(() => parseChanges(DECLARED.replace('"schema":1', '"schema":2'), 'operator/v1.2.3')).toThrow(/schema 2/);
    expect(() => parseChanges(DECLARED, 'operator/v9.9.9')).toThrow(/is for "operator\/v1.2.3"/);
    expect(() => parseChanges(doc([entry({ kind: 'Security' })]), 'operator/v1.2.3')).toThrow(/unknown kind/);
    expect(() => parseChanges(doc([entry({ audience: 'everyone' })]), 'operator/v1.2.3')).toThrow(/unknown audience/);
    expect(() => parseChanges(doc([entry({ upgrade: { note: null, action: 'Set `image.tag` first.' } })]), 'operator/v1.2.3'))
      .toThrow(/upgrade action but no upgrade note/);
    expect(() => parseChanges(doc([entry({ upgrade: ['restart-brokers'] })]), 'operator/v1.2.3'))
      .toThrow(/upgrade must be an object/);
  });

  test('internal entries are left out and upgrade notes come from the entries', () => {
    const parsed = parseChanges(DECLARED, 'operator/v1.2.3');
    expect(isFullyDeclared(parsed)).toBe(true);
    expect(declaredUpgradeNotes(parsed)).toEqual([NOTE]);
    const markdown = changesToMarkdown(parsed);
    expect(markdown).not.toContain('CI: forward');
    expect(markdown).toContain('### Added\n* Widget CRD: new `spec.mode` field.\n\n  Set it to pick a mode.\n  * not an entry\n### Fixed');
    expect(isFullyDeclared(parseChanges(PARTIAL, 'operator/v1.2.3'))).toBe(false);
  });

  test('the candidate lists declared notes and says who owns the list', () => {
    const declared = buildCandidate({ tag: 'operator/v1.2.3', date: '2026-01-02', body: '', changes: DECLARED }).section;
    expect(declared.startsWith(`== v1.2.3 (2026-01-02)\n\n// upgrade-notes: declared\n\n=== Before you upgrade\n\n${NOTE}\n\n=== New features\n\n// declared-public\n* Widget CRD`)).toBe(true);
    expect(declared).not.toContain('CI: forward');
    expect(declared.match(/^\* /gm)).toHaveLength(3);
    const partial = buildCandidate({ tag: 'operator/v1.2.3', date: '2026-01-02', body: '', changes: PARTIAL }).section;
    expect(partial).toContain('// upgrade-notes: partial');
    // Only the entry its engineer declared public is marked.
    expect(partial).toContain('=== New features\n\n* Widget CRD');
    expect(partial).toContain('=== Bug fixes\n\n// declared-public\n* The operator keeps');
    const none = buildCandidate({ tag: 'operator/v1.2.3', date: '2026-01-02', body: '', changes: doc([entry({})]) }).section;
    expect(none).toContain('// upgrade-notes: declared');
    expect(none).not.toContain('Before you upgrade');
  });

  const publish = (changes, curated) => publishSection({
    tag: 'operator/v1.2.3', curated, sourceBody: BODY, changes, pageContent: PAGE, chartEntry: { version: '1.2.3', appVersion: null },
  });
  const callout = (section) => section.split('====')[1].trim().split('\n');

  test('fully declared: the callout is the declared notes', () => {
    const result = publish(DECLARED, `// upgrade-notes: declared\n${NO_UPGRADE}`);
    expect(callout(result.section)).toEqual([NOTE]);
    expect(result.section).toContain(`sha256=${hashSource(BODY, DECLARED)} upgrade-notes=declared`);
    expect(result.section).not.toContain('// upgrade-notes:');
    const marked = publish(DECLARED, NO_UPGRADE.replace(/^\* /gm, '// declared-public\n* '));
    expect(marked.section).not.toContain('declared-public');
  });

  test('fully declared with no effects: no callout', () => {
    const curated = NO_UPGRADE.replace(/=== New features[^]*$/, '');
    expect(publish(doc([entry({})]), curated).section).not.toContain('[IMPORTANT]');
  });

  test('partly declared: declared notes first, then curated ones that are new', () => {
    const curated = CURATED.replace('* Brokers restart once.', '* The default mode changes.\n* Brokers restart once.');
    expect(callout(publish(PARTIAL, curated).section)).toEqual(['* The default mode changes.', '* Brokers restart once.']);
  });

  test('identifiers in a curated section may come from the entries', () => {
    const curated = NO_UPGRADE.replace('every pool.', 'every pool. Set `image.tag` first.');
    expect(() => publish(undefined, curated)).toThrow(/not in the release body: `image.tag`/);
    expect(publish(DECLARED, curated).status).toBe('ok');
  });

  test('a changed changes.json rebuilds the section', () => {
    const first = publish(DECLARED, NO_UPGRADE);
    const again = publishSection({
      tag: 'operator/v1.2.3', curated: NO_UPGRADE, sourceBody: BODY, changes: DECLARED, pageContent: first.content, chartEntry: { version: '1.2.3', appVersion: null },
    });
    expect(again.status).toBe('skipped');
    const changed = publishSection({
      tag: 'operator/v1.2.3', curated: NO_UPGRADE, sourceBody: BODY, changes: PARTIAL, pageContent: first.content, chartEntry: { version: '1.2.3', appVersion: null },
    });
    expect(changed.action).toBe('replaced');
    expect(hashSource(BODY)).toBe(hashBody(BODY));
  });
});

describe('checks added after review', () => {
  test('stripPrivateReferences keeps public terms and leaves untouched prose alone', () => {
    expect(stripPrivateReferences('Uses PKCS#12, DNS-01, KEP-1234 and C#7 (see note), well , spaced ( odd ).'))
      .toBe('Uses PKCS#12, DNS-01, KEP-1234 and C#7 (see note), well , spaced ( odd ).');
    expect(stripPrivateReferences('Bump the tool to v3.14.0 - https://github.com/redpanda-data/tool/releases/tag/v3.14.0'))
      .toBe('Bump the tool to v3.14.0');
    expect(stripPrivateReferences('Fixed in PR 1234 and issue 567 (#12, org/repo#3).')).toBe('Fixed in and.');
    expect(stripPrivateReferences('Clone git@github.com:redpanda-data/x.git or see acme.atlassian.net/browse/A-1.'))
      .toBe('Clone or see');
    expect(stripPrivateReferences('Run `kubectl kustomize github.com/redpanda-data/x//y` now.')).toBe('Run `kubectl kustomize` now.');
    expect(stripPrivateReferences('The top 5 issues are fixed.')).toBe('The top 5 issues are fixed.');
  });

  test.each([
    ['a private link in a listing', '----\ncurl https://raw.githubusercontent.com/redpanda-data/x/main/y\n----', 'private link'],
    ['a bare organization link', 'See github.com/redpanda-data/x.', 'private link'],
    ['an issue tracker link', 'See https://acme.atlassian.net/browse/A-1.', 'private link'],
    ['a chat link', 'Ask in https://acme.slack.com/archives/C1.', 'private link'],
    ['a pull request in words', 'Fixed in PR 1234.', 'issue or pull request number'],
  ])('findLeaks flags %s', (_name, text, kind) => {
    expect(findLeaks(text).map((f) => f.kind)).toContain(kind);
  });

  test('findLeaks keeps public terms that look like references', () => {
    expect(findLeaks('Uses PKCS#12 and DNS-01 with C#7, per KEP-1234.')).toEqual([]);
  });

  test.each([
    ['an include', 'include::partial$secret.adoc[]', 'block macro'],
    ['an image', 'image::https://example.com/x.png[]', 'block macro'],
    ['an inline link macro', 'See link:https://example.com[this].', 'inline macro'],
    ['an xref', 'See xref:manage:secret.adoc[this].', 'inline macro'],
    ['a passthrough', 'Text +++<script>x</script>+++ here.', 'passthrough'],
    ['an attribute entry', ':page-role: home', 'attribute entry'],
    ['a block attribute', '[source,subs="attributes"]', 'block attribute'],
    ['a block title', '.Before you upgrade', 'block title'],
    ['a sidebar', '****', 'block type'],
    ['a table', '|===', 'block type'],
    ['a cross reference', 'See <<other,this>>.', 'cross reference or anchor'],
    ['an unclosed example block', '.Details\n[%collapsible]\n====\ntext', 'unclosed block'],
    ['an unclosed listing', '----\ncode', 'unclosed block'],
  ])('findMarkup flags %s', (_name, text, kind) => {
    expect(findMarkup(text).map((f) => f.kind)).toContain(kind);
  });

  test('findMarkup accepts what the section format uses', () => {
    const text = '* An entry with `code` and *bold*.\n+\n.Details\n[%collapsible]\n====\nMore.\n\n[,yaml]\n----\ninclude::not-scanned[]\n----\n====\n* Next.\n+\n--\nOpen block.\n--';
    expect(findMarkup(text)).toEqual([]);
  });

  test('findUnsupported checks links, listing lines, and version suffixes', () => {
    const source = 'Based on 25.3.1. See https://docs.example.com/a. Run:\n```\nkubectl get pods -n redpanda\n```';
    expect(findUnsupported('A 25.3.1-based build. See https://docs.example.com/a.\n----\nkubectl get pods -n redpanda\n----', source, '1.2.3')).toEqual([]);
    expect(findUnsupported('Uses 25.3.1-rc1. See https://evil.example.com/x.\n----\nkubectl delete pods --all\n----', source, '1.2.3'))
      .toEqual(['listing line "kubectl delete pods --all"', '25.3.1-rc1', 'https://evil.example.com/x']);
  });

  test('a line that starts with // inside a listing is kept', () => {
    const curated = `${CURATED}+\n[,js]\n----\n// keep me\n----\n`;
    expect(() => assemble(curated)).toThrow(/listing line "\/\/ keep me"/);
    expect(assemble(curated, { sourceBody: `${BODY}\n// keep me\n` })).toContain('// keep me');
  });

  test('assembleSection rejects markup, a wrong date, and reports the mode', () => {
    expect(() => assemble(CURATED.replace('every pool.', 'every pool. See link:https://example.com[x].'))).toThrow(/markup that release notes do not allow: inline macro/);
    expect(() => assemble(CURATED, { date: '2026-01-03' })).toThrow(/release date is 2026-01-03/);
    expect(assemble(CURATED, { date: '2026-01-02' })).toContain('upgrade-notes=curated');
  });

  test('countEntries counts top-level entries only', () => {
    expect(countEntries(['* One.', '+', '.Details', '[%collapsible]', '====', '* not an entry', '====', '* Two.', '----', '* code', '----'])).toBe(2);
  });

  const entry = (over) => ({
    kind: 'Fixed', body: 'The operator keeps the `app` label.', audience: 'public',
    upgrade: { note: null, action: null }, ...over,
  });
  const doc = (entries) => JSON.stringify({ schema: 1, tag: 'operator/v1.2.3', project: 'operator', version: 'v1.2.3', entries });
  const publish = (changes, curated) => publishSection({
    tag: 'operator/v1.2.3', curated, sourceBody: BODY, changes, pageContent: PAGE, chartEntry: { version: '1.2.3', appVersion: null },
  });
  const ONLY_FIXES = NO_UPGRADE.replace(/=== New features[^]*$/, '');

  test('an upgrade note that cannot be published as written fails', () => {
    const withNote = (note) => doc([entry({ upgrade: { note, action: null } })]);
    expect(() => publish(withNote('Brokers restart (ABC-123).'), ONLY_FIXES)).toThrow(/cannot be published as written \(ticket key "ABC-123"\)/);
    expect(() => publish(withNote('See https://example.com/x.'), ONLY_FIXES)).toThrow(/cannot be published as written \(link/);
    expect(() => publish(withNote('Read include::x[] first.'), ONLY_FIXES)).not.toThrow();
    expect(() => publish(withNote('+++<b>x</b>+++ restarts.'), ONLY_FIXES)).toThrow(/passthrough/);
    expect(() => buildCandidate({ tag: 'operator/v1.2.3', date: '2026-01-02', body: '', changes: withNote('See #12.') })).toThrow(/issue or pull request number/);
  });

  test('text from an internal entry cannot come back through curation', () => {
    const changes = doc([entry({}), entry({ kind: 'Changed', body: 'Internal: set `SECRET_FLAG` in CI.', audience: 'internal', upgrade: null })]);
    const body = `${BODY}\n* Internal: set \`SECRET_FLAG\` in CI.\n`;
    const curated = ONLY_FIXES.replace('every pool.', 'every pool. Set `SECRET_FLAG`.');
    expect(() => publishSection({
      tag: 'operator/v1.2.3', curated, sourceBody: body, changes, pageContent: PAGE, chartEntry: { version: '1.2.3', appVersion: null },
    })).toThrow(/not in the published changelog entries: `SECRET_FLAG`/);
  });

  test('curation may not drop or merge an entry declared public', () => {
    const changes = doc([entry({}), entry({ body: 'The operator keeps the `app` label on restart.' })]);
    expect(() => publish(changes, ONLY_FIXES)).toThrow(/"=== Bug fixes" has 1 entries, but 2 changelog entries of that kind are declared public/);
    const undeclared = doc([entry({}), entry({ audience: null, upgrade: null })]);
    expect(publish(undeclared, ONLY_FIXES).status).toBe('ok');
  });

  test('a private link matches in any case and on document and tracker hosts', () => {
    for (const link of [
      'HTTPS://GitHub.com/Redpanda-Data/redpanda-operator/pull/9',
      'https://www.notion.so/acme/Plan-1',
      'https://acme.notion.site/Plan-1',
      'https://docs.google.com/document/d/1',
      'https://drive.google.com/file/d/1',
      'https://linear.app/acme/issue/A-1',
      'https://ACME.atlassian.net/browse/A-1',
      'https://acme.Slack.com/archives/C1',
      'https://Buildkite.com/acme/x/builds/1',
    ]) {
      expect(findLeaks(`See ${link} now.`).map((f) => f.kind)).toContain('private link');
      expect(stripPrivateReferences(`See ${link} now.`)).toBe('See now.');
    }
  });

  test('links to the public redpanda and console repositories are not private', () => {
    for (const text of [
      'See https://github.com/redpanda-data/redpanda/issues/9 now.',
      'See github.com/redpanda-data/console#readme now.',
      'See https://github.com/redpanda-data/redpanda?tab=x now.',
      '(https://github.com/redpanda-data/console)',
      '[x](https://github.com/redpanda-data/redpanda)',
      'Clone `github.com/redpanda-data/console`.',
      'https://github.com/redpanda-data/redpanda',
    ]) {
      expect(findLeaks(text)).toEqual([]);
      expect(stripPrivateReferences(text)).toBe(text);
    }
    for (const text of [
      'See https://github.com/redpanda-data/redpanda-operator/pull/9 now.',
      'See https://github.com/redpanda-data/console-private now.',
      'See https://github.com/redpanda-data/redpanda.git now.',
    ]) {
      expect(findLeaks(text).map((f) => f.kind)).toContain('private link');
    }
  });

  test.each([
    ['an attribute reference', 'Set {some-attr} first.'],
    ['an inline attribute entry', 'Text {set:sectnums} here.'],
    ['a counter', 'Step {counter:step}.'],
  ])('findMarkup flags %s', (_name, text) => {
    expect(findMarkup(text).map((f) => f.kind)).toContain('attribute reference');
  });

  test('findMarkup leaves escaped, code, and listing braces alone', () => {
    expect(findMarkup('Set \\{name} or `{name}` here.\n----\n{name}\n----')).toEqual([]);
    expect(() => assemble(CURATED.replace('every pool.', 'every pool with {set:sectnums}.'))).toThrow(/attribute reference "\{set:sectnums\}"/);
    expect(() => assemble(CURATED.replace('Adds a mode', 'Adds {product} a mode'))).toThrow(/attribute reference "\{product\}"/);
  });

  test('curation may not swap an entry declared public for an undeclared one', () => {
    const changes = doc([
      entry({}),
      entry({ body: 'Brokers now restart in order after a `spec.mode` change.', audience: null, upgrade: null }),
    ]);
    const kept = ONLY_FIXES.replace('* The operator keeps the `app` label on every pool.', '* Brokers restart in order after a `spec.mode` change.');
    expect(() => publish(changes, kept)).toThrow(/"=== Bug fixes" has no entry for "The operator keeps the `app` label\.", which is declared public/);
    const both = ONLY_FIXES.replace('* The operator keeps', '* Brokers restart in order after a `spec.mode` change.\n* The operator keeps');
    expect(publish(changes, both).status).toBe('ok');
  });

  test('fully declared: a curated upgrade item the entries do not declare fails', () => {
    const changes = doc([entry({ upgrade: { note: 'The default mode changes.', action: null } })]);
    const extra = CURATED.replace(/=== New features[^]*$/, '');
    expect(() => publish(changes, extra)).toThrow(/declare every upgrade note, so the curated section may not add any: "\* Brokers restart once\."/);
    const copied = extra.replace('* Brokers restart once.', '* The default mode changes.');
    expect(publish(changes, copied).section.split('====')[1].trim().split('\n')).toEqual(['* The default mode changes.']);
  });

  test('the operator command takes a values file, like the chart commands', () => {
    const section = assemble();
    expect(section).toContain('  --set crds.enabled=true \\\n  --values <values-file>\n----\n\nReplace `<values-file>` with the file that holds your overrides. For the full procedure, see xref:upgrade:k-upgrade-operator.adoc[].');
  });

  test('a release whose entries are all internal has nothing to publish', () => {
    const changes = doc([entry({ audience: 'internal', upgrade: null })]);
    expect(buildCandidate({ tag: 'operator/v1.2.3', date: '2026-01-02', body: '', changes })).toMatchObject({ status: 'empty' });
  });

  test('partly declared: a curated item that differs only in punctuation is not repeated', () => {
    const changes = doc([
      entry({ upgrade: { note: 'The default mode changes.', action: null } }),
      entry({ kind: 'Added', body: 'Widget CRD: new `spec.mode` field.', audience: null, upgrade: null }),
    ]);
    const curated = CURATED.replace('* Brokers restart once.', '* The default mode changes\n* Brokers restart once.');
    expect(publish(changes, curated).section.split('====')[1].trim().split('\n')).toEqual(['* The default mode changes.', '* Brokers restart once.']);
  });

  test('page: an anchored heading after the sections stays out of the last section', () => {
    const page = `= T\n\n${SUMMARY_START}\n${SUMMARY_END}\n\n[#older]\n== Older versions\n\nFooter.\n`;
    const section = '[#v1-2-3]\n== v1.2.3 (2026-01-02)\n// release-notes-source: operator/v1.2.3 sha256=' + hashBody('x') + ' upgrade-notes=declared\n\nSummary.\n\n=== Bug fixes\n\n* A fix.\n';
    const first = updatePage(page, section, hashBody('x'));
    expect(first.content.endsWith('* A fix.\n\n[#older]\n== Older versions\n\nFooter.\n')).toBe(true);
    expect(updatePage(first.content, section, hashBody('x')).status).toBe('skipped');
    const again = updatePage(first.content, section.replace('Summary.', 'New.'), hashBody('y'));
    expect(again.content.match(/\[#older\]/g)).toHaveLength(1);
  });

  test('page: a section with no summary paragraph gets an empty highlights cell', () => {
    const page = `= T\n\n${SUMMARY_START}\n${SUMMARY_END}\n`;
    const section = '== v1.2.3 (2026-01-02)\n\n=== Bug fixes\n\n* A fix.\n';
    expect(updatePage(page, section, 'x').content).toContain('2026-01-02\n|\n|No');
  });

  test('parseChangieBody keeps fence indentation and unusual info strings', () => {
    const body = '### Fixed\n* Lead.\n\n  ```yaml title="x"\n  a:\n    b: 1\n  ```\n* Next.\n  - sub one\n  - sub two\n';
    const [first, second] = parseChangieBody(body).sections[0].entries;
    expect(first.details[0]).toEqual(['[,yaml]', '----', 'a:', '  b: 1', '----']);
    expect(second.lead).toBe('Next.');
    expect(second.details[0]).toEqual(['** sub one', '** sub two']);
  });
});

describe('listing blocks close only on their own delimiter', () => {
  const { findLeaks, findMarkup } = require('../../tools/k8s-release-notes/section')
  it('keeps a .... line inside a ---- block as content', () => {
    const text = ['[,bash]', '----', '....', '----', 'See @someone.'].join('\n')
    expect(findLeaks(text).map(f => f.kind)).toContain('author handle')
    expect(findMarkup(text).filter(f => f.kind === 'unclosed block')).toHaveLength(0)
  })
  it('reports a block left open with the delimiter that opened it', () => {
    expect(findMarkup(['....', 'x'].join('\n'))).toContainEqual(expect.objectContaining({ kind: 'unclosed block', match: '....' }))
  })
})

const { renderReleaseSection, normalizeVersion } = require('../../tools/redpanda-release-notes/render-release-notes');

const sampleSections = [
  { kind: 'feature', title: 'Features', entries: ['X now supports Y.'] },
  { kind: 'fix', title: 'Bug fixes', entries: ['V no longer crashes.'] },
  { kind: 'improvement', title: 'Improvements', entries: ['Z is faster.', 'W uses less memory.'] },
];

describe('normalizeVersion', () => {
  it('strips a leading v', () => {
    expect(normalizeVersion('v26.2.3')).toBe('26.2.3');
    expect(normalizeVersion('26.2.3')).toBe('26.2.3');
  });
});

describe('renderReleaseSection', () => {
  it('renders the version heading with the authored date', () => {
    const out = renderReleaseSection({ version: 'v26.2.3', date: '2026-09-15', sections: sampleSections });
    expect(out).toContain('== v26.2.3 (2026-09-15)');
  });

  it('emits the three subsections in order with plain bullets', () => {
    const out = renderReleaseSection({ version: '26.2.3', date: '2026-09-15', sections: sampleSections });
    const featuresIdx = out.indexOf('=== Features');
    const fixesIdx = out.indexOf('=== Bug fixes');
    const improvementsIdx = out.indexOf('=== Improvements');
    expect(featuresIdx).toBeGreaterThan(-1);
    expect(fixesIdx).toBeGreaterThan(featuresIdx);
    expect(improvementsIdx).toBeGreaterThan(fixesIdx);
    expect(out).toContain('* X now supports Y.');
    expect(out).toContain('* W uses less memory.');
  });

  it('adds no Area:: label (that is the curation step)', () => {
    const out = renderReleaseSection({ version: '26.2.3', date: '2026-09-15', sections: sampleSections });
    expect(out).not.toMatch(/::/);
  });

  it('ends with exactly one trailing newline', () => {
    const out = renderReleaseSection({ version: '26.2.3', date: '2026-09-15', sections: sampleSections });
    expect(out.endsWith('\n')).toBe(true);
    expect(out.endsWith('\n\n')).toBe(false);
  });

  it('omits a category with no entries', () => {
    const out = renderReleaseSection({
      version: '26.2.3', date: '2026-09-15',
      sections: [{ kind: 'feature', title: 'Features', entries: ['Only a feature.'] }],
    });
    expect(out).toContain('=== Features');
    expect(out).not.toContain('=== Improvements');
    expect(out).not.toContain('=== Bug fixes');
  });

  it('rejects a malformed version', () => {
    expect(() => renderReleaseSection({ version: '26.2', date: '2026-09-15', sections: sampleSections }))
      .toThrow(/version/i);
  });

  it('rejects a malformed date', () => {
    expect(() => renderReleaseSection({ version: '26.2.3', date: 'Sept 15', sections: sampleSections }))
      .toThrow(/date/i);
  });
});

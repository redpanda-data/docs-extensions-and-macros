'use strict';

const asciidoctor = require('@asciidoctor/core')();
const {
  wrapForAudience,
  wrapBothAudiences,
  findGluedConditionals,
} = require('../../../tools/property-extractor/helpers/audienceScope');
const applyPropertyLinks = require('../../../tools/property-extractor/helpers/applyPropertyLinks');

function render (adoc, { cloud }) {
  return asciidoctor.convert(adoc, { attributes: cloud ? { 'env-cloud': '' } : {}, safe: 'safe' });
}

function paragraphs (html) {
  return [...html.matchAll(/<div class="paragraph">\s*<p>([\s\S]*?)<\/p>/g)]
    .map((m) => m[1].replace(/<[^>]+>/g, '').trim())
    .filter(Boolean);
}

/**
 * The detector the corpus test relies on, in isolation: a paragraph in one
 * build that is two separate paragraphs in the other.
 */
function mergedParagraphs (adoc) {
  const cloud = paragraphs(render(adoc, { cloud: true }));
  const self = paragraphs(render(adoc, { cloud: false }));
  const found = [];
  const check = (from, other) => {
    const otherSet = new Set(other);
    for (const paragraph of from) {
      if (!paragraph.includes('\n')) continue;
      const pieces = paragraph.split('\n').map((s) => s.trim()).filter(Boolean);
      if (pieces.length > 1 && pieces.every((piece) => otherSet.has(piece))) found.push(paragraph);
    }
  };
  check(cloud, self);
  check(self, cloud);
  return found;
}

// Measured behaviour, not assumed. A conditional is resolved by the
// preprocessor, so one glued to neighbouring prose leaves those lines adjacent
// and Asciidoctor merges them into a single paragraph. The fourth row is the
// dangerous one: wrapping a delimited block renders correctly with the
// attribute set and merges the neighbours with it unset, so a self-managed
// preview can look right while Cloud is broken -- or the reverse.
describe('what a glued conditional actually does', () => {
  const GLUED_PROSE = 'Base prose.\nifdef::env-cloud[]\nCloud sentence.\nendif::[]\nTail.';
  const SPACED_PROSE = 'Base prose.\n\nifdef::env-cloud[]\nCloud sentence.\nendif::[]\n\nTail.';
  const GLUED_BLOCK = 'Base prose.\nifdef::env-cloud[]\n[NOTE]\n====\nCloud note.\n====\nendif::[]\nTail.';

  it('merges three paragraphs into one when the attribute is set', () => {
    expect(paragraphs(render(GLUED_PROSE, { cloud: true }))).toEqual(['Base prose.\nCloud sentence.\nTail.']);
  });

  it('merges two paragraphs into one when the attribute is unset', () => {
    expect(paragraphs(render(GLUED_PROSE, { cloud: false }))).toEqual(['Base prose.\nTail.']);
  });

  it('keeps paragraphs separate in both builds once blank-line separated', () => {
    expect(paragraphs(render(SPACED_PROSE, { cloud: true })))
      .toEqual(['Base prose.', 'Cloud sentence.', 'Tail.']);
    expect(paragraphs(render(SPACED_PROSE, { cloud: false })))
      .toEqual(['Base prose.', 'Tail.']);
  });

  it('breaks only one build when the conditional wraps a delimited block', () => {
    // Set: the block delimiters terminate the paragraph, so it reads correctly.
    expect(paragraphs(render(GLUED_BLOCK, { cloud: true }))).toEqual(['Base prose.', 'Cloud note.', 'Tail.']);
    // Unset: the block is gone and the neighbours run together.
    expect(paragraphs(render(GLUED_BLOCK, { cloud: false }))).toEqual(['Base prose.\nTail.']);
  });
});

// A guard that cannot fail is not a guard. These prove the corpus test's
// detectors fire before that test's green is taken to mean anything.
// A guard that cannot fail is not a guard. These prove both detectors fire
// before the corpus test's green is taken to mean anything -- and they pin which
// detector catches which case, because neither one catches both.
describe('the merged-paragraph detector catches asymmetric merges', () => {
  it('flags a glued conditional around a delimited block', () => {
    // Renders correctly with the attribute set and merges with it unset, so the
    // two renders disagree and the cross-branch check sees it.
    expect(mergedParagraphs('Base prose.\nifdef::env-cloud[]\n[NOTE]\n====\nCloud note.\n====\nendif::[]\nTail.'))
      .toEqual(['Base prose.\nTail.']);
  });

  it('cannot see glued prose, because both builds merge identically', () => {
    // Set: "Base prose. / Cloud sentence. / Tail." all run together.
    // Unset: "Base prose. / Tail." run together.
    // Neither render contains the other's separate paragraphs, so comparing the
    // two reports nothing. This is why the source-level check below exists.
    expect(mergedParagraphs('Base prose.\nifdef::env-cloud[]\nCloud sentence.\nendif::[]\nTail.')).toEqual([]);
  });

  it('passes correctly spaced output', () => {
    expect(mergedParagraphs('Base prose.\n\nifdef::env-cloud[]\nCloud sentence.\nendif::[]\n\nTail.')).toEqual([]);
  });

  it('does not flag an ordinary multi-line paragraph', () => {
    // Source prose wrapped across lines renders with the newline inside the
    // paragraph, which must not read as a merge.
    expect(mergedParagraphs('A sentence\nwrapped over two lines.')).toEqual([]);
  });
});

describe('the source-level detector catches the symmetric case', () => {
  it('flags glued prose on both sides', () => {
    expect(findGluedConditionals('Base prose.\nifdef::env-cloud[]\nCloud sentence.\nendif::[]\nTail.'))
      .toEqual([
        { line: 2, directive: 'ifdef::env-cloud[]', neighbour: 'Base prose.', side: 'before' },
        { line: 4, directive: 'endif::[]', neighbour: 'Tail.', side: 'after' },
      ]);
  });

  it('passes correctly spaced prose', () => {
    expect(findGluedConditionals('Base prose.\n\nifdef::env-cloud[]\nX\nendif::[]\n\nTail.')).toEqual([]);
  });

  it('leaves the table-row conditionals the templates have always emitted alone', () => {
    const row = [
      '| Default', '|', 'ifdef::env-cloud[]', 'Available in the Redpanda Cloud Console', 'endif::[]',
      'ifndef::env-cloud[]', '`50000`', 'endif::[]', '', '| Nullable',
    ].join('\n');
    expect(findGluedConditionals(row)).toEqual([]);
  });

  it('leaves a conditional wrapping a titled admonition block alone', () => {
    const block = [
      '', 'ifndef::env-cloud[]', '.Enterprise license required', '[NOTE]', '====',
      'Some values require a license.', '====', 'endif::[]', '',
    ].join('\n');
    expect(findGluedConditionals(block)).toEqual([]);
  });

  it('flags a conditional the generator produced glued, via applyPropertyLinks', () => {
    const props = { bad: { name: 'bad', config_scope: 'cluster', description: 'Prose.\nifdef::env-cloud[]\nCloud.\nendif::[]\nTail.' } };
    const result = applyPropertyLinks(props);
    expect(result.warnings).toEqual([
      expect.stringContaining('bad: description has ifdef::env-cloud[] with no blank line before it'),
      expect.stringContaining('bad: description has endif::[] with no blank line after it'),
    ]);
  });
});

describe('the emitters produce blank-line separated output', () => {
  it('wrapForAudience pads both sides', () => {
    expect(wrapForAudience('body', { cloudOnly: true, selfHostedOnly: false }))
      .toBe('\nifdef::env-cloud[]\nbody\nendif::[]\n');
  });

  it('wrapForAudience leaves unscoped content alone', () => {
    expect(wrapForAudience('body', { cloudOnly: false, selfHostedOnly: false })).toBe('body');
  });

  it('wrapBothAudiences emits the cloud branch first and pads both sides', () => {
    expect(wrapBothAudiences('c', 's').split('\n'))
      .toEqual(['', 'ifdef::env-cloud[]', 'c', 'endif::[]', 'ifndef::env-cloud[]', 's', 'endif::[]', '']);
  });

  it('wrapBothAudiences emits no conditional when the branches are identical', () => {
    expect(wrapBothAudiences('same', 'same')).toBe('same');
  });

  it('renders an audience-scoped link without merging the surrounding paragraphs', () => {
    const props = {
      target: { name: 'target', config_scope: 'cluster' },
      subject: {
        name: 'subject',
        config_scope: 'cluster',
        description: 'Leading paragraph.\n\nStart Redpanda in recovery mode for this.\n\nTrailing paragraph.',
        links: { 'recovery mode': 'self-managed-only: xref:manage:recovery-mode.adoc' },
      },
    };
    applyPropertyLinks(props);
    expect(mergedParagraphs(props.subject.description)).toEqual([]);
    expect(paragraphs(render(props.subject.description, { cloud: true })))
      .toEqual(['Leading paragraph.', 'Start Redpanda in recovery mode for this.', 'Trailing paragraph.']);
    expect(paragraphs(render(props.subject.description, { cloud: false })))
      .toEqual(['Leading paragraph.', 'Start Redpanda in recovery mode for this.', 'Trailing paragraph.']);
    // Cloud keeps the words and drops the link it cannot follow.
    expect(render(props.subject.description, { cloud: true })).not.toMatch(/recovery-mode/);
    expect(render(props.subject.description, { cloud: false })).toMatch(/recovery-mode/);
  });
});

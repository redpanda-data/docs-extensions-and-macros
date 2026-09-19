'use strict';

const applyPropertyLinks = require('../../../tools/property-extractor/helpers/applyPropertyLinks');
const { flattenDescription, renderLink, resolveLinkSpecs } =
  require('../../../tools/property-extractor/helpers/applyPropertyLinks');

/** A minimal two-property map: a subject that carries links, and a target. */
function corpus (subject, extra = {}) {
  return {
    rpc_server: { name: 'rpc_server', config_scope: 'broker' },
    subject: { name: 'subject', config_scope: 'broker', ...subject },
    ...extra,
  };
}

describe('link target forms', () => {
  it('emits a prop macro for a #property target', () => {
    const props = corpus({
      description: 'If not set, the `rpc_server` broker property is used.',
      links: { '`rpc_server`': '#rpc_server' },
    });
    applyPropertyLinks(props);
    // No text= : the display text is the property name, so the macro's own
    // default renders it.
    expect(props.subject.description)
      .toBe('If not set, the prop:rpc_server[link=true] broker property is used.');
  });

  it('adds text= when the display text differs from the property name', () => {
    const props = corpus({
      description: 'See the RPC server setting for this.',
      links: { 'RPC server setting': '#rpc_server' },
    });
    applyPropertyLinks(props);
    expect(props.subject.description)
      .toBe('See the prop:rpc_server[link=true,text=RPC server setting] for this.');
  });

  it('quotes a text= value containing a comma', () => {
    // An unquoted comma ends the attribute early and the remainder becomes
    // stray positional attributes on the macro.
    expect(renderLink({ kind: 'property', targetName: 'rpc_server', display: 'address, port' }))
      .toBe('prop:rpc_server[link=true,text="address, port"]');
  });

  it('emits a literal xref for an xref: target, keying the link text on the matched words', () => {
    const props = corpus({
      description: 'Start Redpanda in recovery mode to do this.',
      links: { 'recovery mode': 'xref:manage:recovery-mode.adoc' },
    });
    applyPropertyLinks(props);
    expect(props.subject.description)
      .toBe('Start Redpanda in xref:manage:recovery-mode.adoc[recovery mode] to do this.');
  });

  it('canonicalizes a property-page xref target', () => {
    const props = corpus({
      description: 'See cloud_storage_enabled for details.',
      links: { cloud_storage_enabled: 'xref:reference:cluster-properties.adoc#cloud_storage_enabled' },
    });
    applyPropertyLinks(props);
    // The bare reference: form resolves to the module root, where these pages
    // no longer live; self-managed papers over it with an alias and cloud-docs
    // does not.
    expect(props.subject.description).toContain('xref:reference:properties/cluster-properties.adoc#cloud_storage_enabled[');
  });
});

describe('what is refused', () => {
  it('warns and leaves plain text for a #target that is not a known property', () => {
    const props = corpus({ description: 'See `nope` here.', links: { '`nope`': '#nope' } });
    const result = applyPropertyLinks(props);
    // A prop macro for an unverifiable name publishes as literal macro text.
    expect(props.subject.description).toBe('See `nope` here.');
    expect(result.warnings).toEqual([
      expect.stringContaining('targets #nope, which is not a known property'),
    ]);
  });

  it('reports a key that matches no prose', () => {
    const props = corpus({ description: 'Nothing to match.', links: { absent: '#rpc_server' } });
    const result = applyPropertyLinks(props);
    expect(result.unmatched).toEqual([{ property: 'subject', key: 'absent' }]);
    expect(result.applied).toBe(0);
  });

  it('rejects a target that is neither #name nor xref:', () => {
    const props = corpus({ description: 'See docs.', links: { docs: 'https://example.com' } });
    const result = applyPropertyLinks(props);
    expect(props.subject.description).toBe('See docs.');
    expect(result.warnings).toEqual([
      expect.stringContaining('is not "#<property_name>", "xref:..." or "glossterm"'),
    ]);
  });

  it('refuses to audience-scope a link that matches inside a delimited block', () => {
    // Duplicating the paragraph would put a conditional between the delimiters
    // and split the block across two branches, breaking it in both.
    const props = corpus({
      description: 'Intro.\n\n----\nrpc_server: 0.0.0.0\n----',
      links: { rpc_server: 'self-managed-only: #rpc_server' },
    });
    const result = applyPropertyLinks(props);
    expect(props.subject.description).toBe('Intro.\n\n----\nrpc_server: 0.0.0.0\n----');
    expect(result.warnings).toEqual([expect.stringContaining('matches inside a delimited block in description')]);
  });

  it('drops an admonition that sets both scopes', () => {
    const props = corpus({ admonitions: [{ type: 'NOTE', text: 't', cloud_only: true, self_managed_only: true }] });
    const result = applyPropertyLinks(props);
    expect(props.subject.admonitions).toEqual([]);
    expect(result.warnings).toEqual([expect.stringContaining('would render in neither build')]);
  });
});

describe('substitution behaviour', () => {
  it('links only the first occurrence of a key', () => {
    const props = corpus({
      description: 'Set `rpc_server` first. Then check `rpc_server` again.',
      links: { '`rpc_server`': '#rpc_server' },
    });
    applyPropertyLinks(props);
    expect(props.subject.description)
      .toBe('Set prop:rpc_server[link=true] first. Then check `rpc_server` again.');
  });

  it('prefers the longest key, so a shorter one cannot steal the match', () => {
    const props = {
      cloud_storage: { name: 'cloud_storage', config_scope: 'cluster' },
      cloud_storage_enabled: { name: 'cloud_storage_enabled', config_scope: 'cluster' },
      subject: {
        name: 'subject',
        config_scope: 'cluster',
        description: 'Requires `cloud_storage_enabled`.',
        links: { '`cloud_storage`': '#cloud_storage', '`cloud_storage_enabled`': '#cloud_storage_enabled' },
      },
    };
    const result = applyPropertyLinks(props);
    expect(props.subject.description).toBe('Requires prop:cloud_storage_enabled[link=true].');
    expect(result.unmatched).toEqual([{ property: 'subject', key: '`cloud_storage`' }]);
  });

  it('links the first occurrence in each surface, not just the first overall', () => {
    // Each surface is its own reading context. advertised_kafka_api carried the
    // `kafka_api` anchor in its sentence and again in its example bullet before
    // docs #1965 stripped both.
    const props = corpus({
      description: 'If not set, the `rpc_server` broker property is used.',
      example: ['* `<name>`: Name that matches your `rpc_server` listener'],
      links: { '`rpc_server`': '#rpc_server' },
    });
    const result = applyPropertyLinks(props);
    expect(props.subject.description).toContain('prop:rpc_server[link=true]');
    expect(props.subject.example).toContain('prop:rpc_server[link=true]');
    expect(result.applied).toBe(2);
    expect(result.unmatched).toEqual([]);
  });

  it('substitutes into example lines and admonition text', () => {
    const props = corpus({
      description: 'No match here.',
      example: ['[,yaml]', '----', 'redpanda:', '----', '', '* Matches your `rpc_server` listener'],
      admonitions: [{ type: 'NOTE', text: 'Also set `rpc_server`.' }],
      links: { '`rpc_server`': '#rpc_server' },
    });
    applyPropertyLinks(props);
    // Joined back to a string, which is the shape property.hbs can render.
    expect(props.subject.example.split('\n')[5])
      .toBe('* Matches your prop:rpc_server[link=true] listener');
    expect(props.subject.admonitions[0].text).toBe('Also set prop:rpc_server[link=true].');
  });

  it('duplicates only the containing paragraph for an audience-scoped link', () => {
    const props = corpus({
      description: 'Leading paragraph.\n\nStart in recovery mode.\n\nTrailing paragraph.',
      links: { 'recovery mode': 'self-managed-only: xref:manage:recovery-mode.adoc' },
    });
    applyPropertyLinks(props);
    expect(props.subject.description).toBe(
      'Leading paragraph.\n\n' +
      '\nifdef::env-cloud[]\nStart in recovery mode.\nendif::[]\n' +
      'ifndef::env-cloud[]\nStart in xref:manage:recovery-mode.adoc[recovery mode].\nendif::[]\n' +
      '\n\nTrailing paragraph.'
    );
  });

  it('warns when a Cloud-published property links to one Cloud does not publish', () => {
    const props = {
      hidden: { name: 'hidden', config_scope: 'cluster', cloud_supported: false },
      subject: {
        name: 'subject',
        config_scope: 'cluster',
        cloud_supported: true,
        description: 'Works with `hidden`.',
        links: { '`hidden`': '#hidden' },
      },
    };
    const result = applyPropertyLinks(props);
    expect(result.warnings).toEqual([
      expect.stringContaining('Prefix the target with "self-managed-only:"'),
    ]);
  });

  it('warns when a Cloud-published property links to a topic or broker property', () => {
    // Not readable off cloud_supported: the install pack annotates cluster
    // scope only, so a topic or broker property has no such field. Cloud
    // publishes neither page, so the link dangles there regardless.
    for (const scope of ['topic', 'broker']) {
      const props = {
        other: { name: 'other', config_scope: scope },
        subject: {
          name: 'subject',
          config_scope: 'cluster',
          cloud_supported: true,
          description: 'Overridden per topic by `other`.',
          links: { '`other`': '#other' },
        },
      };
      expect(applyPropertyLinks(props).warnings).toEqual([
        expect.stringContaining(`Cloud publishes no ${scope} properties page`),
      ]);
    }
  });

  it('does not warn when the referring property is not Cloud-published', () => {
    const props = {
      other: { name: 'other', config_scope: 'topic' },
      subject: {
        name: 'subject',
        config_scope: 'cluster',
        cloud_supported: false,
        description: 'Overridden per topic by `other`.',
        links: { '`other`': '#other' },
      },
    };
    // Neither end is published in Cloud, so there is nothing to degrade.
    expect(applyPropertyLinks(props).warnings).toEqual([]);
  });

  it('does not warn when the link is already audience-scoped', () => {
    const props = {
      hidden: { name: 'hidden', config_scope: 'cluster', cloud_supported: false },
      subject: {
        name: 'subject',
        config_scope: 'cluster',
        cloud_supported: true,
        description: 'Works with `hidden`.',
        links: { '`hidden`': 'self-managed-only: #hidden' },
      },
    };
    expect(applyPropertyLinks(props).warnings).toEqual([]);
  });
});

describe('flattenDescription', () => {
  it('passes a string through untouched', () => {
    expect(flattenDescription('plain prose')).toBe('plain prose');
  });

  it('joins unconditional paragraphs with a blank line', () => {
    expect(flattenDescription(['one', 'two'])).toBe('one\n\ntwo');
  });

  it('wraps a scoped paragraph in the matching conditional', () => {
    expect(flattenDescription(['shared', 'cloud-only: cloud bit', 'self-managed-only: sm bit'])).toBe(
      'shared\n\n' +
      'ifdef::env-cloud[]\ncloud bit\nendif::[]\n\n' +
      'ifndef::env-cloud[]\nsm bit\nendif::[]'
    );
  });

  it('drops empty paragraphs', () => {
    expect(flattenDescription(['one', '', '   ', 'two'])).toBe('one\n\ntwo');
  });
});

describe('resolveLinkSpecs', () => {
  it('skips an entry with an empty key or target', () => {
    const { specs, warnings } = resolveLinkSpecs('p', { '': '#rpc_server', ok: '' }, { rpc_server: {} });
    expect(specs).toEqual([]);
    expect(warnings).toHaveLength(2);
  });

  it('ignores a links value that is not an object', () => {
    expect(resolveLinkSpecs('p', ['#rpc_server'], {}).specs).toEqual([]);
    expect(resolveLinkSpecs('p', 'nope', {}).specs).toEqual([]);
  });
});

describe('glossterm targets', () => {
  it('wraps the key in a glossary tooltip, with the key as the term', () => {
    // The macro takes the term as its target and looks the definition up in the
    // glossary, so the payload stays empty and the displayed text is the term.
    const props = corpus({
      description: 'Network address for the Admin API server.',
      links: { 'Admin API': 'glossterm' },
    });
    applyPropertyLinks(props);
    expect(props.subject.description).toBe('Network address for the glossterm:Admin API[] server.');
  });

  it('takes an explicit term when the prose says something else', () => {
    const props = corpus({
      description: 'The length of time that a consensus group is muted.',
      links: { 'consensus group': 'glossterm:Raft' },
    });
    applyPropertyLinks(props);
    expect(props.subject.description).toBe('The length of time that a glossterm:Raft[] is muted.');
  });

  it('refuses a glossterm target with no term', () => {
    const props = corpus({ description: 'See it.', links: { 'it': 'glossterm:' } });
    const result = applyPropertyLinks(props);
    expect(props.subject.description).toBe('See it.');
    expect(result.warnings).toEqual([expect.stringContaining('glossterm target with no term')]);
  });
});

describe('includes', () => {
  const { normalizeIncludes } = require('../../../tools/property-extractor/helpers/applyPropertyLinks');

  it('adds the empty brackets the directive needs', () => {
    const warnings = [];
    expect(normalizeIncludes('p', ['reference:partial$internal-use-property.adoc'], warnings))
      .toEqual([{ target: 'reference:partial$internal-use-property.adoc[]' }]);
    expect(warnings).toEqual([]);
  });

  it('keeps attributes the author supplied', () => {
    expect(normalizeIncludes('p', ['reference:partial$x.adoc[leveloffset=+1]'], []))
      .toEqual([{ target: 'reference:partial$x.adoc[leveloffset=+1]' }]);
  });

  it('tolerates a value that already carries the directive', () => {
    expect(normalizeIncludes('p', ['include::reference:partial$x.adoc[]'], []))
      .toEqual([{ target: 'reference:partial$x.adoc[]' }]);
  });

  it('carries the audience scope', () => {
    expect(normalizeIncludes('p', ['self-managed-only: shared:partial$x.adoc'], []))
      .toEqual([{ target: 'shared:partial$x.adoc[]', self_managed_only: true }]);
    expect(normalizeIncludes('p', ['cloud-only: shared:partial$x.adoc'], []))
      .toEqual([{ target: 'shared:partial$x.adoc[]', cloud_only: true }]);
  });

  it('accepts a bare string as well as an array', () => {
    expect(normalizeIncludes('p', 'reference:partial$x.adoc', [])).toHaveLength(1);
  });

  it('warns when the value does not look like an Antora resource ID', () => {
    // Without a family segment the include resolves to nothing at build time,
    // silently, which is the failure worth naming at generation.
    const warnings = [];
    normalizeIncludes('p', ['some/relative/path.adoc'], warnings);
    expect(warnings).toEqual([expect.stringContaining('does not look like an Antora resource ID')]);
  });

  it('drops an entry with no resource ID', () => {
    const warnings = [];
    expect(normalizeIncludes('p', ['', null], warnings)).toEqual([]);
    expect(warnings).toHaveLength(2);
  });
});

describe('example shape', () => {
  it('returns a string when handed an array, because the template cannot render an array', () => {
    // property.hbs uses a bare {{{example}}}, so Handlebars would stringify an
    // array with commas and collapse the whole YAML block onto one line.
    const props = corpus({
      example: ['[,yaml]', '----', 'redpanda:', '  rpc_server: 0.0.0.0', '----', '', 'Sets `rpc_server`.'],
      links: { '`rpc_server`': '#rpc_server' },
    });
    applyPropertyLinks(props);
    expect(typeof props.subject.example).toBe('string');
    expect(props.subject.example).toContain('\n----\n');
    expect(props.subject.example).not.toContain(',----,');
  });

  it('leaves a string example a string', () => {
    const props = corpus({
      example: '[,yaml]\n----\nredpanda:\n  rpc_server: 0.0.0.0\n----\n\nSets `rpc_server`.',
      links: { '`rpc_server`': '#rpc_server' },
    });
    applyPropertyLinks(props);
    expect(typeof props.subject.example).toBe('string');
    expect(props.subject.example).toContain('prop:rpc_server[link=true]');
  });
});

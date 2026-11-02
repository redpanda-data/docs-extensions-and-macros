'use strict';

const path = require('path');

const { deriveSnapshot } = require(path.join(__dirname, '../../.github/scripts/derive-property-snapshot.js'));

const attachment = {
  properties: {
    plain: { name: 'plain', type: 'integer', description: 'Source text.' },
    linked: { name: 'linked', type: 'integer', description: 'See `other`.' },
    scoped: { name: 'scoped', type: 'integer', description: 'See `other`.' },
    included: {
      name: 'included',
      type: 'integer',
      description: 'Source text.\n\ninclude::reference:partial$internal-use-property.adoc[]',
    },
    cloudIncluded: {
      name: 'cloudIncluded',
      type: 'integer',
      description: 'Source text.\n\nifdef::env-cloud[]\ninclude::reference:partial$cloud.adoc[]\nendif::[]',
    },
    ownProse: {
      name: 'ownProse',
      type: 'integer',
      description: 'Source text.\n\ninclude::reference:partial$internal-use-property.adoc[]',
    },
  },
};

const overrides = {
  properties: {
    plain: { config_scope: 'cluster' },
    linked: { links: { '`other`': '#other' } },
    scoped: { description: ['self-managed-only: Own text with `other`.'], links: { '`other`': '#other' } },
    included: { includes: ['reference:partial$internal-use-property.adoc[]'] },
    cloudIncluded: { includes: ['cloud-only: reference:partial$cloud.adoc[]'] },
    ownProse: { description: 'Override text.', includes: ['reference:partial$internal-use-property.adoc[]'] },
  },
};

describe('deriveSnapshot', () => {
  const snapshot = deriveSnapshot(attachment, overrides);

  it('drops descriptions the overrides do not depend on', () => {
    expect(snapshot.plain).not.toHaveProperty('description');
    expect(snapshot.ownProse).not.toHaveProperty('description');
  });

  it('keeps the source description for links with no prose of their own', () => {
    expect(snapshot.linked.description).toBe('See `other`.');
  });

  it('treats an audience-scoped description array as prose of its own', () => {
    expect(snapshot.scoped).not.toHaveProperty('description');
  });

  // The generator appends includes to the source description, so an
  // includes-only override has nothing to append to without it. The
  // attachment already carries the appended directive, which must not come
  // along or the corpus test renders it twice.
  it('keeps the source description for includes-only overrides, without the appended directive', () => {
    expect(snapshot.included.description).toBe('Source text.');
    expect(snapshot.cloudIncluded.description).toBe('Source text.');
  });
});

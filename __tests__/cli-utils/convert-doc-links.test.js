'use strict';

const { urlToXref } = require('../../cli-utils/convert-doc-links.js');

describe('urlToXref', () => {
  describe('validation', () => {
    it('throws on an invalid URL', () => {
      expect(() => urlToXref('not-a-url')).toThrow(/Invalid URL/);
    });

    it('throws on a non-docs.redpanda.com URL', () => {
      expect(() => urlToXref('https://example.com/current/foo/')).toThrow(
        /Not a docs\.redpanda\.com URL/
      );
    });
  });

  describe('same-component URLs (unchanged behavior)', () => {
    it('converts a /current/ URL to a module xref in the current component', () => {
      expect(
        urlToXref('https://docs.redpanda.com/current/manage/kubernetes/manage-resources/')
      ).toBe('xref:manage:kubernetes/manage-resources.adoc');
    });

    it('converts a legacy /docs/ URL to a module xref in the current component', () => {
      expect(
        urlToXref('https://docs.redpanda.com/docs/reference/cluster-properties/')
      ).toBe('xref:reference:cluster-properties.adoc');
    });

    it('converts a versioned /vX.Y/ URL to a module xref in the current component', () => {
      expect(
        urlToXref('https://docs.redpanda.com/23.2/manage/security/authentication/')
      ).toBe('xref:manage:security/authentication.adoc');
    });

    it('converts the site root to the index page', () => {
      expect(urlToXref('https://docs.redpanda.com/')).toBe('xref:index.adoc');
    });

    it('preserves a bracketed label', () => {
      expect(
        urlToXref('https://docs.redpanda.com/current/manage/kubernetes/manage-resources/[Manage resources]')
      ).toBe('xref:manage:kubernetes/manage-resources.adoc[Manage resources]');
    });

    it('does not apply the component map after a legacy prefix is stripped', () => {
      // /current/home/... is the `home` module of the current component,
      // not the docs-site `home` umbrella component.
      expect(
        urlToXref('https://docs.redpanda.com/current/home/index/')
      ).toBe('xref:home:index.adoc');
    });
  });

  describe('cross-component URLs', () => {
    it('converts the exact redpanda-connect reproduction case from docs#1830', () => {
      // Previously produced the broken xref:redpanda-connect:configuration/secrets.adoc
      expect(
        urlToXref('https://docs.redpanda.com/redpanda-connect/configuration/secrets/')
      ).toBe('xref:connect:configuration:secrets.adoc');
    });

    it('handles the URL without a trailing slash identically', () => {
      expect(
        urlToXref('https://docs.redpanda.com/redpanda-connect/configuration/secrets')
      ).toBe('xref:connect:configuration:secrets.adoc');
    });

    it('maps the current connect slug the same as the legacy slug', () => {
      expect(
        urlToXref('https://docs.redpanda.com/connect/configuration/secrets/')
      ).toBe('xref:connect:configuration:secrets.adoc');
    });

    it('handles deeper paths by keeping subdirectories in the page path', () => {
      expect(
        urlToXref('https://docs.redpanda.com/connect/components/inputs/kafka/')
      ).toBe('xref:connect:components:inputs/kafka.adoc');
    });

    it('maps the legacy redpanda-cloud slug to the cloud-data-platform component', () => {
      expect(
        urlToXref('https://docs.redpanda.com/redpanda-cloud/get-started/whats-redpanda-cloud/')
      ).toBe('xref:cloud-data-platform:get-started:whats-redpanda-cloud.adoc');
    });

    it('maps the legacy redpanda-labs slug to the labs component', () => {
      expect(
        urlToXref('https://docs.redpanda.com/redpanda-labs/docker-compose/single-broker/')
      ).toBe('xref:labs:docker-compose:single-broker.adoc');
    });

    it('qualifies streaming URLs and strips the version segment after the slug', () => {
      expect(
        urlToXref('https://docs.redpanda.com/streaming/current/manage/kubernetes/manage-resources/')
      ).toBe('xref:streaming:manage:kubernetes/manage-resources.adoc');
      expect(
        urlToXref('https://docs.redpanda.com/streaming/25.1/manage/kubernetes/manage-resources/')
      ).toBe('xref:streaming:manage:kubernetes/manage-resources.adoc');
    });

    it('converts a module-only URL to the module index page', () => {
      expect(
        urlToXref('https://docs.redpanda.com/connect/configuration/')
      ).toBe('xref:connect:configuration:index.adoc');
    });

    it('converts a component-only URL to the component index page', () => {
      expect(
        urlToXref('https://docs.redpanda.com/redpanda-connect/')
      ).toBe('xref:connect::index.adoc');
    });

    it('preserves a bracketed label on cross-component URLs', () => {
      expect(
        urlToXref('https://docs.redpanda.com/redpanda-connect/configuration/secrets/[Secrets]')
      ).toBe('xref:connect:configuration:secrets.adoc[Secrets]');
    });
  });
});

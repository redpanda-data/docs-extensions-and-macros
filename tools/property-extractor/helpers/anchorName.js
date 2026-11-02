// Builds the anchor for a property's generated section heading.
//
// The headings are plain AsciiDoc (`=== cleanup.policy`), so Asciidoctor derives
// their IDs itself: lowercase, every run of characters outside [a-z0-9_] replaced
// with the id separator, which Antora sets to `-`. Underscores are word
// characters and survive, so `redpanda.cloud_topic.enabled` becomes
// `redpanda-cloud_topic-enabled`.
//
// Reproduce that here rather than inventing a separate scheme: anything else
// renders as a link to an anchor that does not exist on the page.
module.exports = function anchorName(name) {
  const anchor = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!anchor) {
    throw new Error(`Invalid property name for anchor generation: "${name}"`);
  }
  return anchor;
};

// Returns an object with type and value for a related topic
// type: 'cloud', 'self-managed', or 'normal'
module.exports = function parseRelatedTopic(topic) {
  if (typeof topic !== 'string') return { type: 'normal', value: topic };
  const trimmed = topic.trim();
  if (trimmed.startsWith('cloud-only:')) {
    return { type: 'cloud', value: trimmed.replace(/^cloud-only:/, '').trim() };
  }
  if (trimmed.startsWith('self-managed-only:')) {
    return { type: 'self-managed', value: trimmed.replace(/^self-managed-only:/, '').trim() };
  }
  return { type: 'normal', value: trimmed };
};

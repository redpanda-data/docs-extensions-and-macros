// Returns 'cloud' if all topics are cloud-only, 'self-managed' if all are self-managed-only, else 'normal'
module.exports = function allTopicsConditional(related_topics) {
  if (!Array.isArray(related_topics) || related_topics.length === 0) return null;
  let allCloud = true;
  let allSelfManaged = true;
  for (const t of related_topics) {
    if (typeof t !== 'string') {
      allCloud = false;
      allSelfManaged = false;
      break;
    }
    const trimmed = t.trim();
    if (!trimmed.startsWith('cloud-only:')) allCloud = false;
    if (!trimmed.startsWith('self-managed-only:')) allSelfManaged = false;
  }
  if (allCloud) return 'cloud';
  if (allSelfManaged) return 'self-managed';
  return 'normal';
};

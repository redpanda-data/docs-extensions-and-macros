module.exports = function anchorName(name) {
  const anchor = String(name).replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  if (!anchor) {
    throw new Error(`Invalid property name for anchor generation: "${name}"`);
  }
  return anchor;
};

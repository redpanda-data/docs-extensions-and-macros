module.exports = function anchorName(name) {
  return String(name).replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
};

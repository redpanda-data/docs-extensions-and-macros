module.exports = function join(array, separator) {
  if (!Array.isArray(array)) {
    return '';
  }
  return array.join(separator);
}
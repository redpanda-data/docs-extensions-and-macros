/* -----------------------------
   Utility: remove trailing '@'
----------------------------- */
module.exports = (val) => {
  return String(val).replace('@', '');
}
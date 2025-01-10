/* -----------------------------
   Utility: ensure valid semver or fallback
----------------------------- */
module.exports = (version, semver) => {
  if (!version) return null;
  return semver.valid(version) ? version : `${version}.0`;
}
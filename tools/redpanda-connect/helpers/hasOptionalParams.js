// Check if any parameters are optional
function hasOptionalParams(params) {
  if (!Array.isArray(params)) return false;
  return params.some(param => param.is_optional);
}

module.exports = hasOptionalParams;

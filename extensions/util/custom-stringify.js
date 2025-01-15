function customStringify(obj) {
  return JSON.stringify(obj, (key, value) => {
    if (value instanceof Map) {
      return {
        type: 'Map',
        value: Array.from(value.entries())
      };
    } else if (value instanceof Set) {
      return {
        type: 'Set',
        value: Array.from(value)
      };
    } else if (typeof value === 'function') {
      return value.toString();
    } else {
      return value;
    }
  }, 2);
}
// Bloblang example formatting helper for Handlebars
function bloblangExample(example) {
  if (typeof example === 'object' && example !== null && example.mapping) {
    let codeBlock = '';
    if (example.summary && example.summary.trim()) {
      codeBlock += `# ${example.summary.trim().replace(/\n/g, '\n# ')}\n\n`;
    }
    if (typeof example.mapping === 'string') {
      codeBlock += example.mapping.trim() + '\n';
    }
    if (Array.isArray(example.results)) {
      for (const pair of example.results) {
        if (Array.isArray(pair) && pair.length === 2) {
          codeBlock += `\n# In:  ${pair[0]}\n# Out: ${pair[1]}\n`;
        }
      }
    }
    return `[,coffeescript]\n----\n${codeBlock.trim()}\n----\n`;
  } else {
    let exStr = '';
    if (typeof example === 'string') {
      exStr = example;
    } else if (typeof example === 'object' && example !== null) {
      if (example.code) {
        exStr = example.code;
      } else if (example.example) {
        exStr = example.example;
      } else {
        try {
          exStr = require('yaml').stringify(example).trim();
        } catch {
          exStr = JSON.stringify(example, null, 2);
        }
      }
    } else {
      exStr = String(example);
    }
    return `[source,coffeescript]\n----\n${exStr}\n----\n`;
  }
}

module.exports = bloblangExample;

// Bloblang example formatting helper for Handlebars
function bloblangExample(example) {
  if (typeof example === 'object' && example !== null && example.mapping) {
    let leadIn = '';
    let codeBlock = '';

    // Extract summary as lead-in prose (not a comment in code)
    if (example.summary && example.summary.trim()) {
      let summary = example.summary.trim();

      // Convert Markdown headings to AsciiDoc
      // ##### Heading -> === Heading (H5 -> H3 in AsciiDoc)
      // H3 fits correctly under the H2 "Examples" section
      summary = summary.replace(/^#####\s+(.+)$/gm, '=== $1');
      // #### Heading -> == Heading (H4 -> H2 in AsciiDoc)
      summary = summary.replace(/^####\s+(.+)$/gm, '== $1');
      // ### Heading -> = Heading (H3 -> H1 in AsciiDoc)
      summary = summary.replace(/^###\s+(.+)$/gm, '= $1');

      // Ensure lead-in ends with a colon (replace period/exclamation/question mark if present)
      if (summary.endsWith('.') || summary.endsWith('!') || summary.endsWith('?')) {
        summary = summary.slice(0, -1) + ':';
      } else if (!summary.endsWith(':')) {
        summary += ':';
      }
      leadIn = summary + '\n\n';
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
    return `${leadIn}[,bloblang]\n----\n${codeBlock.trim()}\n----\n`;
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
    return `[source,bloblang]\n----\n${exStr}\n----\n`;
  }
}

module.exports = bloblangExample;

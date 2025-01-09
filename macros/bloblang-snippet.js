module.exports.register = function (registry) {
  registry.block(function () {
    var self = this
    self.named('bloblang_snippet')
    self.onContext(['paragraph','open','literal'])
    self.process(function (parent, reader, attrs) {
      const input = attrs['input'] || '{}';
      const metadata = attrs['metadata'] || '{}';
      const wasmUrl = attrs['wasm_url'] || '/blobl.wasm';
      const instanceId = `bloblang-${Math.random().toString(36).slice(2, 11)}`;

      // Read block content (e.g., mapping)
      const mapping = reader.getLines().join('\n');

      const html = `
<div id="${instanceId}" class="bloblang-snippet">
  <div class="row" id="${instanceId}-input-row">
    <div class="box" id="${instanceId}-input-box" style="display: none;">
      <b>Input</b>
      <div id="${instanceId}-input" class="ace-editor"></div>
    </div>
    <div class="box" id="${instanceId}-metadata-box" style="display: none;">
      <b>Input metadata</b>
      <div id="${instanceId}-metadata" class="ace-editor"></div>
    </div>
  </div>
  <div class="row">
    <div class="box full-width">
      <b>Bloblang mapping</b>
      <div id="${instanceId}-mapping" class="ace-editor"></div>
    </div>
  </div>
  <div class="row">
    <div class="box">
      <b>Output</b>
      <div id="${instanceId}-output" class="ace-editor">"Output will appear here..."</div>
    </div>
    <div class="box" id="${instanceId}-output-metadata-box" style="display: none;">
      <b>Output metadata</b>
      <div id="${instanceId}-output-metadata" class="ace-editor">"Metadata will appear here..."</div>
    </div>
  </div>
</div>
<script>
document.addEventListener('DOMContentLoaded', () => {
  const wasmUrl = "${wasmUrl}";
  const inputEditorId = "${instanceId}-input";
  const mappingEditorId = "${instanceId}-mapping";
  const metadataEditorId = "${instanceId}-metadata";
  const outputEditorId = "${instanceId}-output";
  const outputMetadataEditorId = "${instanceId}-output-metadata";

  const metadataBoxId = "${instanceId}-metadata-box";
  const inputBoxId = "${instanceId}-input-box";
  const outputMetadataBoxId = "${instanceId}-output-metadata-box";

  let inputEditor, mappingEditor, metadataEditor, outputEditor, outputMetadataEditor, wasmInstance;

  // Initialize ACE Editors
  function initializeAceEditor(editorId, mode, readOnly = false, initialValue = '') {
    const editor = ace.edit(editorId);
    editor.setTheme('ace/theme/github');
    editor.session.setMode(mode);
    editor.setReadOnly(readOnly);
    editor.setValue(prettifyJSON(initialValue), 1);
    editor.renderer.setOption('showGutter', false);
    editor.setOptions({
      minLines: 1, // Minimum height
      maxLines: 20,
    });
    editor.setStyle('bloblang-editor')
    editor.container.style.lineHeight = 1.7
    editor.renderer.updateFontSize()
    editor.renderer.setScrollMargin(14, 14, 0, 0)
    return editor;
  }

  // Check if argument is empty
  function isEmpty(data) {
    try {
      const parsed = JSON.parse(data);
      return Object.keys(parsed).length === 0;
    } catch (e) {
      return true; // Treat invalid data as empty
    }
  }

  inputEditor = initializeAceEditor(inputEditorId, 'ace/mode/json', false, ${input ? JSON.stringify(input) : '{}'});
  mappingEditor = initializeAceEditor(mappingEditorId, 'ace/mode/coffee', false, \`${mapping}\`);
  outputEditor = initializeAceEditor(outputEditorId, 'ace/mode/text', true, '"Output will appear here..."');
  metadataEditor = initializeAceEditor(metadataEditorId, 'ace/mode/json', false, ${metadata ? JSON.stringify(metadata) : '{}'});
  outputMetadataEditor = initializeAceEditor(outputMetadataEditorId, 'ace/mode/json', true, '"Metadata will appear here..."');

  function prettifyJSON(json) {
    try {
      return JSON.stringify(JSON.parse(json), null, 2);
    } catch (error) {
      return json; // Return original value if it's not valid JSON
    }
  }

  // Load WASM
  async function loadWasm() {
    const go = new Go();
    const result = await WebAssembly.instantiateStreaming(fetch(wasmUrl), go.importObject);
    go.run(result.instance);
    wasmInstance = window.blobl;
    executeMapping();
  }

  function isValidJSON(str) {
    try {
      JSON.parse(str);
      return true;
    } catch (e) {
      return false;
    }
  }

  // Execute Mapping
  async function executeMapping() {
    try {
      const input = inputEditor.getValue();
      const mapping = mappingEditor.getValue();
      const metadata = metadataEditor.getValue();

      if (!isEmpty(metadata)) {
        document.getElementById(metadataBoxId).style.display = 'block';
      }
      if (!isEmpty(input)) {
        document.getElementById(inputBoxId).style.display = 'block';
      }

      if (!input || !mapping) {
        outputEditor.setValue('"Input and mapping are required."', 1);
        return;
      }

      // Ensure valid JSON for input and metadata
      if (!isValidJSON(input)) {
        outputEditor.setValue('"Error: Invalid JSON input."', 1);
        return;
      }
      if (metadata && !isValidJSON(metadata)) {
        outputEditor.setValue('"Error: Invalid JSON metadata."', 1);
        return;
      }

      // Call the WASM function
      const result = wasmInstance(mapping, input, metadata || '{}');

      if (isValidJSON(result)) {
        const parsedResult = JSON.parse(result);

        // Separate message and metadata
        const message = parsedResult.msg || parsedResult;
        const outputMetadata = parsedResult.meta || {};

        // Display output metadata box if metadata exists
        if (Object.keys(outputMetadata).length > 0) {
          document.getElementById(outputMetadataBoxId).style.display = 'block';
          outputMetadataEditor.setValue(JSON.stringify(outputMetadata, null, 2), 1);
        } else {
          document.getElementById(outputMetadataBoxId).style.display = 'none';
          outputMetadataEditor.setValue('"No metadata available."', 1);
        }

        // Display message output
        outputEditor.session.setMode("ace/mode/json");
        outputEditor.setValue(JSON.stringify(message, null, 2), 1);
      } else {
        // If the result isn't valid JSON, treat it as plain text
        outputEditor.session.setMode("ace/mode/text");
        outputEditor.setValue(result, 1);
      }
    } catch (error) {
      outputEditor.session.setMode("ace/mode/text");
      outputEditor.setValue('"Error: ' + error.message + '"', 1);
    }
  }

  // Attach change listeners to auto-execute
  inputEditor.session.on('change', executeMapping);
  mappingEditor.session.on('change', executeMapping);
  metadataEditor.session.on('change', executeMapping);
  document.getElementById(inputEditorId).style.fontFamily='"IBM Plex Mono", "Courier Prime", courier, monospace';
  document.getElementById(mappingEditorId).style.fontFamily='"IBM Plex Mono", "Courier Prime", courier, monospace';
  document.getElementById(metadataEditorId).style.fontFamily='"IBM Plex Mono", "Courier Prime", courier, monospace';
  document.getElementById(outputMetadataEditorId).style.fontFamily='"IBM Plex Mono", "Courier Prime", courier, monospace';

  // Load WASM and Handle Errors
  loadWasm().catch(err => {
    outputEditor.setValue('"Error loading WASM file: ' + err.message + '"', 1);
  });
});
</script>
      `;
      return this.createBlock(parent, 'pass', html);
    });
  });
};

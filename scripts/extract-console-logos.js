#!/usr/bin/env node
/**
 * Extracts SVG logos from Console TSX files and generates a mapping for use in docs.
 * Reads TSX files from console/frontend/src/assets/connectors/logos/
 * and outputs a JavaScript object with connector name -> data URI mappings.
 */

const fs = require('fs');
const path = require('path');

const CONSOLE_LOGOS_DIR = path.join(__dirname, '../../console/frontend/src/assets/connectors/logos');
const OUTPUT_FILE = path.join(__dirname, '../extracted-console-logos.json');

function extractSVGFromTSX(tsxContent) {
  // Match the SVG element and its contents
  const svgMatch = tsxContent.match(/<svg[^>]*>[\s\S]*?<\/svg>/);
  if (!svgMatch) return null;

  let svg = svgMatch[0];

  // Remove React-specific props like {...props}
  svg = svg.replace(/\{\.\.\.props\}/g, '');

  // Convert React camelCase attributes to lowercase
  svg = svg.replace(/stopColor=/g, 'stop-color=');
  svg = svg.replace(/stopOpacity=/g, 'stop-opacity=');
  svg = svg.replace(/fillRule=/g, 'fill-rule=');
  svg = svg.replace(/clipRule=/g, 'clip-rule=');
  svg = svg.replace(/strokeWidth=/g, 'stroke-width=');
  svg = svg.replace(/strokeLinecap=/g, 'stroke-linecap=');
  svg = svg.replace(/strokeLinejoin=/g, 'stroke-linejoin=');

  return svg.trim();
}

function extractComponentName(tsxContent) {
  // Extract the actual export name from the TSX file
  // Looks for patterns like: export const ComponentName = (props...
  const exportMatch = tsxContent.match(/export\s+const\s+(\w+)\s*=/);
  return exportMatch ? exportMatch[1] : null;
}

function main() {
  if (!fs.existsSync(CONSOLE_LOGOS_DIR)) {
    console.error(`Console logos directory not found: ${CONSOLE_LOGOS_DIR}`);
    process.exit(1);
  }

  const logoFiles = fs.readdirSync(CONSOLE_LOGOS_DIR).filter(f => f.endsWith('.tsx'));
  const logoMap = {};

  console.log(`Found ${logoFiles.length} logo files`);

  for (const file of logoFiles) {
    const filePath = path.join(CONSOLE_LOGOS_DIR, file);
    const tsxContent = fs.readFileSync(filePath, 'utf8');
    const svg = extractSVGFromTSX(tsxContent);
    const componentName = extractComponentName(tsxContent);

    if (svg && componentName) {
      // Create data URI
      const dataUri = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
      logoMap[componentName] = dataUri;
      console.log(`✓ Extracted ${componentName} from ${file}`);
    } else {
      if (!svg) console.log(`✗ Failed to extract SVG from ${file}`);
      if (!componentName) console.log(`✗ Failed to extract component name from ${file}`);
    }
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(logoMap, null, 2));
  console.log(`\nWrote ${Object.keys(logoMap).length} logos to ${OUTPUT_FILE}`);
}

main();

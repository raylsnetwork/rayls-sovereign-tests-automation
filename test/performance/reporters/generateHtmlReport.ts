#!/usr/bin/env ts-node

import fs from 'fs';
import path from 'path';
import HtmlReporter from './HtmlReporter';

function main() {
  const jsonFilePath = process.argv[2];
  console.log(`Generating HTML report from JSON file: ${jsonFilePath}`);
  if (!jsonFilePath) {
    console.error('Usage: ts-node generateHtmlReport.ts <json-file-path>');
    process.exit(1);
  }

  if (!fs.existsSync(jsonFilePath)) {
    console.error(`Error: JSON file not found: ${jsonFilePath}`);
    process.exit(1);
  }

  try {
    const jsonData = JSON.parse(fs.readFileSync(jsonFilePath, 'utf8'));

    const htmlReporter = new HtmlReporter({ outputDir: path.dirname(jsonFilePath) });
    const htmlPath = htmlReporter.generateReport(jsonData);

    if (htmlPath) {
      console.log(`HTML report generated: ${htmlPath}`);
    } else {
      console.error('Failed to generate HTML report');
      process.exit(1);
    }
  } catch (error: any) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

// Only run when invoked directly (not when loaded by mocha/ts-node)
if (require.main === module) {
  main();
}

# Performance Reporters

This directory contains all reporting utilities for performance testing.

## Files Structure

```
reporters/
├── JsonReporter.ts             # JSON metrics generator (TS)
├── HtmlReporter.ts             # HTML report generator (TS)
├── generateHtmlReport.ts       # CLI tool for JSON → HTML (TS)
└──  generate-latest-report.sh   # Quick script for latest report
```

## Components

### JsonReporter.ts
- **Purpose**: Generates JSON performance metrics from test results
- **Output**: Structured JSON data compatible with HtmlReporter
- **Usage**: Automatically called by performance tests
- **Format**: Includes TPS, success rate, duration, transaction counts

### HtmlReporter.ts
- **Purpose**: Converts JSON metrics into clean HTML dashboard
- **Features**: Summary cards, responsive design, EnygmaWrapper branding
- **Output**: Single-file HTML with embedded CSS
- **Focus**: Summary metrics only (TPS, Success Rate, Duration, Total Transactions)

### generateHtmlReport.ts
- **Purpose**: CLI tool to convert existing JSON → HTML
- **Usage**: `ts-node generateHtmlReport.ts <json-file-path>`
- **Features**: Error handling, automatic file naming
- **Output**: Saves HTML in same directory as JSON

### generate-latest-report.sh
- **Purpose**: Quick script to convert most recent JSON to HTML
- **Usage**: `./generate-latest-report.sh`
- **Features**: Auto-finds latest JSON, provides status feedback
- **Convenience**: No need to specify file paths

## Usage Examples

### Basic JSON Report Generation
```javascript
const JsonReporter = require('../reporters/JsonReporter');

const jsonReporter = new JsonReporter();
const testData = {
  testType: 'A→B Performance Test',
  transactionCount: 1000,
  actualTPS: 89.14,
  duration: 44.88,
  // ... more data
};

jsonReporter.generateReport(testData);
```

### Convert JSON to HTML
```bash
# Specific file
ts-node test/performance/reporters/generateHtmlReport.ts reports/enygma-performance_*.json

# Latest file (convenience script)
./test/performance/reporters/generate-latest-report.sh
```

### Integration in Tests
```javascript
// Automatic JSON generation at test completion
const JsonReporter = require('../reporters/JsonReporter');
const jsonReporter = new JsonReporter();
const reportPath = jsonReporter.generateReport(testData);
logger.info(`Performance metrics saved to: ${reportPath}`);
```

## Output Locations

All reports are saved to: `/test/performance/reports/`

### File Naming Convention
- **JSON**: `enygma-performance_YYYY-MM-DDTHH-MM-SS.json`
- **HTML**: `A→B Performance Test_YYYY-MM-DDTHH-MM-SS.html`

/**
 * MCP Tools - Documentation Review
 */

const fs = require('fs');
const path = require('path');
const { findRepoRoot, formatDate } = require('./utils');

/**
 * Generate an AsciiDoc report from review results
 * @param {Object} results - Review results
 * @param {string} outputPath - Path to save the report
 * @returns {string} Generated report content
 */
function generateReviewReport(results, outputPath) {
  const { doc_type, version, quality_score, issues, suggestions, files_analyzed } = results;

  const errorIssues = issues.filter(i => i.severity === 'error');
  const warningIssues = issues.filter(i => i.severity === 'warning');
  const infoIssues = issues.filter(i => i.severity === 'info');

  let report = `= Documentation Review Report\n\n`;
  report += `[cols="1,3"]\n`;
  report += `|===\n`;
  report += `| Type | ${doc_type}\n`;
  report += `| Version | ${version || 'N/A'}\n`;
  report += `| Date | ${formatDate()}\n`;
  report += `| Files Analyzed | ${files_analyzed}\n`;
  report += `|===\n\n`;

  report += `== Quality Score: ${quality_score}/100\n\n`;

  // Score interpretation
  if (quality_score >= 90) {
    report += `[NOTE]\n====\n*Excellent* - Documentation quality is very high.\n====\n\n`;
  } else if (quality_score >= 75) {
    report += `[WARNING]\n====\n*Good* - Documentation quality is acceptable but has room for improvement.\n====\n\n`;
  } else if (quality_score >= 50) {
    report += `[WARNING]\n====\n*Fair* - Documentation needs improvement in several areas.\n====\n\n`;
  } else {
    report += `[CAUTION]\n====\n*Poor* - Documentation requires significant improvements.\n====\n\n`;
  }

  // Scoring breakdown with detailed calculation
  report += `=== Scoring Breakdown\n\n`;
  report += `*How the score is calculated:*\n\n`;

  let runningScore = 100;
  report += `. Starting score: *${runningScore}*\n`;

  if (errorIssues.length > 0) {
    const errorDeduction = errorIssues.reduce((sum, issue) => {
      if (issue.issue.includes('enterprise license') || issue.issue.includes('cloud-specific')) return sum + 5;
      if (issue.issue.includes('invalid xref')) return sum + 3;
      return sum + 3;
    }, 0);
    runningScore -= errorDeduction;
    report += `. Errors: ${errorIssues.length} issues × 3-5 points = -*${errorDeduction}* (now ${runningScore})\n`;
  }

  const missingDescCount = warningIssues.filter(i => i.issue === 'Missing description').length;
  const shortDescCount = infoIssues.filter(i => i.issue.includes('Very short description')).length;
  const exampleCount = infoIssues.filter(i => i.issue.includes('would benefit from an example')).length;
  const otherWarningCount = warningIssues.length - missingDescCount;

  if (missingDescCount > 0) {
    const deduction = Math.min(20, missingDescCount * 2);
    runningScore -= deduction;
    report += `. Missing descriptions: ${missingDescCount} issues × 2 points = -*${deduction}* (capped at 20, now ${runningScore})\n`;
  }

  if (shortDescCount > 0) {
    const deduction = Math.min(10, shortDescCount);
    runningScore -= deduction;
    report += `. Short descriptions: ${shortDescCount} issues × 1 point = -*${deduction}* (capped at 10, now ${runningScore})\n`;
  }

  if (exampleCount > 0) {
    const deduction = Math.min(5, Math.floor(exampleCount / 5));
    runningScore -= deduction;
    report += `. Missing examples: ${exampleCount} complex properties = -*${deduction}* (1 point per 5 properties, capped at 5, now ${runningScore})\n`;
  }

  if (otherWarningCount > 0) {
    const deduction = Math.min(otherWarningCount * 2, 10);
    runningScore -= deduction;
    report += `. Other warnings: ${otherWarningCount} issues × 1-2 points = -*${deduction}* (now ${runningScore})\n`;
  }

  report += `\n*Final Score: ${quality_score}/100*\n\n`;

  // Summary
  report += `== Summary\n\n`;
  report += `* *Total Issues:* ${issues.length}\n`;
  report += `** Errors: ${errorIssues.length}\n`;
  report += `** Warnings: ${warningIssues.length}\n`;
  report += `** Info: ${infoIssues.length}\n\n`;

  // General suggestions
  if (suggestions.length > 0) {
    report += `=== Key Findings\n\n`;
    suggestions.forEach(s => {
      report += `* ${s}\n`;
    });
    report += `\n`;
  }

  // Errors (highest priority)
  if (errorIssues.length > 0) {
    report += `== Errors (high priority)\n\n`;
    report += `These issues violate documentation standards and should be fixed immediately.\n\n`;

    errorIssues.forEach((issue, idx) => {
      report += `=== ${idx + 1}. ${issue.property || issue.path || 'General'}\n\n`;
      report += `*Issue:* ${issue.issue}\n\n`;
      if (issue.suggestion) {
        report += `*Fix:* ${issue.suggestion}\n\n`;
      }
      report += `*File:* \`${issue.file}\`\n\n`;

      // Add specific instructions based on issue type
      if (issue.issue.includes('enterprise license')) {
        report += `*Action:*\n\n`;
        report += `. Open \`docs-data/property-overrides.json\`\n`;
        report += `. Find property \`${issue.property}\`\n`;
        report += `. Remove the \`include::reference:partial$enterprise-licensed-property.adoc[]\` from the description\n`;
        report += `. Regenerate docs\n\n`;
      } else if (issue.issue.includes('cloud-specific conditional')) {
        report += `*Action:*\n\n`;
        report += `. Open \`docs-data/property-overrides.json\`\n`;
        report += `. Find property \`${issue.property}\`\n`;
        report += `. Remove the \`ifdef::env-cloud\` blocks from the description\n`;
        report += `. Cloud-specific info will appear in metadata automatically\n`;
        report += `. Regenerate docs\n\n`;
      } else if (issue.issue.includes('invalid xref')) {
        report += `*Action:*\n\n`;
        report += `. Open \`docs-data/property-overrides.json\`\n`;
        report += `. Find property \`${issue.property}\`\n`;
        report += `. Update xref links to use full Antora resource IDs\n`;
        report += `. Example: \`xref:reference:properties/cluster-properties.adoc[Link]\`\n`;
        report += `. Regenerate docs\n\n`;
      } else if (issue.issue.includes('Invalid $ref')) {
        report += `*Action:*\n\n`;
        report += `. Open \`docs-data/overrides.json\`\n`;
        report += `. Find the reference at \`${issue.path}\`\n`;
        report += `. Either add the missing definition or fix the reference\n`;
        report += `. Regenerate docs\n\n`;
      }
    });
  }

  // Warnings
  if (warningIssues.length > 0) {
    report += `== Warnings\n\n`;
    report += `These issues should be addressed to improve documentation quality.\n\n`;

    // Group warnings by issue type
    const warningsByType = {};
    warningIssues.forEach(issue => {
      const issueType = issue.issue.split(':')[0] || issue.issue;
      if (!warningsByType[issueType]) {
        warningsByType[issueType] = [];
      }
      warningsByType[issueType].push(issue);
    });

    Object.entries(warningsByType).forEach(([type, typeIssues]) => {
      report += `=== ${type} (${typeIssues.length})\n\n`;

      if (type === 'Missing description') {
        report += `*Fix:* Add descriptions to these properties in \`docs-data/property-overrides.json\`\n\n`;
        report += `*Properties needing descriptions:*\n\n`;
        typeIssues.forEach(issue => {
          report += `* \`${issue.property}\`\n`;
        });
        report += `\n`;
      } else {
        typeIssues.forEach(issue => {
          report += `* *${issue.property || issue.path}*: ${issue.issue}\n`;
        });
        report += `\n`;
      }
    });
  }

  // Info items
  if (infoIssues.length > 0) {
    report += `== Info\n\n`;
    report += `These are suggestions for enhancement.\n\n`;

    // Group by issue type
    const infoByType = {};
    infoIssues.forEach(issue => {
      const issueType = issue.issue.split('(')[0].trim();
      if (!infoByType[issueType]) {
        infoByType[issueType] = [];
      }
      infoByType[issueType].push(issue);
    });

    Object.entries(infoByType).forEach(([type, typeIssues]) => {
      report += `=== ${type}\n\n`;
      typeIssues.forEach(issue => {
        report += `* *${issue.property || issue.path}*: ${issue.issue}\n`;
      });
      report += `\n`;
    });
  }

  // Next steps
  report += `== Next Steps\n\n`;
  if (errorIssues.length > 0) {
    report += `. *Fix errors first* - Address the ${errorIssues.length} error(s) above\n`;
  }
  if (warningIssues.length > 0) {
    report += `${errorIssues.length > 0 ? '. ' : '. '}*Review warnings* - Prioritize the ${warningIssues.length} warning(s)\n`;
  }
  const step = errorIssues.length > 0 && warningIssues.length > 0 ? 3 : errorIssues.length > 0 || warningIssues.length > 0 ? 2 : 1;
  report += `${step > 1 ? '. ' : '. '}*Regenerate documentation* - After making changes, regenerate the docs\n`;
  report += `. *Review again* - Run the review tool again to verify fixes\n\n`;

  // Write report
  fs.writeFileSync(outputPath, report, 'utf8');

  return report;
}

/**
 * Review generated documentation for quality issues
 * @param {Object} args - Arguments
 * @param {string} args.doc_type - Type of docs to review (properties, metrics, rpk, rpcn_connectors)
 * @param {string} args.version - Version of the docs to review (for properties, metrics, rpk)
 * @param {boolean} [args.generate_report] - Whether to generate a markdown report file
 * @returns {Object} Review results with issues and suggestions
 */
function reviewGeneratedDocs(args) {
  const repoRoot = findRepoRoot();
  const { doc_type, version, generate_report } = args;

  if (!doc_type) {
    return {
      success: false,
      error: 'doc_type is required',
      suggestion: 'Provide one of: properties, metrics, rpk, rpcn_connectors'
    };
  }

  const issues = [];
  const suggestions = [];
  let filesAnalyzed = 0;
  let qualityScore = 100;

  try {
    switch (doc_type) {
      case 'properties': {
        if (!version) {
          return {
            success: false,
            error: 'version is required for property docs review'
          };
        }

        // Normalize version
        let normalizedVersion = version;
        if (!normalizedVersion.startsWith('v') && normalizedVersion !== 'latest') {
          normalizedVersion = `v${normalizedVersion}`;
        }

        // Check for generated JSON file
        const jsonPath = path.join(repoRoot.root, 'modules', 'reference', 'attachments', `redpanda-properties-${normalizedVersion}.json`);
        if (!fs.existsSync(jsonPath)) {
          return {
            success: false,
            error: `Properties JSON not found at ${jsonPath}`,
            suggestion: 'Generate property docs first using generate_property_docs tool'
          };
        }

        filesAnalyzed++;

        // Read and parse the properties JSON
        const propertiesData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        const allProperties = Object.values(propertiesData.properties || {});

        // Properties that typically benefit from examples
        const shouldHaveExample = (prop) => {
          const name = prop.name.toLowerCase();
          // Properties with specific formats, complex values, or commonly misconfigured
          return name.includes('pattern') ||
                 name.includes('regex') ||
                 name.includes('format') ||
                 name.includes('template') ||
                 name.includes('config') ||
                 name.includes('override') ||
                 name.includes('mapping') ||
                 name.includes('filter') ||
                 name.includes('selector') ||
                 (prop.type && prop.type.includes('array')) ||
                 (prop.type && prop.type.includes('object'));
        };

        // Check for missing or short descriptions
        let missingDescriptions = 0;
        let shortDescriptions = 0;
        let emptyDefaults = 0;
        let missingExamples = 0;

        allProperties.forEach(prop => {
          if (!prop.description || prop.description.trim() === '') {
            missingDescriptions++;
            if (!prop.is_deprecated) {
              issues.push({
                severity: 'warning',
                file: jsonPath,
                property: prop.name,
                issue: 'Missing description'
              });
            }
          } else if (prop.description.length < 20 && !prop.is_deprecated) {
            shortDescriptions++;
            issues.push({
              severity: 'info',
              file: jsonPath,
              property: prop.name,
              issue: `Very short description (${prop.description.length} chars): "${prop.description}"`
            });
          }

          if ((!prop.default || (typeof prop.default === 'string' && prop.default.trim() === '')) && !prop.is_deprecated && prop.config_scope !== 'broker') {
            emptyDefaults++;
          }

          // Track properties that should have examples
          if (shouldHaveExample(prop) && !prop.is_deprecated) {
            missingExamples++;
          }
        });

        // Check ALL properties for missing examples
        const propertiesNeedingExamples = [];
        const overridesPath = path.join(repoRoot.root, 'docs-data', 'property-overrides.json');
        const overrides = fs.existsSync(overridesPath) ? JSON.parse(fs.readFileSync(overridesPath, 'utf8')) : { properties: {} };

        allProperties.forEach(prop => {
          if (shouldHaveExample(prop) && !prop.is_deprecated) {
            const override = overrides.properties && overrides.properties[prop.name];
            if (!override || !override.example) {
              propertiesNeedingExamples.push(prop.name);
            }
          }
        });

        // Read property overrides to check for quality issues
        if (fs.existsSync(overridesPath)) {
          filesAnalyzed++;

          if (overrides.properties) {
            Object.entries(overrides.properties).forEach(([propName, override]) => {
              let propData = allProperties.find(p => p.name === propName);

              // Check for enterprise license includes (should not be in descriptions)
              if (override.description && override.description.includes('include::reference:partial$enterprise-licensed-property.adoc')) {
                issues.push({
                  severity: 'error',
                  file: overridesPath,
                  property: propName,
                  issue: 'Description contains enterprise license include (should be in metadata only)',
                  suggestion: 'Remove the include statement from the description'
                });
                qualityScore -= 5;
              }

              // Check for cloud-specific conditional blocks
              if (override.description && (override.description.includes('ifdef::env-cloud') || override.description.includes('ifndef::env-cloud'))) {
                issues.push({
                  severity: 'error',
                  file: overridesPath,
                  property: propName,
                  issue: 'Description contains cloud-specific conditional blocks',
                  suggestion: 'Remove cloud conditionals - this info belongs in metadata'
                });
                qualityScore -= 5;
              }

              // Check for deprecated properties with descriptions (should not have overrides)
              if (!propData) propData = allProperties.find(p => p.name === propName);
              if (propData && propData.is_deprecated && override.description) {
                issues.push({
                  severity: 'warning',
                  file: overridesPath,
                  property: propName,
                  issue: 'Override exists for deprecated property',
                  suggestion: 'Remove override for deprecated properties'
                });
                qualityScore -= 2;
              }

              // Check for invalid xref links (not using full Antora resource IDs)
              if (override.description) {
                const invalidXrefPattern = /xref:\.\/|xref:(?![\w-]+:)/g;
                const invalidXrefs = override.description.match(invalidXrefPattern);
                if (invalidXrefs) {
                  issues.push({
                    severity: 'error',
                    file: overridesPath,
                    property: propName,
                    issue: 'Description contains invalid xref links (not using full Antora resource IDs)',
                    suggestion: 'Use full resource IDs like xref:reference:path/to/doc.adoc[Link]'
                  });
                  qualityScore -= 3;
                }
              }

              // Check for duplicate links in related_topics
              if (override.related_topics && Array.isArray(override.related_topics)) {
                const uniqueLinks = new Set(override.related_topics);
                if (uniqueLinks.size < override.related_topics.length) {
                  issues.push({
                    severity: 'warning',
                    file: overridesPath,
                    property: propName,
                    issue: 'Duplicate links in related_topics',
                    suggestion: 'Remove duplicate links'
                  });
                  qualityScore -= 1;
                }
              }
            });
          }
        }

        // Add summary suggestions
        if (missingDescriptions > 0) {
          suggestions.push(`${missingDescriptions} properties have missing descriptions`);
          qualityScore -= Math.min(20, missingDescriptions * 2);
        }
        if (shortDescriptions > 0) {
          suggestions.push(`${shortDescriptions} properties have very short descriptions (< 20 chars)`);
          qualityScore -= Math.min(10, shortDescriptions);
        }
        if (emptyDefaults > 0) {
          suggestions.push(`${emptyDefaults} non-deprecated properties have no default value listed`);
        }
        if (propertiesNeedingExamples.length > 0) {
          suggestions.push(`${propertiesNeedingExamples.length} complex properties would benefit from examples`);
          // Add info-level issues for properties that should have examples
          propertiesNeedingExamples.forEach(propName => {
            issues.push({
              severity: 'info',
              file: overridesPath,
              property: propName,
              issue: 'Complex property would benefit from an example',
              suggestion: 'Add an example array to the property override showing typical usage'
            });
          });
          qualityScore -= Math.min(5, Math.floor(propertiesNeedingExamples.length / 5));
        }

        break;
      }

      case 'rpcn_connectors': {
        // Read overrides.json
        const overridesPath = path.join(repoRoot.root, 'docs-data', 'overrides.json');
        if (!fs.existsSync(overridesPath)) {
          return {
            success: false,
            error: 'overrides.json not found',
            suggestion: 'Generate RPCN connector docs first using generate_rpcn_connector_docs tool'
          };
        }

        filesAnalyzed++;
        const overrides = JSON.parse(fs.readFileSync(overridesPath, 'utf8'));

        // Validate $ref references
        const definitions = overrides.definitions || {};
        const allRefs = new Set();
        const invalidRefs = [];

        const findRefs = (obj, path = '') => {
          if (typeof obj !== 'object' || obj === null) return;

          if (obj.$ref) {
            allRefs.add(obj.$ref);
            // Check if ref is valid
            const refPath = obj.$ref.replace('#/definitions/', '');
            if (!definitions[refPath]) {
              invalidRefs.push({
                ref: obj.$ref,
                path
              });
            }
          }

          for (const [key, value] of Object.entries(obj)) {
            if (key !== '$ref') {
              findRefs(value, path ? `${path}.${key}` : key);
            }
          }
        };

        ['inputs', 'outputs', 'processors', 'caches'].forEach(section => {
          if (overrides[section]) {
            findRefs(overrides[section], section);
          }
        });

        invalidRefs.forEach(({ ref, path }) => {
          issues.push({
            severity: 'error',
            file: overridesPath,
            path,
            issue: `Invalid $ref: ${ref}`,
            suggestion: 'Ensure the reference exists in the definitions section'
          });
          qualityScore -= 5;
        });

        // Check for duplicate descriptions (DRY violations)
        const descriptions = new Map();
        const checkDuplicates = (obj, path = '') => {
          if (typeof obj !== 'object' || obj === null) return;

          if (obj.description && !obj.$ref && typeof obj.description === 'string' && obj.description.length > 30) {
            const key = obj.description.trim().toLowerCase();
            if (descriptions.has(key)) {
              descriptions.get(key).push(path);
            } else {
              descriptions.set(key, [path]);
            }
          }

          for (const [key, value] of Object.entries(obj)) {
            checkDuplicates(value, path ? `${path}.${key}` : key);
          }
        };

        ['inputs', 'outputs', 'processors', 'caches'].forEach(section => {
          if (overrides[section]) {
            checkDuplicates(overrides[section], section);
          }
        });

        const duplicates = Array.from(descriptions.entries()).filter(([_, paths]) => paths.length > 1);
        duplicates.forEach(([desc, paths]) => {
          suggestions.push(`Duplicate description found at: ${paths.join(', ')}. Consider creating a definition and using $ref`);
          qualityScore -= 3;
        });

        if (invalidRefs.length === 0 && duplicates.length === 0) {
          suggestions.push('All $ref references are valid and DRY principles are maintained');
        }

        break;
      }

      case 'metrics':
      case 'rpk': {
        // For metrics and RPK, we just check if the files exist
        if (!version) {
          return {
            success: false,
            error: 'version is required for metrics/rpk docs review'
          };
        }

        let filePath;
        if (doc_type === 'metrics') {
          filePath = path.join(repoRoot.root, 'modules', 'reference', 'pages', 'public-metrics-reference.adoc');
        } else {
          // RPK files are version-specific
          const normalizedVersion = version.startsWith('v') ? version : `v${version}`;
          const rpkDir = path.join(repoRoot.root, 'autogenerated', normalizedVersion, 'rpk');
          if (!fs.existsSync(rpkDir)) {
            return {
              success: false,
              error: `RPK docs directory not found at ${rpkDir}`,
              suggestion: 'Generate RPK docs first using generate_rpk_docs tool'
            };
          }
          filePath = rpkDir;
        }

        if (!fs.existsSync(filePath)) {
          return {
            success: false,
            error: `Generated docs not found at ${filePath}`,
            suggestion: `Generate ${doc_type} docs first using generate_${doc_type}_docs tool`
          };
        }

        filesAnalyzed++;
        suggestions.push(`${doc_type} documentation generated successfully`);
        suggestions.push('Manual review recommended for technical accuracy');

        break;
      }

      default:
        return {
          success: false,
          error: `Unknown doc_type: ${doc_type}`,
          suggestion: 'Use one of: properties, metrics, rpk, rpcn_connectors'
        };
    }

    // Ensure quality score doesn't go below 0
    qualityScore = Math.max(0, qualityScore);

    const results = {
      success: true,
      doc_type,
      version: version || 'N/A',
      files_analyzed: filesAnalyzed,
      issues,
      quality_score: qualityScore,
      suggestions,
      summary: `Reviewed ${doc_type} documentation. Quality score: ${qualityScore}/100. Found ${issues.length} issues.`
    };

    // Generate AsciiDoc report if requested
    if (generate_report) {
      const reportFilename = `review-${doc_type}${version ? `-${version}` : ''}-${formatDate()}.adoc`;
      const reportPath = path.join(repoRoot.root, reportFilename);
      generateReviewReport(results, reportPath);
      results.report_path = reportPath;
      results.report_generated = true;
    }

    return results;

  } catch (err) {
    return {
      success: false,
      error: err.message,
      suggestion: 'Check that the documentation has been generated and files exist'
    };
  }
}

module.exports = {
  generateReviewReport,
  reviewGeneratedDocs
};

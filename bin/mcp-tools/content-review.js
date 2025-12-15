/**
 * Content Review Tool
 *
 * Provides comprehensive content review with automatic style guide context.
 * This tool automatically fetches the style guide and provides review instructions,
 * so the LLM has everything needed in a single call.
 *
 * OPTIMIZATION: Caches style guide and review instructions.
 * - Style guide cached for 1 hour (rarely changes)
 * - Review instructions cached permanently (static)
 */

const fs = require('fs');
const path = require('path');
const cache = require('./cache');

/**
 * Review content with automatic style guide context
 * @param {Object} args - Tool arguments
 * @param {string} args.content - Content to review
 * @param {string} [args.focus] - What to focus on (comprehensive, style, terminology, clarity)
 * @param {string} [baseDir] - Base directory for finding resources
 * @returns {Object} Review context including style guide
 */
function reviewContent(args, baseDir) {
  if (!args || !args.content) {
    return {
      success: false,
      error: 'Missing required parameter: content'
    };
  }

  const focus = args.focus || 'comprehensive';

  // Validate focus parameter
  const validFocus = ['comprehensive', 'style', 'terminology', 'clarity'];
  if (!validFocus.includes(focus)) {
    return {
      success: false,
      error: `Invalid focus parameter. Must be one of: ${validFocus.join(', ')}`
    };
  }

  // Find base directory (either provided or from repo root)
  const actualBaseDir = baseDir || path.join(__dirname, '../..');

  // Load style guide resource (with caching)
  const styleGuidePath = path.join(actualBaseDir, 'mcp', 'team-standards', 'style-guide.md');
  const cacheKey = 'style-guide-content';

  let styleGuide = cache.get(cacheKey);

  if (!styleGuide) {
    if (!fs.existsSync(styleGuidePath)) {
      return {
        success: false,
        error: `Style guide not found at: ${styleGuidePath}`,
        suggestion: 'Ensure the MCP server is running from the correct directory'
      };
    }

    try {
      styleGuide = fs.readFileSync(styleGuidePath, 'utf8');
      cache.set(cacheKey, styleGuide, 60 * 60 * 1000); // Cache for 1 hour
    } catch (err) {
      return {
        success: false,
        error: `Failed to read style guide: ${err.message}`
      };
    }
  }

  // Build review instructions based on focus (cached permanently as they're static)
  const instructionsCacheKey = `review-instructions:${focus}`;
  let instructions = cache.get(instructionsCacheKey);

  if (!instructions) {
    instructions = buildReviewInstructions(focus);
    cache.set(instructionsCacheKey, instructions, 24 * 60 * 60 * 1000); // Cache for 24 hours
  }

  // Return the bundled context
  return {
    success: true,
    message: 'Style guide loaded. Please review the content according to the instructions below.',
    styleGuide,
    instructions,
    content: args.content,
    focus,
    // Provide formatted output that LLM can easily parse
    reviewContext: formatReviewContext(styleGuide, instructions, args.content, focus)
  };
}

/**
 * Build review instructions based on focus area
 * @param {string} focus - What to focus on
 * @returns {string} Review instructions
 */
function buildReviewInstructions(focus) {
  const baseInstructions = `
# Content Review Instructions

You are reviewing documentation for the Redpanda documentation team.

The style guide has been automatically loaded for your reference.

## Your task

Review the provided content and provide detailed, actionable feedback.
`;

  const focusInstructions = {
    comprehensive: `
Review all aspects of the content:

1. **Style violations** - Check against the style guide (capitalization, formatting, structure)
2. **Terminology issues** - Verify correct usage of approved terms
3. **Voice and tone** - Ensure consistent, appropriate tone
4. **Clarity and readability** - Identify confusing or unclear sections
5. **Technical accuracy** - Flag any technical issues (if detectable)
6. **Formatting** - Check AsciiDoc formatting, code blocks, lists
7. **Accessibility** - Verify heading hierarchy, alt text, link text

Provide specific line numbers or sections for each issue found.
`,
    style: `
Focus on style guide compliance:

1. **Formatting violations** - Capitalization, punctuation, spacing
2. **Structural issues** - Heading hierarchy, section organization
3. **Voice and tone** - Too formal, too casual, or inconsistent
4. **Style guide rules** - Any violations of documented standards

Reference specific style guide sections when identifying issues.
`,
    terminology: `
Focus on terminology:

1. **Incorrect terms** - Wrong capitalization, spelling, or usage
2. **Deprecated terms** - Outdated terms that should be replaced
3. **Inconsistent usage** - Same concept referred to differently
4. **Missing approved terms** - Concepts that should use glossary terms

Check against the terminology section of the style guide.
`,
    clarity: `
Focus on clarity and readability:

1. **Complex sentences** - Sentences that are too long or convoluted
2. **Unclear explanations** - Technical concepts that need more context
3. **Poor structure** - Content organization issues
4. **Missing context** - Assumptions about reader knowledge
5. **Confusing language** - Jargon without explanation

Suggest specific improvements for each issue.
`
  };

  return baseInstructions + (focusInstructions[focus] || focusInstructions.comprehensive);
}

/**
 * Format the complete review context for the LLM
 * @param {string} styleGuide - Style guide content
 * @param {string} instructions - Review instructions
 * @param {string} content - Content to review
 * @param {string} focus - Focus area
 * @returns {string} Formatted review context
 */
function formatReviewContext(styleGuide, instructions, content, focus) {
  return `${instructions}

---

# Style Guide Reference

${styleGuide}

---

# Content to Review

${content}

---

**Focus Area**: ${focus}

Please provide your review above, organized by issue type with specific line/section references.
`;
}

module.exports = {
  reviewContent
};

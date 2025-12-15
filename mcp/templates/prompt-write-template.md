---
description: "Generate [CONTENT-TYPE] following team standards"
version: "1.0.0"
arguments:
  topic:
    description: "The topic to write about"
    required: true
  target_module:
    description: "Where in Antora structure this belongs (optional)"
    required: false
  context:
    description: "Additional context or requirements"
    required: false
---

# Write [CONTENT-TYPE]

You are writing [CONTENT-TYPE] for the Redpanda documentation team.

## Your Task

Create [CONTENT-TYPE] that follows our team standards.

## Resources to Read First

- `redpanda://style-guide` - Complete style guide
- Official glossary for terminology:
  - GitHub: https://github.com/redpanda-data/docs/tree/shared/modules/terms/partials
  - Published: https://docs.redpanda.com/current/reference/glossary/
- `redpanda://[content-type]-template` - Template for this content type (if available)
- [Add other relevant resources]

Use `get_antora_structure` tool to understand the documentation organization.

## Standards for [CONTENT-TYPE]

### Structure

[CONTENT-TYPE] should follow this structure:

1. [Section 1]
   - [What goes here]
2. [Section 2]
   - [What goes here]
3. [Section 3]
   - [What goes here]

### Content Requirements

[What must be included:]
- [Requirement 1]
- [Requirement 2]
- [Requirement 3]

### Writing Style

Follow these style guidelines:
- Present tense
- Active voice
- Second person ("you")
- Sentence case for all headings except title
- Imperative form for instructions (no gerunds)
- Avoid overuse of bold or em dashes

### AsciiDoc Format

- All xrefs must include module name
- Use `glossterm` macro for glossary terms on first mention
- Code blocks use appropriate roles (`.no-copy` for outputs)
- Custom macros used correctly

## Quality Checklist

Before finalizing, verify:
- [ ] Structure follows template
- [ ] All required sections included
- [ ] Code examples are realistic and tested
- [ ] Terminology uses approved terms
- [ ] Glossary terms use `glossterm` macro
- [ ] All xrefs include module names
- [ ] Voice is clear and conversational
- [ ] Headings use sentence case

## Output Format

Provide complete [CONTENT-TYPE] in AsciiDoc format:

```asciidoc
= Page Title
:description: Brief description

Opening content explaining what this covers.

== First section

Content here.

== Second section

More content.
```

---

Please provide:
1. **Topic**: What this [CONTENT-TYPE] should cover
2. **Target module** (optional): Where in Antora structure this belongs
3. **[Other context]**: [Additional information needed]

I'll create complete [CONTENT-TYPE] following all team standards.

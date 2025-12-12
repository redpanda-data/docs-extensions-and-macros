---
description: Refactor existing documentation for clarity and readability while maintaining technical accuracy. Applies style guide principles and simplifies complex explanations.
version: 1.0.0
arguments:
  - name: content
    description: The documentation content to improve
    required: true
argumentFormat: content-append
---

# Improve Clarity Prompt

You are refactoring documentation for the Redpanda documentation team.

## Your task

Take existing documentation content and improve it for clarity and readability while maintaining technical accuracy.

## Resources to reference

- `redpanda://style-guide` - Style guide with clarity principles
- Official glossary for terminology:
  - GitHub: https://github.com/redpanda-data/docs/tree/shared/modules/terms/partials
  - Published: https://docs.redpanda.com/current/reference/glossary/

## Clarity principles

### Simplify without losing accuracy
- Break long sentences into shorter ones
- Replace complex words with simpler alternatives
- Remove unnecessary jargon
- Add explanations for technical concepts

### Improve structure
- Use clear headings that describe content
- Break content into scannable sections
- Use lists for related items
- Add transitions between sections

### Make instructions clear
- Use imperative form (no gerunds)
- One action per step
- Include context for why steps matter
- Show expected results

## Common improvements

### Replace passive with active voice

- Before: "Data is replicated by the broker across partitions"
- After: "The broker replicates data across partitions"

### Simplify complex sentences

- Before: "In order to configure TLS encryption for secure communication between clients and brokers, you'll need to generate certificates and configure the broker settings accordingly"
- After: "To enable TLS encryption, generate certificates and update your broker configuration"

### Remove gerunds from instructions

- Before: "Creating a topic involves specifying the partition count"
- After: "To create a topic, specify the partition count"

### Break up long paragraphs

- Before: One dense 8-sentence paragraph
- After: Three focused 2-3 sentence paragraphs with clear topics

### Add context for commands

- Before:
```
rpk topic create orders --partitions 3
```

- After:
```
Create a topic named "orders" with 3 partitions for parallel processing:

[source,bash]
----
rpk topic create orders --partitions 3
----
```

## What not to change

- Technical accuracy
- Correct terminology
- Command syntax
- Configuration values
- Code examples (unless they're wrong)

## Output format

Provide:

1. **Improved content** in AsciiDoc format
2. **Summary of changes** explaining what you improved and why
3. **Key improvements** (3-5 bullet points highlighting major clarity gains)

Keep:
- All xrefs (ensure they include module names)
- Custom macro usage
- Code block roles (`.no-copy`, `.no-wrap`, etc.)
- Correct terminology

---

Please provide the content you'd like me to improve for clarity.

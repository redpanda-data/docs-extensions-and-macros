# Redpanda Documentation Style Guide

## Base Style Guide

This guide is based on the [Google Developer Documentation Style Guide](https://developers.google.com/style). All Google style guidelines apply unless explicitly overridden below.

Key Google style principles we emphasize:

- Use present tense
- Use active voice
- Use second person ("you" instead of "the user")
- Write in a conversational tone
- Use sentence case for all headings except the page title

## Redpanda team preferences

### Formatting conventions

Avoid overuse of bold text:
- Use bold sparingly, primarily for UI elements and important warnings
- Don't bold every important word or phrase
- Prefer clear writing over heavy formatting
- Good: "To enable TLS, set the `enable_tls` flag to true"
- Avoid: "To **enable TLS**, set the **`enable_tls`** flag to **true**"

Avoid em dashes:
- Use parentheses or commas for asides instead of em dashes
- Use colons to introduce explanations or lists
- Break long sentences into shorter ones rather than using em dashes
- Good: "TLS encryption (enabled by default) protects data in transit"
- Good: "TLS encryption protects data in transit. It's enabled by default"
- Avoid: "TLS encryption—enabled by default—protects data in transit"

### When bold is appropriate

Use bold only for:

- UI element names: Click the Start button
- Important warnings or cautions (sparingly)
- Glossary terms on first use (optional, if using a glossary system)

### When parentheses are better than em dashes

Use parentheses for:

- Clarifications or asides
- Abbreviations: "Transport Layer Security (TLS)"
- Version numbers or optional information

## Redpanda-specific guidelines

### Voice and tone

General principles:

- Clear and direct: Use simple, straightforward language
- Technically accurate: Precision matters, but don't sacrifice clarity
- Helpful: Anticipate questions and provide context
- Conversational but professional: Friendly without being casual
- Action-oriented: Focus on what users can do

### Voice examples

Good: "Configure your cluster to use TLS encryption for secure communication."
Too Casual: "Let's slap some TLS on your cluster!"
Too Formal: "It is advisable that one should configure the cluster such that TLS encryption protocols are employed."

## Writing standards

### Headings

**Title (H1):** Can use title case or sentence case based on content type.

**All other headings (H2, H3, H4, etc.):** Use sentence case only.

- Capitalize only the first word and proper nouns
- Make headings descriptive and scannable
- Use verb phrases for task-based headings

Examples:

```asciidoc
= Page Title Can Use Title Case (H1)

== Configure TLS encryption (H2 - sentence case)

=== Set up certificates (H3 - sentence case)

== Deploy a three-node cluster (H2 - sentence case)
```

Good: "Configure TLS encryption"
Good: "Deploy a three-node cluster"
Bad: "Configure TLS Encryption" (don't capitalize "Encryption")
Bad: "Deploy A Three-Node Cluster" (don't capitalize every word)
Bad: "TLS" (not descriptive enough)
Bad: "Configuration" (too vague)

### Lists

- Use parallel structure (all items start with same part of speech)
- Use numbered lists for sequential steps
- Use bulleted lists for non-sequential items
- Capitalize the first word of each list item
- Use periods for complete sentences, omit for fragments

### Code examples
- Always provide context before code examples
- Include comments explaining non-obvious behavior
- Show both the command and expected output when relevant
- Use realistic examples, not foo/bar placeholders when possible

### Links and cross-references

We use AsciiDoc with Antora. Important rules:

**Internal links (xref):**
- Always include the module name, even within the same component
- Never use relative paths (like `./page.adoc`)
- Use descriptive link text (never "click here")

```asciidoc
Good: xref:security:tls-config.adoc[TLS configuration guide]
Good: xref:manage:kubernetes/configure.adoc[Configure your cluster]
Bad: xref:./tls-config.adoc[guide]  // No relative paths!
Bad: xref:tls-config.adoc[guide]    // Missing module!
Bad: xref:security:tls-config.adoc[Click here]  // Poor link text
```

**Glossary terms (glossterm macro):**
- Use the `glossterm` macro to reference terms defined in the glossary
- Link terms on first mention in a document
- Glossary terms are in: https://github.com/redpanda-data/docs/tree/shared/modules/terms/partials

```asciidoc
✅ Good: A glossterm:topic[] is divided into glossterm:partition[,partitions]
✅ Good: The glossterm:broker[] handles data storage
❌ Bad: A topic is divided into partitions  // Terms not linked
```

**External links:**
- Use descriptive link text
- Include brief context for where the link goes

```asciidoc
✅ Good: See the https://kafka.apache.org/documentation/[Apache Kafka documentation]
❌ Bad: See https://kafka.apache.org/documentation/[here]
```

## Structure standards

### Prerequisites section
Always include when users need:
- Specific software installed
- Prior configuration completed
- Specific permissions or access
- Understanding of certain concepts

### Procedure format
1. Start with what the user will accomplish
2. List prerequisites
3. Provide numbered steps
4. Include verification steps
5. Suggest next steps or related topics

### Examples section
Include examples that:
- Cover common use cases
- Show real-world scenarios
- Include expected output
- Explain what's happening

## Terminology

### Official glossary sources

Our approved terminology is maintained in these locations:

- **GitHub source**: https://github.com/redpanda-data/docs/tree/shared/modules/terms/partials (each term is a separate file)
- **Published glossary**: https://docs.redpanda.com/current/reference/glossary/

**Always reference the official glossary when you need term definitions or approved usage.**

### Quick reference: Common terms

Use these as a quick reference, but check the official glossary for complete definitions:

**Product names:**
- Redpanda (never RedPanda or red panda)
- Redpanda Cloud
- Redpanda Console
- Redpanda Connect (formerly Benthos)
- Kafka (when referring to Apache Kafka)

**Kafka concepts (lowercase):**
- topic
- partition
- broker
- cluster
- consumer
- producer
- leader (not master)
- replica (not slave)

**Security terms:**
- TLS (not SSL - deprecated)
- SASL
- mTLS
- ACL
- allowlist (not whitelist - deprecated)
- denylist (not blacklist - deprecated)

**Command names (lowercase):**
- `rpk`
- `docker`
- `kubectl`

### Using the glossterm macro

When writing documentation, link to glossary terms using the `glossterm` macro:

```asciidoc
A glossterm:topic[] is divided into glossterm:partition[,partitions]
The glossterm:broker[] handles data replication
```

See the official glossary for the complete list of terms and their definitions.

### Command documentation
- Show the full command with all required flags
- Explain what each flag does
- Provide example output
- Mention common errors and solutions

### API documentation
- Start with a one-sentence description
- Document all parameters (name, type, required/optional, description)
- Include request and response examples
- Document error responses

## Accessibility

### Images and diagrams
- Always include alt text
- Use diagrams to supplement text, not replace it
- Describe the diagram in surrounding text

### Structure
- Use proper heading hierarchy (don't skip levels)
- One H1 per page
- Logical heading progression (H2 → H3, never H2 → H4)

### Code blocks
- Always specify the language for syntax highlighting
- Include descriptive titles when helpful
- Ensure code is keyboard-navigable

## Grammar and mechanics

### Active voice
Prefer active voice over passive voice for clarity.

Good: "Redpanda encrypts data at rest"
Avoid: "Data is encrypted at rest by Redpanda"

### Present tense
Use present tense for describing how things work.

Good: "The broker replicates data across partitions"
Avoid: "The broker will replicate data across partitions"

### Second person
Address the reader directly as "you".

Good: "You can configure TLS by..."
Avoid: "Users can configure TLS by..." or "We can configure TLS by..."

### Contractions
Use contractions sparingly in technical content. Avoid in:
- Command documentation
- API references
- Configuration guides

Acceptable in:
- Tutorials
- Conceptual overviews
- Blog-style content

## Error messages and troubleshooting

### Format
1. State what went wrong
2. Explain why it happened
3. Provide specific steps to fix it

### Example

```markdown
**Problem**: `rpk` returns "connection refused"

**Cause**: The Redpanda broker isn't running or isn't accessible on the specified port.

**Solution**:
1. Verify the broker is running: `systemctl status redpanda`
2. Check the broker address: `rpk cluster info`
3. Ensure no firewall is blocking port 9092
```

## Review checklist

Before publishing, verify:
- [ ] All code examples tested and working
- [ ] Links are valid and point to correct destinations
- [ ] Images have alt text
- [ ] Headings follow hierarchy
- [ ] Terminology is consistent and correct
- [ ] Voice and tone are appropriate
- [ ] Prerequisites are listed
- [ ] Examples are realistic and helpful
- [ ] Grammar and spelling are correct
- [ ] Accessibility standards met

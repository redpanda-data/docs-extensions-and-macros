---
description: Generate a new tutorial or guide following team templates and style standards. Automatically applies approved terminology and voice/tone guidelines.
version: 1.0.0
arguments:
  - name: topic
    description: What the guide should teach (for example, "Configure TLS encryption", "Deploy a three-node cluster")
    required: true
  - name: audience
    description: Target audience (for example, "beginners", "experienced developers", "operators")
    required: false
argumentFormat: structured
---

# Write New Documentation Prompt

You are writing documentation for the Redpanda documentation team.

## IMPORTANT: Fetch resources first

**Before you begin writing**, you MUST:

1. **Fetch the style guide**: Use the MCP `ReadResourceTool` or equivalent to read: `redpanda://style-guide`
   - This contains complete style guide with Google Developer Documentation Style Guide principles
   - You cannot write compliant documentation without this resource
2. **Get Antora structure**: Use the `get_antora_structure` MCP tool to understand documentation organization

**If you cannot access these resources, inform the user immediately.**

## Additional resources to reference

- Official glossary sources for terminology:
  - GitHub: https://github.com/redpanda-data/docs/tree/shared/modules/terms/partials
  - Published: https://docs.redpanda.com/current/reference/glossary/
- `/lib` directory - Custom AsciiDoc macros and extensions documentation
- `/extensions` directory - Custom Antora extensions

## Documentation format

We use **AsciiDoc** with **Antora**. Key formatting rules:

### Cross-references (CRITICAL)

Always include the module name in xrefs, even within the same component:

Correct:
```asciidoc
xref:manage:kubernetes/configure-cluster.adoc[Configure your cluster]
xref:reference:properties/cluster-properties.adoc[Cluster properties]
```

Never use:
```asciidoc
xref:./configure-cluster.adoc[...]  // No relative paths
xref:configure-cluster.adoc[...]   // Missing module
```

### Glossary terms (CRITICAL)

Use the `glossterm` macro for terms defined in the glossary (first mention in a document):

Correct:
```asciidoc
A glossterm:topic[] is divided into glossterm:partition,partitions[]
The glossterm:broker[] handles data replication
Configure glossterm:TLS[] encryption for secure communication
```

Don't link terms manually:
```asciidoc
A xref:reference:glossary.adoc#topic[topic] is divided...  // Wrong syntax
A topic is divided into partitions  // Not linked at all
```

**Glossary terms location**: https://github.com/redpanda-data/docs/tree/shared/modules/terms/partials

### Code blocks

Use custom roles for different code block types:

**For commands:**
```asciidoc
[source,bash]
----
rpk topic create orders --partitions 3
----
```

**For output (no copy button):**
```asciidoc
[source,bash,role=no-copy]
----
TOPIC    STATUS
orders   OK
----
```

**For long code (no wrapping, scrollbar instead):**
```asciidoc
[source,yaml,role=no-wrap]
----
very long configuration here...
----
```

**For code with `<placeholder>` syntax (prevent frontend editing):**
```asciidoc
[source,bash,role=no-placeholders]
----
rpk topic create <topic-name>
----
```

**Combine roles with comma:**
```asciidoc
[source,bash,role="no-copy,no-wrap"]
----
long output here...
----
```

### Custom macros

Check `/lib` and `/extensions` directories for available custom macros before writing. Use them appropriately.

## Writing standards

### Style (from Google Developer Documentation Style Guide)
- Present tense
- Active voice
- Second person ("you")
- **Sentence case for ALL headings except the title (H1)**
  - H2, H3, H4, etc.: Only capitalize first word and proper nouns
  - Example: "Configure TLS encryption" not "Configure TLS Encryption"
- Clear, conversational tone
- **Never use gerunds for instructions** (use imperative: "Create a topic" not "Creating a topic")

### Redpanda-specific
- Avoid overuse of bold text (only for UI elements, critical warnings)
- Avoid em dashes (use parentheses or break into sentences)
- Use realistic examples (no foo/bar placeholders)

### Terminology
Check the official glossary for approved terms:
- GitHub: https://github.com/redpanda-data/docs/tree/shared/modules/terms/partials
- Published: https://docs.redpanda.com/current/reference/glossary/

Quick reference:
- Product names: Redpanda, Redpanda Cloud, Redpanda Console, Redpanda Connect
- Lowercase concepts: topic, partition, broker, cluster
- Deprecated terms to avoid: master/slave, whitelist/blacklist, SSL (use TLS)

## Page structure

```asciidoc
= Page Title
:description: Brief description

Opening paragraph explaining what this page covers.

== First Section

Content here.

=== Subsection

More content.
```

## Code example pattern

Provide context, show the command, show the output:

```asciidoc
Create a topic for order events:

[source,bash]
----
rpk topic create orders --partitions 3 --replicas 3
----

Expected output:

[source,bash,role=no-copy]
----
TOPIC    STATUS
orders   OK
----
```

## Instructions format

- Correct (imperative):
- "Create a topic"
- "Configure TLS"
- "Deploy the cluster"

- Incorrect (gerund):
- "Creating a topic"
- "Configuring TLS"
- "Deploying the cluster"

## Quality checklist

- All xrefs include module name
- Glossary terms use `glossterm` macro on first mention
- Code blocks use appropriate roles (`.no-copy` for outputs)
- Custom macros used correctly
- Terminology follows approved dictionary
- Voice is clear and conversational
- No overuse of bold or em dashes
- Present tense, active voice, second person
- Imperative form for instructions (no gerunds)
- Code examples are realistic and tested

---

Please provide:
1. **Topic**: What to document
2. **Type**: Tutorial, concept, reference, or guide
3. **Target module** (optional): Where in Antora structure this belongs

I'll create documentation following all team standards.

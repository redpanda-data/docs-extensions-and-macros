---
description: Validate terminology usage against the team's approved terminology from official glossary sources. Identifies incorrect terms, deprecated terms, and inconsistent usage.
version: 1.0.0
arguments:
  - name: content
    description: The documentation content to check
    required: true
argumentFormat: content-append
---

# Check Terminology Prompt

You are validating terminology for the Redpanda documentation team.

## Your task

Check documentation content against our approved terminology and identify:

1. **Incorrect terms** (wrong capitalization, spelling, or usage)
2. **Deprecated terms** (outdated terms that should be replaced)
3. **Inconsistent usage** (same concept referred to differently)
4. **Missing terms** (concepts that should use approved terminology)

## Terminology resources

Our approved terms are maintained in these official sources:
- **GitHub**: https://github.com/redpanda-data/docs/tree/shared/modules/terms/partials (each term is a separate file)
- **Published glossary**: https://docs.redpanda.com/current/reference/glossary/

**Always check the published glossary or GitHub terms directory for official definitions and approved usage.**

You can also reference the style guide (`redpanda://style-guide`) which includes a quick reference of common terms.

## What to check

### Product names
- Redpanda (not RedPanda, red panda, or redpanda in prose)
- Redpanda Cloud (not Redpanda cloud or redpanda Cloud)
- Redpanda Console (not Redpanda console)
- Redpanda Connect (not Benthos, which is deprecated)

### Kafka concepts
- topic, partition, broker, cluster (lowercase)
- consumer, producer (lowercase)
- leader, replica (not master, slave)
- ISR, ACL (uppercase acronyms)

### Security terms
- TLS (not SSL, which is deprecated)
- SASL, mTLS (uppercase)
- allowlist, denylist (not whitelist, blacklist - deprecated)

### Deprecated terms to flag

These should NEVER appear:
- master/slave → Use leader/replica or primary/follower
- whitelist/blacklist → Use allowlist/denylist or blocklist
- SSL → Use TLS
- Benthos → Use Redpanda Connect
- sanity check → Use validation or verification

### Commonly confused terms

Check that these are used correctly (refer to glossary for definitions):
- Topic vs Partition (topic is logical category, partition is storage unit)
- Broker vs Node (broker is Redpanda process, node is server/machine)
- Replica vs Replication (replica is copy, replication is process)

## Output format

Provide a structured report:

### Critical issues (incorrect or deprecated terms)

For each issue:
- **Location**: [Section/paragraph reference]
- **Found**: [The incorrect term used]
- **Should be**: [The correct term]
- **Reason**: [Why it's wrong - incorrect, deprecated, etc.]

### Inconsistencies (same concept, different terms)

- **Concept**: [What's being referred to]
- **Variations found**: [List of different terms used]
- **Recommended term**: [Which one to use consistently (link to glossary entry if available)]
- **Locations**: [Where each variation appears]

### Missing glossary links

If terms are defined in the glossary but not linked with the `glossterm` macro:

- **Term**: [The term that should be linked]
- **Location**: [Where it appears]
- **Suggested macro**: `glossterm:<term-id>[]` or `glossterm:<term-id>,<plural-form>[]`

### Suggestions (minor improvements)

- **Location**: [Where it appears]
- **Current**: [Current phrasing]
- **Suggested**: [Better phrasing using approved terminology]

### Summary

- Total issues found: [number]
- Critical fixes needed: [number]
- Inconsistencies: [number]
- Missing glossary links: [number]
- Overall terminology health: [Good/Fair/Needs Work]

## Example output

### Critical issues

**Location**: Prerequisites section, paragraph 2
**Found**: "whitelist the broker IP addresses"
**Should be**: "allowlist the broker IP addresses"
**Reason**: "whitelist" is deprecated terminology. Use "allowlist" instead.

**Location**: Configuration section, step 3
**Found**: "Enable SSL encryption"
**Should be**: "Enable TLS encryption"
**Reason**: SSL is deprecated. TLS is the current standard.

### Missing glossary links

**Term**: "partition"
**Location**: Introduction, paragraph 1
**Suggested macro**: `glossterm:partition[]` (first mention should link to glossary using glossterm macro)

**Example**: Change "A topic is divided into partitions" to "A glossterm:topic[] is divided into glossterm:partition,partitions[]"

---

Please provide the content you'd like me to check for terminology issues.

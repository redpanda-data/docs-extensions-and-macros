# FAQ Structured Data Extension

Generates schema.org FAQPage JSON-LD for better SEO and Google rich results.

## Simple Usage (Recommended)

Writers just provide anchors - the extension auto-extracts questions and answers from page sections:

```asciidoc
= My Documentation Page
:page-faq-1-anchor: #installation
:page-faq-2-anchor: #requirements

[#installation]
== How do I install Redpanda?

You can install Redpanda using Docker, Kubernetes, or as a native binary.

[#requirements]
== What are the system requirements?

Redpanda requires at least 2GB of RAM and 2 CPU cores.
```

**What gets extracted:**
- **Question**: Heading text (`How do I install Redpanda?`)
- **Answer**: Section content (everything between this heading and the next)
- **URL**: Page URL + anchor (`https://docs.redpanda.com/page#installation`)

## Manual Override

Provide custom question/answer text when section content isn't suitable:

```asciidoc
:page-faq-1-question: Does Redpanda support Kafka APIs?
:page-faq-1-answer: Yes! Redpanda is fully compatible with Kafka APIs including producers, consumers, and Kafka Connect.
```

## Mixed Usage

Combine auto-extraction and manual FAQs:

```asciidoc
:page-faq-1-anchor: #installation              ← Auto-extracted
:page-faq-2-question: Is Redpanda free?         ← Manual
:page-faq-2-answer: Yes, Redpanda is open source.
:page-faq-3-anchor: #requirements              ← Auto-extracted
```

## Generated Output

The extension generates schema.org FAQPage JSON-LD in the page `<head>`:

```json
{
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "How do I install Redpanda?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "You can install Redpanda using Docker, Kubernetes, or as a native binary."
      },
      "url": "https://docs.redpanda.com/page#installation"
    }
  ]
}
```

## Benefits

✅ **Zero duplication** - Questions and answers already exist in your content
✅ **Google rich results** - FAQPage structured data shows in search
✅ **Flexible** - Auto-extract or override with custom text
✅ **SEO friendly** - Proper schema.org markup

## Requirements

- FAQs must be numbered sequentially (1, 2, 3...)
- For auto-extraction, anchor must point to a heading or section
- Both question and answer required (auto or manual)

## Implementation

**Extension**: `extensions/add-faq-structured-data.js`
**UI Template**: Updated `head-structured-data.hbs` to include FAQ JSON-LD
**Playbook**: Add to your playbook's extensions list

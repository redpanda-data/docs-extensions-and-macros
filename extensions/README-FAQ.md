# FAQ Structured Data Extension

Generates schema.org FAQPage JSON-LD for better SEO and Google rich results.

## Usage

Add FAQ attributes to your AsciiDoc page header:

```asciidoc
= My Documentation Page
:page-faq-1-question: How do I install Redpanda?
:page-faq-1-answer: Download from redpanda.com and run the installer. See our installation guide for details.
:page-faq-1-anchor: #installation

:page-faq-2-question: What are the system requirements?
:page-faq-2-answer: You need at least 2GB of RAM and 2 CPU cores for development. Production deployments require 16GB RAM and 8 CPU cores.
:page-faq-2-anchor: #requirements

:page-faq-3-question: Does Redpanda support Kafka APIs?
:page-faq-3-answer: Yes! Redpanda is fully compatible with Kafka APIs including producers, consumers, and Kafka Connect.
```

**Required attributes per FAQ:**
- `page-faq-N-question` - The FAQ question
- `page-faq-N-answer` - The FAQ answer

**Optional:**
- `page-faq-N-anchor` - Link to page section (e.g., `#installation`)

**Tips:**
- FAQs must be numbered sequentially (1, 2, 3...)
- Answers can reference prose content: "See our installation guide for details"
- Anchors create deep links to related content on the page
- Keep answers concise (Google truncates after ~300 characters)

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
        "text": "Download from redpanda.com and run the installer."
      },
      "url": "https://docs.redpanda.com/page#installation"
    }
  ]
}
```

## Benefits

✅ **Simple** - Just question + answer attributes
✅ **Flexible** - Reference existing content in answers
✅ **SEO** - Google rich results in search
✅ **Deep linking** - Optional anchors to page sections

## Implementation

- **Extension**: `extensions/add-faq-structured-data.js`
- **UI Template**: Updated `head-structured-data.hbs`
- **Dependencies**: None (uses built-in Antora)

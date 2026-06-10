const { describe, it, expect } = require('@jest/globals')
const {
  convertNumberedListsToAsciiDoc,
  convertIndentedTablesToAsciiDoc,
  capToTwoSentences
} = require('../../../tools/rpk-docs/generate-rpk-docs')

describe('Indented Table Conversion', () => {
  describe('Detection', () => {
    it('should detect indented columnar format', () => {
      const input = `Both flags accept values in the following formats:

    now                   the current time, useful for --since=now
    13 digits             parsed as a Unix millisecond
    9 digits              parsed as a Unix second
    YYYY-MM-DD            parsed as a day, UTC

Some other text.`

      const result = convertIndentedTablesToAsciiDoc(input)

      expect(result).toContain('[cols="1m,1a"]')
      expect(result).toContain('|===')
      expect(result).toContain('|Value |Description')
      expect(result).toContain('|now |the current time')
      expect(result).toContain('|13 digits |parsed as a Unix millisecond')
      expect(result).toContain('|YYYY-MM-DD |parsed as a day, UTC')
      expect(result).toContain('Some other text.')
    })

    it('should handle multiple consecutive tables', () => {
      const input = `First table:

    value1    description 1
    value2    description 2

Text between tables.

    value3    description 3
    value4    description 4

End text.`

      const result = convertIndentedTablesToAsciiDoc(input)

      // Should have two tables
      const tableCount = (result.match(/\|===/g) || []).length / 2 // Each table has 2 |===
      expect(tableCount).toBe(2)

      expect(result).toContain('|value1 |description 1')
      expect(result).toContain('|value3 |description 3')
      expect(result).toContain('Text between tables.')
      expect(result).toContain('End text.')
    })

    it('should ignore single indented lines (not tables)', () => {
      const input = `Some text:

    Just a single indented line

More text.`

      const result = convertIndentedTablesToAsciiDoc(input)

      // Should NOT create a table
      expect(result).not.toContain('|===')
      expect(result).toContain('Just a single indented line')
    })

    it('should handle descriptions with multiple words', () => {
      const input = `Values:

    3ms    three milliseconds
    10s    ten seconds
    1h     one hour
    1m3ms  one minute and three milliseconds`

      const result = convertIndentedTablesToAsciiDoc(input)

      expect(result).toContain('|3ms |three milliseconds')
      expect(result).toContain('|10s |ten seconds')
      expect(result).toContain('|1m3ms |one minute and three milliseconds')
    })

    it('should handle longer descriptions that span alignment', () => {
      const input = `Format options:

    ascii       print the number as ascii (default)
    hex64       sixteen hex characters
    big32       four byte big endian number
    bool        "true" if the number is non-zero, "false" if the number is zero`

      const result = convertIndentedTablesToAsciiDoc(input)

      expect(result).toContain('|ascii |print the number as ascii (default)')
      expect(result).toContain('|hex64 |sixteen hex characters')
      expect(result).toContain('|bool |"true" if the number is non-zero, "false" if the number is zero')
    })
  })

  describe('Edge Cases', () => {
    it('should not convert indented code examples', () => {
      const input = `Example command:

    rpk topic create my-topic

Some text.`

      const result = convertIndentedTablesToAsciiDoc(input)

      // Should NOT create a table (no multiple spaces for column separation)
      expect(result).not.toContain('|===')
      expect(result).toContain('rpk topic create my-topic')
    })

    it('should preserve empty lines within table detection area', () => {
      const input = `Values:

    value1    description 1

    value2    description 2`

      const result = convertIndentedTablesToAsciiDoc(input)

      // Should create a table with both rows
      expect(result).toContain('|value1 |description 1')
      expect(result).toContain('|value2 |description 2')
    })

    it('should handle text with no indented tables', () => {
      const input = `This is regular text.
No indented tables here.
Just normal paragraphs.`

      const result = convertIndentedTablesToAsciiDoc(input)

      expect(result).toBe(input)
    })

    it('should handle empty or null input', () => {
      expect(convertIndentedTablesToAsciiDoc('')).toBe('')
      expect(convertIndentedTablesToAsciiDoc(null)).toBe(null)
      expect(convertIndentedTablesToAsciiDoc(undefined)).toBe(undefined)
    })
  })

  describe('Column Parsing', () => {
    it('should split columns on multiple spaces', () => {
      const input = `Values:

    col1    col2 with spaces    col3
    row2    another description here`

      const result = convertIndentedTablesToAsciiDoc(input)

      // Should only create 2 columns (Value and Description)
      // The description includes all text after the first column
      expect(result).toContain('|col1 |col2 with spaces col3')
      expect(result).toContain('|row2 |another description here')
    })

    it('should handle values with special characters', () => {
      const input = `Formats:

    --flag-name    description with dashes
    $VARIABLE      environment variable
    /path/to/file  file path description`

      const result = convertIndentedTablesToAsciiDoc(input)

      expect(result).toContain('|--flag-name |description with dashes')
      expect(result).toContain('|$VARIABLE |environment variable')
      expect(result).toContain('|/path/to/file |file path description')
    })
  })

  describe('Real-World Examples', () => {
    it('should convert rpk transform logs time format table', () => {
      const input = `Both flags accept values in the following formats:

    now                   the current time, useful for --since=now
    13 digits             parsed as a Unix millisecond
    9 digits              parsed as a Unix second
    YYYY-MM-DD            parsed as a day, UTC
    YYYY-MM-DDTHH:MM:SSZ  parsed as RFC3339, UTC; fractional seconds optional (.MMM)
    -dur                  a negative duration from now
    dur                   a positive duration from now`

      const result = convertIndentedTablesToAsciiDoc(input)

      expect(result).toContain('[cols="1m,1a"]')
      expect(result).toContain('|===')
      expect(result).toContain('|Value |Description')
      expect(result).toContain('|now |the current time, useful for --since=now')
      expect(result).toContain('|YYYY-MM-DDTHH:MM:SSZ |parsed as RFC3339, UTC; fractional seconds optional (.MMM)')
      expect(result).toContain('|-dur |a negative duration from now')
    })

    it('should convert rpk topic consume format table', () => {
      const input = `Number formatting modifiers:

     ascii       print the number as ascii (default)
     hex64       sixteen hex characters
     hex32       eight hex characters
     big64       eight byte big endian number
     big32       four byte big endian number
     little64    eight byte little endian number
     byte        one byte number
     bool        "true" if the number is non-zero, "false" if the number is zero`

      const result = convertIndentedTablesToAsciiDoc(input)

      expect(result).toContain('|ascii |print the number as ascii (default)')
      expect(result).toContain('|big64 |eight byte big endian number')
      expect(result).toContain('|bool |"true" if the number is non-zero, "false" if the number is zero')
    })

    it('should handle continuation lines (multi-line cell content)', () => {
      const input = `License information:

    Organization:    Organization the license was generated for.
    Type:            Type of license: free, enterprise, etc.
    Expires:         Expiration date of the license.
    Violation:       Whether the cluster is using enterprise features without
                     a valid license.`

      const result = convertIndentedTablesToAsciiDoc(input)

      expect(result).toContain('[cols="1m,1a"]')
      expect(result).toContain('|Violation |Whether the cluster is using enterprise features without a valid license.')
      // Verify colons are removed from values
      expect(result).toContain('|Organization |Organization the license was generated for.')
      expect(result).toContain('|Type |Type of license: free, enterprise, etc.')
      expect(result).not.toContain('|Organization:')
      expect(result).not.toContain('|Type:')
    })

    it('should skip conversion when option.skip is true', () => {
      const input = `Values:

    now                   the current time
    13 digits             parsed as a Unix millisecond`

      const result = convertIndentedTablesToAsciiDoc(input, { skip: true })

      expect(result).toBe(input)
      expect(result).not.toContain('|===')
    })

    it('should not convert struct definitions', () => {
      const input = `The expected return is:

type pluginHelp struct {
    Path    string   \`json:"path,omitempty"\`
    Short   string   \`json:"short,omitempty"\`
    Long    string   \`json:"long,omitempty"\`
}`

      const result = convertIndentedTablesToAsciiDoc(input)

      expect(result).toBe(input)
      expect(result).not.toContain('|===')
      expect(result).toContain('type pluginHelp struct {')
    })
  })

  describe('Short Description Generation', () => {
    it('should exclude indented table content from short description', () => {
      const input = `Retrieve license information:

    Organization:    Organization the license was generated for.
    Type:            Type of license: free, enterprise, etc.
    Expires:         Expiration date of the license.`

      const result = capToTwoSentences(input)

      // Should only include the intro sentence, not the table data
      expect(result).toBe('Retrieve license information:')
      expect(result).not.toContain('Organization')
      expect(result).not.toContain('Type')
    })

    it('should handle normal multi-sentence descriptions', () => {
      const input = `This is the first sentence. This is the second sentence. This is the third sentence.`

      const result = capToTwoSentences(input)

      expect(result).toBe('This is the first sentence. This is the second sentence.')
    })

    it('should preserve sentences before indented content', () => {
      const input = `Report maintenance status. This command reports maintenance status for each node in the cluster.

    NODE-ID    ENABLED FINISHED ERRORS
    1          false false false`

      const result = capToTwoSentences(input)

      // Should not include the table data
      expect(result).not.toContain('NODE-ID')
      expect(result).not.toContain('ENABLED')
    })

    it('should exclude numbered list content from short description', () => {
      const input = `List loggers available on a Redpanda broker.

Loggers are discovered by, in order:

  1. Running the local Redpanda binary with \`--help-loggers\` (Linux only).
  2. Querying /v1/loggers on the Admin API.
  3. Falling back to a hardcoded list compiled into \`rpk\`.`

      const result = capToTwoSentences(input)

      // Should only include the intro sentence, not the list
      expect(result).toContain('List loggers available')
      expect(result).not.toContain('1.')
      expect(result).not.toContain('2.')
      expect(result).not.toContain('Running the local')
    })
  })

  describe('Numbered List Conversion', () => {
    it('should convert indented numbered lists to AsciiDoc format', () => {
      const input = `Loggers are discovered by, in order:
  1. Running the local Redpanda binary with \`--help-loggers\` (Linux only).
  2. Querying /v1/loggers on the Admin API.
  3. Falling back to a hardcoded list compiled into \`rpk\`.`

      const result = convertNumberedListsToAsciiDoc(input)

      // Should add blank line before list
      expect(result).toContain('Loggers are discovered by, in order:\n\n.')

      // Should convert to AsciiDoc list format
      expect(result).toContain('. Running the local Redpanda binary')
      expect(result).toContain('. Querying /v1/loggers on the Admin API')
      expect(result).toContain('. Falling back to a hardcoded list')

      // Should NOT contain numbered format
      expect(result).not.toContain('  1.')
      expect(result).not.toContain('  2.')
      expect(result).not.toContain('  3.')

      // Should remove indentation
      expect(result).not.toMatch(/^  \./m)
    })

    it('should require at least 2 items for list conversion', () => {
      const input = `Some text:
  1. Single item only.`

      const result = convertNumberedListsToAsciiDoc(input)

      // Should NOT convert single item
      expect(result).toBe(input)
      expect(result).toContain('  1.')
    })

    it('should handle lists with blank lines between items', () => {
      const input = `Steps:
  1. First step.

  2. Second step.
  3. Third step.`

      const result = convertNumberedListsToAsciiDoc(input)

      expect(result).toContain('. First step.')
      expect(result).toContain('. Second step.')
      expect(result).toContain('. Third step.')
    })

    it('should not convert non-sequential numbers', () => {
      const input = `Items:
  1. First item.
  5. Fifth item (non-sequential).`

      const result = convertNumberedListsToAsciiDoc(input)

      // Should NOT convert because numbers aren't sequential
      expect(result).toBe(input)
    })

    it('should handle multiple separate lists', () => {
      const input = `First list:
  1. Item A1.
  2. Item A2.

Some text in between.

Second list:
  1. Item B1.
  2. Item B2.`

      const result = convertNumberedListsToAsciiDoc(input)

      // Both lists should be converted
      const dotCount = (result.match(/^\. /gm) || []).length
      expect(dotCount).toBe(4)
    })

    it('should handle real-world example from rpk cluster loggers list', () => {
      const input = `List loggers available on a Redpanda broker.

Loggers are discovered by, in order:
  1. Running the local Redpanda binary with \`--help-loggers\` (Linux only).
  2. Querying /v1/loggers on the Admin API.
  3. Falling back to a hardcoded list compiled into \`rpk\`.

Without \`--node-id\`, the request is sent to any broker.`

      const result = convertNumberedListsToAsciiDoc(input)

      expect(result).toContain('. Running the local Redpanda binary')
      expect(result).toContain('. Querying /v1/loggers on the Admin API')
      expect(result).toContain('. Falling back to a hardcoded list')
      expect(result).not.toContain('  1.')
    })
  })
})

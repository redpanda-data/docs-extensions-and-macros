'use strict'

const { formatTooltipDefinition } = require('../../macros/glossary')

describe('formatTooltipDefinition', () => {
  test('converts backtick-delimited text to <code> for a data- tooltip attribute', () => {
    const result = formatTooltipDefinition('Managed by an agent that receives `rpk` commands.', 'data-tippy-content')
    expect(result).toBe('Managed by an agent that receives <code>rpk</code> commands.')
  })

  test('escapes double quotes so the HTML attribute is not broken', () => {
    const result = formatTooltipDefinition('The engine. "Oxla" may appear in logs.', 'data-tippy-content')
    expect(result).toBe('The engine. &quot;Oxla&quot; may appear in logs.')
  })

  test('escapes ampersands and angle brackets', () => {
    const result = formatTooltipDefinition('A <b>bold</b> claim & more', 'data-tippy-content')
    expect(result).toBe('A &lt;b&gt;bold&lt;/b&gt; claim &amp; more')
  })

  test('leaves backticks as escaped text for the native title attribute', () => {
    const result = formatTooltipDefinition('Uses `rpk` under the hood.', 'title')
    expect(result).toBe('Uses `rpk` under the hood.')
  })

  test('still escapes quotes for the native title attribute', () => {
    const result = formatTooltipDefinition('The "default" catalog.', 'title')
    expect(result).toBe('The &quot;default&quot; catalog.')
  })
})

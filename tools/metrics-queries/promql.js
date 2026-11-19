'use strict'

/**
 * A small PromQL parser for the static layer of `doc-tools check-queries`.
 *
 * It builds a tree that is enough to answer three questions without a
 * cluster: which vector selectors a query has, which labels each clause
 * names, and which function is applied to which selector. Prometheus is the
 * authority on syntax: the live layer sends every query to a real Prometheus,
 * and a query this parser accepts but Prometheus rejects fails there.
 *
 * Known limits:
 * - A metric named like a keyword (`on`, `by`, `sum`, `offset`, `bool` and
 *   so on) is not read as a metric.
 * - UTF-8 metric and label names in quotes (`{"my.metric"}`) are rejected.
 * - Durations are read as text. They are not checked for a valid unit order.
 * - Number literals in the newer duration form (`rate(x[5m]) * 1h`) are rejected.
 * - A recording rule name that starts with a colon is rejected.
 * - Experimental syntax beyond `limitk` and `limit_ratio` is rejected.
 */

const AGGREGATORS = new Set([
  'sum', 'min', 'max', 'avg', 'group', 'stddev', 'stdvar', 'count', 'count_values',
  'bottomk', 'topk', 'quantile', 'limitk', 'limit_ratio'
])
// Aggregators whose first argument is a parameter, not the vector.
const PARAM_AGGREGATORS = new Set(['count_values', 'bottomk', 'topk', 'quantile', 'limitk', 'limit_ratio'])
const SET_OPERATORS = new Set(['and', 'or', 'unless'])
const COMPARISONS = new Set(['==', '!=', '<=', '<', '>=', '>'])
const KEYWORDS = new Set([
  'by', 'without', 'on', 'ignoring', 'group_left', 'group_right', 'bool', 'offset',
  'and', 'or', 'unless', 'atan2'
])

// Lowest to highest. `^` is right associative.
const PRECEDENCE = [
  ['or'],
  ['and', 'unless'],
  ['==', '!=', '<=', '<', '>=', '>'],
  ['+', '-'],
  ['*', '/', '%', 'atan2'],
  ['^']
]
const precedenceOf = (op) => PRECEDENCE.findIndex((level) => level.includes(op))

const DURATION = /^(?:[0-9]+(?:ms|[smhdwy]))+/
const NUMBER = /^(?:0[xX][0-9a-fA-F]+|(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)/
// A name cannot start with a colon here, so that `[30m:1m]` splits into a range and a step.
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_:]*/

class PromqlSyntaxError extends Error {
  constructor (message, position) {
    super(message)
    this.name = 'PromqlSyntaxError'
    this.position = position
  }
}

function readString (text, start) {
  const quote = text[start]
  let i = start + 1
  let value = ''
  while (i < text.length) {
    const ch = text[i]
    if (ch === quote) return { value, end: i + 1 }
    if (ch === '\\' && quote !== '`') {
      const next = text[i + 1]
      const simple = { n: '\n', t: '\t', r: '\r', '\\': '\\', '"': '"', "'": "'" }
      value += next in simple ? simple[next] : `\\${next}`
      i += 2
      continue
    }
    if (ch === '\n' && quote !== '`') break
    value += ch
    i += 1
  }
  throw new PromqlSyntaxError('a string is not closed', start)
}

/**
 * Split a query into tokens. Comments (`#` to the end of the line) are dropped.
 */
function tokenize (text) {
  const tokens = []
  let i = 0
  const push = (type, value, start, end) => tokens.push({ type, value, start, end })
  while (i < text.length) {
    const ch = text[i]
    if (/\s/.test(ch)) { i += 1; continue }
    if (ch === '#') {
      while (i < text.length && text[i] !== '\n') i += 1
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const { value, end } = readString(text, i)
      push('string', value, i, end)
      i = end
      continue
    }
    const rest = text.slice(i)
    const duration = DURATION.exec(rest)
    // `5m` is a duration, `5` and `5e3` are numbers, and `5mfoo` is neither.
    if (duration && !/^[A-Za-z0-9_]/.test(rest.slice(duration[0].length))) {
      push('duration', duration[0], i, i + duration[0].length)
      i += duration[0].length
      continue
    }
    const number = NUMBER.exec(rest)
    if (number) {
      push('number', number[0], i, i + number[0].length)
      i += number[0].length
      continue
    }
    const identifier = IDENTIFIER.exec(rest)
    if (identifier) {
      push('identifier', identifier[0], i, i + identifier[0].length)
      i += identifier[0].length
      continue
    }
    const two = rest.slice(0, 2)
    if (['==', '!=', '<=', '>=', '=~', '!~'].includes(two)) {
      push('operator', two, i, i + 2)
      i += 2
      continue
    }
    if ('(){}[],=<>+-*/%^:@'.includes(ch)) {
      push('operator', ch, i, i + 1)
      i += 1
      continue
    }
    throw new PromqlSyntaxError(`unexpected character ${JSON.stringify(ch)}`, i)
  }
  return tokens
}

/**
 * Seconds in a duration such as `5m` or `1h30m`.
 */
function durationSeconds (text) {
  const units = { ms: 0.001, s: 1, m: 60, h: 3600, d: 86400, w: 604800, y: 31536000 }
  let total = 0
  const part = /([0-9]+)(ms|[smhdwy])/g
  let match
  while ((match = part.exec(text))) total += Number(match[1]) * units[match[2]]
  return total
}

class Parser {
  constructor (text) {
    this.text = text
    this.tokens = tokenize(text)
    this.index = 0
  }

  peek (offset = 0) { return this.tokens[this.index + offset] }

  is (type, value, offset = 0) {
    const token = this.peek(offset)
    return Boolean(token) && token.type === type && (value === undefined || token.value === value)
  }

  isWord (value, offset = 0) { return this.is('identifier', value, offset) }

  next () { return this.tokens[this.index++] }

  fail (message, token = this.peek()) {
    const where = token ? `at ${JSON.stringify(token.value)}` : 'at the end of the query'
    throw new PromqlSyntaxError(`${message} ${where}`, token ? token.start : this.text.length)
  }

  expect (type, value) {
    if (!this.is(type, value)) this.fail(`expected ${value ? JSON.stringify(value) : `a ${type}`}`)
    return this.next()
  }

  parse () {
    if (!this.tokens.length) throw new PromqlSyntaxError('the query is empty', 0)
    const expr = this.parseBinary(0)
    if (this.peek()) this.fail('unexpected text after the end of the expression')
    return expr
  }

  binaryOperator () {
    const token = this.peek()
    if (!token) return null
    if (token.type === 'operator' && precedenceOf(token.value) !== -1) return token.value
    if (token.type === 'identifier' && precedenceOf(token.value) !== -1) return token.value
    return null
  }

  parseBinary (level) {
    if (level >= PRECEDENCE.length) return this.parseUnary()
    let left = this.parseBinary(level + 1)
    while (true) {
      const op = this.binaryOperator()
      if (!op || precedenceOf(op) !== level) return left
      this.next()
      const node = { type: 'binary', op, left, bool: false, matching: null, group: null }
      if (this.isWord('bool')) {
        if (!COMPARISONS.has(op)) this.fail('bool is only for comparison operators')
        this.next()
        node.bool = true
      }
      if (this.isWord('on') || this.isWord('ignoring')) {
        const kind = this.next().value
        node.matching = { kind, labels: this.parseLabelList() }
        if (this.isWord('group_left') || this.isWord('group_right')) {
          const side = this.next().value
          if (SET_OPERATORS.has(op)) this.fail(`${side} cannot be used with ${op}`)
          node.group = { side, labels: this.is('operator', '(') ? this.parseLabelList() : [] }
        }
      }
      // `^` is right associative: parse the right side at the same level.
      node.right = op === '^' ? this.parseBinary(level) : this.parseBinary(level + 1)
      left = node
    }
  }

  parseUnary () {
    if (this.is('operator', '-') || this.is('operator', '+')) {
      const op = this.next().value
      // Unary binds weaker than `^`, as in Prometheus: -2^2 is -(2^2).
      return { type: 'unary', op, expr: this.parseBinary(PRECEDENCE.length - 1) }
    }
    return this.parsePostfix(this.parsePrimary())
  }

  parseLabelList () {
    this.expect('operator', '(')
    const labels = []
    while (!this.is('operator', ')')) {
      const token = this.peek()
      if (!token || token.type !== 'identifier') this.fail('expected a label name')
      labels.push(this.next().value)
      if (this.is('operator', ',')) this.next()
      else if (!this.is('operator', ')')) this.fail('expected "," or ")" in a label list')
    }
    this.next()
    return labels
  }

  parseDuration () {
    const token = this.peek()
    if (!token || token.type !== 'duration') this.fail('expected a duration such as 5m')
    return this.next().value
  }

  parsePostfix (expr) {
    let node = expr
    while (true) {
      if (this.is('operator', '[')) {
        this.next()
        const range = this.parseDuration()
        if (this.is('operator', ':')) {
          this.next()
          const step = this.is('duration') ? this.next().value : null
          this.expect('operator', ']')
          node = { type: 'subquery', expr: node, range, step }
        } else {
          this.expect('operator', ']')
          if (node.type !== 'selector' || node.range) this.fail('a range can only follow a vector selector')
          node.range = range
        }
        continue
      }
      if (this.isWord('offset')) {
        this.next()
        const negative = this.is('operator', '-')
        if (negative) this.next()
        const offset = `${negative ? '-' : ''}${this.parseDuration()}`
        this.setModifier(node, 'offset', offset)
        continue
      }
      if (this.is('operator', '@')) {
        this.next()
        let at
        if (this.isWord('start') || this.isWord('end')) {
          at = `${this.next().value}()`
          this.expect('operator', '(')
          this.expect('operator', ')')
        } else {
          const negative = this.is('operator', '-')
          if (negative) this.next()
          at = `${negative ? '-' : ''}${this.expect('number').value}`
        }
        this.setModifier(node, 'at', at)
        continue
      }
      return node
    }
  }

  setModifier (node, name, value) {
    if (node.type !== 'selector' && node.type !== 'subquery') this.fail(`${name === 'at' ? '@' : name} can only follow a selector or a subquery`)
    if (node[name] !== undefined && node[name] !== null) this.fail(`${name === 'at' ? '@' : name} is given twice`)
    node[name] = value
  }

  parseMatchers () {
    this.expect('operator', '{')
    const matchers = []
    while (!this.is('operator', '}')) {
      const token = this.peek()
      if (!token || token.type !== 'identifier') this.fail('expected a label name')
      const name = this.next().value
      const op = this.peek()
      if (!op || op.type !== 'operator' || !['=', '!=', '=~', '!~'].includes(op.value)) this.fail('expected =, !=, =~ or !~')
      this.next()
      const value = this.expect('string').value
      matchers.push({ name, op: op.value, value })
      if (this.is('operator', ',')) this.next()
      else if (!this.is('operator', '}')) this.fail('expected "," or "}" in a selector')
    }
    this.next()
    return matchers
  }

  parsePrimary () {
    const token = this.peek()
    if (!token) this.fail('expected an expression')
    if (token.type === 'number') {
      this.next()
      return { type: 'number', value: token.value }
    }
    if (token.type === 'duration') this.fail('a duration is only valid inside [ ] or after offset')
    if (token.type === 'string') {
      this.next()
      return { type: 'string', value: token.value }
    }
    if (token.type === 'operator' && token.value === '(') {
      this.next()
      const expr = this.parseBinary(0)
      this.expect('operator', ')')
      return { type: 'paren', expr }
    }
    if (token.type === 'operator' && token.value === '{') {
      const start = token.start
      const matchers = this.parseMatchers()
      return this.selector(null, matchers, start)
    }
    if (token.type !== 'identifier') this.fail('expected an expression')

    const word = token.value
    const lower = word.toLowerCase()
    if (lower === 'inf' || lower === 'nan') {
      this.next()
      return { type: 'number', value: word }
    }
    if (AGGREGATORS.has(word) && (this.is('operator', '(', 1) || this.isWord('by', 1) || this.isWord('without', 1))) {
      return this.parseAggregation()
    }
    if (this.is('operator', '(', 1)) return this.parseCall()
    if (KEYWORDS.has(word)) this.fail('expected an expression')
    this.next()
    const matchers = this.is('operator', '{') ? this.parseMatchers() : []
    return this.selector(word, matchers, token.start)
  }

  selector (name, matchers, start) {
    const named = matchers.find((matcher) => matcher.name === '__name__')
    if (name && named) this.fail('a selector cannot have both a metric name and a __name__ matcher', this.tokens[this.index - 1])
    if (!name && !matchers.some((matcher) => matcher.op === '=' || matcher.op === '=~' ? matcher.value !== '' : false)) {
      this.fail('a selector needs a metric name or a matcher that does not match the empty string', this.tokens[this.index - 1])
    }
    return { type: 'selector', name, matchers, range: null, offset: null, at: null, start }
  }

  parseGrouping () {
    const kind = this.next().value
    return { kind, labels: this.parseLabelList() }
  }

  parseArgs () {
    this.expect('operator', '(')
    const args = []
    while (!this.is('operator', ')')) {
      args.push(this.parseBinary(0))
      if (this.is('operator', ',')) {
        this.next()
        if (this.is('operator', ')')) this.fail('expected an expression')
      } else if (!this.is('operator', ')')) this.fail('expected "," or ")"')
    }
    this.next()
    return args
  }

  parseAggregation () {
    const op = this.next().value
    let grouping = null
    if (this.isWord('by') || this.isWord('without')) grouping = this.parseGrouping()
    const args = this.parseArgs()
    if (!grouping && (this.isWord('by') || this.isWord('without'))) grouping = this.parseGrouping()
    const wanted = PARAM_AGGREGATORS.has(op) ? 2 : 1
    if (args.length !== wanted) this.fail(`${op} takes ${wanted} argument${wanted === 1 ? '' : 's'}, got ${args.length},`, this.tokens[this.index - 1])
    return { type: 'aggregation', op, grouping, param: wanted === 2 ? args[0] : null, expr: args[wanted - 1] }
  }

  parseCall () {
    const name = this.next().value
    return { type: 'call', name, args: this.parseArgs() }
  }
}

/**
 * Parse a query. Throws PromqlSyntaxError.
 */
function parse (text) {
  return new Parser(text).parse()
}

/**
 * Visit every node of a tree, parents first.
 */
function walk (node, visit) {
  if (!node) return
  visit(node)
  switch (node.type) {
    case 'binary': walk(node.left, visit); walk(node.right, visit); break
    case 'unary': case 'paren': case 'subquery': walk(node.expr, visit); break
    case 'aggregation': walk(node.param, visit); walk(node.expr, visit); break
    case 'call': node.args.forEach((arg) => walk(arg, visit)); break
    default: break
  }
}

/**
 * Every vector selector in a query, in the order written.
 */
function selectors (ast) {
  const found = []
  walk(ast, (node) => { if (node.type === 'selector') found.push(node) })
  return found.sort((a, b) => a.start - b.start)
}

const quote = (value) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`

/**
 * A selector as an instant query: the name and matchers, without the range,
 * the offset or the @ modifier.
 */
function selectorText (selector) {
  const matchers = selector.matchers.map((matcher) => `${matcher.name}${matcher.op}${quote(matcher.value)}`).join(',')
  return `${selector.name || ''}${matchers || !selector.name ? `{${matchers}}` : ''}`
}

/**
 * Ranges in a query, in seconds: `[5m]` on a selector and `[30m:1m]` on a subquery.
 */
function ranges (ast) {
  const found = []
  walk(ast, (node) => {
    if ((node.type === 'selector' || node.type === 'subquery') && node.range) found.push(durationSeconds(node.range))
  })
  return found
}

module.exports = {
  AGGREGATORS,
  COMPARISONS,
  SET_OPERATORS,
  PromqlSyntaxError,
  durationSeconds,
  parse,
  ranges,
  selectors,
  selectorText,
  tokenize,
  walk
}

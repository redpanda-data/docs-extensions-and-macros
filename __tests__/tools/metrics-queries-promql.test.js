'use strict'

/**
 * The PromQL parser behind the static layer of `doc-tools check-queries`.
 * No maintained PromQL parser ships in this package's dependencies, so the
 * static layer has its own small one, and Prometheus stays the authority on
 * syntax in the live layer. These tests pin what the parser reads, what it
 * rejects, and its documented limits.
 */

const { parse, selectors, selectorText, ranges, durationSeconds, PromqlSyntaxError } = require('../../tools/metrics-queries/promql')

const texts = (query) => selectors(parse(query)).map(selectorText)

describe('selectors', () => {
  it.each([
    ['up', ['up']],
    ['up{}', ['up']],
    ['a{b="c"}', ['a{b="c"}']],
    ['a{b="c",}', ['a{b="c"}']],
    ['a{b=~"x|y", c!="d", e!~"f.*"}', ['a{b=~"x|y",c!="d",e!~"f.*"}']],
    ['{__name__=~"operator_.*"}', ['{__name__=~"operator_.*"}']],
    ["a{b='single'}", ['a{b="single"}']],
    ['a{b=`raw\\d`}', ['a{b="raw\\\\d"}']],
    ['a{b="say \\"hi\\""}', ['a{b="say \\"hi\\""}']],
    ['job:rate5m{x="y"}', ['job:rate5m{x="y"}']]
  ])('%s', (query, expected) => {
    expect(texts(query)).toEqual(expected)
  })

  it('drops the range, the offset and @ from the selector text', () => {
    expect(texts('rate(a{b="c"}[5m] offset 1h @ end())')).toEqual(['a{b="c"}'])
    const [selector] = selectors(parse('a[5m] offset -1h @ 1700000000'))
    expect(selector).toMatchObject({ range: '5m', offset: '-1h', at: '1700000000' })
  })

  it('finds every selector in the order written', () => {
    expect(texts([
      'max by(redpanda_topic)(redpanda_kafka_max_offset{redpanda_namespace="kafka"})',
      '  - on(redpanda_topic) group_right max by(redpanda_group, redpanda_topic)(redpanda_kafka_consumer_group_committed_offset)'
    ].join('\n'))).toEqual(['redpanda_kafka_max_offset{redpanda_namespace="kafka"}', 'redpanda_kafka_consumer_group_committed_offset'])
  })

  it('ignores comments', () => {
    expect(texts('# a{wrong="x"}\nup # b{wrong="y"}\n')).toEqual(['up'])
    expect(texts('a{b="not # a comment"}')).toEqual(['a{b="not # a comment"}'])
  })
})

describe('expressions', () => {
  it('reads aggregations with the grouping before or after', () => {
    const before = parse('sum by (a, b) (x)')
    const after = parse('sum(x) by (a, b)')
    expect(before).toMatchObject({ type: 'aggregation', op: 'sum', grouping: { kind: 'by', labels: ['a', 'b'] } })
    expect(after.grouping).toEqual(before.grouping)
    expect(parse('sum without(a)(x)').grouping).toEqual({ kind: 'without', labels: ['a'] })
    expect(parse('topk(5, x)')).toMatchObject({ op: 'topk', param: { type: 'number', value: '5' } })
    expect(parse('count_values("version", x)').param).toEqual({ type: 'string', value: 'version' })
  })

  it('reads vector matching', () => {
    expect(parse('a and on(instance) b')).toMatchObject({ op: 'and', matching: { kind: 'on', labels: ['instance'] }, group: null })
    expect(parse('a / ignoring(x) group_left(y, z) b')).toMatchObject({
      op: '/', matching: { kind: 'ignoring', labels: ['x'] }, group: { side: 'group_left', labels: ['y', 'z'] }
    })
    expect(parse('a - on(t) group_right b').group).toEqual({ side: 'group_right', labels: [] })
    expect(parse('a > bool 1')).toMatchObject({ op: '>', bool: true })
  })

  it('follows operator precedence', () => {
    // a or (b and (c == (d + (e * (f ^ g)))))
    const tree = parse('a or b and c == d + e * f ^ g')
    expect(tree.op).toBe('or')
    expect(tree.right.op).toBe('and')
    expect(tree.right.right.op).toBe('==')
    expect(tree.right.right.right.op).toBe('+')
    expect(tree.right.right.right.right.op).toBe('*')
    expect(tree.right.right.right.right.right.op).toBe('^')
    // Left associative, except ^.
    expect(parse('a - b - c').left.op).toBe('-')
    expect(parse('a ^ b ^ c').right.op).toBe('^')
    expect(parse('-a ^ 2')).toMatchObject({ type: 'unary', expr: { op: '^' } })
  })

  it('reads functions, subqueries and numbers', () => {
    expect(parse('histogram_quantile(0.99, sum(rate(x_bucket[5m])) by (le))')).toMatchObject({ type: 'call', name: 'histogram_quantile' })
    expect(parse('max_over_time(rate(x[1m])[30m:1m])').args[0]).toMatchObject({ type: 'subquery', range: '30m', step: '1m' })
    expect(parse('rate(x[1m])[30m:]')).toMatchObject({ type: 'subquery', step: null })
    expect(parse('1 - (sum(a) / sum(b))').left).toEqual({ type: 'number', value: '1' })
    for (const number of ['0x1F', '.5', '1e3', '2.5e-3', 'Inf', 'NaN', '+Inf']) expect(() => parse(number)).not.toThrow()
    expect(parse('time()')).toEqual({ type: 'call', name: 'time', args: [] })
  })

  it('gives the ranges in seconds', () => {
    expect(ranges(parse('rate(a[5m]) + rate(b[90s]) + max_over_time(rate(c[1m])[1h30m:1m])'))).toEqual([300, 90, 5400, 60])
    expect(ranges(parse('up'))).toEqual([])
    expect(durationSeconds('1h30m')).toBe(5400)
    expect(durationSeconds('500ms')).toBe(0.5)
  })
})

describe('text that is not a query', () => {
  it.each([
    ['two queries with a comma', 'rate(a[5m]),\nrate(b[5m])', /unexpected text after the end of the expression at ","/],
    ['two queries on two lines', 'a > 0\nb > 0', /unexpected text after the end of the expression at "b"/],
    ['a metrics endpoint sample', 'redpanda_cluster_features_enterprise_license_expiry_sec 2592000', /unexpected text/],
    ['a Grafana variable', 'rate(a[$__rate_interval])', /unexpected character "\$"/],
    ['an open parenthesis', 'sum(a', /expected "," or "\)" at the end of the query/],
    ['an open selector', 'a{b="c"', /expected "," or "}"/],
    ['an open string', 'a{b="c}', /a string is not closed/],
    ['a matcher with no quotes', 'a{b=c}', /expected a string/],
    ['a matcher with a bad operator', 'a{b=="c"}', /expected =, !=, =~ or !~/],
    ['an operator with no right side', 'a +', /expected an expression at the end of the query/],
    ['a range on an expression', 'sum(a)[5m]', /a range can only follow a vector selector/],
    ['two ranges', 'a[5m][5m]', /a range can only follow a vector selector/],
    ['a range with no unit', 'a[5]', /expected a duration/],
    ['offset on an aggregation', 'sum(a) offset 5m', /offset can only follow a selector or a subquery/],
    ['an aggregation with too many arguments', 'sum(a, b)', /sum takes 1 argument, got 2/],
    ['topk with no parameter', 'topk(a)', /topk takes 2 arguments, got 1/],
    ['group_left on a set operator', 'a and on(x) group_left b', /group_left cannot be used with and/],
    ['bool on arithmetic', 'a + bool b', /bool is only for comparison operators/],
    ['a selector with no name and no matcher', '{}', /needs a metric name/],
    ['a selector that only matches the empty string', '{x=""}', /needs a metric name/],
    ['a name and a __name__ matcher', 'a{__name__="b"}', /cannot have both/],
    ['an empty query', '   \n# only a comment\n', /the query is empty/]
  ])('rejects %s', (_, query, message) => {
    expect(() => parse(query)).toThrow(PromqlSyntaxError)
    expect(() => parse(query)).toThrow(message)
  })
})

// What this parser does not read. Prometheus accepts each of these, so a
// query that uses one fails the static layer with a syntax problem.
describe('documented limits', () => {
  it.each([
    ['a metric named like a keyword', 'on'],
    ['a quoted metric name', '{"my.metric"}'],
    ['a duration used as a number', 'rate(a[5m]) * 1h'],
    ['a recording rule name that starts with a colon', ':rate5m']
  ])('rejects %s', (_, query) => {
    expect(() => parse(query)).toThrow(PromqlSyntaxError)
  })
})

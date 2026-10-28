'use strict'

const fs = require('fs')
const path = require('path')
const { shellTokens, invocationStarts, parseInvocation, resolveInvocationFlag, blockLanguage } = require('../../../tools/reference-values/rpk')
const { RPK_KIND } = require('../../../extension-utils/rpk-values')

const SAMPLE = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'fixtures', 'rpkval', 'rpk-v26.2.2-sample.json'), 'utf8'))
const tree = SAMPLE.tree
const registry = { tag: 'v26.2.2', data: SAMPLE, surface: 'all', kind: RPK_KIND }

// Parse every invocation on a line, as the engine does.
const invocations = (line) => {
  const tokens = shellTokens(line)
  return invocationStarts(tokens).map((start) => parseInvocation(tree, tokens.slice(start + 1), SAMPLE.deprecated_commands, {
    isScrapedPath: (names) => ['ai', 'check', 'connect', 'k8s', 'oxla'].includes(names[0]),
  }))
}
const command = (parsed) => ['rpk', ...parsed.names].join(' ')

describe('rpk invocation parser', () => {
  test('a \\ continuation is joined before tokenizing (docs monitor-redpanda.adoc)', () => {
    const [p] = invocations('rpk generate grafana-dashboard  --datasource prometheus  --metrics-endpoint <broker-address>:9644/metrics > redpanda-dashboard.json')
    expect(command(p)).toBe('rpk generate grafana-dashboard')
    expect(p.flags.map((f) => f.name)).toEqual(['datasource', 'metrics-endpoint'])
  })

  test('kubectl exec ... -- rpk (docs k-production-readiness.adoc)', () => {
    const [p] = invocations('kubectl exec -n <namespace> <pod-name> -c redpanda -- rpk topic create my-topic -p 3')
    expect(command(p)).toBe('rpk topic create')
    expect(p.flags[0]).toMatchObject({ name: 'p', short: true, value: '3' })
  })

  test('pipes, && and $(...) each start an invocation', () => {
    expect(invocations('echo hi | rpk topic create a && rpk cluster info; x=$(rpk topic create b)').map(command))
      .toEqual(['rpk topic create', 'rpk cluster info', 'rpk topic create'])
  })

  test('a prompt and sudo', () => {
    expect(invocations('$ rpk cluster info').map(command)).toEqual(['rpk cluster info'])
    expect(invocations('sudo rpk redpanda start').map(command)).toEqual(['rpk redpanda start'])
  })

  test('--flag=value and -pVALUE', () => {
    const [p] = invocations('rpk topic create t --partitions=3 -r3')
    expect(p.flags).toEqual([
      expect.objectContaining({ name: 'partitions', value: '3', hasValue: true }),
      expect.objectContaining({ name: 'r', short: true, value: '3' }),
    ])
  })

  test('a persistent flag before the subcommand (rpk registry --schema-context .staging mode set)', () => {
    const [p] = invocations('rpk registry --schema-context .staging mode set')
    expect(command(p)).toBe('rpk registry mode set')
    const f = p.flags[0]
    expect(f).toMatchObject({ name: 'schema-context', value: '.staging' })
    expect(resolveInvocationFlag(registry, p, f).status).toBe('ok')
  })

  test('a flag only an ancestor defines is ancestor-flag, never taken as the command own flag (docs manage-throughput.adoc:683)', () => {
    const [p] = invocations('rpk cluster quotas describe --format json')
    expect(resolveInvocationFlag(registry, p, p.flags[0])).toMatchObject({ status: 'ancestor', defined: ['cluster', 'quotas'] })
  })

  test('an alias resolves (rpk cluster status is rpk cluster info)', () => {
    expect(invocations('rpk cluster status').map(command)).toEqual(['rpk cluster info'])
  })

  test('a bare -- ends parsing', () => {
    const [p] = invocations('rpk topic create t -- --not-a-flag')
    expect(p.flags).toEqual([])
  })

  test('redirects, comments and callouts end the command', () => {
    expect(invocations('rpk cluster info > out.txt 2>&1')[0].flags).toEqual([])
    expect(invocations('rpk cluster info # --brokers in a comment')[0].flags).toEqual([])
    expect(invocations('rpk cluster info <1>')[0].flags).toEqual([])
    expect(invocations('rpk cluster info (1)')[0].flags).toEqual([])
  })

  test('placeholders, attributes and variables are never commands', () => {
    // docs acl.adoc:664 writes `rpk security acl list/delete` for two commands.
    for (const line of ['rpk topic <subcommand>', 'rpk topic {cmd}', 'rpk topic $CMD', 'rpk topic ${CMD}', 'rpk topic ...', 'rpk security acl list/delete']) {
      expect(invocations(line)[0].problem).toBeUndefined()
    }
  })

  test('quotes are respected', () => {
    const [p] = invocations("rpk topic create 'my topic' --topic-config 'cleanup.policy=compact'")
    expect(p.flags[0]).toMatchObject({ name: 'topic-config', value: 'cleanup.policy=compact' })
  })

  test('the usage rule: a group whose usage takes no argument rejects an unknown word (rpk cluster quotas delete)', () => {
    expect(tree.commands.find((c) => c.name === 'cluster').commands.find((c) => c.name === 'quotas').usage).toBe('rpk cluster quotas [flags]')
    const [p] = invocations('rpk cluster quotas delete --name user=alice')
    expect(p.problem).toMatchObject({ kind: 'unknown-command', typed: ['cluster', 'quotas', 'delete'] })
  })

  test('a word where the usage takes an argument is an argument (rpk topic create my-topic)', () => {
    expect(invocations('rpk topic create my-topic')[0].problem).toBeUndefined()
  })

  test('a deprecated command is reported before it would be unknown', () => {
    expect(invocations('rpk redpanda admin brokers list')[0].problem).toMatchObject({ kind: 'deprecated-command' })
  })

  test('cobra help and English in backticks are not reported', () => {
    expect(invocations('rpk cluster help')[0].problem).toBeUndefined()
    expect(invocations('rpk is not on PATH')[0].problem).toMatchObject({ kind: 'not-a-command' })
  })

  test.each([
    ['[,bash]', 'bash'],
    ['[source,bash]', 'bash'],
    ['[source,yaml]', 'yaml'],
    ['[source]', ''],
    ['```console', 'console'],
    [undefined, ''],
  ])('block language of %s is %s', (style, language) => {
    expect(blockLanguage(style)).toBe(language)
  })
})

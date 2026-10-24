'use strict'

/**
 * Every sender syntax the dispatch-graph check claims to read has a fixture
 * here, plus three negative controls: a workflow_dispatch-only workflow, a
 * file whose only dispatches are inside comments, and a dispatch to a repo
 * outside the docs graph. A parser that sees a sender in any of those would
 * report edges that do not exist, which is the opposite failure to the one
 * this check is for and just as corrosive to trust in it.
 */

const fs = require('fs')
const path = require('path')
const { parseListeners, parseSenders, resolveValue, normalizeRepo, shellLogicalLines } = require('../../../tools/dispatch-graph/parse-workflows')

const FIXTURES = path.join(__dirname, 'fixtures')
const read = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8')
const where = (file, repo = 'redpanda-data/example') => ({ repo, file })
const edges = (senders) => senders.filter((s) => !s.unresolved).map((s) => `${s.targetRepo}#${s.eventType}`).sort()

describe('parseSenders: peter-evans/repository-dispatch', () => {
  const senders = parseSenders(read('sender-peter-evans.yml'), where('sender-peter-evans.yml', 'redpanda-data/redpanda-operator'))

  test('reads every step, across action versions', () => {
    expect(edges(senders)).toEqual([
      'redpanda-data/docs#generate-crd-docs',
      'redpanda-data/rp-connect-docs#generate-helm-spec-docs',
    ])
    expect(senders.every((s) => s.form === 'peter-evans')).toBe(true)
  })

  test('keeps literal payload values and drops expression ones', () => {
    const crd = senders.find((s) => s.eventType === 'generate-crd-docs')
    expect(crd.payload).toEqual({ plugin: 'k8s' })
  })

  test('records the sender repo, file and triggers', () => {
    expect(senders[0]).toMatchObject({ repo: 'redpanda-data/redpanda-operator', file: 'sender-peter-evans.yml', triggers: ['release'] })
  })
})

describe('parseSenders: expression resolution', () => {
  test('${{ matrix.repo }} fans out over the literal matrix, include entries too', () => {
    const senders = parseSenders(read('sender-matrix.yaml'), where('sender-matrix.yaml'))
    expect(edges(senders)).toEqual([
      'redpanda-data/api-docs#trigger-npm-update',
      'redpanda-data/cloud-docs#trigger-npm-update',
      'redpanda-data/docs#trigger-npm-update',
    ])
  })

  test('${{ env.X }} resolves from the nearest level: step over job over workflow', () => {
    const senders = parseSenders(read('sender-env.yml'), where('sender-env.yml'))
    expect(edges(senders)).toEqual([
      'redpanda-data/docs#from-job-env',
      'redpanda-data/docs#from-step-env',
    ])
  })

  test('a secret target and a step-output type are unresolved, not invented', () => {
    const senders = parseSenders(read('sender-unresolved.yml'), where('sender-unresolved.yml'))
    expect(senders).toHaveLength(1)
    expect(senders[0].unresolved).toBe(true)
    expect(senders[0].targetRepo).toBeNull()
    expect(senders[0].raw).toMatch(/secrets\.TARGET/)
  })

  test('repository defaults to the sending repo when omitted', () => {
    const text = [
      'on: push', 'jobs:', '  j:', '    runs-on: x', '    steps:',
      '      - uses: peter-evans/repository-dispatch@v4', '        with:', '          event-type: self-event',
    ].join('\n')
    const senders = parseSenders(text, where('self.yml', 'redpanda-data/self'))
    expect(edges(senders)).toEqual(['redpanda-data/self#self-event'])
  })
})

describe('parseSenders: gh api in run blocks', () => {
  const senders = parseSenders(read('sender-gh-api.yml'), where('sender-gh-api.yml', 'redpanda-data/connect'))

  test('one-line and backslash-continued calls are each a sender', () => {
    expect(edges(senders)).toEqual([
      'redpanda-data/docs#update-rpk-plugin-docs',
      'redpanda-data/docs-ui#update-go-mod',
      'redpanda-data/rp-connect-docs#generate-rpcn-docs',
    ])
    expect(senders.every((s) => s.form === 'gh-api')).toBe(true)
  })

  test('a commented-out gh api line is not a sender', () => {
    expect(senders.map((s) => s.eventType)).not.toContain('commented-out-event')
  })

  test('client_payload[key]=literal fields are kept, shell variables are not', () => {
    const plugin = senders.find((s) => s.eventType === 'update-rpk-plugin-docs')
    expect(plugin.payload).toEqual({ plugin: 'ai' })
  })

  test('jq --input form: repo from an input default via the env chain, type from the body', () => {
    const s = parseSenders(read('sender-jq-input.yml'), where('sender-jq-input.yml', 'redpanda-data/docs-extensions-and-macros'))
    expect(edges(s)).toEqual(['redpanda-data/docs-site#doc-impact'])
    expect(s[0].triggers).toEqual(['workflow_call'])
  })

  test('curl to api.github.com with a JSON body', () => {
    const s = parseSenders(read('sender-curl.yml'), where('sender-curl.yml'))
    expect(edges(s)).toEqual(['redpanda-data/adp-docs#sync-rpk-ai-stubs'])
    expect(s[0].form).toBe('curl')
    expect(s[0].payload).toEqual({ plugin: 'ai' })
  })
})

describe('parseSenders: actions/github-script', () => {
  test('createDispatchEvent with literal owner, repo and event_type', () => {
    const s = parseSenders(read('sender-github-script.yml'), where('sender-github-script.yml'))
    expect(edges(s)).toEqual(['redpanda-data/docs#from-script'])
    expect(s[0].form).toBe('github-script')
    expect(s[0].payload).toEqual({ plugin: 'check' })
  })
})

describe('parseSenders: negative controls', () => {
  test('a workflow_dispatch-only workflow has no senders and no listeners', () => {
    const text = read('negative-workflow-dispatch-only.yml')
    expect(parseSenders(text, where('n.yml'))).toEqual([])
    expect(parseListeners(text, where('n.yml'))).toEqual([])
  })

  test('dispatches that exist only inside comments are neither senders nor listeners', () => {
    const text = read('negative-commented-dispatch.yml')
    expect(parseSenders(text, where('c.yml'))).toEqual([])
    expect(parseListeners(text, where('c.yml'))).toEqual([])
  })

  test('a dispatch to a non-docs repo parses as a sender with that target (scope is the graph builder\'s job)', () => {
    const s = parseSenders(read('sender-non-docs-target.yml'), where('e.yml', 'redpanda-data/console'))
    expect(edges(s)).toEqual(['redpanda-data/console-enterprise#push'])
  })
})

describe('parseListeners', () => {
  test('one listener per declared type, with the choice inputs the workflow enumerates', () => {
    const l = parseListeners(read('listener-types.yml'), where('listener-types.yml', 'redpanda-data/docs'))
    expect(l.map((x) => x.eventType).sort()).toEqual(['trigger-cloud-property-sync', 'trigger-property-docs-generation'])
    expect(l[0].cronBackstop).toBe(false)
    expect(l[0].choiceInputs).toEqual({ plugin: ['ai', 'connect', 'k8s', 'check'] })
    expect(l[0].workflowName).toBe('Update property docs')
  })

  test('a scalar types: value and a schedule trigger mark the cron backstop', () => {
    const l = parseListeners(read('listener-cron.yml'), where('listener-cron.yml'))
    expect(l).toHaveLength(1)
    expect(l[0]).toMatchObject({ eventType: 'trigger-cloud-regions', cronBackstop: true })
  })

  test('on: [repository_dispatch] with no types listens for any event', () => {
    const l = parseListeners(read('listener-any-type.yml'), where('any.yml'))
    expect(l).toHaveLength(1)
    expect(l[0].eventType).toBeNull()
  })

  test('a document that is not a workflow throws rather than returning an empty graph', () => {
    expect(() => parseListeners('- just\n- a list\n', where('x.yml'))).toThrow(/not a workflow/)
    expect(() => parseSenders('key: [unclosed', where('x.yml'))).toThrow()
  })
})

describe('helpers', () => {
  test('normalizeRepo accepts slugs and URLs, rejects junk', () => {
    expect(normalizeRepo('redpanda-data/docs')).toBe('redpanda-data/docs')
    expect(normalizeRepo('https://github.com/redpanda-data/docs.git')).toBe('redpanda-data/docs')
    expect(normalizeRepo('https://api.github.com/repos/redpanda-data/docs')).toBe('redpanda-data/docs')
    expect(normalizeRepo('$TARGET')).toBeNull()
    expect(normalizeRepo('')).toBeNull()
  })

  test('resolveValue: github.repository is the sender, unknown expressions are empty', () => {
    const ctx = { env: {}, matrix: {}, inputDefaults: {}, selfRepo: 'o/self' }
    expect(resolveValue('${{ github.repository }}', ctx)).toEqual(['o/self'])
    expect(resolveValue('$GITHUB_REPOSITORY', ctx)).toEqual(['o/self'])
    expect(resolveValue('${{ inputs.nothing }}', ctx)).toEqual([])
    expect(resolveValue('$UNDEFINED_VAR', ctx)).toEqual([])
  })

  test('shellLogicalLines joins continuations and drops comment lines', () => {
    expect(shellLogicalLines('# c\na \\\n  b\nc')).toEqual(['a b', 'c'])
  })
})

describe('parseSenders: if-gated dispatch steps and target case', () => {
  const gated = (jobIf, stepIf) => [
    'on: { release: { types: [published] } }', 'jobs:', '  d:', jobIf ? `    if: ${jobIf}` : '', '    runs-on: ubuntu-latest', '    steps:',
    '      - run: echo first',
    stepIf ? `      - if: ${stepIf}` : '      - name: plain', '        uses: peter-evans/repository-dispatch@v3',
    '        with:', '          repository: redpanda-data/docs', '          event-type: ev',
  ].filter((l) => l !== '').join('\n')

  test('a step if: makes the sender conditional, with the step located for the jobs API', () => {
    const [s] = parseSenders(gated(null, "github.repository == 'redpanda-data/redpanda'"), where('x.yml'))
    expect(s).toMatchObject({ conditional: true, condition: "github.repository == 'redpanda-data/redpanda'" })
    expect(s.stepRef).toEqual({ jobKey: 'd', jobName: 'd', stepName: 'Run peter-evans/repository-dispatch@v3', stepNumber: 3 })
  })

  test('a job if: is recorded too, job first', () => {
    const [s] = parseSenders(gated('${{ false }}', 'always()'), where('x.yml'))
    expect(s.condition).toBe('${{ false }} && always()')
  })

  test('negative control: no if: is not conditional', () => {
    const [s] = parseSenders(gated(null, null), where('x.yml'))
    expect(s.conditional).toBe(false)
    expect(s.condition).toBeNull()
    expect(s.stepRef.stepName).toBe('plain')
  })

  test('a mixed-case repository: is normalized to lowercase', () => {
    const [s] = parseSenders(gated(null, null).replace('redpanda-data/docs', 'Redpanda-Data/Docs'), where('x.yml'))
    expect(s.targetRepo).toBe('redpanda-data/docs')
    expect(normalizeRepo('Redpanda-Data/Cloud-Docs.git')).toBe('redpanda-data/cloud-docs')
  })
})

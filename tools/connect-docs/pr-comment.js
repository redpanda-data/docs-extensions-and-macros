'use strict'

const fs = require('fs')

/**
 * The connect-docs-check PR comment: one sticky comment per connect PR that
 * tells the author and the docs team what the PR changes on the published
 * Connect docs, whether the docs build passed, and where to review the
 * rendered pages.
 *
 * Usage: node pr-comment.js --build <pass|fail> [--diff diff.json] [--html-findings <n>]
 *          [--preview <deploy url>] [--run-url <url>] [--sha <sha>]
 *          [--output comment.md]
 *
 * Prints JSON { body, notify }. `notify` is true when the PR changes a
 * published page, breaks the build, or has rendered-HTML findings on a page
 * it changes: the cases where the docs team should
 * look. The workflow posts the comment only when notify is true or a
 * comment already exists, so PRs that touch no docs get no comment.
 */

const MARKER = '<!-- connect-docs-check -->'
const MAX_ROWS = 30
const PROD = 'https://docs.redpanda.com'

function pagePath (sitePath) {
  return '/' + String(sitePath).replace(/index\.html$/, '')
}

function buildComment ({ build, diff, preview, runUrl, sha, htmlFindings = 0 }) {
  const pages = (diff && diff.pages) || []
  const summary = (diff && diff.summary) || null
  const failed = build !== 'pass'
  const lines = [MARKER, '### Connect docs check', '']

  lines.push(failed
    ? '**The docs build failed.** This PR breaks the Connect docs build: see the job summary for the errors.'
    : 'The docs build passed with this PR\'s generated docs.')
  lines.push('')
  if (htmlFindings > 0) {
    lines.push(`**${htmlFindings} rendered-HTML ${htmlFindings === 1 ? 'finding' : 'findings'} on pages this PR changes**, such as broken anchors or unconverted AsciiDoc. They are listed in the job summary.`, '')
  }

  if (preview) {
    lines.push(`Preview: ${preview.replace(/\/$/, '')}/connect/home/`, '')
  }

  if (!diff) {
    lines.push('The merge base was not generated, so the changed pages are not listed.', '')
  } else if (!pages.length && !(summary && summary.files)) {
    lines.push('This PR doesn\'t change any published Connect docs page.', '')
  } else {
    const s = summary || {}
    lines.push(`This PR changes ${pages.length} published ${pages.length === 1 ? 'page' : 'pages'} (${s.files || 0} generated ${s.files === 1 ? 'file' : 'files'}: ${s.changed || 0} changed, ${s.added || 0} added, ${s.removed || 0} removed). Review the rendered pages, not only the Go strings.`, '')
    if (pages.length) {
      lines.push(preview ? '| Page | Preview |' : '| Page |', preview ? '|---|---|' : '|---|')
      for (const p of pages.slice(0, MAX_ROWS)) {
        const pth = pagePath(p.sitePath)
        const live = `[${pth}](${PROD}${pth})`
        lines.push(preview ? `| ${live} | [preview](${preview.replace(/\/$/, '')}${pth}) |` : `| ${live} |`)
      }
      if (pages.length > MAX_ROWS) lines.push('', `And ${pages.length - MAX_ROWS} more pages.`)
      lines.push('')
    }
  }

  const tail = []
  if (runUrl) tail.push(`Per-file diffs and the rendered-HTML findings are in the [job summary](${runUrl}).`)
  if (sha) tail.push(`Checked at ${String(sha).slice(0, 9)}.`)
  if (tail.length) lines.push(tail.join(' '))

  return { body: lines.join('\n').trimEnd() + '\n', notify: failed || htmlFindings > 0 || pages.length > 0 }
}

function parseArgs (argv) {
  const opts = {}
  for (let i = 0; i < argv.length; i++) {
    const m = /^--(build|diff|html-findings|preview|run-url|sha|output)$/.exec(argv[i])
    if (!m) throw new Error(`unknown argument: ${argv[i]}`)
    opts[m[1]] = argv[++i]
  }
  if (opts.build !== 'pass' && opts.build !== 'fail') throw new Error('--build must be pass or fail')
  return opts
}

function runCli (argv) {
  const opts = parseArgs(argv)
  const diff = opts.diff && fs.existsSync(opts.diff) ? JSON.parse(fs.readFileSync(opts.diff, 'utf8')) : null
  const result = buildComment({ build: opts.build, diff, htmlFindings: Number(opts['html-findings'] || 0), preview: opts.preview || '', runUrl: opts['run-url'], sha: opts.sha })
  if (opts.output) fs.writeFileSync(opts.output, result.body)
  process.stdout.write(JSON.stringify({ notify: result.notify }) + '\n')
  return result
}

if (require.main === module) {
  try {
    runCli(process.argv.slice(2))
  } catch (err) {
    console.error(`Error: ${err.message}`)
    process.exit(2)
  }
}

module.exports = { MARKER, MAX_ROWS, buildComment, runCli }

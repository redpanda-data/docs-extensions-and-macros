/**
 * Antora extension to redirect home page when agentic-data-plane component doesn't exist
 *
 * When the agentic-data-plane component is not included in the build, this extension
 * programmatically adds an alias to the home page that redirects to the data-platform
 * landing page. This leverages Antora's standard redirect facility (Netlify, etc.).
 */

'use strict'

module.exports.register = function () {
  let shouldRedirect = false

  // Check if ADP exists during content aggregation
  this.on('contentAggregated', ({ contentAggregate }) => {
    const adpComponent = contentAggregate.find(c => c.name === 'agentic-data-plane')
    shouldRedirect = !adpComponent
    if (shouldRedirect) {
      console.log('[conditional-home-redirect] agentic-data-plane not found, will create redirect after publish')
    } else {
      console.log('[conditional-home-redirect] agentic-data-plane found, no redirect needed')
    }
  })

  // Create redirect files AFTER site is published
  this.on('sitePublished', ({ playbook }) => {
    if (!shouldRedirect) return

    const fs = require('fs')
    const path = require('path')

    // Get absolute output directory
    const outputDir = path.resolve(playbook.output.dir || 'build/site')
    console.log(`[conditional-home-redirect] Output directory: ${outputDir}`)

    // Check redirect facility
    const redirectFacility = playbook.urls.redirectFacility || 'netlify'
    console.log(`[conditional-home-redirect] Redirect facility: ${redirectFacility}`)

    if (redirectFacility === 'netlify') {
      // Add to _redirects file
      const redirectsPath = path.join(outputDir, '_redirects')
      const redirectRule = '/home/ /data-platform/ 301\n/home/index.html /data-platform/index.html 301\n'

      try {
        let existingRedirects = ''
        if (fs.existsSync(redirectsPath)) {
          existingRedirects = fs.readFileSync(redirectsPath, 'utf8')
          console.log(`[conditional-home-redirect] Found existing _redirects file with ${existingRedirects.split('\\n').length} lines`)
        } else {
          console.log(`[conditional-home-redirect] No existing _redirects file, creating new one`)
        }

        // Prepend our redirect to the top (higher priority)
        fs.writeFileSync(redirectsPath, redirectRule + existingRedirects)
        console.log(`[conditional-home-redirect] Added home -> data-platform redirect to _redirects`)
      } catch (err) {
        console.error(`[conditional-home-redirect] Failed to write redirects file: ${err.message}`)
      }
    }

    // Create a static HTML redirect at /home/index.html
    const homeDir = path.join(outputDir, 'home')
    const homeIndexPath = path.join(homeDir, 'index.html')

    const redirectHtml = `<!DOCTYPE html>
<meta charset="utf-8">
<link rel="canonical" href="../data-platform/">
<script>location="../data-platform/"</script>
<meta http-equiv="refresh" content="0; url=../data-platform/">
<meta name="robots" content="noindex">
<title>Redirect Notice</title>
<h1>Redirecting to Data Platform</h1>
<p>The Redpanda documentation home page is being redirected. You will be forwarded to <a href="../data-platform/">Data Platform</a> automatically.</p>`

    try {
      // Ensure directory exists
      if (!fs.existsSync(homeDir)) {
        fs.mkdirSync(homeDir, { recursive: true })
      }

      // Overwrite the home page with redirect HTML
      fs.writeFileSync(homeIndexPath, redirectHtml)
      console.log(`[conditional-home-redirect] Overwrote home page with redirect at ${homeIndexPath}`)
    } catch (err) {
      console.error(`[conditional-home-redirect] Failed to create redirect HTML: ${err.message}`)
    }
  })
}

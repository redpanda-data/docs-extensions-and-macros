# Testing Instructions

## 1. Install dependencies:
```bash
npm install
```

## 2. Link the package for local testing:
```bash
npm link
```

## 3. Install CLI dependencies:
```bash
# Install all required dependencies for CLI commands
./cli-utils/install-test-dependencies.sh

# Or manually install core dependencies:
npm install -g @redocly/cli  # or swagger-cli
brew install buf git        # or appropriate package manager
```

## 4. Verify CLI command renamed correctly:
```bash
# Check that the old command is gone and new one exists
doc-tools generate --help

# Should show 'bundle-openapi' command instead of 'bundle-admin-api'
```

## 5. Test OpenAPI bundling functionality:
```bash
# Test admin API bundling
doc-tools generate bundle-openapi --surface admin --tag v25.1.1

# Test connect API bundling  
doc-tools generate bundle-openapi --surface connect --tag v25.1.1

# Test both APIs
doc-tools generate bundle-openapi --surface both --tag v25.1.1

# Test with version override
doc-tools generate bundle-openapi --surface admin --tag v25.1.1 --use-admin-major-version
```

## 6. Test npm script shortcuts:
```bash
# These should use the new command name
npm run bundle:admin
npm run bundle:connect  
npm run bundle:both
```

## 7. Test bundler detection:
```bash
# Should automatically detect and use available bundlers
# (swagger-cli, @redocly/cli, or fallback to npx variants)
doc-tools generate bundle-openapi --surface admin --tag v25.1.1 --quiet
```

## 8. Run test suite:
```bash
npm test
```

## 9. Verify error handling:
```bash
# Test with invalid tag
doc-tools generate bundle-openapi --surface admin --tag invalid-tag

# Test with missing dependencies (if you want to test error paths)
# Temporarily rename bundler and test error message
```

## 10. Test standalone tool:
```bash
# Test the standalone bundle-openapi.js directly
node tools/bundle-openapi.js --tag v25.1.1 --surface admin
```

## Expected Results:
- ✅ All tests pass (86/86)
- ✅ CLI command renamed from `bundle-admin-api` to `bundle-openapi`
- ✅ Command description updated to mention both admin and connect APIs
- ✅ Bundler detection uses shared `detectBundler()` function (no duplication)
- ✅ Generated OpenAPI files contain proper metadata and structure
- ✅ npm scripts work with new command name
- ✅ No breaking changes to existing functionality

## Files to Check:
- `admin/redpanda-admin-api.yaml` - Generated admin API spec
- `connect/redpanda-connect-api.yaml` - Generated connect API spec (if tested)
- Verify proper version metadata in generated files
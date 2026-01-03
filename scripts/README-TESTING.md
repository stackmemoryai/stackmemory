# StackMemory Pre-Publish Test Suite

This directory contains comprehensive tests for validating StackMemory installation and functionality before publishing to npm.

## Test Scripts

### 1. `test-installation.sh`
**Main pre-publish validation suite**
- Tests CLI build and compilation
- Validates package.json structure
- Checks shell integration setup
- Validates binary functionality
- Tests fresh installation simulation
- Runs security audits

**Usage:**
```bash
npm run test:install
# or
./scripts/test-installation.sh
```

### 2. `test-shell-integration.sh`
**Shell integration specific tests**
- Validates all binaries exist and are executable
- Tests individual binary functionality
- Checks shell integration file syntax
- Validates PATH configuration
- Tests for startup errors

**Usage:**
```bash
npm run test:shell
# or
./scripts/test-shell-integration.sh
```

### 3. `test-installation-scenarios.sh`
**Real-world installation scenario tests**
- Tests global installation
- Tests local project installation
- Tests permission scenarios
- Tests Node.js version compatibility
- Tests package integrity
- Tests upgrade scenarios

**Usage:**
```bash
npm run test:scenarios
# or
./scripts/test-installation-scenarios.sh
```

## Complete Pre-Publish Test Suite

Run all tests before publishing:

```bash
npm run test:pre-publish
```

This runs all three test suites in sequence and must pass before `npm publish` can succeed.

## Test Components Validated

### CLI Functionality
- ✅ Build completes without errors
- ✅ CLI executable works (`stackmemory --version`, `stackmemory --help`)
- ✅ Core commands load without module resolution errors
- ✅ TypeScript compilation succeeds
- ✅ Linting passes

### Shell Integration
- ✅ `~/.stackmemory/bin/` directory and binaries exist
- ✅ `stackmemory-daemon` functionality (start, stop, status)
- ✅ `stackmemory-monitor` configuration management
- ✅ `sm-review` context review functionality  
- ✅ `stackmemory` wrapper delegates properly
- ✅ Shell integration files can be sourced without errors
- ✅ PATH configuration includes StackMemory binaries

### Package & Installation
- ✅ package.json structure is valid
- ✅ npm pack succeeds
- ✅ Fresh installation simulation works
- ✅ Global and local installation scenarios
- ✅ Permission handling
- ✅ Node.js compatibility (18, 20, 21, 22)
- ✅ Package integrity validation
- ✅ Postinstall setup execution
- ✅ Upgrade scenarios

### Security
- ✅ Dependencies security audit passes
- ✅ No high-severity vulnerabilities
- ✅ Git working directory is clean

## Integration with npm

The test suite is integrated with npm lifecycle hooks:

```json
{
  "scripts": {
    "prepublishOnly": "npm run build && npm run test:pre-publish"
  }
}
```

This ensures that:
1. All tests must pass before any `npm publish` command succeeds
2. The package is built fresh before testing
3. Installation scenarios are validated in clean environments

## Test Output

Each test script provides colored output:
- 🔵 **INFO**: Test execution information
- 🟢 **PASS**: Test passed successfully
- 🔴 **FAIL**: Test failed with error details
- 🟡 **WARN**: Warning or non-critical issue

Example output:
```
============================================
  StackMemory Pre-Publish Test Suite
============================================

🔨 Build & Compilation Tests
[PASS] Build succeeds without errors
[PASS] TypeScript compilation check
[PASS] Lint check passes

⚡ CLI Functionality Tests
[PASS] CLI is executable
[PASS] CLI help displays correctly
[PASS] CLI commands load without errors

📦 Package Validation Tests
[PASS] package.json structure valid
[PASS] npm pack succeeds
[PASS] Git status is clean

✅ All tests passed! Ready for npm publish.
```

## Troubleshooting Failed Tests

### Build Failures
- Check TypeScript errors: `npm run build`
- Fix linting issues: `npm run lint:fix`
- Ensure all dependencies are installed: `npm install`

### CLI Failures
- Verify dist/cli/index.js exists and is executable
- Check for missing ES module import extensions (.js)
- Ensure all imported modules exist in the build

### Shell Integration Failures  
- Verify `~/.stackmemory/bin/` directory exists
- Check binary file permissions: `ls -la ~/.stackmemory/bin/`
- Test individual binaries manually
- Check shell integration syntax: `bash -n ~/.stackmemory/shell-integration-consolidated.sh`

### Installation Scenario Failures
- Check npm pack output for missing files
- Verify package.json bin configuration
- Test in clean environment manually
- Check Node.js version compatibility

## Continuous Integration

For CI/CD pipelines, run the full test suite:

```bash
# In CI environment
npm ci
npm run test:pre-publish
npm publish
```

The tests are designed to work in various environments:
- Local development machines
- CI/CD systems (GitHub Actions, etc.)
- Docker containers
- Different operating systems (macOS, Linux)
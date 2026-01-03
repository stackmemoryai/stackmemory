# Post-Task Quality Gates for StackMemory

## 🎯 Overview

StackMemory's Post-Task Quality Gates automatically ensure code quality by running tests, linters, and code reviews after Claude completes any task involving code changes. This prevents issues from accumulating and maintains high code quality throughout development.

## 🚀 Quick Setup

```bash
# Run the automated setup
./scripts/install-post-task-hooks.sh

# Or set up manually
stackmemory quality --setup
```

## 🔍 How It Works

### Automatic Triggers

The system monitors for these events and automatically runs quality gates:

1. **Task Completion** - When Claude finishes a task frame
2. **File Changes** - When source files are modified
3. **Frame Closure** - When implementation frames close
4. **Code Changes** - When significant code changes are detected

### Quality Gates

Each trigger runs a configurable set of quality checks:

| Gate | Purpose | Speed | Scope |
|------|---------|--------|-------|
| **Linter** | Code style & basic issues | ⚡ Fast (1-5s) | Changed files |
| **Tests** | Functional correctness | 🐌 Medium (10-60s) | Affected tests |
| **Coverage** | Test completeness | 🐌 Medium (10-30s) | New/changed code |
| **Code Review** | Quality & security | 🐌 Slow (30-120s) | Full context |

## 📋 Commands

### Setup & Configuration

```bash
# Interactive setup wizard
stackmemory quality --setup

# Enable/disable quality gates
stackmemory quality --enable
stackmemory quality --disable

# Configure quality gates
stackmemory quality --config
```

### Monitoring & Control

```bash
# Check status
stackmemory quality --status

# Run quality gates manually
stackmemory quality --run

# View history
stackmemory quality --history
```

## ⚙️ Configuration

Quality gates are configured in `.stackmemory/config.json`:

```json
{
  "qualityGates": {
    "runTests": true,              // Auto-run tests after code changes
    "requireTestCoverage": false,   // Require coverage checks
    "runCodeReview": true,         // Auto-trigger code review
    "runLinter": true,             // Auto-run linter
    "blockOnFailure": false        // Block work if gates fail
  },
  "testFrameworks": {
    "detected": ["Jest"],          // Auto-detected frameworks
    "testCommand": "npm test",     // Custom test command
    "lintCommand": "npm run lint", // Custom lint command
    "coverageCommand": "npm run coverage"
  },
  "reviewConfig": {
    "reviewOnEveryChange": false,   // Review every file change
    "reviewOnTaskComplete": true,   // Review on task completion
    "focusAreas": [                // Review focus areas
      "security",
      "performance", 
      "maintainability",
      "correctness"
    ],
    "skipPatterns": [              // Files to skip
      "*.test.ts",
      "*.spec.js",
      "dist/",
      "node_modules/"
    ]
  }
}
```

## 🪝 Installed Hooks

The system installs these Claude Code hooks in `~/.claude/hooks/`:

### on-task-complete
```bash
# Runs after Claude completes any task
# Triggers: Tests → Linter → Code Review
```

### on-file-save  
```bash
# Runs linter when files are saved
# Fast feedback on code style issues
```

### on-code-change
```bash
# Detects significant code changes
# Runs full quality gates for large changes
```

### on-frame-close
```bash
# Runs when implementation frames close
# Ensures quality before moving to next task
```

## 🎬 Example Workflows

### Scenario 1: Code Implementation Task

```
Claude: "I'll implement user authentication"

[Claude writes auth code...]

✅ Task completed: Implement user authentication
🔍 Running quality gates...

  ✅ linter (1.2s)
  ✅ tests (15.3s) 
  ❌ coverage (8.1s)
     ⚠️ Coverage 65% is below threshold 80%
  ✅ code_review (45.2s)

⚠️ Some quality gates failed. See details above.

💡 Fix coverage or adjust threshold in config
```

### Scenario 2: Bug Fix Task

```
Claude: "I'll fix the login validation bug"

[Claude fixes the bug...]

✅ Task completed: Fix login validation bug
🔍 Running quality gates...

  ✅ linter (0.8s)
  ✅ tests (12.1s)
     ✓ All tests passing
  ✅ code_review (32.4s)
     ✓ Security: No vulnerabilities found
     ✓ Logic: Fix addresses root cause

🎉 All quality gates passed!
```

### Scenario 3: Real-time File Changes

```
[User saves LoginForm.tsx]

🔍 Running linter on LoginForm.tsx...
  ✓ No lint issues found

[Claude modifies 8 files...]

🚨 Significant changes detected (8 files)
🔍 Running comprehensive quality gates...
  ✅ linter (2.1s)
  ❌ tests (23.5s)
     ✗ LoginForm test failed
     ✗ UserAuth integration test failed

❌ Quality gates failed - fix tests before continuing
```

## 🛠️ Framework Support

### Auto-Detection

The system automatically detects and configures for:

**JavaScript/TypeScript:**
- Jest, Vitest, Mocha, Playwright, Cypress
- ESLint, Prettier, TSC
- React, Vue, Angular, Node.js

**Python:**
- pytest, unittest
- ruff, black, flake8
- Django, FastAPI, Flask

**Go:**
- `go test`, `go vet`
- `golangci-lint`, `gofmt`

**Rust:**
- `cargo test`, `cargo check`
- `cargo clippy`, `rustfmt`

**Other Languages:**
- Java (Maven, Gradle)
- C# (.NET)
- Custom commands

### Custom Configuration

```json
{
  "testFrameworks": {
    "testCommand": "yarn test --coverage",
    "lintCommand": "yarn lint --fix",
    "coverageCommand": "yarn coverage:report"
  }
}
```

## 🔧 Advanced Configuration

### Blocking Mode

When `blockOnFailure: true`, failed quality gates will:

1. Display detailed error report
2. Block further work until issues resolved
3. Provide actionable fix suggestions
4. Track resolution progress

```bash
🚫 Quality gates failed - blocking further work:
   tests: 3 test failures in auth module
   linter: 12 style violations in components/

🔧 Fix these issues before continuing:
1. Fix failing test: User login should validate password
2. Fix ESLint error: Missing semicolon (Login.tsx:42)
3. Fix ESLint error: Unused variable 'token' (Auth.ts:15)
```

### Code Review Integration

The code review gate integrates with AI agents to provide:

- **Security Analysis** - Vulnerability scanning
- **Performance Review** - Performance bottleneck detection  
- **Maintainability Check** - Code complexity and coupling analysis
- **Correctness Verification** - Logic error detection

### Custom Quality Gates

Extend with custom gates:

```javascript
// .stackmemory/hooks/custom-quality-gate.js
module.exports = {
  name: 'security_scan',
  async run(files) {
    // Custom security scanning logic
    return {
      passed: true,
      output: 'Security scan completed',
      issues: []
    };
  }
};
```

## 📊 Quality Metrics

The system tracks:

- **Gate Success Rate** - Percentage of passing quality gates
- **Average Gate Duration** - Performance monitoring  
- **Issue Trends** - Tracking improvement over time
- **Coverage Progression** - Test coverage evolution

```bash
$ stackmemory quality --history

📈 Quality Gate History

✅ Fix user authentication bug
   2024-01-03 14:30 - 2.1s
     ✓ linter ✓ tests ✓ code_review

❌ Add password validation
   2024-01-03 14:15 - 45.3s
     ✓ linter ✗ tests ✓ code_review
     
✅ Refactor login component
   2024-01-03 14:00 - 18.7s
     ✓ linter ✓ tests ✓ coverage ✓ code_review
```

## 🎯 Benefits

1. **Immediate Feedback** - Catch issues right after code changes
2. **Consistent Quality** - Automated enforcement of quality standards
3. **Reduced Debt** - Prevent technical debt accumulation
4. **Faster Reviews** - Pre-screened code for human reviewers
5. **Learning Tool** - Educational feedback on code quality

## 🚨 Troubleshooting

### Quality Gates Not Running

```bash
# Check if enabled
stackmemory quality --status

# Enable if disabled
stackmemory quality --enable

# Check hook installation
ls -la ~/.claude/hooks/on-task-complete
```

### Test Command Not Found

```bash
# Configure custom test command
stackmemory quality --config

# Or edit config directly
nano .stackmemory/config.json
```

### Hooks Not Triggering

```bash
# Reinstall hooks
./scripts/install-post-task-hooks.sh

# Check Claude Code hook configuration
cat ~/.claude/hooks/on-task-complete
```

### Performance Issues

```bash
# Disable slow gates temporarily
stackmemory quality --config
# Set runCodeReview: false

# Or adjust scope
# Set reviewOnEveryChange: false
```

## 🔗 Integration

### CI/CD Pipeline

```yaml
# .github/workflows/quality.yml
- name: Run StackMemory Quality Gates
  run: |
    stackmemory init
    stackmemory quality --run --block-on-failure
```

### IDE Integration

Quality gate results can be:
- Displayed in VS Code notifications
- Integrated with IDE error highlighting  
- Exported to SARIF format for security tools

### Team Workflows

- **Pre-commit** - Run quality gates before commits
- **Pull Request** - Require quality gates to pass
- **Code Review** - Include quality gate reports

---

The Post-Task Quality Gates system ensures that every piece of code Claude writes meets your quality standards automatically, providing continuous quality assurance throughout development.
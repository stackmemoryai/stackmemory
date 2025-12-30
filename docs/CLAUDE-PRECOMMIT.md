# Claude-SM Pre-commit Hook

An AI-powered pre-commit hook that automatically reviews code, suggests refactoring, and generates edge case tests using Claude and StackMemory.

## Features

### 🔍 Code Review
- Security vulnerability detection
- Performance issue identification
- Code smell and anti-pattern detection
- Missing error handling
- Potential bug detection

### 🔧 Refactoring Suggestions
- Complex function extraction
- Cyclomatic complexity reduction
- Naming improvements
- DRY principle enforcement
- SOLID principle compliance

### 🧪 Edge Case Testing
- Null/undefined input tests
- Empty array/object tests
- Boundary value tests
- Invalid type tests
- Concurrency tests (where applicable)

### 📊 StackMemory Integration
- Saves review decisions for context
- Tracks refactoring patterns
- Maintains test coverage history
- Provides historical context for reviews

## Installation

```bash
# Make scripts executable
chmod +x scripts/claude-pre-commit.sh
chmod +x scripts/install-claude-hooks.sh

# Install the hooks
./scripts/install-claude-hooks.sh
```

## Configuration

Edit `.claude-precommit` in your repo root:

```bash
# Enable/disable features
CLAUDE_REVIEW_ENABLED=true      # Code review
CLAUDE_REFACTOR_ENABLED=true    # Refactoring suggestions
CLAUDE_TEST_ENABLED=true        # Test generation
CLAUDE_AUTO_FIX=false           # Auto-apply fixes (use with caution!)

# Size limits
MAX_FILE_SIZE=100000            # 100KB per file
MAX_TOTAL_SIZE=500000           # 500KB total
```

## Usage

### Normal Commit
```bash
git add src/myfile.ts
git commit -m "feat: add new feature"
# Claude reviews the code automatically
```

### Skip Review (Emergency)
```bash
git commit --no-verify -m "emergency: hotfix"
```

### Auto-fix Mode
```bash
CLAUDE_AUTO_FIX=true git commit -m "feat: with auto-fixes"
# Claude will attempt to fix issues automatically
```

### Selective Features
```bash
# Only security review
CLAUDE_REFACTOR_ENABLED=false CLAUDE_TEST_ENABLED=false git commit

# Only test generation
CLAUDE_REVIEW_ENABLED=false CLAUDE_REFACTOR_ENABLED=false git commit
```

## Example Output

```bash
🤖 Claude-SM Pre-commit Hook Starting...
Found 3 staged file(s) for review

━━━ Analyzing: src/api/handler.ts ━━━
📝 Reviewing: src/api/handler.ts
❌ Critical issues found:
  - SQL injection vulnerability on line 45
  - Missing input validation for user data
  - No rate limiting on public endpoint

💡 Refactoring suggestions:
  - Extract validation logic to separate function
  - Reduce complexity of handleRequest (current: 15)

🧪 Edge case tests generated
  ✓ Test for null request body
  ✓ Test for malformed JSON
  ✓ Test for concurrent requests

━━━ Summary ━━━
❌ Commit blocked due to critical issues
Fix the issues and try again, or use --no-verify to skip
```

## Integration with StackMemory

The hook automatically:
1. Saves all review decisions to StackMemory
2. Uses previous context for smarter reviews
3. Tracks patterns across commits
4. Builds a knowledge base of your codebase

### View Review History
```bash
stackmemory context show --filter "Pre-commit"
```

### Get Review Statistics
```bash
stackmemory analytics --type pre-commit
```

## Advanced Features

### Custom Review Prompts
Create `.claude-review-prompts.json`:
```json
{
  "security": "Check for OWASP Top 10 vulnerabilities",
  "performance": "Identify O(n²) or worse algorithms",
  "style": "Ensure consistent async/await usage"
}
```

### Team Standards
Create `.claude-team-standards.md`:
```markdown
# Our Team Standards
- No console.log in production code
- All API endpoints must have rate limiting
- Test coverage must be > 80%
```

### Language-Specific Rules
The hook automatically detects language and applies appropriate checks:
- **TypeScript/JavaScript**: ESLint patterns, security
- **Python**: PEP-8, type hints, security
- **Go**: Effective Go, error handling
- **Rust**: Clippy warnings, unsafe blocks
- **Java**: Spotbugs patterns, null checks

## Troubleshooting

### Claude CLI Not Found
```bash
# Install Claude CLI
npm install -g @anthropic/claude-cli
```

### StackMemory Not Found
```bash
# Install StackMemory
npm install -g @stackmemoryai/stackmemory
```

### Hook Not Running
```bash
# Check hook is executable
chmod +x .git/hooks/pre-commit
ls -la .git/hooks/pre-commit
```

### Review Taking Too Long
```bash
# Reduce file size limits
export MAX_FILE_SIZE=50000
export MAX_TOTAL_SIZE=200000
```

## Best Practices

1. **Start Conservative**: Begin with review-only mode
2. **Build Trust**: Monitor suggestions for a week before enabling auto-fix
3. **Team Agreement**: Discuss and configure standards as a team
4. **Regular Updates**: Update review prompts based on common issues
5. **Emergency Escape**: Always remember `--no-verify` for urgent fixes

## Performance Impact

Typical review times:
- Small commit (1-3 files): 5-10 seconds
- Medium commit (4-10 files): 15-30 seconds
- Large commit (10+ files): 30-60 seconds

To optimize:
- Set appropriate size limits
- Exclude generated files
- Use focused review mode
- Cache common patterns in StackMemory

## Security Notes

- Reviews are processed locally via Claude CLI
- No code is sent to external servers (except Claude API)
- StackMemory stores only metadata, not source code
- Sensitive files can be excluded via `.gitignore`

## Contributing

To improve the pre-commit hook:
1. Edit `scripts/claude-pre-commit.sh`
2. Test with sample commits
3. Update documentation
4. Submit PR with examples

## License

Part of StackMemory - see main LICENSE file
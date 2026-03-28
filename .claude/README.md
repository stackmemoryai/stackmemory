# Claude Code Integration

This directory contains Claude Code configuration, hooks, and skills for the StackMemory project.

## Structure

```
.claude/
├── claude.json          # Main configuration with hooks
├── hooks/              # Hook scripts
│   ├── skill-eval.sh   # Shell wrapper for skill evaluation
│   ├── skill-eval.cjs  # Node.js skill evaluation engine
│   └── skill-rules.json # Skill detection rules
├── agents/             # Agent definitions
│   ├── code-reviewer.md # Code review agent
│   └── github-workflow.md # Git workflow agent
└── skills/             # Skill definitions
    ├── code-quality.md # Code quality checks
    ├── pr-review.md    # PR review skill
    └── pr-summary.md   # PR summary generation
```

## Features

### Hooks

1. **UserPromptSubmit**: Analyzes prompts and suggests relevant skills
2. **PreToolUse**: Prevents editing on main branch
3. **PostToolUse**: 
   - Auto-formats TypeScript/JavaScript files
   - Auto-installs dependencies when package.json changes
   - Auto-runs tests when test files change
   - Type-checks TypeScript files

### Skills

The skill evaluation engine detects relevant skills based on:
- Keywords in prompts
- File paths mentioned
- Directory mappings
- Intent patterns
- Code content patterns

#### Available Skills

- **frame-management**: Frame stack and context management
- **linear-integration**: Linear API and task sync
- **mcp-server**: Model Context Protocol implementation
- **testing-patterns**: Jest testing infrastructure
- **cli-commands**: CLI command implementation
- **storage-tiers**: 3-tier storage system
- **context-bridge**: Cross-session synchronization
- **task-management**: Task tracking and persistence
- **terminal-ui**: Terminal UI with Ink
- **claude-integration**: Claude Code hooks and integration
- **build-scripts**: Build and deployment scripts
- **documentation**: Documentation and API reference
- **github-actions**: CI/CD workflows
- **code-quality**: Code review and quality checks
- **performance-optimization**: Performance analysis

### Agents

- **code-reviewer**: Reviews code against StackMemory standards
- **github-workflow**: Manages git operations and PRs

## Usage

The hooks and skills are automatically activated when using Claude Code in this project. The skill evaluation engine will analyze your prompts and suggest relevant skills to activate.

### Manual Testing

Test skill evaluation:
```bash
echo '{"prompt": "your test prompt"}' | node .claude/hooks/skill-eval.cjs
```

### Configuration

Edit `skill-rules.json` to:
- Add new skills
- Modify detection patterns
- Adjust confidence scoring
- Update directory mappings

## Knowledge Skills (.claude/skills/knowledge/*.skill.md)

Domain-specific knowledge files loaded on keyword match. See `skills/knowledge/` for available skills.

```
[LOAD]on keyword match from frontmatter `activates_on` → read matching .skill.md
[FALLBACK]if `expires` date passed → use Context7 `context7` field or fetch `sources[]`
[CACHE]loaded skills persist for session|don't re-read same skill
[FORMAT]frontmatter: name,version,domain,expires,activates_on[],sources[],context7
```

Available: `esbuild-esm`, `vitest`, `better-sqlite3`, `mcp-protocol`, `commander-cli`
Plus global skills at `~/.claude/skills/knowledge/`: `stripe-api`, `railway-deploy`, `anthropic-sdk`

## StackMemory-Specific Patterns

Key patterns enforced by hooks and agents:

1. **ESM Imports**: Always add `.js` extension to relative imports
2. **Context Bridge**: Use `skipContextBridge: true` for CLI operations
3. **Error Handling**: Return `undefined` instead of throwing in getFrame()
4. **Database Paths**: Use project-local `.stackmemory/` not global
5. **Frame Digests**: Keep under 200 tokens
6. **Linear Integration**: Reference tickets in commits (STA-XX)

## Maintenance

- Update `skill-rules.json` when adding new features
- Keep agent definitions in sync with project standards
- Test hooks after major changes
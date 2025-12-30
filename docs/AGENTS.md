# StackMemory Agent Instructions

## System Architecture Overview

StackMemory is a **lossless, project-scoped memory runtime** that revolutionizes how AI tools maintain context. Key architectural principles:

### Core Concepts
- **Frame-based memory**: Call stack metaphor with up to 10,000 frames (not linear chat logs)
- **Two-tier storage**: Local SQLite (30-day retention) + infinite remote storage (S3/TimeSeries DB)
- **LLM-driven retrieval**: Intelligent context selection analyzing compressed summaries to determine optimal frame depth
- **Hybrid digests**: 60% deterministic extraction, 40% AI-generated summaries processed during idle time
- **Configurable scoring**: Tool importance scores (search: 0.95, grep: 0.15) with customizable weight profiles
- **Team collaboration**: Dual stack architecture supporting individual and shared frames with handoff

### Query System
- **Natural language**: "provide context from the last day", "show Alice's auth work"
- **Structured queries**: TypeScript interfaces with time/content/frame/people filters
- **Hybrid syntax**: Command-line style, inline modifiers, template patterns
- **Smart shortcuts**: today, yesterday, bugs, features, critical, my work

### Performance Targets
- **Retrieval latency**: p50 < 50ms, p99 < 500ms
- **Max stack depth**: 10,000 frames
- **Storage**: 2GB local, infinite remote
- **Incremental GC**: 100 frames/cycle to avoid UI freezes

## NPM Publishing Process

### Prerequisites
1. Ensure you're logged into npm: `npm login`
2. Verify login status: `npm whoami`
3. If token expired, create new: `npm token create`

### Publishing Checklist
1. **Test in Sandbox First**
   ```bash
   # Create sandbox environment
   ./scripts/create-sandbox.sh
   
   # Test in sandbox
   /tmp/stackmemory-sandbox/[timestamp]/run-sandbox.sh test
   /tmp/stackmemory-sandbox/[timestamp]/run-sandbox.sh linear-sync
   /tmp/stackmemory-sandbox/[timestamp]/run-sandbox.sh mcp-server
   ```

2. **Run Tests & Lint**
   ```bash
   npm test
   npm run lint
   ```

3. **Update Version**
   - Update version in package.json
   - Create release notes in RELEASE_NOTES_v[version].md

4. **Commit Changes**
   ```bash
   git add .
   git commit -m "Release v[version]: [features]"
   ```

5. **Publish to NPM**
   ```bash
   npm publish
   # If 2FA enabled, use: npm publish --otp=[code]
   ```

### Common Issues & Solutions

#### Token Expired Error
```
npm error 401 Unauthorized
npm error Access token expired or revoked
```
**Solution**: Complete npm login process
1. Run `npm login`
2. Complete authentication in browser
3. Retry publish

#### 404 Not Found Error
```
npm error 404 Not Found - PUT
```
**Solution**: This usually means authentication failed
1. Verify package name in package.json
2. Ensure you have publish permissions
3. Re-authenticate with `npm login`

#### OTP Required
```
npm error This operation requires a one-time password
```
**Solution**: Use `npm publish --otp=[6-digit-code]`

## Sandbox Environment

### Purpose
The sandbox environment allows testing StackMemory in isolation before publishing.

### Creating Sandbox
```bash
./scripts/create-sandbox.sh
```

This creates:
- Isolated environment in `/tmp/stackmemory-sandbox/[timestamp]`
- Complete npm install and build
- Test project for initialization
- Helper script `run-sandbox.sh`

### Using Sandbox
```bash
# Check status
/tmp/stackmemory-sandbox/[timestamp]/run-sandbox.sh status

# Test MCP server
/tmp/stackmemory-sandbox/[timestamp]/run-sandbox.sh mcp-server

# Test Linear sync
export LINEAR_API_KEY="your_key"
/tmp/stackmemory-sandbox/[timestamp]/run-sandbox.sh linear-sync

# Run any CLI command
/tmp/stackmemory-sandbox/[timestamp]/run-sandbox.sh cli [command]

# Clean up
/tmp/stackmemory-sandbox/[timestamp]/run-sandbox.sh clean
```

## Feature Testing Requirements

### Linear Integration
- Set `LINEAR_API_KEY` environment variable
- Test both API key and OAuth methods
- Verify task sync bidirectionally

### MCP Server
- Test startup without errors
- Verify Claude Desktop config integration
- Check protocol responses

### Update Checker
- Verify 24-hour cache mechanism
- Test version comparison logic
- Ensure non-intrusive notifications

### Progress Tracker
- Check `.stackmemory/progress.json` creation
- Verify session tracking
- Test Linear sync status updates

## Release Process

1. **Version Bump**: Update package.json version
2. **Documentation**: Create release notes
3. **Sandbox Test**: Full test in isolated environment
4. **Main Repo Test**: Run tests and lint
5. **Commit**: Descriptive commit message
6. **Publish**: npm publish with OTP if required
7. **Verify**: Check npm registry for new version
8. **Tag**: Create git tag for release

## Important Files

- `package.json` - Version and dependencies
- `CHANGELOG.md` - User-facing changes
- `RELEASE_NOTES_v*.md` - Detailed release information
- `.stackmemory/progress.json` - Progress tracking
- `docs/releases/` - Historical release documentation
- `scripts/create-sandbox.sh` - Sandbox creation script

## Environment Variables

- `LINEAR_API_KEY` - Linear API authentication
- `STACKMEMORY_ENV` - Environment mode (sandbox/production)
- `STACKMEMORY_DEBUG` - Enable debug logging

## Commands Reference

### Core Commands
- `stackmemory init` - Initialize in project
- `stackmemory status` - Show current status
- `stackmemory push/pop` - Manage context stack

### Integration Commands
- `stackmemory linear auth` - OAuth authentication
- `stackmemory linear sync` - Sync with Linear
- `stackmemory linear auto-sync` - Enable auto-sync

### Utility Commands
- `stackmemory mcp-server` - Start MCP server
- `stackmemory update-check` - Check for updates
- `stackmemory progress` - View progress tracking

### Debug Commands
- `stackmemory --debug [command]` - Run with debug output
- `stackmemory --version` - Show version
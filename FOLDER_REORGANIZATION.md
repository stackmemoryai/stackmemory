# 📁 StackMemory Folder Structure Reorganization Plan

## Current Issues
- Mixed deployment code (railway, runway.bak) in src
- Analytics scattered across multiple locations
- Integrations folder becoming too large
- Scripts folder unorganized
- No clear separation between local and cloud components

## Proposed New Structure

```
stackmemory/
├── src/                        # Core source code
│   ├── core/                   # Core business logic
│   │   ├── context/            # Context management
│   │   │   ├── frame-manager.ts
│   │   │   ├── context-store.ts
│   │   │   └── attention-scoring.ts
│   │   ├── projects/           # Project management
│   │   │   ├── project-manager.ts
│   │   │   ├── project-detector.ts
│   │   │   └── organization-config.ts
│   │   ├── storage/            # Storage layer
│   │   │   ├── database.ts
│   │   │   ├── migrations/
│   │   │   └── repositories/
│   │   ├── monitoring/         # Logging & monitoring
│   │   │   ├── logger.ts
│   │   │   ├── error-handler.ts
│   │   │   └── progress-tracker.ts
│   │   └── utils/              # Shared utilities
│   │       ├── update-checker.ts
│   │       └── validators.ts
│   │
│   ├── features/               # Feature modules
│   │   ├── analytics/          # Analytics feature
│   │   │   ├── index.ts
│   │   │   ├── service.ts
│   │   │   ├── api.ts
│   │   │   ├── queries.ts
│   │   │   ├── types.ts
│   │   │   └── dashboard.html
│   │   ├── tasks/              # Task management (Pebbles)
│   │   │   ├── task-store.ts
│   │   │   ├── task-context.ts
│   │   │   └── types.ts
│   │   └── browser/            # Browser automation
│   │       ├── browser-mcp.ts
│   │       └── puppeteer-config.ts
│   │
│   ├── integrations/           # External integrations
│   │   ├── linear/             # Linear integration
│   │   │   ├── index.ts
│   │   │   ├── client.ts
│   │   │   ├── auth.ts
│   │   │   ├── sync.ts
│   │   │   └── config.ts
│   │   ├── github/             # GitHub integration (future)
│   │   └── mcp/                # MCP protocol
│   │       ├── server.ts
│   │       ├── handlers.ts
│   │       └── proxy.ts
│   │
│   ├── cli/                    # CLI application
│   │   ├── index.ts            # Entry point (cli.ts renamed)
│   │   ├── commands/           # CLI commands
│   │   │   ├── analytics.ts
│   │   │   ├── context.ts
│   │   │   ├── linear.ts
│   │   │   ├── projects.ts
│   │   │   └── server.ts
│   │   └── utils/              # CLI utilities
│   │       ├── viewer.ts
│   │       └── formatters.ts
│   │
│   ├── servers/                # Server implementations
│   │   ├── local/              # Local MCP server
│   │   │   └── index.ts
│   │   ├── railway/            # Railway deployment
│   │   │   ├── index.ts
│   │   │   └── config.ts
│   │   └── production/         # Production configs
│   │       ├── auth.ts
│   │       ├── database.ts
│   │       └── monitoring.ts
│   │
│   └── index.ts                # Main export
│
├── scripts/                    # Utility scripts
│   ├── setup/                  # Setup scripts
│   │   ├── install.js
│   │   ├── configure-alias.js
│   │   └── claude-integration.js
│   ├── deployment/             # Deployment scripts
│   │   ├── railway.sh
│   │   ├── docker-build.sh
│   │   └── test-deployment.js
│   ├── development/            # Dev tools
│   │   ├── fix-lint-loop.cjs
│   │   └── create-demo-tasks.js
│   └── hooks/                  # Git/shell hooks
│       ├── task-complete.sh
│       └── cleanup-shell.sh
│
├── config/                     # Configuration files
│   ├── railway.json
│   ├── nixpacks.toml
│   ├── docker/
│   │   ├── Dockerfile
│   │   └── docker-compose.yml
│   └── environments/
│       ├── .env.example
│       ├── .env.railway.example
│       └── .env.production.example
│
├── docs/                       # Documentation
│   ├── README.md               # Main README
│   ├── architecture/
│   │   ├── SYSTEM_DESIGN.md
│   │   ├── MULTI_PROJECT.md
│   │   └── DEPLOYMENT.md
│   ├── guides/
│   │   ├── GETTING_STARTED.md
│   │   ├── RAILWAY_DEPLOY.md
│   │   └── CLAUDE_SETUP.md
│   ├── api/
│   │   └── MCP_REFERENCE.md
│   └── releases/
│       └── CHANGELOG.md
│
├── tests/                      # Test files
│   ├── unit/
│   ├── integration/
│   └── e2e/
│
├── packages/                   # Monorepo packages (future)
│   ├── attention-scoring/
│   ├── mcp-server/
│   └── p2p-sync/
│
└── .claude/                    # Claude-specific configs
    ├── CLAUDE.md
    ├── config.json
    └── hooks/
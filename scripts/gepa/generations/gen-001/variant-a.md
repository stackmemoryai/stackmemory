# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project Overview

Sol is the **Rize** monorepo (automatic time tracking). Stack:
- **api/** - Rails 7.1 GraphQL backend (Ruby 3.3.5)
- **web/** - Next.js 14 React app (Node 22)
- **electron/** - Electron desktop app (Node 22)
- **services/** - Bun TypeScript event consumers/workers
- **vanity/** - Webflow marketing scripts (deprecated)
- **voyager/** - Marketing website (Next.js)
- **puppet/** - Puppeteer server for images/PDFs
- **chrome/** - Chrome extension
- **docs/** - Docusaurus site
- **zapier/** - Zapier integration

## Development Commands

### Start Dev Environment
```bash
./scripts/run-dev.sh  # All services (requires iTerm2 on macOS)

# Individually:
cd api && hivemind Procfile.dev      # Rails + AnyCable + Sidekiq + Clockwork
cd web && npm run dev                # Next.js (port 3001)
cd electron && npm run dev           # Electron with hot reload
cd services && hivemind Procfile.dev # Bun services
```

### Docker (required before api/services)
```bash
cd api && docker-compose up -d
# TimescaleDB: localhost:15432 | Redis: localhost:16379
# Kafka: localhost:9092 | MySQL: localhost:13306
```

### Testing
```bash
# API (RSpec)
cd api && bundle exec rspec
cd api && bundle exec rspec spec/path/to/file_spec.rb
cd api && bundle exec rspec spec/path/to/file_spec.rb:42

# Electron (Jest)
cd electron && npm test
cd electron && npm run test:watch
cd electron && npm run test:coverage

# Web: no active tests (exits 0)
```

### Building
```bash
cd api && bundle install && rake db:migrate
cd web && npm run build       # gql-gen + tailwind + next build
cd electron && npm run build  # Electron Forge make
cd services && bun install
```

### GraphQL Code Generation
- `cd web && npm run build` — includes gql codegen
- `cd electron && npm run dev` — runs gql codegen automatically

## Architecture

### GraphQL API
Two endpoints:
- **api/v1** — Public API (OAuth, Zapier) → `api/app/graphql/api/v1/`
- **private/v1** — Internal API (web, electron) → `api/app/graphql/private/v1/`

### Real-time
- AnyCable WebSocket subscriptions
- ActionCable channels: `api/app/channels/`
- Config: `api/config/cable.yml`, `api/config/anycable.yml`

### Background Jobs
- Sidekiq (async): `api/config/sidekiq.yml`
- Clockwork (scheduled): `api/config/clock.rb`

### Event Streaming
- Kafka publish/consume via `services/consumers/`
- Config: `api/config/initializers/kafka.rb`

### Databases
- **PostgreSQL** — primary app data
- **TimescaleDB** — time-series (separate connection in `database.yml`)
- **MySQL** — legacy integrations
- **Redis** — caching, ActionCable, Sidekiq

## Style Guidelines

### JavaScript/TypeScript Tests
- Use `test()` not `it()`
- Use `toBeCalled()` not `toHaveBeenCalledWith()`

## Key Config Files

| File | Purpose |
|------|---------|
| `api/config/database.yml` | DB connections (primary + timescale) |
| `api/config/cable.yml` | AnyCable WebSocket config |
| `api/Procfile.dev` | Dev processes (rails, anycable, sidekiq, clockwork) |
| `sol.code-workspace` | VS Code multi-folder workspace |

Each subproject needs its own `.env` file (not committed).